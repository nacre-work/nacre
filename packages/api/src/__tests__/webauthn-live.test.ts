import { createPool, hashPassword } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SecondFactors } from '../second-factor.js'

/**
 * A WebAuthn second factor, against a real PostgreSQL.
 *
 * The bytes are genuine — Chrome's virtual authenticator produced them, and
 * `packages/core/__tests__/webauthn.test.ts` explains why they are not
 * hand-encoded. What is under test here is everything the *database* decides,
 * which is the half `webauthn.ts` cannot have an opinion about:
 *
 * - a challenge is single-use, and is spent by the statement that finds it;
 * - a challenge issued for enrolment cannot be spent on a sign-in;
 * - the counter is written back, so clone detection compares against what the
 *   authenticator last said rather than always against zero;
 * - a credential belonging to somebody else is not found.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the WebAuthn store would go untested.')
}

const un64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'))

const RP = { id: 'localhost', name: 'Nacre', origins: ['http://localhost:8099'] }

const FIXTURES = {
  es256: {
    registration: {
      id: '41NK_HB9L5RxAV_RyQfCb3PDw06Ik38yM-34IMpNaPs',
      challenge: 'fw_CDPbDqYHqyuQYl8hspZcgTkCwYs5me4ntLnc-XB0',
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVikSZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2NFAAAAAQAAAAAAAAAAAAAAAAAAAAAAIONTSvxwfS-UcQFf0ckHwm9zw8NOiJN_MjPt-CDKTWj7pQECAyYgASFYIHga_4HYdM3Pdag5hqgrjXCwJ5B5bzQViL3SEAiKGFCwIlggMvoKhER73Kx9uybKGOZB88BE0Yr6Kkke44n55uyXSH4',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiZndfQ0RQYkRxWUhxeXVRWWw4aHNwWmNnVGtDd1lzNW1lNG50TG5jLVhCMCIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODA5OSIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
    },
    assertion: {
      challenge: 'p2CBYKm_rzKBqv33LIjNUfVg81tl_4IMXhH3OUJ0f_k',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAg',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoicDJDQllLbV9yektCcXYzM0xJak5VZlZnODF0bF80SU1YaEgzT1VKMGZfayIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODA5OSIsImNyb3NzT3JpZ2luIjpmYWxzZSwib3RoZXJfa2V5c19jYW5fYmVfYWRkZWRfaGVyZSI6ImRvIG5vdCBjb21wYXJlIGNsaWVudERhdGFKU09OIGFnYWluc3QgYSB0ZW1wbGF0ZS4gU2VlIGh0dHBzOi8vZ29vLmdsL3lhYlBleCJ9',
      signature: 'MEUCIA59qU6za4ztAwmvYvrNB3Ml0yRvcm2jpM16Pwt9ncqLAiEAjuzFtL2DWBX9r5Pk_4UJA-xDqiOr0FmtK4UKm_Zwcko',
    },
  },
  rs256: {
    registration: {
      id: 'Z9uFKrD82Hk4OhqvuCVY3TUmrW7PNcSRe-UlyoiLitg',
      challenge: 'KKG3OhaTHnYnhD6mVbdw5WJ-d-Q0CKpvg82ohLInk-w',
      attestationObject: 'o2NmbXRkbm9uZWdhdHRTdG10oGhhdXRoRGF0YVkBZ0mWDeWIDoxodDQXD2R2YFuP5K65ooYyx5lc87qDHZdjRQAAAAEAAAAAAAAAAAAAAAAAAAAAACBn24UqsPzYeTg6Gq-4JVjdNSatbs81xJF75SXKiIuK2KQBAwM5AQAgWQEAl8AAvUUh2t-76wO5u3c-e4vbPfK9qlaPu1Ieo32HAcuJXQY1H9QY86Aa2WALWn7Bmom-IA_9_lf8H3q3HK_XK63vDl0y4BGYDJE9f82HyN3Tk-w2OlbMTr9dGnpZxQJexjlysYPvXYZUShWInXK4GitLT2w3h9F-G0SbrdGsAIIom2CKoZoaF5GjhxjOMBC4foL2Par2if2XT-b0uhqV88yC29tpGwevWMue4Qf_BtxAVQRMLTyGErTMRgGWzxu870_pBiIO_npvft1OrM38a02eHnkWf8kFxSRSu85rrobBfzQNUXFtR-pzov6-95llvybZH4uCcsVDs6WEX5WKfyFDAQAB',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIiwiY2hhbGxlbmdlIjoiS0tHM09oYVRIblluaEQ2bVZiZHc1V0otZC1RMENLcHZnODJvaExJbmstdyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODA5OSIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
    },
    assertion: {
      challenge: 'Lm6Me3mw9QYnc3ccbG3JPZTqYdVUic05VutScV7pyOo',
      authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAg',
      clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0IiwiY2hhbGxlbmdlIjoiTG02TWUzbXc5UVluYzNjY2JHM0pQWlRxWWRWVWljMDVWdXRTY1Y3cHlPbyIsIm9yaWdpbiI6Imh0dHA6Ly9sb2NhbGhvc3Q6ODA5OSIsImNyb3NzT3JpZ2luIjpmYWxzZX0',
      signature: 'XPtt_Ca2ReLR-2RuNOWWVyhAjAtAF12EmI7Cf_W4_S73XMik-9T_2f5rkkcly2dXuEdbIq6NJyfkn0J1qRgFV115yPyakx4hYFs8eDx4m4l57x9XEU5AFmNwQI9k0fWdmKaT7mXeYUrfmF-OUMynKY5NMnMvDP6Ic3leBP64dJ3Uo3k_sWgTckUjdBpE7OVtlrBOCGrtaw-_yq15Eb-LuSwzbA-JLwZPx2VLUG1yh-G8B6uqG5ecPlvYiJvTq2FEnCaVZAMbvzauW6dCYHZk9-7VkdqKB7E7vqb7l_qm7Ojhu-gsHJ9LFDRVcaLWmCB3TvTmSLkhP3U_g13SLfJPcw',
    },
  },
} as const

const F = FIXTURES.es256

let pool: Pool
let factors: SecondFactors
let orgId: string
let userId: string
let otherId: string

const when = url ? describe : describe.skip

/**
 * Enrol the fixture credential, spending a challenge whose value is the one the
 * fixture was made with. `issueChallenge` mints a random one, so the row is
 * written directly — the alternative is a fixture per test run, which needs a
 * browser in the unit suite.
 */
