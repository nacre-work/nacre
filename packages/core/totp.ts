/**
 * A second factor, and the codes that get you back in without one.
 *
 * ## What this decides, and what it does not
 *
 * A second factor decides whether a **session starts**. It grants nothing: the
 * permitted set is still computed per request from `grants`, and a token minted
 * after a correct code reaches exactly what the same token reaches without one.
 * Nothing in `authz/` reads anything here, deliberately — a factor that could
 * widen access would be a second answer to the question this product exists to
 * answer once.
 *
 * ## Why SHA-1
 *
 * RFC 6238 leaves the hash open and every authenticator on a phone implements
 * SHA-1; several implement nothing else. The weakness SHA-1 is retired for is
 * collision resistance, which HMAC does not rest on — and the key here is 160
 * bits from the CSPRNG while the message is a counter and the answer lives
 * thirty seconds. Choosing SHA-256 would buy nothing measurable and would meet
 * a person whose authenticator shows six digits that never work.
 *
 * ## Standard library only
 *
 * The same argument the parser makes: this module is on the authentication
 * path, and a dependency here is a dependency inside every sign-in. The whole
 * of it is HMAC, a counter, a base32 alphabet and AES-GCM, all of which
 * `node:crypto` already has.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** RFC 6238's default and what every authenticator assumes. */
export const TOTP_PERIOD_SECONDS = 30
/** Six, for the same reason: it is what the apps show. */
export const TOTP_DIGITS = 6

/**
 * How far either side of now a code is accepted.
 *
 * One step, which is up to sixty seconds of tolerance in the worst alignment.
 * Phones drift and people type slowly; two steps is the number that starts
 * making a shoulder-surfed code useful for longer than it should be.
 */
export const TOTP_SKEW_STEPS = 1

/** RFC 4648 base32, which is the only encoding an authenticator will read. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  // Padding and case are both things a person retypes wrongly, and neither
  // carries information. Whitespace goes first: with the order reversed, a
  // value ending in `== ` keeps its padding, because it is no longer at the
  // end — which a test caught on the first run.
  const clean = text.replace(/\s+/gu, '').replace(/=+$/u, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const character of clean) {
    const index = ALPHABET.indexOf(character)
    if (index === -1) throw new Error(`not base32: ${character}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/**
 * 160 bits, which is what RFC 4226 recommends and what the apps expect.
 *
 * Shorter secrets are accepted by every authenticator and are the reason a
 * generator is here rather than left to a call site: 80 bits is legal, common
 * in examples, and half the strength of the thing it is protecting.
 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The step a moment falls in. Exported because the replay bound is a step. */
export const totpStep = (at: Date = new Date()): number =>
  Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS)

/** RFC 6238 over RFC 4226: HMAC the counter, take the dynamic offset, mod 10^d. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

export interface TotpVerification {
  /** The step the code belonged to, to be stored so it cannot be spent twice. */
  readonly step: number
}

/**
 * Check a code, and say which step it was.
 *
 * `after` is the last step this factor already accepted, and a code at or
 * before it is refused however correct it is. Without that, a code is good for
 * the whole window it was shown in — so somebody who reads it over a shoulder,
 * or a phishing page that relays it, gets a second use out of it. The caller
 * stores the returned step.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { readonly at?: Date; readonly after?: number | null } = {},
): TotpVerification | undefined {
  const typed = code.replace(/\s+/gu, '')
  if (!new RegExp(`^[0-9]{${String(TOTP_DIGITS)}}$`, 'u').test(typed)) return undefined

  const current = totpStep(options.at ?? new Date())
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset += 1) {
    const step = current + offset
    if (options.after !== undefined && options.after !== null && step <= options.after) continue
    const expected = Buffer.from(totpCode(secret, step))
    const given = Buffer.from(typed)
    // Constant time, because the comparison is over a secret-derived value and
    // an attacker controls one side of it.
    if (expected.length === given.length && timingSafeEqual(expected, given)) return { step }
  }
  return undefined
}

/**
 * The URL an authenticator reads out of a QR code.
 *
 * The label carries the issuer as well as the account, which is what makes two
 * installations distinguishable in a list of thirty entries — an app shows the
 * label, and "dana@example.com" alone is four identical rows.
 */
export function otpauthUrl(options: {
  readonly issuer: string
  readonly account: string
  readonly secret: string
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`
  const query = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${query.toString()}`
}

// ── the secret at rest ───────────────────────────────────────────────────────

/**
 * Sealed with AES-256-GCM under a key this process is given.
 *
 * A TOTP secret in the clear is a second factor that a database dump defeats,
 * which is the same blast-radius argument that made the token signing key
 * asymmetric: the point of the factor is that stealing one thing is not enough.
 *
 * The nonce and the tag travel inside the stored value the way `password_hash`
 * carries its scrypt parameters — a column that needs a second column to be
 * readable is two things that can come apart.
 */
const SEALED = 'v1'

export function sealTotpSecret(secret: string, key: Buffer): string {
  if (key.length !== 32) throw new Error('a 2FA key is 32 bytes')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [SEALED, nonce.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.')
}

export function openTotpSecret(sealed: string, key: Buffer): string {
  const [version, nonce, body, tag] = sealed.split('.')
  if (version !== SEALED || nonce === undefined || body === undefined || tag === undefined) {
    throw new Error('not a sealed TOTP secret')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
}

// ── recovery codes ───────────────────────────────────────────────────────────

/** Ten, which is what a person can print on one line each and lose half of. */
export const RECOVERY_CODE_COUNT = 10

/**
 * A recovery code, in the shape people retype correctly.
 *
 * Four groups of five from a 32-character alphabet is 100 bits — far past
 * anything guessable — and the groups exist because a twenty-character run
 * gets transcribed wrongly and blamed on the product.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20)
  const text = base32Encode(bytes).slice(0, 20)
  return [text.slice(0, 5), text.slice(5, 10), text.slice(10, 15), text.slice(15, 20)].join('-')
}

export const normalizeRecoveryCode = (code: string): string =>
  code.replace(/[\s-]+/gu, '').toUpperCase()

/**
 * Hashed with SHA-256 and deliberately not with scrypt.
 *
 * A recovery code is 100 bits from the CSPRNG, so there is no dictionary to
 * slow down and no human-chosen password to protect. A cost parameter would buy
 * nothing against an attacker and would make issuing ten of them a second of
 * CPU on a request — on the same libuv pool the sign-in path already has to be
 * careful about.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
}
