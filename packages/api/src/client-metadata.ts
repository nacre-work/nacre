/**
 * Client ID Metadata Documents: a client whose `client_id` is the URL of a JSON
 * document describing it.
 *
 * Beside registration (RFC 7591), never instead of it. A client that prefers
 * this — the MCP SDK does whenever the authorization server's metadata says
 * `client_id_metadata_document_supported` and the client has a document — no
 * longer has to post itself to every installation it connects to, and the
 * consent screen gets something registration cannot give it: a domain that
 * served the document, where a registered client offers only a name it chose.
 *
 * ## The fetch is the risk, and it goes through the egress guard
 *
 * The URL comes from somebody who has not signed in, so this is an outbound
 * request an anonymous caller chose. `egressFetch` is what makes that
 * acceptable: the name is resolved at connect time and refused if any address
 * it answers with is not globally routable — loopback, private ranges, the
 * metadata endpoint, every IPv6 spelling of them — and a redirect is refused
 * rather than followed. On top of that the fetch here is bounded in time and
 * size, only an https URL with a path is ever fetched, a document is cached
 * rather than fetched per request, and a cache miss spends the caller's
 * `client_registration` budget, the same one `POST /oauth/register` spends.
 *
 * ## What the document must say
 *
 * Its own URL as `client_id`, byte for byte — or one document could vouch for
 * another client — a non-empty `redirect_uris` that each pass the rule a
 * registration's do, and no client authentication: this server issues public
 * clients only, PKCE is what binds the exchange, and a document asking for
 * `private_key_jwt` is refused by name rather than accepted and ignored.
 */

import { egressFetch, type EgressPolicy } from '@nacre.work/core'

/** Bytes a document may be. A client's metadata is a few hundred; five kilobytes is generous. */
export const MAX_DOCUMENT_BYTES = 5 * 1024
/** How long the fetch may take, end to end. */
export const FETCH_TIMEOUT_MS = 5_000
/** Bounds on how long a document is trusted before it is fetched again. */
export const MIN_CACHE_SECONDS = 300
export const MAX_CACHE_SECONDS = 86_400
export const DEFAULT_CACHE_SECONDS = 3_600
/** A `client_id` URL longer than this is refused before anything is fetched. */
const MAX_URL_LENGTH = 512

/**
 * Whether a `client_id` names a metadata document rather than a registration.
 *
 * The shape the specification requires and nothing looser: https, a path that
 * is more than `/`, no fragment and no credentials. And **canonical**: the id
 * must be exactly what the URL parser makes of it, which is what rules out a
 * `.` or `..` segment, a default port written out, an upper-case host — every
 * spelling where a normalising fetcher and the byte comparison against the
 * document's own `client_id` would disagree about which client this is.
 */
export function isMetadataClientId(clientId: string): boolean {
  if (clientId.length > MAX_URL_LENGTH || !clientId.startsWith('https://')) return false
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return false
  }
  if (url.href !== clientId) return false
  if (url.username !== '' || url.password !== '' || url.hash !== '' || clientId.includes('#')) return false
  return url.pathname !== '' && url.pathname !== '/'
}

/** Seconds to trust a document for, from its `Cache-Control`, inside the bounds. */
export function cacheSeconds(cacheControl: string | null): number {
  if (cacheControl === null) return DEFAULT_CACHE_SECONDS
  const directives = cacheControl.toLowerCase().split(',').map((d) => d.trim())
  if (directives.includes('no-store') || directives.includes('no-cache')) return MIN_CACHE_SECONDS
  const maxAge = directives.find((d) => d.startsWith('max-age='))
  if (maxAge === undefined) return DEFAULT_CACHE_SECONDS
  const seconds = Number(maxAge.slice('max-age='.length))
  if (!Number.isFinite(seconds)) return DEFAULT_CACHE_SECONDS
  return Math.min(MAX_CACHE_SECONDS, Math.max(MIN_CACHE_SECONDS, Math.floor(seconds)))
}

