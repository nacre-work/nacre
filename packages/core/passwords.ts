import {
  randomBytes,
  randomInt,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto'
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

/* ─────────────────────── the gate, and why there is one ───────────────────────
 *
 * `crypto.scrypt` is asynchronous in the sense that it does not block the event
 * loop — it runs on libuv's thread pool. That pool has four threads by default,
 * and it is not the crypto pool: `dns.lookup`, `fs`, and zlib are on it too.
 *
 * So four concurrent sign-in attempts occupy the whole pool for the duration of
 * a deliberately expensive hash, and the fifth thing to want a thread waits.
 * When that thing is `getaddrinfo` for Postgres, the request path stops on a
 * name lookup — which looks like a database problem, on a dashboard, at the
 * exact moment somebody is spraying the login endpoint. Each call also holds
 * 134 MB while it runs, so the unbounded version is 134 MB times however many
 * requests arrive at once.
 *
 * The rate limiter does not cover this. It counts per email address, and an
 * attacker rotating addresses never repeats one; it counts in Redis, so it
 * fails open by design; and it runs per request while this is about how many
 * run *at the same time*, which is a different quantity. A limit of ten per
 * fifteen minutes still permits every attempt to arrive in the same second.
 *
 * ─── the numbers ───
 *
 * Two concurrent hashes, so half the default pool stays free for the DNS and
 * file I/O the rest of the process needs. Read from UV_THREADPOOL_SIZE where an
 * operator has raised it, because the point is a fraction of the pool rather
 * than the number two.
 *
 * The queue is bounded as well, and that bound is the load-shedding one: a
 * queue is cheap in memory — a waiting request holds no scrypt buffer — but an
 * unbounded one converts a flood into unbounded latency for the legitimate
 * user, who ends up behind ten thousand guesses. Past the bound the call is
 * refused immediately and the caller answers 503, which is the honest response
 * to "this process cannot verify a password right now".
 *
 * Refusing is not an oracle. It depends on how loaded the process is and not at
 * all on whether the account exists, and it is returned identically to the
 * caller whether the address matched a user or not.
 *
 * The 503 is `errors.ts`'s `tooBusy`, sent from the two error boundaries in
 * `server.ts` — sign-in is reached without a credential and everything else
 * with one, so a single catch cannot cover both. That is worth naming here
 * because this paragraph claimed "the caller answers 503" while exactly one of
 * the four routes that reach this gate did: the other three — creating a user,
 * an administrator resetting a password, and redeeming a recovery link — turned
 * a loaded process into a 500.
 */

const poolSize = Number(process.env.UV_THREADPOOL_SIZE ?? 4)
const MAX_CONCURRENT = Math.max(1, Math.floor((Number.isFinite(poolSize) ? poolSize : 4) / 2))
const MAX_QUEUED = 64

/** Raised when the process is already verifying as many passwords as it will. */
export class TooBusy extends Error {
  constructor() {
    super('too many passwords are being verified at once')
    this.name = 'TooBusy'
  }
}

let active = 0
const waiting: (() => void)[] = []

async function gated<T>(work: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    if (waiting.length >= MAX_QUEUED) throw new TooBusy()
    // Waits to be *handed* a permit, and does not increment on waking.
    //
    // The obvious version releases the permit, wakes a waiter, and lets it take
    // a slot on its own — which leaves a window between the release and the
    // waiter's turn where an arriving call sees a free slot and takes it too.
    // As it happens that window is not reachable from a single Node event loop:
    // the waiter's continuation is queued as a microtask at the moment of the
    // release, so it runs before anything that could have arrived afterwards.
    // Tried to reproduce it and could not.
    //
    // Handing the permit over regardless, because "correct, given the current
    // microtask ordering of the runtime" is a bad thing for a bound to depend
    // on, and this version does not depend on it at all: the count never
    // changes when a permit changes owner, so there is no window to reason
    // about. It is also shorter.
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    active++
  }

  try {
    return await work()
  } finally {
    // Hand the permit over rather than release it. `active` is unchanged when
    // there is a waiter, because the slot never becomes free — it changes
    // owner. One waiter per completion, so a queue drains at the rate work
    // finishes and never all at once.
    const next = waiting.shift()
    if (next === undefined) active--
    else next()
  }
}

