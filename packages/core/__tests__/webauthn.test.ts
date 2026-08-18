import { describe, expect, it } from 'vitest'

import {
  CborError,
  coseToPublicKey,
  decodeCbor,
  parseAuthenticatorData,
  verifyAssertion,
  verifyRegistration,
} from '../webauthn.js'

/**
 * WebAuthn, against what an authenticator actually produced.
 *
 * The fixtures below are **not hand-encoded**. They came out of Chrome's own
 * virtual authenticator over CDP — `scripts/webauthn-fixtures.mjs` regenerates
 * them — driven through `navigator.credentials.create()` and `.get()` on a real
 * page. That is the same rule `totp.ts` follows by using RFC 6238's vectors: a
 * decoder checked against bytes this repository encoded agrees with itself and
 * with no authenticator anybody owns.
 *
 * Two algorithms, because they take different shapes through this file. ES256
 * is an EC2 key with x and y and a DER signature; RS256 is an RSA key with a
 * modulus and an exponent and a PKCS#1 signature. EdDSA has no fixture here and
 * the reason is honest rather than principled: Chrome's virtual authenticator
 * does not offer it, so there was nothing genuine to capture — the branch is
 * exercised by `coseToPublicKey` and by the round trip in
 * `webauthn-live.test.ts`, and it is written down as covered less than the
 * other two rather than claimed as covered.
 */

const un64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64url'))

/** localhost, because that is a secure origin and where the fixtures were made. */
const RP_ID = 'localhost'
const ORIGINS = ['http://localhost:8099']

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

type Name = keyof typeof FIXTURES

describe.each(['es256', 'rs256'] as Name[])('%s, from a real authenticator', (name) => {
  const f = FIXTURES[name]

  it('verifies the registration and reads the credential back', () => {
    const registered = verifyRegistration({
      attestationObject: un64(f.registration.attestationObject),
      clientDataJSON: un64(f.registration.clientDataJSON),
      challenge: f.registration.challenge,
      rpId: RP_ID,
      origins: ORIGINS,
    })

    // The id the browser reports and the id inside the signed authenticator
    // data are the same credential. A server that stored the former without
    // checking the latter would be storing something the authenticator did not
    // attest to.
    expect(Buffer.from(registered.credentialId).toString('base64url')).toBe(f.registration.id)
    expect(registered.publicKey.alg).toBe(name === 'es256' ? -7 : -257)
    expect(registered.publicKey.jwk.kty).toBe(name === 'es256' ? 'EC' : 'RSA')
  })

  it('verifies an assertion against the key the registration produced', () => {
    const registered = verifyRegistration({
      attestationObject: un64(f.registration.attestationObject),
      clientDataJSON: un64(f.registration.clientDataJSON),
      challenge: f.registration.challenge,
      rpId: RP_ID,
      origins: ORIGINS,
    })

    const assertion = verifyAssertion({
      authenticatorData: un64(f.assertion.authenticatorData),
      clientDataJSON: un64(f.assertion.clientDataJSON),
      signature: un64(f.assertion.signature),
      challenge: f.assertion.challenge,
      rpId: RP_ID,
      origins: ORIGINS,
      publicKey: registered.publicKey,
      storedSignCount: 0,
    })
    expect(assertion.signCount).toBeGreaterThanOrEqual(0)
  })

  /*
   * Every way this must fail, and each is a real attack rather than a typo.
   *
   * A green verifier proves nothing on its own: what says a signature check is
   * a signature check is that it refuses a signature. Each case below changes
   * exactly one thing.
   */
  const registered = () =>
    verifyRegistration({
      attestationObject: un64(f.registration.attestationObject),
      clientDataJSON: un64(f.registration.clientDataJSON),
      challenge: f.registration.challenge,
      rpId: RP_ID,
      origins: ORIGINS,
    })

  const assert = (over: Record<string, unknown>) =>
    verifyAssertion({
      authenticatorData: un64(f.assertion.authenticatorData),
      clientDataJSON: un64(f.assertion.clientDataJSON),
      signature: un64(f.assertion.signature),
      challenge: f.assertion.challenge,
      rpId: RP_ID,
      origins: ORIGINS,
      publicKey: registered().publicKey,
      storedSignCount: 0,
      ...over,
    } as Parameters<typeof verifyAssertion>[0])

  it('refuses a replayed challenge', () => {
    expect(() => assert({ challenge: 'a-challenge-this-server-never-issued' })).toThrow(/challenge/u)
  })

  it('refuses an origin this deployment does not serve', () => {
    expect(() => assert({ origins: ['https://somewhere.else.test'] })).toThrow(/origin/u)
  })

  /*
   * The suffix hole, from the direction it is actually attacked.
   *
   * The first version of this case varied the *allowed* list and left the
   * received origin alone, which a suffix comparison refuses just as happily as
   * an equality one — so it passed with the hole restored and could only ever
   * have passed. What an attacker controls is the origin in `clientDataJSON`,
   * so that is what this changes: `evil-localhost` ends with `localhost`, and a
   * check written as `hostname.endsWith(allowed)` admits it.
   *
   * The forged client data will not verify against the signature either, which
   * is the point — the origin is checked *first*, so this measures the origin
   * check rather than the signature one behind it.
   */
  it('refuses an origin that merely ends with one it serves', () => {
    const forged = Buffer.from(
      JSON.stringify({
        type: 'webauthn.get',
        challenge: f.assertion.challenge,
        origin: 'http://evil-localhost:8099',
        crossOrigin: false,
      }),
    )
    expect(() => assert({ clientDataJSON: new Uint8Array(forged) })).toThrow(/origin/u)
  })

  it('refuses another relying party', () => {
    expect(() => assert({ rpId: 'example.test' })).toThrow(/relying party/u)
  })

  it('refuses a flipped signature', () => {
    const bad = un64(f.assertion.signature)
    // One bit, in the last byte. A signature check that survives this is not
    // checking the signature.
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0x01
    expect(() => assert({ signature: bad })).toThrow(/does not verify/u)
  })

  it('refuses a counter that went backwards', () => {
    // What a cloned authenticator looks like: a signature that verifies and a
    // counter behind the one already seen.
    const data = un64(f.assertion.authenticatorData)
    const counter = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0)
    if (counter === 0) {
      // A platform authenticator that never counts is allowed, and this fixture
      // is one — so the case asserts *that* rather than being skipped silently.
      expect(assert({ storedSignCount: 99 }).signCount).toBe(0)
      return
    }
    expect(() => assert({ storedSignCount: counter })).toThrow(/cloned/u)
  })
})

