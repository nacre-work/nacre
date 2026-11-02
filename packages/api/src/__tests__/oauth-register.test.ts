import * as http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import { Redis } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { RateLimiter, type LimitPolicy } from '../limits.js'
import { createApi } from '../server.js'

/**
 * `POST /oauth/register` bounds `redirect_uris` before checking any of it.
 *
 * The check that follows is `uris.every(u => redirectAllowed(u, uris))`, one
 * O(n) membership scan per entry — O(n^2) in the length of a self-asserted,
 * unauthenticated list, with no bound of its own besides the generic request
 * body cap. This endpoint needs no database at all: the bound is refused
 * before `oauth.clients.register` is ever called, which is what lets this run
 * as a plain unit test rather than a live one.
 */

const SECRET = new TextEncoder().encode('r'.repeat(32))

let server: Server
let base: string
let registered: number

beforeAll(async () => {
  registered = 0
  server = createApi({
    verify: { key: SECRET, issuer: 'https://register.test', audience: 'register' },
    documents: { read: async () => undefined },
    search: { search: async () => [] },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: { write: async () => undefined },
    oauth: {
      issuer: 'https://register.test',
      consentUrl: 'https://register.test/#/consent',
      clients: {
        register: async (name: string, redirectUris: readonly string[], clientId: string) => {
          registered++
          return { clientId, clientName: name, redirectUris, source: 'registration' as const }
        },
        find: async () => undefined,
        cacheMetadata: async () => {
          throw new Error('not used')
        },
        touch: async () => undefined,
      },
      authorizations: { approve: async () => undefined, consume: async () => undefined } as never,
      consents: { record: async () => '00000000-0000-4000-8000-000000000000', list: async () => [], revoke: async () => false } as never,
      refreshTokens: { issue: async () => '', rotate: async () => undefined } as never,
      refreshTtlSeconds: 3600,
      accessTtlSeconds: 300,
      mint: async () => ({ accessToken: 'unused', expiresIn: 300 }),
    },
  } as unknown as Parameters<typeof createApi>[0])
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

const register = (redirect_uris: unknown) =>
  fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'probe', redirect_uris }),
  })

describe('POST /oauth/register bounds redirect_uris', () => {
  it('accepts a normal, small list', async () => {
    const res = await register(['https://app.example.com/cb'])
    expect(res.status).toBe(201)
    expect(registered).toBe(1)
  })

  it('refuses more than 20 entries without ever checking any of them', async () => {
    const many = Array.from({ length: 21 }, (_, i) => `https://app.example.com/cb/${String(i)}`)
    const before = registered
    const res = await register(many)
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_redirect_uri')
    expect(body.error_description).toMatch(/at most 20/i)
    // The expensive check, and the store write, never ran.
    expect(registered).toBe(before)
  })

  it('refuses a single entry over 512 characters', async () => {
    const long = `https://app.example.com/${'a'.repeat(500)}`
    expect(long.length).toBeGreaterThan(512)
    const res = await register([long])
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error_description: string }
    expect(body.error_description).toMatch(/512/)
  })

  it('accepts exactly the bound: 20 entries of 512 characters each', async () => {
    const uris = Array.from({ length: 20 }, (_, i) => {
      const prefix = `https://app.example.com/${String(i)}/`
      return prefix + 'a'.repeat(512 - prefix.length)
    })
    expect(uris.every((u) => u.length === 512)).toBe(true)
    const res = await register(uris)
    expect(res.status).toBe(201)
  })

  it('rejects a packed worst case fast, rather than validating it', async () => {
    // Representative of the finding's own reproduction: a list built to sit
    // near the body cap. Bounded by entry count first, so this returns
    // immediately rather than running an O(n^2) check over it.
    const many = Array.from({ length: 25_000 }, (_, i) => `https://a.example/${String(i)}`)
    const start = performance.now()
    const res = await register(many)
    const elapsed = performance.now() - start
    expect(res.status).toBe(400)
    expect(elapsed).toBeLessThan(200)
  })
})