/** For a metric and for tests. Not a decision anything makes. */
export const hashingLoad = (): { active: number; queued: number; limit: number } => ({
  active,
  queued: waiting.length,
  limit: MAX_CONCURRENT,
})

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
  const key = await gated(() =>
    scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
      N,
      r: R,
      p: P,
      maxmem: MAX_MEM,
    }),
  )
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

  const key = await gated(() =>
    scrypt(password.normalize('NFKC'), parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    }),
  )

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

/**
 * A generated password: six words and a number, from the CSPRNG.
 *
 * **Generated and never accepted**, everywhere this is used. `init` runs in a
 * terminal and an argument ends up in a shell history and in `ps`. And an
 * administrator who chooses a colleague's password knows it — "the person who
 * onboarded you can sign in as you" is not a property worth having, while a
 * value the process invented and showed once is nobody's to keep.
 *
 * Six words rather than a random string of the same strength, because this gets
 * typed into a sign-in form by a person at least once and read aloud more often
 * than anyone plans. A base64 string gets copied wrong, and the recovery from
 * that is re-running `init` against a live installation.
 *
 * ## One list, and the number is computed rather than claimed
 *
 * There were two of these — a 60-word list beside `init` and a 28-word one
 * beside the user endpoints — so the same product minted credentials at two
 * different strengths depending on which door they came through, and the
 * weaker one was the door an administrator uses to onboard a colleague. The
 * comment on the stronger one said "roughly 70 bits"; it was 41.9. Nothing
 * compared them, which is this repository's most repeated shape: a property
 * that has to hold in N places with nothing that knows N.
 *
 * So the list is one list — the union of the two, since either alone was a
 * choice somebody had already made — and `PASSWORD_ENTROPY_BITS` is derived
 * from it rather than written down. A test asserts a floor against the computed
 * value, so growing or shrinking the list cannot quietly move the strength
 * while a comment goes on saying otherwise.
 */
export const PASSWORD_WORDS = [
  'abalone', 'anchor', 'aragonite', 'aurora', 'basalt', 'beacon', 'bloom', 'bramble',
  'brine', 'calcite', 'cinder', 'clover', 'compass', 'coral', 'crest', 'current',
  'delta', 'drift', 'ember', 'estuary', 'fathom', 'ferry', 'fjord', 'granite', 'harbor',
  'harbour', 'haven', 'iridescent', 'iris', 'keel', 'kelp', 'lagoon', 'lantern',
  'ledger', 'lichen', 'lustre', 'mantle', 'marlin', 'meadow', 'mica', 'nacre',
  'nautilus', 'obsidian', 'onyx', 'opal', 'orbit', 'pearl', 'pelagic', 'pillar',
  'plover', 'prism', 'quarry', 'quartz', 'reef', 'ripple', 'salt', 'sextant', 'shale',
  'shoal', 'silt', 'slate', 'sound', 'spindrift', 'stratum', 'tide', 'trawler',
  'trench', 'vellum', 'wharf', 'willow', 'zephyr',
] as const

/** Words in a generated password. */
export const PASSWORD_WORD_COUNT = 6

/** The two-digit suffix, `10`–`99`. */
const SUFFIX_RANGE = 90

/**
 * What one of these is actually worth, from the list rather than from a memory.
 *
 * Online guessing against `/v1/auth/login` is bounded three ways already — per
 * address, per client, and by the cap on concurrent scrypt calls — so this
 * number is about the offline case: somebody holding the `password_hash`
 * column. scrypt at OWASP's minimum over this much true entropy is the claim,
 * and stating it exactly is what lets the next person judge it.
 */
export const PASSWORD_ENTROPY_BITS =
  PASSWORD_WORD_COUNT * Math.log2(PASSWORD_WORDS.length) + Math.log2(SUFFIX_RANGE)

export function generatePassword(): string {
  // randomInt rather than Math.random or a modulo of randomBytes: one is not a
  // CSPRNG and the other is biased unless the range divides evenly.
  const chosen = Array.from(
    { length: PASSWORD_WORD_COUNT },
    () => PASSWORD_WORDS[randomInt(PASSWORD_WORDS.length)],
  )
  return `${chosen.join('-')}-${String(randomInt(10, 10 + SUFFIX_RANGE))}`
}
