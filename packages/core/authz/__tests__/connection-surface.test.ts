import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createSecretKey, randomBytes } from 'node:crypto'

import {
  createApi,
  oauthMinter,
  postgresVerification,
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
  type AuthContext,
} from '@nacre.work/api'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'

/**
 * Which connections may be made, and by whom — T41, and who may approve one
 * for the administrative resource.
 *
 * Over a real socket, against a real PostgreSQL, through the handler the
 * browser reaches. What is under test is a request a connected application can
 * send and a database row the answer depends on, so a stub of either would be
 * asserting what it was written to believe about the other.
 *
 * Tokens are minted by `oauthMinter`, the function the API itself mints with,
 * so the audience rule under test is the one that ships rather than a copy.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. T41 would silently skip, and it is the case ' +
      'that decides whether a connected application can approve itself a wider one.',
  )
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'
const KEY = createSecretKey(Buffer.from('c'.repeat(48)))
const ISSUER = 'https://connections.test'
const AUDIENCE = 'connections'
const REDIRECT = 'http://127.0.0.1:33419/callback'

const id = (n: number): string => `c0cc5e7f-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const PERSON = id(2)
const ADMIN = id(3)

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

/** A console session: the person, signed in, with no connection behind the token. */
const session = async (userId: string, role: AuthContext['role'] = 'member'): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

/** A connected application's token, stored through the consent table and minted as the API mints. */
const connection = async (
  who: AuthContext,
  clientId: string,
  permissions: readonly ('read' | 'write' | 'admin' | 'skill')[] | undefined,
): Promise<string> => {
  const consentId = await consents.record(who, clientId, { actsAs: 'user', userId: who.principal.id }, [], permissions)
  return (
    await mint({ orgId: ORG, subject: { actsAs: 'user', userId: who.principal.id }, consentId, surface: 'default' })
  ).accessToken
}

const register = async (name: string): Promise<string> => {
  const clientId = `nacre_client_${randomBytes(8).toString('hex')}`
  await clients.register(name, [REDIRECT], clientId)
  return clientId
}

const challenge = (): string =>
  createHash('sha256').update(randomBytes(32).toString('base64url'), 'utf8').digest('base64url')

/** `POST /v1/oauth/consent`, as the console's Approve sends it. */
const approve = (token: string, body: Record<string, unknown>): Promise<Response> =>
  fetch(`${base}/v1/oauth/consent`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

when('delegation · who may make a connection, and for which resource', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    consents = new PostgresOAuthConsents(pool, AS_APP)
    clients = new PostgresOAuthClients(pool, AS_APP)

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'connections','Connections','org_connections') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES
           ($1,$3,'person@cs.test','member'),
           ($2,$3,'admin@cs.test','org_admin')
         ON CONFLICT DO NOTHING`,
        [PERSON, ADMIN, ORG],
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

  it('T41 · a connected application cannot approve a connection, so it cannot widen its own ceiling', async () => {
    // The person connected an application read-only. The application holds a
    // token that is the person's, under a ceiling of `{read}`.
    const theirs = await register('a read-only search client')
    const readOnly = await connection(as(PERSON), theirs, ['read'])

    // It registers a client of its own — registration is open, which is what
    // RFC 7591 is for — and asks the consent endpoint, with its own token, for
    // a connection with no ceiling at all.
    const own = await register('the same application, again')
    const widened = await approve(readOnly, {
      client_id: own,
      redirect_uri: REDIRECT,
      code_challenge: challenge(),
    })
    expect(widened.status).toBe(404)

    // Nothing was stored for it, which is the property: a refusal that wrote
    // the row first would leave a connection waiting to be exchanged.
    const listed = await consents.list(as(PERSON))
    expect(listed.map((c) => c.clientId)).toEqual([theirs])

    // The control. The person, signed in, approves exactly that request and is
    // handed a code — so the refusal above is about who asked, not about the
    // request.
    const approved = await approve(await session(PERSON), {
      client_id: own,
      redirect_uri: REDIRECT,
      code_challenge: challenge(),
    })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as { redirect_to: string }).redirect_to).toContain('code=')
  })

  it('an administrative connection is approved only by an organization administrator, for a person, unnarrowed', async () => {
    const clientId = await register('an administrative client')
    const request = {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: challenge(),
      resource: 'https://mcp.connections.test/mcp/admin',
    }

    // A member gets the 404 every endpoint that role gates answers with.
    expect((await approve(await session(PERSON), request)).status).toBe(404)

    // An administrator gets a code, and the connection it names is the
    // administrative one, with the fixed ceiling.
    const approved = await approve(await session(ADMIN, 'org_admin'), request)
    expect(approved.status).toBe(200)
    const listed = await consents.list(as(ADMIN, 'org_admin'))
    const made = listed.find((c) => c.clientId === clientId)
    expect(made).toMatchObject({ surface: 'admin', permissions: ['read', 'admin'], layers: [] })

    // Never an agent, never narrowed, never a ceiling the caller chooses.
    expect((await approve(await session(ADMIN, 'org_admin'), { ...request, service_account_id: id(99) })).status).toBe(400)
    expect((await approve(await session(ADMIN, 'org_admin'), { ...request, permissions: ['read'] })).status).toBe(400)
    expect((await approve(await session(ADMIN, 'org_admin'), { ...request, layers: [id(98)] })).status).toBe(400)

    // And the same application connected the ordinary way is a second row,
    // not this one overwritten.
    const ordinary = await approve(await session(ADMIN, 'org_admin'), { ...request, resource: 'https://mcp.connections.test' })
    expect(ordinary.status).toBe(200)
    const both = (await consents.list(as(ADMIN, 'org_admin'))).filter((c) => c.clientId === clientId)
    expect(both.map((c) => c.surface).sort()).toEqual(['admin', 'default'])
  })
})
