import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  openTotpSecret,
  otpauthUrl,
  sealTotpSecret,
  TOTP_PERIOD_SECONDS,
  totpCode,
  totpStep,
  verifyTotp,
} from '../totp.js'

/**
 * RFC 6238's own key: the ASCII "12345678901234567890", which is what every
 * implementation is checked against. Asserting our arithmetic against the
 * standard rather than against ourselves is the whole point — a code generator
 * tested against its own output is a generator that agrees with itself and with
 * no authenticator anybody owns.
 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'))

describe('totpCode against RFC 6238', () => {
  // The document's SHA-1 vectors, truncated to the six digits an app shows.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at %i seconds', (seconds, expected) => {
    expect(totpCode(RFC_SECRET, Math.floor(seconds / TOTP_PERIOD_SECONDS))).toBe(expected)
  })
})

describe('base32', () => {
  it('round trips arbitrary bytes', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = randomBytes(length)
      expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true)
    }
  })

  it('reads back what a person retypes: lower case, spaces, padding', () => {
    const secret = generateTotpSecret()
    const mangled = ` ${secret.toLowerCase().replace(/(.{4})/gu, '$1 ')}== `
    expect(base32Decode(mangled).equals(base32Decode(secret))).toBe(true)
  })
})

describe('verifyTotp', () => {
  const at = new Date(1_700_000_000_000)
  const secret = generateTotpSecret()

  it('accepts the current code and says which step it was', () => {
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(secret, step), { at })).toEqual({ step })
  })

  it('accepts one step either side, because phones drift and people type slowly', () => {
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(secret, step - 1), { at })).toEqual({ step: step - 1 })
    expect(verifyTotp(secret, totpCode(secret, step + 1), { at })).toEqual({ step: step + 1 })
  })

  it('refuses two steps away', () => {
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(secret, step - 2), { at })).toBeUndefined()
    expect(verifyTotp(secret, totpCode(secret, step + 2), { at })).toBeUndefined()
  })

  /*
   * The property the `last_step` column exists for. Without it a code is good
   * for the whole window it was shown in, so a shoulder-surfed code — or one a
   * phishing proxy relays — is worth a second use.
   */
  it('refuses a code from a step already spent', () => {
    const step = totpStep(at)
    const code = totpCode(secret, step)
    expect(verifyTotp(secret, code, { at })).toEqual({ step })
    expect(verifyTotp(secret, code, { at, after: step })).toBeUndefined()
  })

  it('still accepts a later code after one is spent', () => {
    const step = totpStep(at)
    expect(verifyTotp(secret, totpCode(secret, step + 1), { at, after: step })).toEqual({ step: step + 1 })
  })

  it('refuses anything that is not six digits without touching the secret', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56', '000000\n']) {
      expect(verifyTotp(secret, bad, { at })).toBeUndefined()
    }
  })

  it('refuses a correct code for a different secret', () => {
    const other = generateTotpSecret()
    expect(verifyTotp(secret, totpCode(other, totpStep(at)), { at })).toBeUndefined()
  })
})

describe('the secret at rest', () => {
  const key = randomBytes(32)

  it('round trips', () => {
    const secret = generateTotpSecret()
    expect(openTotpSecret(sealTotpSecret(secret, key), key)).toBe(secret)
  })

  it('does not carry the secret in the clear', () => {
    const secret = generateTotpSecret()
    expect(sealTotpSecret(secret, key)).not.toContain(secret)
  })

  it('refuses another key', () => {
    const sealed = sealTotpSecret(generateTotpSecret(), key)
    expect(() => openTotpSecret(sealed, randomBytes(32))).toThrow()
  })

  it('refuses a tampered body, which is what the tag is for', () => {
    const sealed = sealTotpSecret(generateTotpSecret(), key)
    const parts = sealed.split('.')
    const body = Buffer.from(parts[2]!, 'base64url')
    body[0] = (body[0] ?? 0) ^ 0xff
    parts[2] = body.toString('base64url')
    expect(() => openTotpSecret(parts.join('.'), key)).toThrow()
  })

  it('refuses a key that is not 32 bytes rather than stretching one', () => {
    expect(() => sealTotpSecret(generateTotpSecret(), randomBytes(16))).toThrow()
  })

  it('seals the same secret differently every time', () => {
    const secret = generateTotpSecret()
    expect(sealTotpSecret(secret, key)).not.toBe(sealTotpSecret(secret, key))
  })
})

describe('recovery codes', () => {
  it('are grouped, so they get retyped correctly', () => {
    expect(generateRecoveryCode()).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}$/u)
  })

  it('hash the same however they are typed back', () => {
    const code = generateRecoveryCode()
    expect(hashRecoveryCode(code.toLowerCase())).toBe(hashRecoveryCode(code))
    expect(hashRecoveryCode(normalizeRecoveryCode(code))).toBe(hashRecoveryCode(code))
    expect(hashRecoveryCode(` ${code} `)).toBe(hashRecoveryCode(code))
  })

  it('are distinct', () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateRecoveryCode()))
    expect(codes.size).toBe(200)
  })
})

describe('otpauthUrl', () => {
  it('names the issuer as well as the account, so a list of thirty is readable', () => {
    const url = new URL(otpauthUrl({ issuer: 'Nacre', account: 'dana@example.com', secret: 'ABCD' }))
    expect(url.protocol).toBe('otpauth:')
    expect(decodeURIComponent(url.pathname)).toBe('/Nacre:dana@example.com')
    expect(url.searchParams.get('issuer')).toBe('Nacre')
    expect(url.searchParams.get('secret')).toBe('ABCD')
    expect(url.searchParams.get('digits')).toBe('6')
    expect(url.searchParams.get('period')).toBe('30')
  })

  /*
   * The case above passed a bare name, which is a value no deployment produced:
   * the API handed this function `NACRE_JWT_ISSUER`, a URL. The label is
   * `issuer:account`, so the colon in `https://` became the separator and an
   * authenticator showed
   *
   *     https://playground.nacre.work: //playground.nacre….
   *
   * — the account name replaced by the tail of a URL. A fixture written to the
   * shape somebody imagined rather than to the one the wiring sends, which is
   * the defect this repository names three times already.
   */
  it('refuses a URL as the issuer, because the colon is the label separator', () => {
    expect(() =>
      otpauthUrl({
        issuer: 'https://playground.nacre.work',
        account: 'dana@example.com',
        secret: 'ABCD',
      }),
    ).toThrow(/colon/u)
  })

  it('refuses a colon in the account name too, for the same reason', () => {
    expect(() => otpauthUrl({ issuer: 'Nacre', account: 'user:one', secret: 'ABCD' })).toThrow(
      /colon/u,
    )
  })

  it('takes the hostname the API now passes', () => {
    const url = new URL(
      otpauthUrl({ issuer: 'playground.nacre.work', account: 'dana@example.com', secret: 'ABCD' }),
    )
    expect(decodeURIComponent(url.pathname)).toBe('/playground.nacre.work:dana@example.com')
    expect(url.searchParams.get('issuer')).toBe('playground.nacre.work')
  })
})
