/**
 * Admitting a browser, for both surfaces that can be asked to.
 *
 * ## Why this is one module
 *
 * Validating `Origin` and *admitting* one are two halves. The MCP transport had
 * only the first: no preflight handler, no `Access-Control-Allow-Origin`, so
 * `NACRE_MCP_ALLOWED_ORIGINS` could turn a `403` into a reply the browser then
 * discarded, and no browser could reach it whatever the list said. Found by
 * sending a preflight at a deployed stand.
 *
 * The API has the same shape and the same need — a browser client running the
 * OAuth flow registers and exchanges its code there, both by `fetch`. Written
 * twice, the two would disagree about which headers a client may read, and the
 * one that forgot `WWW-Authenticate` would be a surface where discovery stops
 * at "unauthorized" with nothing in a log. So the property lives here and both
 * ask it, which is this repository's rule for anything that has to hold in more
 * than one place.
 *
 * ## The rules, and why each one
 *
 * **Credentials are never allowed.** Both surfaces authenticate with a bearer
 * token in a header and never with a cookie, so `Allow-Credentials` would buy
 * nothing and would let a page on an allowed origin act as whoever is signed in
 * there.
 *
 * **`WWW-Authenticate` is exposed.** A browser client reads the RFC 9728
 * pointer out of the `401` and cannot begin discovery without it. A surface
 * that admits an origin and hides that header has admitted a client which can
 * only ever be unauthorized.
 *
 * **`Vary: Origin` always**, when a header is emitted at all: the answer
 * depends on who asked, and a cache must not hand one origin's response to
 * another.
 *
 * **An empty list emits nothing.** That is the default on both surfaces and
 * what every existing deployment has: no header, and a preflight refused
 * exactly as it was before any of this existed.
 */

/** Headers a caller may read off a response. Both surfaces expose the same set. */
const EXPOSED = 'WWW-Authenticate, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, Retry-After'

/**
 * What a browser MCP client sends at **every** surface it touches.
 *
 * `mcp-protocol-version` is the one that is not obvious, and it is the reason
 * this constant exists rather than two hand-written lists. The MCP SDK puts
 * that header on every request of the walk — including the `GET` for
 * `/.well-known/oauth-protected-resource` and the one for
 * `/.well-known/oauth-authorization-server`, both of which the **API** serves.
 * The API's list did not have it, so the preflight admitted the origin and
 * refused the header, and a browser cancelled the request before it was sent.
 *
 * The walk still finished, which is what made this invisible: the SDK retries
 * discovery without the header, so what a deployment saw was two `net::ERR_FAILED`
 * lines in a browser console and a flow that worked anyway. A client that does
 * not retry gets no metadata at all — and a resource server whose metadata a
 * browser cannot read is the same "admitted a client that can only ever be
 * unauthorized" shape that put `WWW-Authenticate` in `EXPOSED` above.
 *
 * Found by driving the deployed stand's `/agent` page in a real browser and
 * reading the failed requests' headers, not by reading either list.
 *
 * Each surface adds what only it reads. Neither can drop what is here.
 */
const MCP_WALK = ['authorization', 'content-type', 'accept', 'mcp-protocol-version'] as const

/**
 * The `Access-Control-Allow-Headers` value for a surface, from what it alone
 * reads. The shared set above is prepended rather than repeated.
 */
export function allowedRequestHeaders(own: readonly string[]): string {
  return [...MCP_WALK, ...own.filter((header) => !MCP_WALK.includes(header as (typeof MCP_WALK)[number]))].join(', ')
}

/** The shared set, for a check that wants to ask a surface whether it admits it. */
export const mcpWalkHeaders = (): readonly string[] => MCP_WALK

/**
 * What a response carries for this origin — empty unless it is allowed.
 *
 * `origin` is the request's `Origin` header. Absent means an agent rather than
 * a browser, which is the caller both surfaces are built for and which needs
 * none of this.
 */
export function corsHeaders(
  origin: string | undefined,
  allowed: readonly string[],
): Record<string, string> {
  if (origin === undefined || !allowed.includes(origin)) return {}
  return {
    'access-control-allow-origin': origin,
    vary: 'Origin',
    'access-control-expose-headers': EXPOSED,
  }
}

/** Whether this request is a browser's preflight rather than a call. */
export const isPreflight = (method: string | undefined): boolean => method === 'OPTIONS'

/**
 * The answer to a preflight from an allowed origin.
 *
 * `methods` and `headers` are the surface's own: the MCP transport refuses a
 * request whose mirrored `Mcp-*` headers disagree with its body, so a browser
 * that may not send them cannot call it at all — and the API takes an
 * `Idempotency-Key` the MCP transport has never heard of. What they share is
 * everything above; what differs is what each one actually reads.
 */
export function preflightHeaders(options: {
  readonly origin: string
  readonly methods: string
  readonly headers: string
}): Record<string, string> {
  return {
    ...corsHeaders(options.origin, [options.origin]),
    'access-control-allow-methods': options.methods,
    'access-control-allow-headers': options.headers,
    // Ten minutes. Long enough that a conversation is not one preflight per
    // turn, short enough that widening the list is not waited out.
    'access-control-max-age': '600',
  }
}
