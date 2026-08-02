import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/**
 * Which client a request came from, for the one limit that cannot be keyed on
 * anything else.
 *
 * Every other limit in this API is per organization, which is the right key
 * because a per-credential limit is bypassed by minting another credential. The
 * login endpoint has no organization yet, so it is keyed on the email address —
 * and that bounds guessing at *one* account and nothing else. An attacker
 * spraying one password across ten thousand addresses never repeats a key and
 * never meets the limit, which is the shape most real credential-stuffing takes.
 *
 * So the source gets a limit too, and the two run together: the address limit
 * stops one account being ground down, the source limit stops one client
 * grinding down the whole directory.
 *
 * ## Why the proxy has to be configured
 *
 * `X-Forwarded-For` is a request header. Trusting it unconditionally means the
 * limit is keyed on a string the attacker picks, and a fresh value per request
 * makes it worse than no limit at all — it costs a Redis round trip to
 * accomplish nothing. Ignoring it unconditionally is wrong in the other
 * direction: behind an ingress every request carries the proxy's address, so
 * one bad client would rate-limit every user of the deployment.
 *
 * Neither default is safe, so it is configuration, and it defaults to not
 * trusting anything. `NACRE_TRUST_PROXY` is the number of proxies in front of
 * this process — 0 means the socket address is the client, 1 means take the
 * last entry of `X-Forwarded-For`, 2 the second from last.
 *
 * **Counted from the right, not the left.** The left-hand entries are whatever
 * the client sent; each proxy *appends*, so the rightmost entries are the ones
 * added by infrastructure that cannot be forged from outside. Reading
 * `xff[0]` — which is the common shorthand — reads exactly the attacker's
 * value. A misconfigured count is a bounded error either way: too low keys on a
 * proxy's address and over-restricts, too high keys on a forgeable value and
 * under-restricts, and neither can be worse than the default of not trusting
 * headers at all.
 */

export interface SourceOptions {
  /** Number of trusted proxies in front of this process. 0 disables the header. */
  readonly trustProxy: number
}

/**
 * A stable, low-cardinality identifier for the client.
 *
 * Returns `undefined` when there is nothing to key on — a socket with no
 * address, which happens on some unix-socket and test transports. The caller
 * treats that as "no source limit", never as one shared bucket: a single bucket
 * for every unidentifiable client is a denial of service with extra steps.
 */
export function clientSource(req: IncomingMessage, options: SourceOptions): string | undefined {
  if (options.trustProxy > 0) {
    const header = req.headers['x-forwarded-for']
    const raw = Array.isArray(header) ? header.join(',') : header
    if (typeof raw === 'string' && raw.trim() !== '') {
      const hops = raw
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h !== '')
      // From the right. See the note above — the leftmost entry is the one the
      // client chose, and the rightmost `trustProxy` entries are the ones added
      // by infrastructure.
      const index = hops.length - options.trustProxy
      const candidate = hops[Math.max(0, index)]
      if (candidate !== undefined) return normalize(candidate)
    }
    // Configured to trust a proxy and got no header. Falling through to the
    // socket is right: it means the request did not come through the proxy, and
    // the socket address is then the only thing that is true.
  }

  const address = req.socket.remoteAddress
  return address === undefined ? undefined : normalize(address)
}

/**
 * Fold an address to the unit a limit should count.
 *
 * IPv6 goes to its /64, because that is what a single subscriber is handed:
 * counting whole addresses there means an attacker with one allocation has
 * 18 quintillion buckets and the limit does not exist. IPv4 is counted whole —
 * folding to a /24 would put a small office behind one bucket.
 *
 * The `::ffff:` mapped form is unwrapped first, or the same client reaches two
 * different buckets depending on whether the listener is dual-stack.
 */
function normalize(address: string): string {
  // The zone index (`%eth0`) is link-local routing information, not part of the
  // address, and it is never the same between two hosts.
  const bare = (address.split('%')[0] ?? address).toLowerCase()
  const mapped = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare
  // IPv4, or something with no colons in it at all — which is what a forged
  // header usually is. Bounded on the way out for the same reason the
  // unparseable IPv6 path is: with `trustProxy` set this string came from a
  // request header. Returning it raw is how an unauthenticated caller writes a
  // key of any length it likes.
  if (!mapped.includes(':')) return bounded(mapped)

  const groups = expand(mapped)
  // Unparseable. Kept as its own key rather than guessed at — inventing a
  // prefix for something that is not an address would merge unrelated clients —
  // but bounded first, which matters once `trustProxy` is set: from that point
  // the value comes from a header, on an unauthenticated request, and an
  // unbounded string from there must not become a Redis key. A megabyte of
  // `X-Forwarded-For` is a cheap way to fill somebody's cache.
  if (groups === undefined) return bounded(mapped)

  return `${groups.slice(0, 4).join(':')}::/64`
}

/** 45 characters is the longest an address can be. Past that it is not one. */
const MAX_ADDRESS = 45

/**
 * Anything that is not plausibly an address becomes a digest of itself.
 *
 * A digest rather than a truncation, because truncating collapses every long
 * value sharing a prefix into one bucket — which is a way to rate-limit other
 * people by picking their prefix.
 */
function bounded(value: string): string {
  if (value.length <= MAX_ADDRESS && /^[0-9a-f:.]+$/.test(value)) return value
  return `x:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`
}

/**
 * The eight groups of an IPv6 address, with `::` expanded and each group
 * stripped of leading zeros.
 *
 * The expansion has to be real. `fe80::1` splits on `:` into three pieces and
 * the `1` belongs to the *end* of the address, so treating the pieces as
 * positions puts it at index 2 and gives `fe80:0:1:0` — a different /64 from
 * `fe80::2`, when the two are the same subscriber. Zeros go in the middle;
 * that is what the notation means.
 */
function expand(address: string): readonly string[] | undefined {
  const halves = address.split('::')
  if (halves.length > 2) return undefined

  const part = (s: string | undefined): string[] =>
    s === undefined || s === '' ? [] : s.split(':')

  const left = part(halves[0])
  if (halves.length === 1) {
    return left.length === 8 ? left.map(trim) : undefined
  }

  const right = part(halves[1])
  const zeros = 8 - left.length - right.length
  if (zeros < 1) return undefined

  return [...left, ...Array<string>(zeros).fill('0'), ...right].map(trim)
}

/** `0db8` and `db8` are the same group; two spellings must not be two buckets. */
const trim = (group: string): string => group.replace(/^0+(?=.)/, '')
