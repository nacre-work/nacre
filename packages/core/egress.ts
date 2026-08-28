/**
 * Whether a tenant-supplied embedder endpoint is one the worker may POST to.
 *
 * ## The hole this closes
 *
 * `POST /v1/embedding-providers` takes an `endpoint` from an `org_admin`, and
 * the worker then POSTs every chunk of every document in that layer to it. That
 * is the *feature* — "point a provider at your own embedder" — and it is also,
 * unguarded, an exfiltration channel with a request body: an administrator can
 * name `http://169.254.169.254/…`, the cloud metadata endpoint, or the API next
 * to the worker, or the vector store, and read the answer back as document text.
 *
 * The parser sidecar has carried a private-address guard for tenant-supplied
 * URLs since it existed, behind `NACRE_PARSER_ALLOW_PRIVATE_URLS`, and this path
 * — which sends document *contents* rather than fetching them — had none. That
 * asymmetry is the defect; this is the parser's guard on the other surface, in
 * the language that surface is written in.
 *
 * ## The rule, which is the operator's
 *
 * A deployment names its embedder in configuration —
 * `NACRE_DEFAULT_EMBEDDING_ENDPOINT`, often an internal single-label host like
 * `http://embedder:80` in a Compose profile, or the embedding adapter that
 * fronts a cloud vendor. Those origins are the operator's decision and are
 * admitted **as written**, by exact origin match, without resolving — because
 * resolving `embedder` gives a private address the rest of this guard refuses,
 * and the operator naming it is the whole point.
 *
 * Any *other* endpoint is the "your own embedder" case, and it must be
 * `https://` to a **globally routable** host: the document text leaves the
 * installation either way, so the least it can be is encrypted in transit and
 * pointed somewhere that is not the deployment's own private network. A public
 * name that resolves to a private address is the trick this exists against, so
 * every address the name answers with is checked, not the first.
 *
 * ## Not covered, and said rather than hidden
 *
 * DNS rebinding, exactly as the parser documents it: this resolves at *create*
 * time and the worker resolves again at *fetch* time, so a name that answers
 * differently twice can still get through. The enforcement point is the stored
 * row — a row that cannot name a private host is a worker that cannot be pointed
 * at one — and closing the rebinding gap means the worker connecting to a
 * validated address while carrying the hostname for TLS, which is a change on
 * the fetch path and not here.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** A resolver, so a test can answer without a network. Matches `dns.lookup`'s
 * `{ all: true }` shape: every address a name resolves to. */
export type AddressResolver = (host: string) => Promise<readonly { address: string }[]>

const defaultResolver: AddressResolver = async (host) =>
  dnsLookup(host, { all: true, verbatim: true })

export type EndpointVerdict = 'ok' | { readonly refused: string }

/**
 * The origin of a configured endpoint, or `undefined` if it is not a usable
 * http(s) URL. `http://embedder:80` and `http://embedder` are the same origin,
 * because a `URL`'s `origin` drops the default port.
 */
export function endpointOrigin(endpoint: string): string | undefined {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (url.host === '') return undefined
  return url.origin
}

/**
 * Whether an IP literal is globally routable.
 *
 * This is the subset of Python's `ipaddress.is_global` that matters for egress
 * — the ranges a tenant must not be able to reach — rather than a re-derivation
 * of the whole table. The parser's header names the list as "the thing that
 * gets an entry missed", so the blocks here are the security-relevant ones and
 * they are pinned as tests: loopback, the cloud metadata address, every private
 * range, and their IPv6 equivalents including IPv4-mapped addresses.
 */
export function isGlobalAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return isGlobalV4(address)
  if (kind === 6) return isGlobalV6(address)
  // Not an IP literal at all — a name reached here would be unresolved, which
  // the caller treats as a refusal rather than passing to this.
  return false
}

function isGlobalV4(address: string): boolean {
  const parts = address.split('.').map((p) => Number(p))
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false
  }
  const [a, b] = parts as [number, number, number, number]
  if (a === 0) return false // 0.0.0.0/8 "this network"
  if (a === 10) return false // private
  if (a === 127) return false // loopback
  if (a === 169 && b === 254) return false // link-local — the metadata endpoint
  if (a === 172 && b >= 16 && b <= 31) return false // private
  if (a === 192 && b === 168) return false // private
  if (a === 100 && b >= 64 && b <= 127) return false // CGNAT 100.64/10
  if (a === 192 && b === 0 && parts[2] === 0) return false // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking 198.18/15
  if (a >= 224) return false // multicast 224/4 and reserved 240/4, 255.255.255.255
  return true
}

function isGlobalV6(address: string): boolean {
  const lower = address.toLowerCase()
  // An IPv4-mapped address (::ffff:a.b.c.d or ::ffff:aabb:ccdd) is only as
  // global as the v4 address inside it — mapping the metadata endpoint is the
  // trick this catches.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)
  if (mapped?.[1] !== undefined) return isGlobalV4(mapped[1])
  if (lower === '::1' || lower === '::') return false // loopback, unspecified
  if (lower.startsWith('fe8') || lower.startsWith('fe9') ||
      lower.startsWith('fea') || lower.startsWith('feb')) return false // fe80::/10 link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false // fc00::/7 unique-local
  if (lower.startsWith('ff')) return false // ff00::/8 multicast
  return true
}

/**
 * The verdict on a tenant-supplied embedder endpoint.
 *
 * `allowedOrigins` are the operator-configured embedder origins — admitted as
 * written, whatever they resolve to. Everything else must be https to a host
 * that resolves entirely to global addresses.
 */
export async function admitEmbeddingEndpoint(
  endpoint: string,
  allowedOrigins: readonly string[],
  resolver: AddressResolver = defaultResolver,
): Promise<EndpointVerdict> {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return { refused: "'endpoint' must be an absolute http(s) URL." }
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.host === '') {
    return { refused: "'endpoint' must be an absolute http(s) URL." }
  }

  // The operator's own embedder, named in configuration. Admitted as written —
  // it is typically an internal host, and refusing it would refuse every
  // Compose profile this product ships.
  if (allowedOrigins.includes(url.origin)) return 'ok'

  // Otherwise this is the "point at your own embedder" case, and the text of
  // the documents leaves the installation. The least it can be is encrypted.
  if (url.protocol !== 'https:') {
    return {
      refused:
        "'endpoint' must be https unless it is the embedder this installation " +
        'is configured with. Document text is sent to it, so a plaintext ' +
        'endpoint would put that text on the wire in the clear.',
    }
  }

  // A literal address is checked directly; a name is resolved and every address
  // it answers with is checked, because one public and one private is the trick.
  const host = url.hostname
  if (isIP(host) !== 0) {
    return isGlobalAddress(host)
      ? 'ok'
      : { refused: refusalFor() }
  }

  let addresses: readonly { address: string }[]
  try {
    addresses = await resolver(host)
  } catch {
    return { refused: "'endpoint' does not resolve." }
  }
  if (addresses.length === 0) return { refused: "'endpoint' does not resolve." }
  if (!addresses.every((a) => isGlobalAddress(a.address))) {
    return { refused: refusalFor() }
  }
  return 'ok'
}

function refusalFor(): string {
  return (
    "'endpoint' resolves to an address inside this installation's own network. " +
    'Only the embedder named in configuration may be an internal host; any ' +
    'other endpoint must be a public https address, because document text is ' +
    'sent to it.'
  )
}
