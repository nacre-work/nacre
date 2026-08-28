/**
 * Whether a tenant-supplied embedder endpoint is one the worker may POST to.
 *
 * ## The hole this closes, and the one it does not
 *
 * `POST /v1/embedding-providers` takes an `endpoint` and is gated on
 * **`org_admin`**, and that role is the whole of the threat model — so it is
 * worth being exact. In the open core there is one organization, so its
 * `org_admin` is the operator: they own the documents already, and pointing the
 * worker at an endpoint of their choosing takes nothing from anyone. An earlier
 * version of this header called it "an exfiltration channel with a request
 * body", which was wrong — the document text sent is the caller's own, and
 * there is nobody to take it from.
 *
 * The real hole is in **multi-tenancy**, where `org_admin` administers **one
 * tenant** and not the installation. The worker is a single, installation-owned
 * process on the internal network. A tenant admin who can make it POST to
 * `http://169.254.169.254/…`, the API beside it, or the vector store — which
 * has no per-tenant authorization of its own — holds an SSRF primitive: at
 * minimum a blind request from a privileged position, and plausibly a partial
 * read oracle, because `endpointReason` surfaces the response as
 * `documents.error`. Cloud metadata credentials are installation-wide, so that
 * is a tenant→installation escalation performed by somebody entitled to
 * administer one customer's data and nothing else. In the single-organization
 * case it is defence in depth against a leaked `org_admin` token, and little
 * more.
 *
 * The installation *default* — the `platform_admin` "Installation" screen that
 * writes the global provider row — is a different, un-gated path on purpose:
 * that role administers the installation and is trusted with the internal
 * network. This guard is on the tenant-scoped write, and the default's origin
 * is exactly what it admits below.
 *
 * The parser sidecar has carried a private-address guard for tenant-supplied
 * URLs since it existed, behind `NACRE_PARSER_ALLOW_PRIVATE_URLS`; the
 * asymmetry was that this path had none. This is that guard on the other
 * surface, in the language that surface is written in.
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
 * `https://` to a **globally routable** host: an internal address is where the
 * SSRF value lives, so a non-configured endpoint is confined to the public
 * network, and encrypted because a tenant's own document text does travel to it.
 * A public name that resolves to a private address is the trick this exists
 * against, so every address the name answers with is checked, not the first.
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
  if (a === 192 && b === 0 && parts[2] === 0) return false // 192.0.0/24 IETF protocol
  if (a === 192 && b === 0 && parts[2] === 2) return false // TEST-NET-1 192.0.2/24
  if (a === 198 && b === 51 && parts[2] === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return false // TEST-NET-3
  if (a === 192 && b === 88 && parts[2] === 99) return false // 6to4 relay anycast
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
  // NAT64 (64:ff9b::/96 and 64:ff9b:1::/48) embeds a v4 address in its low
  // bits — `64:ff9b::a9fe:a9fe` is the metadata endpoint by another spelling.
  // Refused wholesale rather than decoded: a public host never resolves to a
  // NAT64 address (it is an on-network translation prefix), and decoding the
  // embedded v4 through IPv6 zero-compression is exactly the fragile parsing
  // this guard avoids.
  if (lower.startsWith('64:ff9b:')) return false
  if (lower === '::1' || lower === '::') return false // loopback, unspecified
  if (lower.startsWith('2001:db8')) return false // documentation 2001:db8::/32
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
 * written, whatever they resolve to. Everything a *tenant* supplies is held to
 * the strict form: `https://`, a **hostname** and not an IP literal, and every
 * address that name resolves to globally routable.
 *
 * The IP-literal refusal is deliberate and does more than the resolve check.
 * A legitimate "your own embedder" is a public API behind a DNS name — OpenAI,
 * a cloud GPU, a hosted TEI — never a bare address. Refusing literals closes
 * the obfuscations a range check keeps missing: decimal (`http://2130706433`),
 * octal (`http://0177.0.0.1`), hex, and `[::ffff:a.b.c.d]` bracket forms, none
 * of which a URL parser normalises the way a range check expects. The
 * operator's own embedder can still be an address, because it is matched by
 * exact origin against `allowedOrigins` before any of this.
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
  // Compose profile this product ships. This is the only path an internal
  // address reaches 'ok'.
  if (allowedOrigins.includes(url.origin)) return 'ok'

  // Everything below is a tenant's "point at your own embedder". Document text
  // travels to it, so https; a plaintext hop would put it on the wire in the
  // clear.
  if (url.protocol !== 'https:') {
    return {
      refused:
        "'endpoint' must be https unless it is the embedder this installation " +
        'is configured with, so document text is not sent in the clear.',
    }
  }

  // No IP literals. A public embedder is a DNS name; a literal is either an
  // internal address or an obfuscation of one, and both are refused here rather
  // than range-checked, because the URL parser's idea of an address and a range
  // check's do not agree on the octal/decimal/hex spellings.
  const host = url.hostname
  const bracketed = host.startsWith('[') && host.endsWith(']')
  if (isIP(host) !== 0 || isIP(bracketed ? host.slice(1, -1) : host) !== 0) {
    return { refused: refusalFor(true) }
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

function refusalFor(literal = false): string {
  return literal
    ? "'endpoint' must be a hostname, not an IP address. Only the embedder named " +
        'in configuration may be given as an address; any other endpoint is a ' +
        'public https URL, because document text is sent to it.'
    : "'endpoint' resolves to an address inside this installation's own network. " +
        'Only the embedder named in configuration may be an internal host; any ' +
        'other endpoint must be a public https address, because document text is ' +
        'sent to it.'
}
