import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, createSecretKey, randomBytes } from 'node:crypto'

import { createPool, Redis } from '@nacre.work/core'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { GuardedFetch } from '../client-metadata.js'
import { RateLimiter, type LimitPolicy } from '../limits.js'
import {
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
} from '../oauth-store.js'
import { createApi } from '../server.js'

/**
 * Who may register, who may arrive by metadata document, and how much any one
 * caller may ask of the API — over a real socket, against a real PostgreSQL and
 * a real Redis.
 *
 * Real ones because each property here is a statement and a counter: the
 * metadata cache is an upsert whose conflict arm must never touch a
 * registration, the client sweep depends on `last_seen_at` being written by the
 * request that reaches a consent screen, and a limit is `INCR` under
 * concurrency. A stub of any of them would agree with what it was written to
 * believe about the others.
 *
 * The one thing stood in for is the network: the guarded fetch is the
 * egress guard's signature, and the guard is held by its own suite against
 * real sockets. What is under test is what the server does with what it is
 * handed.
 */

const pgUrl = process.env.NACRE_PG_URL
const redisUrl = process.env.NACRE_REDIS_URL
if ((!pgUrl || !redisUrl) && process.env.CI) {
  throw new Error('NACRE_PG_URL and NACRE_REDIS_URL are both needed in CI; client registration limits would go untested.')
}
const when = pgUrl && redisUrl ? describe : describe.skip

const AS_APP = 'nacre_app'
const KEY = createSecretKey(Buffer.from('m'.repeat(48)))
const ISSUER = 'https://clients.test'
const AUDIENCE = 'clients'
const ORG = '0a555555-5555-4555-8555-555555555501'
const PERSON = '0a555555-5555-4555-8555-5555555555a1'

/** Each run its own keys in Redis: a window outlives the run that opened it. */
const RUN = randomBytes(4).toString('hex')
/** The organization the limit cases' tokens name — its own per run, for the same reason. */
const LIMITED_ORG = `0a666666-6666-4666-8666-${randomBytes(6).toString('hex')}`

const DOCUMENT_ID = `https://agent-${RUN}.example/oauth/client.json`

const policies: Record<string, LimitPolicy> = {
  requests: { limit: 3, windowSeconds: 60 },
  search: { limit: 1, windowSeconds: 60 },
  ingest: { limit: 100, windowSeconds: 3600 },
  login: { limit: 100, windowSeconds: 900 },
  login_source: { limit: 100, windowSeconds: 900 },
  client_registration: { limit: 3, windowSeconds: 3600 },
}

let pool: Pool
let redis: Redis
let server: Server
let base: string
let clients: PostgresOAuthClients
let consents: PostgresOAuthConsents
let audited: { action: string; actor: string }[] = []

/** What the stand-in fetch answers next, and how many times it was asked. */
let served: { body: unknown; status?: number; cacheControl?: string } | Error
let fetches = 0
const fetchDocument: GuardedFetch = async (input) => {
  fetches++
  if (served instanceof Error) throw served
  expect(input).toBe(DOCUMENT_ID)
  return new Response(JSON.stringify(served.body), {
    status: served.status ?? 200,
    headers: { 'content-type': 'application/json', ...(served.cacheControl ? { 'cache-control': served.cacheControl } : {}) },
  })
}

const metadataDocument = (redirects: string[] = ['http://127.0.0.1/callback']) => ({
  client_id: DOCUMENT_ID,
  client_name: 'A desktop agent',
  redirect_uris: redirects,
  token_endpoint_auth_method: 'none',
})

const session = async (userId: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ org: LIMITED_ORG, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

const authorize = (clientId: string, redirectUri: string): Promise<Response> =>
  fetch(
    `${base}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(randomBytes(16)).digest('base64url'),
      code_challenge_method: 'S256',
      state: 's',
    }).toString()}`,
    { redirect: 'manual', headers: { 'x-forwarded-for': `198.51.100.${String(Math.floor(Math.random() * 200))}` } },
  )

const register = (from: string): Promise<Response> =>
  fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ client_name: 'probe', redirect_uris: ['http://127.0.0.1:4000/cb'] }),
  })

async function row(clientId: string) {
  const { rows } = await pool.query<{ source: string; last_seen_at: Date | null; refresh_after: Date | null; client_name: string }>(
    'SELECT source, last_seen_at, refresh_after, client_name FROM oauth_clients WHERE client_id = $1',
    [clientId],
  )
  return rows[0]
}

