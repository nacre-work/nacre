import { SignJWT } from 'jose'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi } from '../server.js'
import type { Login } from '../login.js'
import type { SecondFactors } from '../second-factor.js'

/**
 * The narrow door: what an **enrolment challenge** can reach, and what it cannot.
 *
 * A gate that answers `enrol` sends somebody here holding a token that is not a
 * session. It exists so that turning a policy on does not lock out everybody
 * who had not already enrolled — and the whole value of it is that it is
 * *narrow*, so this file is mostly about the routes it must refuse.
 *
 * Driven over real HTTP against the real server rather than by calling the
 * handler, because the claim is about routing: the door sits behind the same
 * `authenticate` that refuses this token as a credential, and only the instance
 * decides whether it is consulted at all. A test that called the function would
 * prove the function and say nothing about which requests reach it.
 */

const ORG = '5f2b7a0e-0000-4000-8000-00000000f00d'
const USER = '5f2b7a0e-0000-4000-8000-00000000beef'
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const SECRET = new TextEncoder().encode('e'.repeat(32))
// A real uuid, because the route checks the shape before it does anything —
// the first version of this file used `a-factor-id` and got a 400 that had
// nothing to do with the door.
const FACTOR = '5f2b7a0e-0000-4000-8000-0000000000fa'

let enrolled: string[] = []
let removed = 0

const factors = {
  get available() {
    return true
  },
  get kinds() {
    return ['totp', 'webauthn'] as const
  },
  begin: async () => ({ id: FACTOR, secret: 'ABCDEFGH', otpauthUrl: 'otpauth://totp/x' }),
  confirm: async () => ['code-one', 'code-two'],
  list: async () => [],
  recoveryCodesLeft: async () => 2,
  remove: async () => {
    removed += 1
    return true
  },
  beginWebAuthnRegistration: async () => ({
    challenge: 'a-registration-challenge',
    rp: { id: 'nacre.test', name: 'nacre.test' },
    user: { id: USER, name: 'gil@door.test', displayName: 'gil@door.test' },
    algorithms: [-7],
    excludeCredentials: [],
    timeoutMs: 300_000,
  }),
  finishWebAuthnRegistration: async () => ['code-one', 'code-two'],
  beginWebAuthnProof: async () => ({ challenge: 'x', rpId: 'nacre.test', allowCredentials: [], timeoutMs: 1 }),
  verify: async () => true,
  verifyWebAuthnAssertion: async () => true,
} as unknown as SecondFactors

const login = {
  // Only a token carrying this exact string is an enrolment challenge here, so
  // every other case below is asking the door about a credential it must not
  // accept — which is what makes those cases mean something.
  readEnrolmentChallenge: async (token: string) =>
    token === 'an-enrolment-challenge' ? { orgId: ORG, userId: USER } : undefined,
  sessionAfterEnrolment: async () => {
    enrolled.push('session')
    return {
      kind: 'tokens' as const,
      tokens: {
        accessToken: 'a-new-access-token',
        refreshToken: 'a-new-refresh-token',
        expiresIn: 900,
        orgId: ORG,
        userId: USER,
      },
    }
  },
} as unknown as Login

let server: Server
let base: string

const session = async (): Promise<string> =>
  `Bearer ${await new SignJWT({ org: ORG, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)}`

const asEnrolment = (path: string, method = 'POST', body: unknown = {}): Promise<Response> =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: 'Bearer an-enrolment-challenge', 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
  })

describe('the enrolment door', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
      login,
      secondFactors: factors,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    enrolled = []
    removed = 0
  })

  it('begins a TOTP enrolment', async () => {
    const res = await asEnrolment('/v1/me/second-factor')
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ secret: 'ABCDEFGH' })
  })

  it('begins a WebAuthn enrolment', async () => {
    const res = await asEnrolment('/v1/me/second-factor/webauthn')
    expect(res.status).toBe(201)
  })

  /*
   * Confirming is the end of a sign-in as well as the end of an enrolment.
   *
   * Without this the person who was just made to enrol would be handed their
   * recovery codes and a sign-in screen — at exactly the moment they would give
   * up, and having done everything the policy asked.
   */
  it('answers a confirmed factor with the recovery codes **and** a session', async () => {
    const res = await asEnrolment(`/v1/me/second-factor/${FACTOR}/confirm`, 'POST', { code: '123456' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.recovery_codes).toEqual(['code-one', 'code-two'])
    expect(body.access_token).toBe('a-new-access-token')
    expect(body.refresh_token).toBe('a-new-refresh-token')
    expect(enrolled).toEqual(['session'])
  })

  it('answers a finished WebAuthn enrolment the same way', async () => {
    const res = await asEnrolment('/v1/me/second-factor/webauthn/finish', 'POST', {
      challenge: 'a-registration-challenge',
      attestation_object: 'AAA',
      client_data_json: 'AAA',
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      recovery_codes: ['code-one', 'code-two'],
      access_token: 'a-new-access-token',
    })
  })

  /*
   * The refusals, and they are the point of the door being narrow.
   *
   * Removing a factor while under a mandate to add one is the move somebody who
   * has stolen a password would make, and listing them tells a caller who has
   * proved nothing what the account holds.
   */
  it('will not remove a factor', async () => {
    const res = await asEnrolment(`/v1/me/second-factor/${FACTOR}`, 'DELETE')
    expect(res.status).toBe(404)
    expect(removed).toBe(0)
  })

  it('will not list what the account holds', async () => {
    expect((await asEnrolment('/v1/me/second-factor', 'GET')).status).toBe(404)
  })

  it('will not begin the assertion that belongs to the other ceremony', async () => {
    expect((await asEnrolment('/v1/me/second-factor/webauthn/assert')).status).toBe(404)
  })

  /*
   * And the door is keyed on the instance, so nothing else in the API is
   * reachable with one of these. `401` rather than `404` is the shape that
   * matters: the token never authenticated at all, which is the fail-closed
   * property the whole design rests on.
   */
  it('reaches nothing else in the API, and fails closed when it tries', async () => {
    for (const [path, method] of [
      ['/v1/layers', 'GET'],
      ['/v1/search', 'POST'],
      ['/v1/me', 'GET'],
      ['/v1/users', 'GET'],
      ['/v1/audit', 'GET'],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: 'Bearer an-enrolment-challenge', 'content-type': 'application/json' },
        ...(method === 'GET' ? {} : { body: '{}' }),
      })
      expect([path, res.status]).toEqual([path, 401])
    }
  })

  it('leaves the wide door alone: a session still reaches the whole surface', async () => {
    const res = await fetch(`${base}/v1/me/second-factor`, {
      method: 'GET',
      headers: { authorization: await session() },
    })
    expect(res.status).toBe(200)

    const gone = await fetch(`${base}/v1/me/second-factor/${FACTOR}`, {
      method: 'DELETE',
      headers: { authorization: await session(), 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456' }),
    })
    expect(gone.status).toBe(204)
    expect(removed).toBe(1)
  })
})
