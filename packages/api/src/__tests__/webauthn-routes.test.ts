import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent } from '../index.js'
import type { Login, SecondFactorProof } from '../login.js'
import type { SecondFactors } from '../second-factor.js'

/**
 * The HTTP surface a WebAuthn ceremony needs, and only that.
 *
 * Whether a signature verifies is `packages/core/__tests__/webauthn.test.ts`,
 * on genuine bytes; whether a challenge can be spent twice is
 * `webauthn-live.test.ts`, against a real PostgreSQL. What is left is what this
 * layer decides, and every one of them is a way to ship a feature that is
 * unreachable rather than wrong:
 *
 * - the routes exist at all, which is what the store had no way to say;
 * - the wire shape is snake_case and base64url, so a browser's own values go
 *   back out unchanged;
 * - a body carrying **both** proofs is refused rather than resolved by
 *   precedence;
 * - removal accepts an assertion, or a WebAuthn-only account can never take a
 *   factor off;
 * - the two "what does this installation offer" answers say so.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = 'cccccccc-0000-4000-8000-000000000001'
const FACTOR = 'ffffffff-0000-4000-8000-000000000001'

const audited: AuditEvent[] = []

/** What a browser would send, in the encoding a browser reports. */
const ASSERTION = {
  credential_id: 'Y3JlZC1pZA',
  authenticator_data: 'YXV0aC1kYXRh',
  client_data_json: 'Y2xpZW50LWRhdGE',
  signature: 'c2ln',
  challenge: 'a-ceremony-challenge',
}

let sawAssertion: { credentialId: string; challenge: string; signature: string } | undefined
let sawProof: SecondFactorProof | undefined
let verifyReturns = true

const factors = {
  available: true,
  kinds: ['webauthn'] as const,
  list: async () => [],
  recoveryCodesLeft: async () => 7,
  begin: async () => undefined,
  verify: async () => false,
  remove: async () => true,
  beginWebAuthnRegistration: async () => ({
    challenge: 'a-registration-challenge',
    rp: { id: 'nacre.test', name: 'Nacre' },
    user: { id: USER, name: 'dana@nacre.test', displayName: 'dana@nacre.test' },
    algorithms: [-7, -257, -8],
    excludeCredentials: ['Y3JlZC1pZA'],
    timeoutMs: 300_000,
  }),
  finishWebAuthnRegistration: async (
    _org: string,
    _user: string,
    label: string,
  ): Promise<readonly string[] | undefined> => (label === 'refuse me' ? undefined : ['one-code', 'two-code']),
  beginWebAuthnAssertion: async () => ({
    challenge: 'a-ceremony-challenge',
    rpId: 'nacre.test',
    allowCredentials: ['Y3JlZC1pZA'],
    timeoutMs: 300_000,
  }),
  verifyWebAuthnAssertion: async (
    _org: string,
    _user: string,
    response: { credentialId: string; challenge: string; signature: Uint8Array },
  ): Promise<boolean> => {
    sawAssertion = {
      credentialId: response.credentialId,
      challenge: response.challenge,
      signature: Buffer.from(response.signature).toString('base64url'),
    }
    return verifyReturns
  },
} as unknown as SecondFactors

const login = {
  beginSecondFactorWebAuthn: async (challenge: string) =>
    challenge === 'a-good-sign-in-challenge'
      ? { challenge: 'a-ceremony-challenge', rpId: 'nacre.test', allowCredentials: ['Y3JlZC1pZA'], timeoutMs: 300_000 }
      : undefined,
  completeSecondFactor: async (challenge: string, proof: SecondFactorProof) => {
    sawProof = proof
    if (challenge !== 'a-good-sign-in-challenge') return undefined
    return {
      kind: 'tokens',
      tokens: {
        accessToken: 'an-access-token',
        refreshToken: 'a-refresh-token',
        expiresIn: 900,
        orgId: ORG,
        userId: USER,
      },
    }
  },
  // The enrolment door asks this of every credential the API refused, so a stub
  // that omitted it would make an ordinary 401 on this path a 500.
  readEnrolmentChallenge: async () => undefined,
} as unknown as Login

let server: Server
let base: string

const headers = async (extra: Record<string, unknown> = {}): Promise<Record<string, string>> => ({
  authorization: `Bearer ${await new SignJWT({ org: ORG, principal_type: 'user', role: 'member', ...extra })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)}`,
  'content-type': 'application/json',
})

const post = async (path: string, body: unknown, h?: Record<string, string>): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'POST', headers: h ?? (await headers()), body: JSON.stringify(body) })

