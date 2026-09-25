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
 * ## The half this cannot do, and where it is done
 *
 * DNS rebinding: this resolves at *create* time and the worker resolves again
 * at *fetch* time, so a name that answers differently twice gets through a
 * check that stands alone — and a row written before 0.26.0, when there was no
 * check, needs no trick at all. Since 0.26.3 that half is `egressFetch`
 * (`egress-fetch.ts`): every embedding request to an endpoint that is not the
 * installation's own is judged at connect time, by the address the socket
 * actually dials. This file is the early refusal with a readable message; that
 * one is the guarantee.
 */

import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

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
 * Two parts, and the split is the point. The ranges are a `BlockList` — the
 * runtime's own prefix matcher, so a range is written once as CIDR and never
 * as a hand-rolled comparison of octets. And every IPv6 form that *carries* an
 * IPv4 address is decoded first and judged as that address, because each of
 * them is a way to spell the metadata endpoint that a v6 range table does not
 * see: IPv4-mapped (`::ffff:169.254.169.254` and `::ffff:a9fe:a9fe`, which are
 * the same address — the first version of this matched only the dotted
 * spelling), IPv4-compatible (`::169.254.169.254`), 6to4 (`2002:a9fe:a9fe::`)
 * and NAT64 (`64:ff9b::a9fe:a9fe`). Decoding rather than refusing 6to4
 * wholesale is deliberate: an address there is as public as the v4 inside it.
 *
 * The ranges are the security-relevant subset of IANA's special-purpose
 * registries — every block a tenant must not reach — and they are pinned as
 * tests, since the list is the thing that gets an entry missed.
 */
export function isGlobalAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) return !NON_GLOBAL_V4.check(address, 'ipv4')
  if (kind !== 6) {
    // Not an IP literal at all — a name reached here would be unresolved,
    // which the caller treats as a refusal rather than passing to this.
    return false
  }
  // A zone id (`fe80::1%eth0`) only ever qualifies a link-local address.
  if (address.includes('%')) return false
  const words = ipv6Words(address)
  if (words === undefined) return false
  const embedded = embeddedV4(words)
  if (embedded !== undefined) return !NON_GLOBAL_V4.check(embedded, 'ipv4')
  return !NON_GLOBAL_V6.check(address, 'ipv6')
}

// Two lists and never one: a `BlockList` holding `::ffff:0:0/96` answers true
// for *every* IPv4 address checked against it, because it matches v4 through
// the mapped range — measured, and the first version of this refused 8.8.8.8.
const NON_GLOBAL_V4 = (() => {
  const list = new BlockList()
  const v4: readonly [string, number][] = [
    ['0.0.0.0', 8], // "this network"
    ['10.0.0.0', 8], // private
    ['100.64.0.0', 10], // carrier-grade NAT
    ['127.0.0.0', 8], // loopback
    ['169.254.0.0', 16], // link-local — the metadata endpoint
    ['172.16.0.0', 12], // private
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay anycast
    ['192.168.0.0', 16], // private
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved, and 255.255.255.255
  ]
  for (const [net, prefix] of v4) list.addSubnet(net, prefix, 'ipv4')
  return list
})()

const NON_GLOBAL_V6 = (() => {
  const list = new BlockList()
  const v6: readonly [string, number][] = [
    ['::', 96], // unspecified, loopback, and IPv4-compatible (decoded above)
    ['::ffff:0:0', 96], // IPv4-mapped (decoded above; here if decoding is ever skipped)
    ['64:ff9b:1::', 48], // local-use NAT64
    ['100::', 64], // discard-only
    ['2001::', 23], // IETF protocol assignments, Teredo among them
    ['2001:db8::', 32], // documentation
    ['3fff::', 20], // documentation
    ['5f00::', 16], // segment routing
    ['fc00::', 7], // unique-local
    ['fe80::', 10], // link-local
    ['fec0::', 10], // site-local, deprecated and still routed by some stacks
    ['ff00::', 8], // multicast
  ]
  for (const [net, prefix] of v6) list.addSubnet(net, prefix, 'ipv6')
  return list
})()

/** The eight 16-bit words of an IPv6 literal, or `undefined` if it is not one. */
function ipv6Words(address: string): number[] | undefined {
  let text = address.toLowerCase()
  // A trailing dotted quad is the last two words; rewritten as hex so there is
  // one grammar below.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (dotted !== null) {
    const octets = dotted.slice(1).map(Number)
    if (octets.some((n) => n > 255)) return undefined
    const [a, b, c, d] = octets as [number, number, number, number]
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? parseInt(w, 16) : NaN))
  const head = parse(halves[0] ?? '')
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : []
  const known = head.length + rest.length
  if (halves.length === 1 ? known !== 8 : known > 7) return undefined
  const words = [...head, ...new Array<number>(8 - known).fill(0), ...rest]
  return words.some((w) => Number.isNaN(w)) ? undefined : words
}

/** The IPv4 address an IPv6 one carries, where its prefix says it carries one. */
function embeddedV4(w: readonly number[]): string | undefined {
  const quad = (hi: number, lo: number) => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0)
  // ::ffff:a.b.c.d — IPv4-mapped
  if (zero(0, 5) && w[5] === 0xffff) return quad(w[6]!, w[7]!)
  // ::a.b.c.d — IPv4-compatible, except :: and ::1 themselves
  if (zero(0, 6) && !(w[6] === 0 && (w[7] === 0 || w[7] === 1))) return quad(w[6]!, w[7]!)
  // 64:ff9b::a.b.c.d — well-known NAT64
  if (w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6)) return quad(w[6]!, w[7]!)
  // 2002:aabb:ccdd::/48 — 6to4
  if (w[0] === 0x2002) return quad(w[1]!, w[2]!)
  return undefined
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