when('client registration, metadata documents and per-caller limits', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: pgUrl as string })
    redis = new Redis({ url: redisUrl as string })
    clients = new PostgresOAuthClients(pool, AS_APP)
    consents = new PostgresOAuthConsents(pool, AS_APP)
    await pool.query(
      `INSERT INTO organizations (id, slug, name, vector_collection)
       VALUES ($1, 'clientslive', 'clientslive', 'org_clientslive') ON CONFLICT DO NOTHING`,
      [ORG],
    )
    await pool.query(
      `INSERT INTO users (id, org_id, email, role) VALUES ($1, $2, 'person@clientslive.test', 'member')
       ON CONFLICT DO NOTHING`,
      [PERSON, ORG],
    )

    server = createApi({
      verify: { key: KEY, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event: { action: string; actor: string }) => {
          audited.push({ action: event.action, actor: event.actor })
        },
      },
      limits: new RateLimiter({ redis, policies: policies as never }),
      limitPolicies: policies as never,
      // One proxy hop, so each case can be its own client by X-Forwarded-For.
      trustProxy: 1,
      oauth: {
        issuer: ISSUER,
        consentUrl: `${ISSUER}/#/consent`,
        clients,
        authorizations: new PostgresOAuthAuthorizations(pool, AS_APP),
        consents,
        refreshTokens: new PostgresOAuthRefreshTokens(pool, AS_APP),
        metadataDocuments: { trustedOrigins: [], fetch: fetchDocument },
        refreshTtlSeconds: 3600,
        accessTtlSeconds: 300,
        mint: async () => ({ accessToken: 'unused', expiresIn: 300 }),
      },
    } as never)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    if (pool !== undefined) {
      await pool.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
      await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [DOCUMENT_ID])
      await pool.end()
    }
    redis?.close()
  })

  beforeEach(() => {
    audited = []
    fetches = 0
    served = { body: metadataDocument() }
  })

  describe('POST /oauth/register', () => {
    it('is limited per client address, with the wait in the answer', async () => {
      const from = `203.0.113.${String(Math.floor(Math.random() * 250))}`
      for (let i = 0; i < 3; i++) expect((await register(from)).status).toBe(201)

      const refused = await register(from)
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      const body = (await refused.json()) as { error: string; error_description: string }
      // RFC 6749's shape, which is what a registering client reads, and not a
      // problem document it would not.
      expect(body.error).toBe('temporarily_unavailable')
      expect(body.error_description).toMatch(/Too many client registrations from this address/)

      // Another address is untouched: the limit is on a source, not on the
      // endpoint, so one noisy caller does not close registration for everyone.
      expect((await register(`192.0.2.${String(Math.floor(Math.random() * 250))}`)).status).toBe(201)
    })
  })

  describe('a client identified by its metadata document', () => {
    it('is fetched once, cached, and sent to the consent screen', async () => {
      served = { body: metadataDocument(), cacheControl: 'max-age=600' }
      const first = await authorize(DOCUMENT_ID, 'http://127.0.0.1:51234/callback')
      expect(first.status).toBe(302)
      expect(first.headers.get('location')).toContain('#/consent?')
      expect(fetches).toBe(1)

      const cached = await row(DOCUMENT_ID)
      expect(cached?.source).toBe('metadata')
      expect(cached?.client_name).toBe('A desktop agent')
      // max-age=600 is inside the bounds, so it is trusted for ten minutes.
      const ttl = (cached!.refresh_after!.getTime() - Date.now()) / 1000
      expect(ttl).toBeGreaterThan(550)
      expect(ttl).toBeLessThanOrEqual(600)

      // A second authorization — another port, as a native client picks one —
      // is answered from the cache.
      const second = await authorize(DOCUMENT_ID, 'http://127.0.0.1:40000/callback')
      expect(second.status).toBe(302)
      expect(fetches).toBe(1)
    })

    it('refuses a redirect the document does not list, before any consent', async () => {
      const refused = await authorize(DOCUMENT_ID, 'http://127.0.0.1:51234/elsewhere')
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error: string }).error).toBe('invalid_redirect_uri')
    })

    it('refetches a stale document, and refuses rather than serving the old one when that fails', async () => {
      await pool.query(`UPDATE oauth_clients SET refresh_after = now() - interval '1 second' WHERE client_id = $1`, [
        DOCUMENT_ID,
      ])
      // The client dropped its loopback redirect. Serving the stale copy would
      // keep delivering codes to the place it stopped listing.
      served = new Error('unreachable')
      const refused = await authorize(DOCUMENT_ID, 'http://127.0.0.1:51234/callback')
      expect(refused.status).toBe(400)
      expect(await refused.json()).toEqual({
        error: 'invalid_client',
        error_description: 'the client metadata document could not be fetched: it could not be reached.',
      })

      served = { body: metadataDocument(['https://agent.example/cb']) }
      const after = await authorize(DOCUMENT_ID, 'http://127.0.0.1:51234/callback')
      expect(after.status).toBe(400)
      expect(((await after.json()) as { error: string }).error).toBe('invalid_redirect_uri')
      expect((await row(DOCUMENT_ID))?.source).toBe('metadata')
    })

    it('says why a document was refused', async () => {
      await pool.query(`UPDATE oauth_clients SET refresh_after = now() - interval '1 second' WHERE client_id = $1`, [
        DOCUMENT_ID,
      ])
      served = { body: { ...metadataDocument(), client_id: 'https://someone-else.example/client.json' } }
      const refused = await authorize(DOCUMENT_ID, 'http://127.0.0.1:51234/callback')
      expect(refused.status).toBe(400)
      expect(((await refused.json()) as { error_description: string }).error_description).toMatch(
        /names a different client_id/,
      )
    })

    it('can never overwrite a registration', async () => {
      // The upsert's conflict arm is conditioned on the row being a metadata
      // client. Nothing mints a URL as a registered id, so this state is built
      // by hand — and the store refuses it rather than turning the row over.
      const id = `https://registered-${RUN}.example/client.json`
      await clients.register('registered', ['https://registered.example/cb'], id)
      await expect(clients.cacheMetadata(id, 'impostor', ['https://evil.example/cb'], 600)).rejects.toThrow()
      expect((await row(id))?.client_name).toBe('registered')
      await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [id])
    })
  })

  describe('last_seen_at', () => {
    it('is written by an authorization that could reach a consent screen, and only by one', async () => {
      const created = (await (await register(`198.18.0.${String(Math.floor(Math.random() * 250))}`)).json()) as {
        client_id: string
      }
      expect((await row(created.client_id))?.last_seen_at).toBeNull()

      // A redirect the client never registered keeps nothing alive.
      expect((await authorize(created.client_id, 'http://127.0.0.1:9/nope')).status).toBe(400)
      expect((await row(created.client_id))?.last_seen_at).toBeNull()

      expect((await authorize(created.client_id, 'http://127.0.0.1:4000/cb')).status).toBe(302)
      expect((await row(created.client_id))?.last_seen_at).toBeInstanceOf(Date)
      await pool.query('DELETE FROM oauth_clients WHERE client_id = $1', [created.client_id])
    })
  })

  describe("a caller's general budget", () => {
    const call = async (token: string, method = 'GET', path = '/v1/nowhere'): Promise<Response> =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ query: 'x' }) } : {}),
      })

    it('counts every request against the principal, and names the account in the refusal', async () => {
      const me = `0a555555-5555-4555-8555-${randomBytes(6).toString('hex')}`
      const token = await session(me)
      for (let i = 0; i < 3; i++) expect((await call(token)).status).not.toBe(429)

      const refused = await call(token)
      expect(refused.status).toBe(429)
      expect(refused.headers.get('ratelimit-policy')).toBe('requests;q=3;w=60')
      const problem = (await refused.json()) as { detail: string }
      expect(problem.detail).toMatch(/^This account has used its 3 requests per 60 seconds\. Try again in \d+ seconds\.$/)

      // Somebody else in the same organization is not the noisy caller.
      expect((await call(await session(`0a555555-5555-4555-8555-${randomBytes(6).toString('hex')}`))).status).not.toBe(429)
    })

    it('records a refusal in the access log once per window, not once per refusal', async () => {
      const me = `0a555555-5555-4555-8555-${randomBytes(6).toString('hex')}`
      const token = await session(me)
      for (let i = 0; i < 3; i++) await call(token)
      for (let i = 0; i < 5; i++) expect((await call(token)).status).toBe(429)
      expect(audited.filter((e) => e.action === 'rate_limited' && e.actor === `user:${me}`)).toHaveLength(1)
    })

    it('gives the general request back when the operation limit refuses', async () => {
      // search is 1 a minute here, requests 3. Without the give-back the
      // refused search would spend a request, and the fourth call below would
      // be the general limit's refusal.
      const me = `0a555555-5555-4555-8555-${randomBytes(6).toString('hex')}`
      const token = await session(me)
      expect((await call(token, 'POST', '/v1/search')).status).not.toBe(429)
      const search = await call(token, 'POST', '/v1/search')
      expect(search.status).toBe(429)
      expect(((await search.json()) as { detail: string }).detail).toMatch(/search limit for this organization/)
      expect((await call(token)).status).not.toBe(429)
      expect((await call(token)).status).not.toBe(429)
      expect((await call(token)).status).toBe(429)
    })
  })
})