describe('the WebAuthn surface', () => {
  beforeAll(async () => {
    server = createApi({
      verify: {
        key: SECRET,
        issuer: ISSUER,
        audience: AUDIENCE,
        delegations: { resolve: async () => ({ userId: USER, role: 'member' }) },
      },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
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
    audited.length = 0
    sawAssertion = undefined
    sawProof = undefined
    verifyReturns = true
  })

  it('hands out registration options a browser can use', async () => {
    const res = await post('/v1/me/second-factor/webauthn', {})
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    // Every key snake_case, and `algorithms` the COSE identifiers rather than
    // names — this object is copied into `publicKey` by the page almost
    // verbatim, so a camelCase field here is one the browser ignores.
    expect(Object.keys(body).sort()).toEqual([
      'algorithms',
      'challenge',
      'exclude_credentials',
      'rp',
      'timeout_ms',
      'user',
    ])
    expect(body.algorithms).toEqual([-7, -257, -8])
    expect((body.user as Record<string, unknown>).display_name).toBe('dana@nacre.test')
  })

  it('finishes an enrolment and prints the recovery codes once', async () => {
    const res = await post('/v1/me/second-factor/webauthn/finish', {
      label: 'A yubikey',
      challenge: 'a-registration-challenge',
      attestation_object: 'YXR0',
      client_data_json: 'Y2xpZW50',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ recovery_codes: ['one-code', 'two-code'] })
    expect(audited.at(-1)?.action).toBe('second_factor.enrol')
    expect(audited.at(-1)?.detail).toEqual({ kind: 'webauthn' })
  })

  it('refuses an enrolment missing a field, and one the verifier rejects', async () => {
    const short = await post('/v1/me/second-factor/webauthn/finish', {
      challenge: 'a-registration-challenge',
      attestation_object: 'YXR0',
    })
    expect(short.status).toBe(400)

    // A signature that does not verify and a challenge already spent are the
    // same 404, which is invariant 4 applied to a ceremony.
    const refused = await post('/v1/me/second-factor/webauthn/finish', {
      label: 'refuse me',
      challenge: 'a-registration-challenge',
      attestation_object: 'YXR0',
      client_data_json: 'Y2xpZW50',
    })
    expect(refused.status).toBe(404)
  })

  it('removes a factor on an assertion, which is the only proof a key-only account has', async () => {
    const res = await fetch(`${base}/v1/me/second-factor/${FACTOR}`, {
      method: 'DELETE',
      headers: await headers(),
      body: JSON.stringify({ assertion: ASSERTION }),
    })
    expect(res.status).toBe(204)
    // The bytes arrived decoded and the credential id did not: it is compared
    // against a column holding the string a browser reported.
    expect(sawAssertion).toEqual({
      credentialId: 'Y3JlZC1pZA',
      challenge: 'a-ceremony-challenge',
      signature: 'c2ln',
    })
    expect(audited.at(-1)?.action).toBe('second_factor.remove')
  })

  it('refuses a removal carrying both proofs, and one carrying neither', async () => {
    for (const body of [{ code: '123456', assertion: ASSERTION }, {}]) {
      const res = await fetch(`${base}/v1/me/second-factor/${FACTOR}`, {
        method: 'DELETE',
        headers: await headers(),
        body: JSON.stringify(body),
      })
      // 400 rather than a precedence. A caller sending both has two ideas of
      // how it is proving possession, and picking one leaves the other
      // apparently offered and ignored.
      expect(res.status).toBe(400)
    }
  })

  it('refuses a removal whose assertion does not verify', async () => {
    verifyReturns = false
    const res = await fetch(`${base}/v1/me/second-factor/${FACTOR}`, {
      method: 'DELETE',
      headers: await headers(),
      body: JSON.stringify({ assertion: ASSERTION }),
    })
    expect(res.status).toBe(404)
  })

  it('hands a signing-in browser its assertion options, and refuses a challenge that is not ours', async () => {
    const good = await post('/v1/auth/second-factor/webauthn', { challenge: 'a-good-sign-in-challenge' }, {
      'content-type': 'application/json',
    })
    expect(good.status).toBe(200)
    expect(await good.json()).toEqual({
      challenge: 'a-ceremony-challenge',
      rp_id: 'nacre.test',
      allow_credentials: ['Y3JlZC1pZA'],
      timeout_ms: 300_000,
    })

    const bad = await post('/v1/auth/second-factor/webauthn', { challenge: 'forged' }, {
      'content-type': 'application/json',
    })
    expect(bad.status).toBe(401)
  })

  it('signs in on an assertion, and the journal says which kind', async () => {
    const res = await post(
      '/v1/auth/second-factor',
      { challenge: 'a-good-sign-in-challenge', assertion: ASSERTION },
      { 'content-type': 'application/json' },
    )
    expect(res.status).toBe(200)
    expect(sawProof?.kind).toBe('webauthn')
    expect(audited.at(-1)?.detail).toEqual({ second_factor: true, second_factor_kind: 'webauthn' })
  })

  it('says which kinds it offers, on both surfaces that are asked', async () => {
    const methods = await fetch(`${base}/v1/auth/methods`)
    expect(((await methods.json()) as Record<string, unknown>).second_factor_kinds).toEqual(['webauthn'])

    const mine = await fetch(`${base}/v1/me/second-factor`, { headers: await headers() })
    expect(((await mine.json()) as Record<string, unknown>).kinds).toEqual(['webauthn'])
  })

  it('is not reachable by a delegation', async () => {
    const delegated = await headers({ principal_type: 'user', del: FACTOR })
    const res = await post('/v1/me/second-factor/webauthn', {}, delegated)
    // A third party acting for somebody must not be able to change how that
    // somebody signs in, and the whole block is behind one check rather than
    // each route remembering.
    expect(res.status).toBe(404)
  })
})
