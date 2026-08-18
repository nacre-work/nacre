import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent } from '../index.js'
import type { ChangePasswordOutcome, Login } from '../login.js'
import type { Message } from '@nacre.work/core'

/**
 * `POST /v1/me/password` — a person changing their own password.
 *
 * What is under test is what this layer decides: who may reach it at all, the
 * status each refusal wears, that the pair replacing the ended sessions comes
 * back in the body, and that both outcomes reach the journal. Whether Postgres
 * revokes the right rows is `password-change-live.test.ts`, against a real one.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = 'cccccccc-0000-4000-8000-000000000001'
const DELEGATION = 'dddddddd-0000-4000-8000-000000000001'

const LONG = 'a properly long password'

const audited: AuditEvent[] = []
const sent: Message[] = []

let asked: { current: string; next: string } | undefined

const login = {
  changePassword: async (
    _org: string,
    _user: string,
    current: string,
    next: string,
  ): Promise<ChangePasswordOutcome> => {
    asked = { current, next }
    if (current !== 'the right one') return 'wrong-password'
    return {
      kind: 'changed',
      email: 'dana@example.test',
      tokens: {
        accessToken: 'a-fresh-access-token',
        refreshToken: 'a-fresh-refresh-token',
        expiresIn: 900,
        orgId: ORG,
        userId: USER,
      },
    }
  },
} as unknown as Login

let server: Server
let base: string

const token = async (claims: Record<string, unknown>, sub: string): Promise<string> =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

const headersFor = async (claims: Record<string, unknown>, sub = USER): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await token({ org: ORG, ...claims }, sub)}`,
  'content-type': 'application/json',
})

const person = () => headersFor({ principal_type: 'user', role: 'member' })

const change = async (
  body: unknown,
  headers?: Record<string, string>,
): Promise<Response> =>
  fetch(`${base}/v1/me/password`, {
    method: 'POST',
    headers: headers ?? (await person()),
    body: JSON.stringify(body),
  })

const last = (): AuditEvent | undefined => audited[audited.length - 1]

describe('changing your own password', () => {
  beforeAll(async () => {
    server = createApi({
      verify: {
        key: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        // A delegated token needs something able to resolve one, or it is
        // refused as forged before it reaches any route.
        delegations: {
          resolve: async () => ({ userId: USER, role: 'member' }),
        },
      },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
      mailer: {
        send: async (message) => {
          sent.push(message)
        },
      },
      login,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    audited.length = 0
    sent.length = 0
    asked = undefined
  })

  it('changes it and hands back the pair that replaces every ended session', async () => {
    const res = await change({ current_password: 'the right one', new_password: LONG })
    expect(res.status).toBe(200)

    const body = (await res.json()) as Record<string, string>
    expect(body.access_token).toBe('a-fresh-access-token')
    expect(body.refresh_token).toBe('a-fresh-refresh-token')
    expect(body.token_type).toBe('Bearer')

    // Never the password, in either direction.
    expect(JSON.stringify(body)).not.toContain(LONG)

    expect(last()).toMatchObject({ action: 'password.change', result: 'allow' })

    // The person who did not do this is the one who needs to know.
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe('dana@example.test')
    expect(sent[0]?.text).not.toContain(LONG)
  })

  it('refuses a wrong current password with 403, and journals the refusal', async () => {
    const res = await change({ current_password: 'not it', new_password: LONG })

    /*
     * Not 401. On an authenticated route that means "your session is over", and
     * every client here renews on it and replays — so a wrong password would
     * spend a refresh token and reach the person as two failures. Not 404
     * either: they are looking straight at their own account.
     */
    expect(res.status).toBe(403)
    expect(((await res.json()) as { detail: string }).detail).toMatch(/current password/u)
    expect(last()).toMatchObject({ action: 'password.change', result: 'deny' })
    expect(sent).toHaveLength(0)
  })

  it('refuses a new password below the minimum without asking the store', async () => {
    const res = await change({ current_password: 'the right one', new_password: 'short' })
    expect(res.status).toBe(400)
    // The one thing this endpoint explains, because it is about what was sent.
    expect(((await res.json()) as { detail: string }).detail).toMatch(/at least 12/u)
    // And it costs nothing: a length rule is not a reason to hash anything.
    expect(asked).toBeUndefined()
  })

  it('refuses a missing field', async () => {
    expect((await change({ new_password: LONG })).status).toBe(400)
    expect((await change({ current_password: 'the right one' })).status).toBe(400)
  })

  it('is not there for a service account', async () => {
    // A key has no password and is rotated by minting another, so this is 404
    // and not 403 — the route does not exist for this principal at all.
    const res = await change(
      { current_password: 'the right one', new_password: LONG },
      await headersFor({ principal_type: 'service_account', role: 'member' }, 'a-key'),
    )
    expect(res.status).toBe(404)
    expect(asked).toBeUndefined()
  })

  it('is not there for a delegation', async () => {
    // A third party acting for somebody was not approved to change how that
    // somebody signs in. Asserted separately from the service account, because
    // the guard is two conditions and a case that only ever exercises one of
    // them is a case that cannot fail on the other.
    const res = await change(
      { current_password: 'the right one', new_password: LONG },
      await headersFor({ principal_type: 'user', role: 'member', del: DELEGATION }),
    )
    expect(res.status).toBe(404)
    expect(asked).toBeUndefined()
  })

  it('is not there for another method', async () => {
    const res = await fetch(`${base}/v1/me/password`, { method: 'GET', headers: await person() })
    expect(res.status).toBe(404)
  })
})