async function enrol(user = userId, label = 'a key'): Promise<readonly string[] | undefined> {
  await pool.query(
    `INSERT INTO webauthn_challenges (org_id, user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, 'register', $3, now() + interval '5 min')
     ON CONFLICT (org_id, challenge) DO NOTHING`,
    [orgId, user, F.registration.challenge],
  )
  return factors.finishWebAuthnRegistration(orgId, user, label, {
    attestationObject: un64(F.registration.attestationObject),
    clientDataJSON: un64(F.registration.clientDataJSON),
    challenge: F.registration.challenge,
  })
}

async function offerAssertion(user = userId): Promise<void> {
  await pool.query(
    `INSERT INTO webauthn_challenges (org_id, user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, 'authenticate', $3, now() + interval '5 min')
     ON CONFLICT (org_id, challenge) DO NOTHING`,
    [orgId, user, F.assertion.challenge],
  )
}

/**
 * The second person enrols on the other algorithm's fixture, because a
 * credential id is unique per organization and reusing the first would collide
 * — and because a second algorithm exercised end to end is free here.
 */
async function enrolOther(): Promise<readonly string[]> {
  await pool.query(
    `INSERT INTO webauthn_challenges (org_id, user_id, purpose, challenge, expires_at)
     VALUES ($1, $2, 'register', $3, now() + interval '5 min')
     ON CONFLICT (org_id, challenge) DO NOTHING`,
    [orgId, otherId, FIXTURES.rs256.registration.challenge],
  )
  const codes = await factors.finishWebAuthnRegistration(orgId, otherId, 'their key', {
    attestationObject: un64(FIXTURES.rs256.registration.attestationObject),
    clientDataJSON: un64(FIXTURES.rs256.registration.clientDataJSON),
    challenge: FIXTURES.rs256.registration.challenge,
  })
  if (codes === undefined) throw new Error('the rs256 enrolment was refused')
  return codes
}

const assertWith = async (user = userId) =>
  factors.verifyWebAuthnAssertion(orgId, user, {
    credentialId: F.registration.id,
    authenticatorData: un64(F.assertion.authenticatorData),
    clientDataJSON: un64(F.assertion.clientDataJSON),
    signature: un64(F.assertion.signature),
    challenge: F.assertion.challenge,
  })