export interface MetadataClient {
  readonly clientName: string
  readonly redirectUris: readonly string[]
}

/**
 * A fetched document, judged. Pure, so every refusal can be asked directly.
 *
 * `redirectAllowed` is passed in rather than imported so this file and the
 * registration endpoint cannot hold two ideas of which redirect URIs are
 * acceptable.
 */
export function validateMetadataDocument(
  clientId: string,
  document: unknown,
  redirectAllowed: (uri: string, registered: readonly string[]) => boolean,
): MetadataClient | { readonly refusal: string } {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { refusal: 'the client metadata document is not a JSON object' }
  }
  const doc = document as Record<string, unknown>
  if (doc.client_id !== clientId) {
    return { refusal: 'the client metadata document names a different client_id than the URL it was fetched from' }
  }
  const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : []
  if (uris.length === 0 || uris.length > 20 || !uris.every((u): u is string => typeof u === 'string' && u.length <= 512)) {
    return { refusal: 'the client metadata document has no usable redirect_uris' }
  }
  if (!uris.every((u) => redirectAllowed(u, uris))) {
    return {
      refusal:
        'every redirect URI in the client metadata document must be https, or http on loopback (127.0.0.1, [::1], localhost)',
    }
  }
  const auth = doc.token_endpoint_auth_method
  if (auth !== undefined && auth !== 'none') {
    return {
      refusal: `the client metadata document asks for token_endpoint_auth_method "${String(auth).slice(0, 40)}"; this server issues public clients only and binds the exchange with PKCE`,
    }
  }
  if (Array.isArray(doc.grant_types) && !doc.grant_types.includes('authorization_code')) {
    return { refusal: 'the client metadata document does not ask for the authorization_code grant' }
  }
  const name =
    typeof doc.client_name === 'string' && doc.client_name.trim() !== ''
      ? doc.client_name.trim().slice(0, 200)
      : new URL(clientId).host
  return { clientName: name, redirectUris: uris }
}

/** A fetch with the guard's signature, so a case can stand one in. */
export type GuardedFetch = (input: string, init: RequestInit, policy: EgressPolicy) => Promise<Response>

export type FetchedMetadata =
  | { readonly client: MetadataClient; readonly ttlSeconds: number }
  | { readonly refusal: string }

/**
 * Fetch a client's document through the egress guard, bounded, and judge it.
 *
 * Every failure is a sentence, because it is shown to whoever is setting the
 * client up and "unknown client" would send them looking in the wrong place.
 */
export async function fetchClientMetadata(
  clientId: string,
  options: {
    readonly trustedOrigins: readonly string[]
    readonly redirectAllowed: (uri: string, registered: readonly string[]) => boolean
    readonly fetch?: GuardedFetch
  },
): Promise<FetchedMetadata> {
  const fetcher = options.fetch ?? egressFetch
  let response: Response
  try {
    response = await fetcher(
      clientId,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
      { trustedOrigins: options.trustedOrigins },
    )
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'EgressRefused'
        ? 'its address is not a public one'
        : error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
          ? `it did not answer within ${String(FETCH_TIMEOUT_MS / 1000)} seconds`
          : 'it could not be reached'
    return { refusal: `the client metadata document could not be fetched: ${reason}` }
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    return { refusal: `the client metadata document answered ${String(response.status)}` }
  }

  let text: string
  try {
    text = await readBounded(response, MAX_DOCUMENT_BYTES)
  } catch {
    return { refusal: `the client metadata document is larger than ${String(MAX_DOCUMENT_BYTES)} bytes` }
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    return { refusal: 'the client metadata document is not JSON' }
  }
  const judged = validateMetadataDocument(clientId, document, options.redirectAllowed)
  if ('refusal' in judged) return judged
  return { client: judged, ttlSeconds: cacheSeconds(response.headers.get('cache-control')) }
}

/** The body, or a throw the moment it passes `limit` — never the whole of an oversized one. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('too large')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new Error('too large')
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}
