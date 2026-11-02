import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSecretKey, randomBytes } from 'node:crypto'

import { createPool } from '@nacre.work/core'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { AuthContext } from '../auth.js'
import { oauthMinter } from '../oauth-mint.js'
import {
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
} from '../oauth-store.js'
import { createApi } from '../server.js'
import { postgresVerification } from '../verification.js'

/**
 * Security audit 2026-11-01, LOW finding
 * api/server.ts:oauth-consents-list-and-revoke-accept-delegated-token.
 *
 * `POST /v1/oauth/consent` refuses any delegated token (T41: "approving is
 * the person's act, in a session they signed into"). `GET
 * /v1/oauth/consents` and `DELETE /v1/oauth/consents/{id}` were left out of
 * that pattern — both hand the delegated `AuthContext` straight to the
 * store, whose non-administering branch scopes by `approved_by`, the
 * *person*'s id, never the connection's. So a connected application a
 * person limited to `{read}` on one layer could list every connection that
 * person approved — including a `{read,write}` connection narrowed to a
 * different layer, and names, ceilings and the approver's email beyond its
 * own narrowing — and end any one of them, which for an `org_admin` person
 * reaches their administrative MCP connection too.
 *
 * Over a real socket against a real PostgreSQL and the real `createApi`,
 * mirroring `connection-surface.test.ts`'s own T41 fixture: a stub of the
 * store or the token verifier would agree with whatever it was told to
 * believe about the other.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; a delegation reading or ending another connection would go untested.')
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'
const KEY = createSecretKey(Buffer.from('q'.repeat(48)))
const ISSUER = 'https://consents-delegation.test'
const AUDIENCE = 'consents-delegation'
const REDIRECT = 'http://127.0.0.1:33420/callback'

const id = (n: number): string => `0dc0115e-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const PERSON = id(2)
const WS = id(3)
const PROVIDER = id(4)
const LAYER_L = id(10)
const LAYER_M = id(11)

let pool: Pool
let server: Server
let base: string
let consents: PostgresOAuthConsents
let clients: PostgresOAuthClients

const mint = oauthMinter({ issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 300, signing: KEY, algorithm: 'HS256' })

const as = (userId: string, role: AuthContext['role'] = 'member'): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role,
})

/** A connected application's token, stored through the consent table and minted as the API mints. */
const connection = async (
  who: AuthContext,
  clientId: string,
  layers: readonly { readonly id: string; readonly permissions?: readonly ('read' | 'write' | 'admin')[] }[],
  permissions: readonly ('read' | 'write' | 'admin' | 'skill')[] | undefined,
): Promise<{ token: string; consentId: string }> => {
  const consentId = await consents.record(who, clientId, { actsAs: 'user', userId: who.principal.id }, layers, permissions)
  const token = (
    await mint({ orgId: ORG, subject: { actsAs: 'user', userId: who.principal.id }, consentId, surface: 'default' })
  ).accessToken
  return { token, consentId }
}

const register = async (name: string): Promise<string> => {
  const clientId = `nacre_client_${randomBytes(8).toString('hex')}`
  await clients.register(name, [REDIRECT], clientId)
  return clientId
}

/** A console session: the person, signed in, with no connection — and no `del` claim — behind the token. */
const session = async (userId: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ org: ORG, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

const getConsents = (token: string): Promise<Response> =>
  fetch(`${base}/v1/oauth/consents`, { headers: { authorization: `Bearer ${token}` } })

const deleteConsent = (token: string, consentId: string): Promise<Response> =>
  fetch(`${base}/v1/oauth/consents/${consentId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })

when('a delegated token against GET and DELETE /v1/oauth/consents', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    consents = new PostgresOAuthConsents(pool, AS_APP)
    clients = new PostgresOAuthClients(pool, AS_APP)

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'consentsdel','Consents delegation','org_consentsdel') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$2,'person@consentsdel.test','member')
         ON CONFLICT DO NOTHING`,
        [PERSON, ORG],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'ws','WS') ON CONFLICT DO NOTHING`,
        [WS, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,$2,'p','http://embedder.test','stub',4) ON CONFLICT DO NOTHING`,
        [PROVIDER, ORG],
      )
      // The narrowing's own layers need to exist — the FK on
      // oauth_consent_layers requires it — even though neither case below
      // exercises what a narrowing actually reaches; both are about who may
      // list or end the connection, not what it may read.
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$3,$4,'l','L',$5,'v1'), ($2,$3,$4,'m','M',$5,'v1')
         ON CONFLICT DO NOTHING`,
        [LAYER_L, LAYER_M, ORG, WS, PROVIDER],
      )
    } finally {
      c.release()
    }

    server = createApi({
      verify: { key: KEY, issuer: ISSUER, audience: AUDIENCE, ...postgresVerification(pool, AS_APP) },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
      oauth: {
        issuer: ISSUER,
        consentUrl: `${ISSUER}/#/consent`,
        clients,
        authorizations: new PostgresOAuthAuthorizations(pool, AS_APP),
        consents,
        refreshTokens: new PostgresOAuthRefreshTokens(pool, AS_APP),
        refreshTtlSeconds: 3600,
        accessTtlSeconds: 300,
        mint,
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    await pool?.end()
  })

  beforeEach(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_authorizations WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_consent_layers WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
    } finally {
      c.release()
    }
  })

  it('refuses a delegation on GET, which used to list every other connection the same person made', async () => {
    const narrowed = await register('a read-only client narrowed to one layer')
    const other = await register('a different, wider connection')

    const { token } = await connection(as(PERSON), narrowed, [{ id: LAYER_L }], ['read'])
    await connection(as(PERSON), other, [{ id: LAYER_M }], ['read', 'write'])

    const res = await getConsents(token)
    expect(res.status).toBe(404)

    // The control: the person, signed in with no connection behind the
    // token, sees both of their own connections. The refusal above is
    // about the token being a delegation, not about the organization or
    // the person.
    const listed = await getConsents(await session(PERSON))
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { items: readonly { client_id: string }[] }
    expect(body.items.map((i) => i.client_id).sort()).toEqual([narrowed, other].sort())
  })

  it('refuses a delegation on DELETE, which used to end any connection the same person made', async () => {
    const narrowed = await register('a read-only client narrowed to one layer')
    const other = await register('a different, wider connection it must not reach')

    const { token } = await connection(as(PERSON), narrowed, [{ id: LAYER_L }], ['read'])
    const { consentId: otherId } = await connection(as(PERSON), other, [{ id: LAYER_M }], ['read', 'write'])

    const res = await deleteConsent(token, otherId)
    expect(res.status).toBe(404)

    // Nothing was touched — the wider connection is still live.
    const stillLive = await consents.list(as(PERSON))
    const row = stillLive.find((c) => c.id === otherId)
    expect(row?.revokedAt).toBeNull()
  })

  it('a signed-in session, not a delegation, can still list and end its own connections', async () => {
    const clientId = await register('an ordinary connection')
    const { consentId } = await connection(as(PERSON), clientId, [], undefined)
    const token = await session(PERSON)

    const listed = await getConsents(token)
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { items: readonly { id: string }[] }
    expect(body.items.map((i) => i.id)).toContain(consentId)

    const ended = await deleteConsent(token, consentId)
    expect(ended.status).toBe(200)
  })
})