describe('the CBOR subset', () => {
  /*
   * Every one of these is a shape a conforming authenticator does not produce,
   * and refusing them is what keeps this reader small enough to be worth having
   * written. A decoder that accepted them would be a general CBOR library with
   * none of a general CBOR library's testing.
   */
  it('refuses an indefinite-length map', () => {
    // 0xbf is "map, indefinite length" — legal CBOR, not canonical CTAP2.
    expect(() => decodeCbor(new Uint8Array([0xbf, 0x01, 0x01, 0xff]))).toThrow(CborError)
  })

  it('refuses a tag', () => {
    expect(() => decodeCbor(new Uint8Array([0xc0, 0x01]))).toThrow(/major type 6/u)
  })

  it('refuses a duplicate map key', () => {
    // {1: 1, 1: 2}. Picking one of the two would be this reader deciding
    // something the sender did not.
    expect(() => decodeCbor(new Uint8Array([0xa2, 0x01, 0x01, 0x01, 0x02]))).toThrow(/duplicate/u)
  })

  it('refuses trailing bytes after the item', () => {
    // The shape of a malleability bug: two inputs that decode the same.
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow(/trailing/u)
  })

  it('refuses input that ends early', () => {
    expect(() => decodeCbor(new Uint8Array([0x42, 0x01]))).toThrow(/ran off the end/u)
  })

  it('reads a negative integer, which is how COSE labels its parameters', () => {
    expect(decodeCbor(new Uint8Array([0x26]))).toBe(-7)
  })
})

describe('authenticator data', () => {
  it('refuses anything shorter than the fixed part', () => {
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow(/37 is the minimum/u)
  })

  it('refuses a credential id longer than the specification allows', () => {
    const data = new Uint8Array(55)
    data[32] = 0x41 // user present, attested credential data
    data[53] = 0x04 // 1024, one past the 1023 ceiling
    data[54] = 0x00
    expect(() => parseAuthenticatorData(data)).toThrow(/1023 is the maximum/u)
  })
})

describe('COSE keys', () => {
  it('refuses an algorithm this server never asked for', () => {
    // -37 is PS256, which is not in `pubKeyCredParams`, so no authenticator
    // would choose it — accepting one would be accepting something unasked for.
    const key = new Map<number | string, unknown>([[1, 2], [3, -37]])
    expect(() => coseToPublicKey(key as never)).toThrow(/not one this server asked for/u)
  })

  it('refuses ES256 on a curve it is not defined over', () => {
    const key = new Map<number | string, unknown>([[1, 2], [3, -7], [-1, 2]])
    expect(() => coseToPublicKey(key as never)).toThrow(/P-256/u)
  })
})