/**
 * `admitClientRegistration`'s per-source budget — specifically the case
 * `clientSource` itself documents as "no source limit, never one shared
 * bucket": a transport with no socket address, which source.ts names as
 * happening "on some unix-socket and test transports". A Unix domain socket
 * is exactly that, and it is real rather than simulated: Node never sets
 * `req.socket.remoteAddress` for one.
 *
 * Before the fix, every such caller fell into `?? 'unknown'`, one shared
 * Redis bucket for all of them — the opposite of "no limit". After it, each
 * such request skips the source check entirely, so a count past the
 * configured limit never refuses one.
 */
const redisUrl = process.env.NACRE_REDIS_URL
if (!redisUrl && process.env.CI) {
  throw new Error('NACRE_REDIS_URL is not set and CI is; the unidentifiable-source case would go untested.')
}
const whenRedis = redisUrl ? describe : describe.skip

whenRedis('POST /oauth/register from a transport with no socket address', () => {
  const policies: Record<string, LimitPolicy> = {
    requests: { limit: 1000, windowSeconds: 60 },
    org_requests: { limit: 1000, windowSeconds: 60 },
    search: { limit: 1000, windowSeconds: 60 },
    ingest: { limit: 1000, windowSeconds: 3600 },
    login: { limit: 1000, windowSeconds: 900 },
    login_source: { limit: 1000, windowSeconds: 900 },
    // Low enough that a shared 'unknown' bucket would refuse well inside
    // this test's own request count.
    client_registration: { limit: 2, windowSeconds: 60 },
  }

  let redis: Redis
  let unixServer: Server
  let socketPath: string
  let registeredCount: number

  beforeAll(async () => {
    redis = new Redis({ url: redisUrl as string })
    socketPath = join(tmpdir(), `nacre-oauth-register-${randomBytes(6).toString('hex')}.sock`)
    registeredCount = 0
    unixServer = createApi({
      verify: { key: SECRET, issuer: 'https://register.test', audience: 'register' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
      limits: new RateLimiter({ redis, policies: policies as never }),
      limitPolicies: policies as never,
      // Unset, matching every shipped Compose default — clientSource would
      // read the socket address even if it were set, and a Unix socket has
      // none either way.
      oauth: {
        issuer: 'https://register.test',
        consentUrl: 'https://register.test/#/consent',
        clients: {
          register: async (name: string, redirectUris: readonly string[], clientId: string) => {
            registeredCount++
            return { clientId, clientName: name, redirectUris, source: 'registration' as const }
          },
          find: async () => undefined,
          cacheMetadata: async () => {
            throw new Error('not used')
          },
          touch: async () => undefined,
        },
        authorizations: { approve: async () => undefined, consume: async () => undefined } as never,
        consents: { record: async () => '00000000-0000-4000-8000-000000000000', list: async () => [], revoke: async () => false } as never,
        refreshTokens: { issue: async () => '', rotate: async () => undefined } as never,
        refreshTtlSeconds: 3600,
        accessTtlSeconds: 300,
        mint: async () => ({ accessToken: 'unused', expiresIn: 300 }),
      },
    } as unknown as Parameters<typeof createApi>[0])
    await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => unixServer?.close(() => resolve()))
    redis?.close()
  })

  const registerOverUnixSocket = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: '/oauth/register',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        },
        (res) => {
          res.on('data', () => undefined)
          res.on('end', () => resolve(res.statusCode as number))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ client_name: 'unix caller', redirect_uris: ['https://app.example.com/cb'] }))
    })

  it('is never rate-limited by source, however many times it registers', async () => {
    // One more than the configured limit: under the 'unknown'-bucket defect
    // this would answer 429 on at least the third call.
    const statuses: number[] = []
    for (let i = 0; i < policies.client_registration!.limit + 2; i++) {
      statuses.push(await registerOverUnixSocket())
    }
    expect(statuses.every((s) => s === 201)).toBe(true)
    expect(registeredCount).toBe(statuses.length)
  })
})
