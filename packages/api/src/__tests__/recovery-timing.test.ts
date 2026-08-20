import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi } from '../index.js'
import type { Login } from '../login.js'
import type { PasswordRecovery } from '../recovery.js'

/**
 * `POST /v1/auth/password-reset` answers before the recovery work runs.
 *
 * The body is `204` whatever happened — that half has always held. What had
 * not held was the *time* to it: a miss returns after one SELECT and a hit
 * does a full SMTP round trip, hundreds of milliseconds against a couple, so
 * a handler that awaited `request()` made the one endpoint reachable without
 * a credential a timing oracle for "does this address have an account". The
 * module's own header names exactly that property, and the sign-in path
 * spends `spendVerificationTime` on it; the recovery path's answer is not to
 * equalise an SMTP round trip but not to wait for it.
 *
 * The case is deterministic rather than a stopwatch: `request()` here never
 * resolves until the test lets it, so a handler that awaits it does not
 * answer at all — the race below names the defect instead of hanging the
 * suite — and one that answers first has the property whatever the relay's
 * latency is.
 */

const SECRET = new TextEncoder().encode('t'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

let server: Server
let base: string

let release: () => void = () => undefined
let requested = 0
const pending = new Promise<void>((resolve) => {
  release = resolve
})

const recovery = {
  request: async () => {
    requested += 1
    await pending
  },
  redeem: async () => 'invalid',
} as unknown as PasswordRecovery

// The auth routes mount only with a login port; none of its methods is reached.
const login = { login: async () => undefined } as unknown as Login

describe('password recovery timing', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
      login,
      recovery,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    release()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('answers 204 while the recovery work is still in flight', async () => {
    const answered = await Promise.race([
      fetch(`${base}/v1/auth/password-reset`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'somebody@example.test' }),
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('the 204 waited for request() — the response time carries whether the account exists')),
          5_000,
        ).unref(),
      ),
    ])
    expect(answered.status).toBe(204)
    // The work really started — the answer came first, it was not skipped.
    expect(requested).toBe(1)
  })
})
