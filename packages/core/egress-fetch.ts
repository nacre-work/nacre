/**
 * A `fetch` that cannot be steered into this installation's own network.
 *
 * `admitEmbeddingEndpoint` judges a tenant's endpoint when the row is written,
 * and its header said what that leaves open: the worker resolves the name
 * again when it sends, so a name that answers with a public address to the
 * check and a private one to the request — DNS rebinding, a TTL of zero is all
 * it takes — reaches the metadata endpoint with every check green. A row
 * written before 0.26.0, when there was no check at all, reaches it with no
 * trick whatsoever.
 *
 * So the address is judged where it is **used**: the connection's own lookup
 * resolves the name, refuses if any answer is not globally routable, and hands
 * the socket the address it has just judged. There is no second resolution for
 * a rebinding to land in, because the check and the connect share one answer.
 * TLS still verifies the certificate against the hostname, since the lookup
 * replaces only the address and never the name the handshake presents.
 *
 * Two things the lookup cannot see, both handled before it runs. An IP literal
 * never reaches a lookup — the socket connects to it directly — so a literal is
 * judged here, after the URL parser has already turned `2130706433`, `0x7f.1`
 * and `0177.0.0.1` into the dotted form the classifier reads. And a redirect is
 * refused rather than followed: the guard would hold on the next hop too, but a
 * 3xx from an embedding endpoint is not something any vendor sends, and
 * following one is how a request ends up somewhere nobody wrote down.
 *
 * Trusted origins — the embedder the operator configured, which is typically
 * an internal host like `http://embedder:80` — go through the ordinary `fetch`,
 * because refusing them would refuse every Compose profile this product ships.
 * The trust is an exact origin, never a hostname suffix.
 */

import { lookup as dnsLookup } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

import { Agent, fetch as undiciFetch } from 'undici'

import { isGlobalAddress } from './egress.js'

/** Thrown, or carried as the `cause` of the transport error, when the guard refuses. */
export class EgressRefused extends Error {
  readonly code = 'EGRESS_REFUSED'
  constructor(host: string, address?: string) {
    super(
      address === undefined
        ? `refused to connect to ${host}: it is not a public address`
        : `refused to connect to ${host}: it resolves to ${address}, which is not a public address`,
    )
    this.name = 'EgressRefused'
  }
}

interface LookupAddress {
  readonly address: string
  readonly family: number
}

/** Every address a name resolves to. A seam, so a test can rebind without a network. */
export type LookupAll = (hostname: string) => Promise<readonly LookupAddress[]>

const systemLookupAll: LookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses),
    )
  })

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | readonly LookupAddress[],
  family?: number,
) => void

/**
 * A `lookup` for `net.connect` that admits only globally routable addresses.
 *
 * Every answer is judged and one bad answer refuses the whole name: picking the
 * public one out of a mixed set would leave which address the socket actually
 * uses to the order a resolver returns them in.
 */
export function publicOnlyLookup(lookupAll: LookupAll = systemLookupAll): LookupFunction {
  const lookup = (
    hostname: string,
    options: { family?: number | string | undefined; all?: boolean | undefined } | number | undefined,
    callback: LookupCallback,
  ): void => {
    const opts = typeof options === 'object' && options !== null ? options : {}
    const wanted = typeof options === 'number' ? options : Number(String(opts.family ?? 0).replace('IPv', ''))
    lookupAll(hostname).then(
      (answers) => {
        const refused = answers.find((a) => !isGlobalAddress(a.address))
        if (refused !== undefined) {
          callback(new EgressRefused(hostname, refused.address), '')
          return
        }
        const usable = wanted === 4 || wanted === 6 ? answers.filter((a) => a.family === wanted) : answers
        const first = usable[0]
        if (first === undefined) {
          const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`)
          error.code = 'ENOTFOUND'
          callback(error, '')
          return
        }
        if (opts.all === true) callback(null, usable)
        else callback(null, first.address, first.family)
      },
      (error: NodeJS.ErrnoException) => callback(error, ''),
    )
  }
  return lookup as unknown as LookupFunction
}

export interface EgressPolicy {
  /** Exact origins that are the operator's own and are fetched as written. */
  readonly trustedOrigins: readonly string[]
  /** Only for tests. */
  readonly lookupAll?: LookupAll
}

const agents = new WeakMap<LookupAll, Agent>()
let systemAgent: Agent | undefined

function guardedAgent(lookupAll: LookupAll | undefined): Agent {
  if (lookupAll === undefined) {
    systemAgent ??= new Agent({ connect: { lookup: publicOnlyLookup() } })
    return systemAgent
  }
  let agent = agents.get(lookupAll)
  if (agent === undefined) {
    agent = new Agent({ connect: { lookup: publicOnlyLookup(lookupAll) } })
    agents.set(lookupAll, agent)
  }
  return agent
}

/** The refusal inside a transport error, if that is what it was. */
function refusalIn(error: unknown): EgressRefused | undefined {
  for (let e: unknown = error, depth = 0; e !== undefined && e !== null && depth < 5; depth += 1) {
    if (e instanceof EgressRefused) return e
    e = (e as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * `fetch`, confined to the public network unless the origin is trusted.
 *
 * Redirects are refused on both paths. A refusal is thrown as
 * {@link EgressRefused} itself rather than as the transport's `fetch failed`,
 * so the stored failure says what happened.
 */
export async function egressFetch(
  input: string | URL,
  init: RequestInit,
  policy: EgressPolicy,
): Promise<Response> {
  const url = new URL(input)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`refused to fetch ${url.protocol} — only http(s) is supported`)
  }
  if (policy.trustedOrigins.includes(url.origin)) {
    return fetch(url, { ...init, redirect: 'error' })
  }

  // A literal never reaches the lookup; the URL parser has already normalised
  // decimal, octal and hex spellings into the dotted form, and a bracketed v6
  // host is unwrapped here.
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname
  if (isIP(host) !== 0 && !isGlobalAddress(host)) throw new EgressRefused(host)

  try {
    const response = await undiciFetch(url, {
      ...(init as unknown as Parameters<typeof undiciFetch>[1]),
      redirect: 'error',
      dispatcher: guardedAgent(policy.lookupAll),
    })
    // undici's Response is the same class the runtime's fetch returns, from a
    // newer copy; the shape callers read — status, headers, json, text — is the
    // standard one.
    return response as unknown as Response
  } catch (error) {
    throw refusalIn(error) ?? error
  }
}