when('a WebAuthn factor', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const client = await pool.connect()
    try {
      await client.query("DELETE FROM organizations WHERE slug = 'wakeys'")
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, vector_collection)
         VALUES ('wakeys','wakeys','org_wakeys') RETURNING id`,
      )
      orgId = rows[0]!.id
      const hash = await hashPassword('a password long enough')
      const { rows: people } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'dana@wakeys.test','org_admin',$2), ($1,'sam@wakeys.test','member',$2)
         RETURNING id`,
        [orgId, hash],
      )
      userId = people[0]!.id
      otherId = people[1]!.id
    } finally {
      client.release()
    }

    factors = new SecondFactors({ pool, key: undefined, issuer: 'api.example.test', relyingParty: RP })
  })

  afterAll(async () => {
    await pool?.end()
  })

  /*
   * The property that makes this worth having at all: WebAuthn needs no sealing
   * key, so an installation that offers no TOTP still offers the stronger of
   * the two. `key: undefined` above is that installation.
   */
  it('is offered on an installation with no sealing key, and TOTP is not', () => {
    expect(factors.kinds).toEqual(['webauthn'])
    expect(factors.available).toBe(true)
  })

  it('enrols the credential and issues recovery codes for the first factor', async () => {
    const codes = await enrol()
    expect(codes).toHaveLength(10)

    const listed = await factors.list(orgId, userId)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.kind).toBe('webauthn')
    expect(listed[0]?.label).toBe('a key')

    // Confirmed by the insert, unlike TOTP: producing the attestation *is* the
    // proof that the credential reached an authenticator.
    expect(await factors.required(orgId, userId)).toBe(true)
  })

  it('will not spend a registration challenge twice', async () => {
    // The row is already used from the case above, and `ON CONFLICT DO NOTHING`
    // means the helper does not resurrect it.
    expect(await enrol(userId, 'a second name')).toBeUndefined()
    expect(await factors.list(orgId, userId)).toHaveLength(1)
  })

  it('verifies an assertion and writes the counter back', async () => {
    const before = await pool.query<{ sign_count: string }>(
      "SELECT sign_count FROM user_second_factors WHERE org_id = $1 AND kind = 'webauthn'",
      [orgId],
    )
    // What the *registration* stored. The first version of this case asserted
    // only that the column was above zero, which the registration already makes
    // true — so it passed with the assertion's write removed and could only
    // ever have passed.
    const registered = Number(before.rows[0]?.sign_count)

    await offerAssertion()
    expect(await assertWith()).toBe(true)

    const after = await pool.query<{ sign_count: string }>(
      "SELECT sign_count FROM user_second_factors WHERE org_id = $1 AND kind = 'webauthn'",
      [orgId],
    )
    // The assertion's own counter, which this fixture's authenticator moved. A
    // counter checked and not stored is clone detection that only ever compares
    // against the registration, which is the detection not existing.
    const asserted = new DataView(un64(F.assertion.authenticatorData).buffer).getUint32(33)
    expect(asserted).toBeGreaterThan(registered)
    expect(Number(after.rows[0]?.sign_count)).toBe(asserted)
  })

  it('will not spend an assertion challenge twice', async () => {
    // The same bytes again, with the challenge already used. This is the replay
    // the store exists to stop — the signature still verifies perfectly.
    expect(await assertWith()).toBe(false)
  })

  it('will not spend a registration challenge on a sign-in', async () => {
    const challenge = 'a-challenge-issued-for-enrolment'
    await pool.query(
      `INSERT INTO webauthn_challenges (org_id, user_id, purpose, challenge, expires_at)
       VALUES ($1, $2, 'register', $3, now() + interval '5 min')`,
      [orgId, userId, challenge],
    )
    expect(
      await factors.verifyWebAuthnAssertion(orgId, userId, {
        credentialId: F.registration.id,
        authenticatorData: un64(F.assertion.authenticatorData),
        clientDataJSON: un64(F.assertion.clientDataJSON),
        signature: un64(F.assertion.signature),
        challenge,
      }),
    ).toBe(false)
  })

  it('does not find somebody else\'s credential', async () => {
    // The credential id is real and the assertion verifies; it belongs to
    // another person in the same organization, and the lookup is scoped to the
    // user rather than to the id alone.
    await offerAssertion(otherId)
    expect(await assertWith(otherId)).toBe(false)
  })

  it('offers nothing to sign in with where nothing is enrolled', async () => {
    expect(await factors.beginWebAuthnAssertion(orgId, otherId)).toBeUndefined()
  })

  /*
   * The recovery codes an enrolment printed have to be spendable, and on this
   * installation there is no other way to spend one: `verify` is where a code
   * is redeemed and it began with `if (key === undefined) return false`.
   *
   * That guard was right about TOTP and wrong about the sheet of codes beside
   * it — so a WebAuthn-only deployment printed ten of them at enrolment and
   * refused every one, which is the person whose key is in the other coat
   * locked out with a valid code in their hand. Nothing failed: the codes are
   * minted by one method and redeemed by another, and no case asked the second
   * on an installation with no key.
   */
  it('redeems a recovery code where there is no sealing key at all', async () => {
    const codes = (await factors.list(orgId, otherId)).length === 0 ? await enrolOther() : []
    expect(codes).toHaveLength(10)
    expect(await factors.recoveryCodesLeft(orgId, otherId)).toBe(10)

    expect(await factors.verify(orgId, otherId, codes[0]!)).toBe(true)
    expect(await factors.recoveryCodesLeft(orgId, otherId)).toBe(9)
    // And spent, because the UPDATE that finds one is what marks it used.
    expect(await factors.verify(orgId, otherId, codes[0]!)).toBe(false)
  })

  it('excludes what is already registered when enrolling again', async () => {
    const options = await factors.beginWebAuthnRegistration(orgId, userId)
    // So an authenticator the person is already holding refuses to make a
    // second credential rather than quietly making one.
    expect(options?.excludeCredentials).toContain(F.registration.id)
    expect(options?.rp.id).toBe('localhost')
  })
})
