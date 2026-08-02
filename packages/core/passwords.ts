import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { promisify } from 'node:util'

/**
 * Password hashing, with scrypt from the standard library.
 *
 * Argon2id is the first choice in every current guideline and it is not
 * available here without a dependency — either a native module built by
 * node-gyp, or one shipping prebuilt binaries for every platform an operator
 * might self-host on. Both are things every operator of a security product
 * inherits, and the second is a supply chain that ships machine code.
 *
 * scrypt is the documented alternative in the same guidelines, it is memory-
 * hard, and it is in `node:crypto`. The parameters below are OWASP's minimum
 * for it. This is a deliberate second choice rather than an oversight, and the
 * encoding carries its parameters so that moving to Argon2id later is a new
 * prefix and a rehash on next login rather than a migration that invalidates
 * every password.
 *
 * ## Why the cost is a constant and not configuration
 *
 * A tunable would let an operator turn it down, and the only reason anyone ever
 * does is that logins felt slow. The cost is the entire defence: it is what
 * makes a stolen `password_hash` column expensive rather than a wordlist away
 * from plaintext.
 */

// promisify picks the overload without options, and the options are the whole
// point here — the cost parameters live in them.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>

/** OWASP's minimum for scrypt: N=2^17, r=8, p=1. */
const N = 131_072
const R = 8
const P = 1
const KEY_BYTES = 64
const SALT_BYTES = 32

/**
 * 128 * N * r is 134 MB, and Node's default `maxmem` is 32 MB — without this
 * every call fails with an error about memory rather than a wrong password,
 * which is a confusing way to find out. The headroom is for the internal
 * allocations on top of the working set.
 */
const MAX_MEM = 256 * 1024 * 1024

/**
 * `scrypt$N$r$p$salt$hash`, base64url, parameters first.
 *
 * Self-describing on purpose. A bare hash cannot be verified after the cost is
 * raised, so raising it means invalidating every password in the database;
 * carrying the parameters means old hashes keep verifying and get rewritten as
 * people sign in.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`
}

interface Parsed {
  readonly n: number
  readonly r: number
  readonly p: number
  readonly salt: Buffer
  readonly key: Buffer
}

function parse(encoded: string): Parsed | undefined {
  const parts = encoded.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined

  const n = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return undefined
  // A stored record could otherwise ask for a work factor large enough to hang
  // the process, which turns one poisoned row into an outage.
  if (n < 1024 || n > 1 << 22 || r < 1 || r > 32 || p < 1 || p > 16) return undefined

  try {
    return {
      n,
      r,
      p,
      salt: Buffer.from(parts[4] as string, 'base64url'),
      key: Buffer.from(parts[5] as string, 'base64url'),
    }
  } catch {
    return undefined
  }
}

/**
 * Verify, in time that does not depend on whether the password was right.
 *
 * A malformed or absent hash answers false rather than throwing: the caller
 * turns every failure into the same refusal, and an exception on one of them
 * would be a way to tell them apart from the outside.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded)
  if (parsed === undefined) return false

  const key = await scrypt(password.normalize('NFKC'), parsed.salt, parsed.key.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEM,
  })

  if (key.length !== parsed.key.length) return false
  return timingSafeEqual(key, parsed.key)
}

/**
 * Whether a stored hash was made with parameters weaker than the current ones.
 *
 * The caller rehashes on a successful sign-in, which is the only moment the
 * plaintext exists. Without this, raising the cost protects nobody who already
 * has an account.
 */
export function needsRehash(encoded: string): boolean {
  const parsed = parse(encoded)
  if (parsed === undefined) return true
  return parsed.n < N || parsed.r < R || parsed.p < P
}

/**
 * Spend the same work as a real verification, and fail.
 *
 * For the case where no user matched. Returning early there makes the response
 * time say whether an address has an account — the enumeration oracle that
 * makes a careful 404 elsewhere pointless. This burns a scrypt call against a
 * fixed hash so the two paths cost the same.
 *
 * It is not exact, and cannot be: a database round trip that finds nothing is
 * shorter than one that finds a row. It removes the difference that matters,
 * which is the one measured in hundreds of milliseconds rather than in tenths
 * of one.
 */
let decoy: string | undefined
export async function spendVerificationTime(password: string): Promise<false> {
  decoy ??= await hashPassword(randomBytes(32).toString('base64url'))
  await verifyPassword(password, decoy)
  return false
}
