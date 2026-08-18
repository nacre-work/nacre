import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { TooBusy } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type Users } from '../index.js'
import type { Login } from '../login.js'
import type { PasswordRecovery } from '../recovery.js'

/**
 * A full password gate answers `503` on **every** route that hashes.
 *
 * `core/passwords.ts` bounds how many scrypt calls run at once — the pool is
 * libuv's and is shared with DNS, so an unbounded one stops the rest of the API
 * on a name lookup — and its own header says "the caller answers 503, which is
 * the honest response to 'this process cannot verify a password right now'".
 *
 * That claim was true of sign-in, which caught `TooBusy` beside the call, and
 * false of the three other routes that hash: each turned load into a `500`,
 * which a client reports as a broken server and an operator investigates as a
 * bug. A rule stated in a comment and held in one of four places is the shape
 * this repository keeps closing with a check.
 *
 * The five are driven here rather than the translation being unit-tested,
 * because what was wrong was never the translation — it was which routes
 * reached one. Storage raises `TooBusy` the way the gate does; nothing here
 * hashes, since how the gate fills is `passwords.ts`'s business and is bounded
 * by a queue sixty-four deep.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = 'cccccccc-0000-4000-8000-000000000001'

const busy = (): never => {
  throw new TooBusy()
}

const audited: AuditEvent[] = []

/** Every write hashes: `create` generates a password, `resetPassword` sets one. */
const users: Users = {
  list: async () => ({ nextCursor: null, items: [] }),
  create: async () => busy(),
  update: async () => 'updated',
  // A stub with no shared accounts, which is what an installation that has
  // never minted one has.
  isShared: async () => false,
  resetPassword: async () => busy(),
}

const login = { login: async () => busy(), changePassword: async () => busy() } as unknown as Login
const recovery = { request: async () => undefined, redeem: async () => busy() } as unknown as PasswordRecovery

let server: Server
let base: string

const admin = async (): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await new SignJWT({ org: ORG, principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)}`,
  'content-type': 'application/json',
})

describe('a full password gate', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
      users,
      login,
      recovery,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const cases: { name: string; path: string; body: unknown; headers?: () => Promise<Record<string, string>> }[] = [
    {
      name: 'signing in',
      path: '/v1/auth/login',
      body: { email: 'dana@example.test', password: 'a-password-that-is-long-enough' },
    },
    {
      name: 'creating a user',
      path: '/v1/users',
      body: { email: 'new@example.test', role: 'member' },
      headers: admin,
    },
    {
      name: 'an administrator resetting a password',
      path: `/v1/users/${USER}/password`,
      body: {},
      headers: admin,
    },
    {
      name: 'redeeming a recovery link',
      path: '/v1/auth/password-reset/confirm',
      body: { token: `${ORG}.not-a-real-secret`, password: 'a-password-that-is-long-enough' },
    },
    {
      // The fifth, added after this check was. That is the point of the table:
      // a route that hashes lands in one of the two boundaries by construction,
      // and gets a line here rather than a translation of its own.
      name: 'changing your own password',
      path: '/v1/me/password',
      body: {
        current_password: 'whatever it is',
        new_password: 'a-password-that-is-long-enough',
      },
      headers: admin,
    },
  ]

  for (const c of cases) {
    it(`answers 503 with Retry-After: ${c.name}`, async () => {
      audited.length = 0
      const headers = c.headers === undefined ? { 'content-type': 'application/json' } : await c.headers()
      const res = await fetch(`${base}${c.path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(c.body),
      })

      // 503 and never 401: nothing was decided about the credential, and
      // answering "not valid" to a request that was never checked is a lie the
      // client acts on.
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('2')

      const problem = (await res.json()) as { title: string; detail: string }
      expect(problem.title).toBe('Service unavailable')
      // One wording for all four. The reason to have moved it is that there is
      // now one place to change it.
      expect(problem.detail).toMatch(/verified at once/)

      // Shedding load is the design working, so it is not a failure in the
      // journal. An `error` row is read as a defect and would send somebody
      // looking for one.
      expect(audited.filter((e) => e.result === 'error')).toHaveLength(0)
    })
  }
})
