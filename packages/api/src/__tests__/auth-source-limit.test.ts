import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi } from '../index.js'
import type { RateLimiter } from '../limits.js'
import type { Login } from '../login.js'
import type { PasswordRecovery } from '../recovery.js'

/**
 * Every route that takes a credential with no session spends from the
 * per-client bucket.
 *
 * Only sign-in and the second-factor step did. The WebAuthn sign-in and the
 * recovery link's redemption took any number of requests from one client, and
 * the redemption ran a full scrypt for each — which fills the gate every
 * sign-in shares and answers `503` to all of them. A limiter that refuses the
 * source bucket and nothing else, and every route here has to answer `429`
 * before the work behind it runs.
 */

const reached: string[] = []

const login = {
  login: async () => {
    reached.push('login')
    return undefined
  },
  completeSecondFactor: async () => {
    reached.push('second-factor')
    return undefined
  },
  beginSecondFactorWebAuthn: async () => {
    reached.push('webauthn')
    return undefined
  },
} as unknown as Login

const recovery = {
  request: async () => undefined,
  redeem: async () => {
    reached.push('redeem')
    return 'refused'
  },
} as unknown as PasswordRecovery

const limits = {
  check: async (_subject: string, resource: string) => ({
    allowed: resource !== 'login_source',
    limit: 1,
    remaining: 0,
    reset: 60,
    degraded: false,
  }),
} as unknown as RateLimiter

let server: Server
let base: string

describe('the per-client sign-in bucket', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: new TextEncoder().encode('a'.repeat(32)), issuer: 'https://api.nacre.test', audience: 'nacre' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
      login,
      recovery,
      limits,
      limitPolicies: {
        login: { limit: 10, windowSeconds: 900 },
        login_source: { limit: 60, windowSeconds: 900 },
      } as never,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const routes: readonly { path: string; body: unknown; work: string }[] = [
    { path: '/v1/auth/login', body: { email: 'a@b.test', password: 'a password long enough' }, work: 'login' },
    { path: '/v1/auth/second-factor', body: { challenge: 'c', code: '123456' }, work: 'second-factor' },
    { path: '/v1/auth/second-factor/webauthn', body: { challenge: 'c' }, work: 'webauthn' },
    {
      path: '/v1/auth/password-reset/confirm',
      body: { token: '11111111-1111-1111-1111-111111111111.x', password: 'a password long enough' },
      work: 'redeem',
    },
  ]

  for (const route of routes) {
    it(`refuses ${route.path} before the work behind it runs`, async () => {
      reached.length = 0
      const res = await fetch(`${base}${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(route.body),
      })
      expect(res.status).toBe(429)
      expect(reached).not.toContain(route.work)
    })
  }
})
