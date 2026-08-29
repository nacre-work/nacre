import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import {
  allowedRequestHeaders,
  corsHeaders,
  logger,
  MetadataError,
  preflightHeaders,
  PROTECTED_RESOURCE_PATH,
  type ProtectedResourceMetadata,
} from '@nacre.work/core'
import {
  authenticate,
  findTenantOverride,
  limitHeaders,
  Problem,
  type AuthContext,
  type LimitPolicy,
  type RateLimiter,
  type Resource,
  type VerifyOptions,
} from '@nacre.work/api'

import { CATALOG_SAMPLE, catalog, dispatchCatalog, type Layer, type ToolDefinition } from './tools.js'
// Both transports answer `initialize`, `server/discover` and `tools/list` from
// these, rather than each building its own object — which is how one server
// came to declare two different capability sets, and to send a cache hint over
// one transport and not the other. results.ts has the whole argument.
import { discoverResult, initializeResult, PROTOCOL_VERSIONS, toolsListResult, pingResult, callToolResult } from './results.js'

// Re-exported because this module is what the package's entry point and the
// surface tests already import them from.
export {
  DISCOVER_TTL_MS,
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  TOOLS_TTL_MS,
} from './results.js'

export interface Layers {
  /**
   * One page of the layers this caller may read, ordered by id.
   *
   * A page and never the whole catalog, and the bound is **required** rather
   * than defaulted: this used to return every layer the plan reaches, which on
   * an installation at the scale layers are sold for — one per patient, one
   * per matter — is a million-row answer built per call. `afterId` is the seek;
   * `nextCursor` is the last id when another page exists. Drives `list_layers`
   * and the search description, each at its own bound.
   */
  forCaller(
    auth: AuthContext,
    page: { readonly limit: number; readonly afterId?: string },
  ): Promise<{ readonly layers: readonly Layer[]; readonly nextCursor: string | null }>
}

export interface ToolRunner {
  /**
   * `requestId` is threaded through so audit rows can be joined to a request.
   *
   * Every MCP audit row carried the literal string `mcp` — this transport
   * generates a real id per request and never passed it down, so
   * `docs/config.md`'s claim that "an auditor's question and a latency
   * investigation resolve against the same identifier" was true of REST and
   * false here.
   */
  call(
    name: string,
    args: Record<string, unknown>,
    auth: AuthContext,
    requestId: string,
  ): Promise<unknown>
}

export interface McpOptions {
  /**
   * `serviceKeys` is required here, unlike on the REST surface.
   *
   * This transport exists for agents, and an agent authenticates with a service
   * account key. Leaving the resolver out is not a smaller deployment — it is a
   * server that 401s every `nacre_sk_` token while the same key works over REST
   * and STDIO, which reads as a revoked credential rather than a missing wire.
   * Requiring it makes that a compile error instead of a support ticket.
   */
  readonly verify: VerifyOptions & { readonly serviceKeys: NonNullable<VerifyOptions['serviceKeys']> }
  readonly layers: Layers
  readonly tools: ToolRunner
  /** Where a 401 points the client for discovery, per RFC 9728. */
  readonly resourceMetadataUrl: string
  /** The document that URL resolves to. Built once, in main, and shared with the API. */
  readonly resourceMetadata: ProtectedResourceMetadata
  /**
   * What `initialize` reports as `serverInfo.version`.
   *
   * Informational, and passed in rather than read from a manifest here: this
   * module is imported by tests and by the STDIO entry point as well as by the
   * server, and a file read at import time is the shape that threw ENOENT from
   * the built package once already.
   */
  readonly serverVersion?: string
  /**
   * Build the discovery document from the origin the client actually reached,
   * rather than from one baked in at startup.
   *
   * Set only when the deployment has **not** pinned `NACRE_MCP_CANONICAL_URL`.
   * RFC 9728 has the client compare the `resource` identifier against the URL
   * it used, so a document naming anything else is refused before a token is
   * ever sent — and the Compose default named `http://localhost:8081`, which is
   * wrong for every client that is not on the server's own machine. A default
   * that quietly points at localhost is the failure `loadConfig` refuses for
   * every other URL in this product, and it had been introduced here.
   *
   * Deriving from `Host` is not a trust decision: the identifier is not an
   * authorization input. A token is still checked against `NACRE_JWT_AUDIENCE`
   * and `NACRE_JWT_ISSUER`, neither of which comes from the request, so the
   * worst a forged `Host` achieves is a document naming a resource whose tokens
   * this server will not accept.
   */
  readonly resourceFromRequest?: (origin: string) => ProtectedResourceMetadata
  /**
   * Browser origins this transport answers, from `NACRE_MCP_ALLOWED_ORIGINS`.
   *
   * Validating `Origin` is a MUST in the specification and the attack it names
   * is DNS rebinding: a page in somebody's browser reaching an MCP server on
   * their network. Absent means no browser origin is allowed, which is the
   * right default for a transport built for agents — an agent sends no
   * `Origin` and is unaffected.
   */
  readonly allowedOrigins?: readonly string[]

  /**
   * The same limiter and the same policies the REST surface uses.
   *
   * Absent means unlimited, which is what this transport was: `NACRE_RATE_*`
   * applied to REST only, so a client that had run out of search budget could
   * point at port 8081 and carry on. Two doors into one authorization service,
   * one of them with a lock on it.
   *
   * Counted per organization on the same keys, deliberately — a shared bucket
   * rather than one bucket per surface. Splitting them would give a caller
   * twice the documented allowance for holding two clients, which is the same
   * hole one level up.
   */
  readonly limits?: RateLimiter
  readonly limitPolicies?: Readonly<Record<Resource, LimitPolicy>>

  /** Rendered at `/metrics`. Absent means the endpoint answers 404. */
  readonly metrics?: { render(): Promise<string> }
  /** A bearer token required on `/metrics`. Absent leaves it open. */
  readonly metricsToken?: string
  /** Where the tool path writes what it measured. */
  readonly observe?: McpMetrics
}

/**
 * What this transport records.
 *
 * It recorded nothing. The MCP server built no registry and served no
 * `/metrics`, so every claim in `docs/config.md` about search latency and
 * denials was true of REST and silent here — and this is the transport the
 * product is *for*. An agent's search was invisible: not slow, not failing,
 * absent.
 */
export interface McpMetrics {
  toolDuration: { observe(seconds: number, labels?: Record<string, string>): void }
  toolCalls: { inc(labels?: Record<string, string>, by?: number): void }
  aclDenials: { inc(labels?: Record<string, string>, by?: number): void }
  authFailures: { inc(labels?: Record<string, string>, by?: number): void }
}

/**
 * Which budget a tool spends from.
 *
 * By what the tool *does*, not by its name: `search` is a read against the
 * index and the ingest tools queue work. A tool with no mapping is unlimited,
 * which is right for `list_layers` — it is one indexed query and refusing it
 * would break discovery for a client that is otherwise behaving.
 */
function resourceForTool(tool: string): Resource | undefined {
  if (tool === 'search') return 'search'
  if (tool === 'ingest_document' || tool === 'delete_document') return 'ingest'
  return undefined
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
  /**
   * Request metadata, where the binding carries the protocol version under
   * `io.modelcontextprotocol/protocolVersion`. Read only to compare against the
   * header; nothing dispatches on it.
   */
  readonly _meta?: unknown
}

const MAX_BODY_BYTES = 1_000_000

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/**
 * A path this transport does not serve, answered as HTTP rather than as
 * JSON-RPC.
 *
 * The envelope belongs to `/mcp` and nowhere else. Everything that reaches
 * this function got here over plain HTTP — a discovery document, an OAuth
 * endpoint, a mistyped path — and none of those callers is a JSON-RPC client.
 *
 * That was not a cosmetic mismatch. A client with no token reads the
 * protected-resource document to find an authorization server; if it finds
 * none named there it falls back to treating **this** origin as one and posts
 * a registration request to `/register`. It got
 * `{"jsonrpc":"2.0","id":null,"error":{"code":-32601,…}}`, tried to read it as
 * an RFC 6749 error, and surfaced
 * `HTTP 404: Invalid OAuth error response: ZodError: …` — a parser complaint
 * about the shape of a reply, in place of the one sentence that would have
 * explained the problem.
 *
 * So the body is `{ error, error_description }`: the shape RFC 6749 §5.2 fixes
 * for exactly this reader, and ordinary JSON for everyone else. The
 * description names where the authorization server actually is, because a
 * client that landed here is looking for one.
 */
function httpError(res: ServerResponse, status: number, code: string, description: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: code, error_description: description }))
}

/**
 * Where a client that came here looking for an authorization server should go.
 *
 * The document this transport serves already names it — RFC 9728 discovery is
 * how a client is supposed to find it — so this repeats what is one GET away
 * rather than deciding anything.
 */
function authorizationServerHint(options: McpOptions): string {
  const named = options.resourceMetadata.authorization_servers?.[0]
  return named === undefined
    ? `It issues no tokens; read ${PROTECTED_RESOURCE_PATH} on this origin to find the authorization server.`
    : `It issues no tokens — the authorization server is ${named}.`
}

/**
 * The one 404 this transport has, for every path it does not serve.
 *
 * One body for all of them, deliberately: `/metrics` behind a token answers
 * this too, and a differently-worded 404 there would confirm the endpoint
 * exists to anyone who guessed the path and got the token wrong.
 */
function notServed(res: ServerResponse, options: McpOptions): void {
  httpError(
    res,
    404,
    'not_found',
    `This is the MCP endpoint of a resource server; it serves POST /mcp. ${authorizationServerHint(options)}`,
  )
}

/**
 * Streamable HTTP, one endpoint, no session.
 *
 * There is no `initialize`, no `Mcp-Session-Id`, and nothing kept between
 * requests — which is what lets any replica behind a round-robin balancer serve
 * any request. A tool that needs state between calls returns an explicit
 * descriptor and takes it back as an argument; hidden state in the transport
 * would quietly reintroduce the affinity the deployment model rules out.
 */
export function createMcpServer(options: McpOptions): Server {
  return createServer((req, res) => {
    void handle(req, res, options).catch(() => {
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error'))
    })
  })
}

/**
 * `HeaderMismatch`, from the sub-range the specification reserves for
 * protocol-defined errors. It covers a missing required header as well as one
 * that disagrees with the body — both are "the headers do not describe this
 * request", and a client reads the code to tell a modern server from a legacy
 * one before deciding whether to fall back.
 */
const HEADER_MISMATCH = -32020

/** The three methods that name something, and where the name lives. */
const NAMED_METHODS: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}


/**
 * `UnsupportedProtocolVersionError`, which the schema pins at -32022 and
 * requires to carry both halves of the disagreement.
 *
 * Listing what this server *does* speak is the part that matters: a bare
 * refusal leaves a client with nothing to retry, and the whole point of naming
 * a version is that the other side can pick another one.
 */
const UNSUPPORTED_VERSION = -32022

/**
 * Decode the Base64 sentinel a client uses for a value that is not header-safe.
 *
 * `=?base64?…?=`, lower case and exact — a value that merely looks like one is
 * required to be encoded too, so treating the markers as a hint rather than a
 * format would let a plain string impersonate an encoded one.
 */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value
  const inner = value.slice('=?base64?'.length, -'?='.length)
  try {
    return Buffer.from(inner, 'base64').toString('utf8')
  } catch {
    return value
  }
}

/**
 * Whether the mirrored headers describe this body, and what is wrong if not.
 *
 * Three comparisons: the protocol version against `_meta`, `Mcp-Method` against
 * the method, and `Mcp-Name` against the field the method names — the last only
 * on the three methods that name something, because requiring it everywhere
 * refuses a `tools/list` no client can make any other way.
 *
 * Every one is "when present". Absent is not a mismatch, and that is the branch
 * the binding sanctions for a server supporting clients older than 2025-06-18;
 * see docs/mcp-conformance.md. What is refused is a header that *disagrees*.
 */
function headerMismatch(
  headers: IncomingMessage['headers'],
  rpc: { method: string; params?: unknown; _meta?: unknown },
): string | undefined {
  // The version the body carries, when it carries one. The binding puts it in
  // `_meta` under a reversed-domain key and requires the header to agree — the
  // same rule as `Mcp-Method`, and it was the one comparison still missing
  // after the others went in. A header that says one revision while the body
  // says another is two components acting on different instructions, which is
  // the entire reason any of these are mirrored.
  const declaredVersion = headers['mcp-protocol-version']
  const meta = (rpc._meta ?? {}) as Record<string, unknown>
  const bodyVersion = meta['io.modelcontextprotocol/protocolVersion']
  if (
    typeof declaredVersion === 'string' &&
    typeof bodyVersion === 'string' &&
    declaredVersion !== bodyVersion
  ) {
    return (
      `Header mismatch: MCP-Protocol-Version header value '${declaredVersion}' does not match ` +
      `body value '${bodyVersion}'`
    )
  }

  const declared = headers['mcp-method']
  if (typeof declared === 'string' && declared !== rpc.method) {
    return `Header mismatch: Mcp-Method header value '${declared}' does not match body value '${rpc.method}'`
  }

  const field = NAMED_METHODS[rpc.method]
  if (field === undefined) return undefined

  const params = (rpc.params ?? {}) as Record<string, unknown>
  const expected = params[field]
  // Absent in the body means the call is malformed rather than the header
  // wrong; dispatch answers that with the error the method owes.
  if (typeof expected !== 'string') return undefined

  const presented = headers['mcp-name']
  // Absent is not a mismatch. See the note on the required-header check: these
  // headers arrived in 2026-07-28 and no shipping client sends them yet, so
  // demanding one refuses the request instead of protecting it. Present and
  // disagreeing is still refused, which is the property they exist for.
  if (typeof presented !== 'string') return undefined
  if (decodeHeaderValue(presented) !== expected) {
    return `Header mismatch: Mcp-Name header value does not match body value '${expected}'`
  }
  return undefined
}

/**
 * The origin this request arrived on, as the client wrote it.
 *
 * `Host` is what the client put in the URL bar or the config file, which is
 * exactly what RFC 9728 asks the identifier to match. Behind a proxy that
 * terminates TLS the scheme is the one thing `Host` cannot carry, so
 * `X-Forwarded-Proto` decides it — and only `https` is honoured from that
 * header, because anything else is the default already.
 */
function originOf(req: IncomingMessage): string | undefined {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return undefined
  const forwarded = req.headers['x-forwarded-proto']
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim()
  return `${first === 'https' ? 'https' : 'http'}://${host}`
}

/** Where this request should be told to read the protected-resource document. */
function metadataUrlFor(req: IncomingMessage, options: McpOptions): string {
  const origin = originOf(req)
  if (options.resourceFromRequest === undefined || origin === undefined) return options.resourceMetadataUrl
  return new URL(PROTECTED_RESOURCE_PATH, origin).toString()
}

async function handle(req: IncomingMessage, res: ServerResponse, options: McpOptions): Promise<void> {
  const requestId = randomUUID()

  const path = (req.url ?? '').split('?')[0]

  // Prometheus, on the same terms as the API's: unauthenticated unless a token
  // is configured, and a wrong token gets 404 rather than 401 so a deployment
  // hiding the endpoint does not confirm it has one.
  if (req.method === 'GET' && path === '/metrics') {
    if (options.metrics === undefined) {
      notServed(res, options)
      return
    }
    if (options.metricsToken !== undefined) {
      const header = req.headers.authorization
      const presented = header?.startsWith('Bearer ') === true ? header.slice(7) : ''
      const expected = Buffer.from(options.metricsToken, 'utf8')
      const given = Buffer.from(presented, 'utf8')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        notServed(res, options)
        return
      }
    }
    const body = await options.metrics.render()
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
    return
  }

  // `Origin`, before anything else. The specification makes validating it a
  // MUST and names the attack: without it a page in somebody's browser can
  // reach an MCP server on their network by rebinding DNS, and this transport
  // listens on a network interface rather than a socket.
  //
  // A browser sends `Origin`; an agent does not, and must not be refused for
  // it. So an absent header is allowed through and only a *present and
  // unrecognised* one is refused — which is the distinction the rule is about,
  // because a rebinding attack is by definition a browser.
  //
  // `403`, per the specification, and never `404`: unlike the paths this
  // server does not route, an origin refusal is about the caller rather than
  // about what exists.
  const origin = req.headers.origin
  const originAllowed = origin !== undefined && (options.allowedOrigins ?? []).includes(origin)
  if (origin !== undefined && !originAllowed) {
    send(res, 403, rpcError(null, -32600, 'Origin not allowed'))
    return
  }

  // ── the other half of allowing an origin ────────────────────────────────
  //
  // Validating `Origin` stops a browser this transport does not want. It does
  // not *admit* the browser it does: a cross-origin request needs the response
  // to carry `Access-Control-Allow-Origin`, and anything past a simple form
  // POST needs a preflight answered first. Neither existed, so
  // `NACRE_MCP_ALLOWED_ORIGINS` could only ever turn a 403 into a reply the
  // browser then threw away — and `docs/config.md` said to "set it only if a
  // browser talks to this transport directly", which nothing could.
  //
  // Found by pointing a browser at a deployed stand: the preflight came back
  // `403 Origin not allowed` with no `Access-Control-*` header on it. The
  // specification's own transport is built for browser clients as well as
  // agents; this one answered none of them.
  //
  // **Nothing changes with the list empty**, which is the default: no origin is
  // allowed, so no header below is ever emitted and a preflight is refused
  // exactly as it was.
  // `packages/core/cors.ts`, not a second copy: the API admits a browser for
  // the same flow — a client registering and exchanging its code — and two
  // implementations would disagree about which headers a caller may read.
  const cors = corsHeaders(origin, options.allowedOrigins ?? [])

  // Set once rather than at forty call sites. `writeHead` merges what it is
  // given over what was set here, and nothing below sets an `access-control-*`
  // header — so every reply from this point carries them, including the 401
  // that starts the OAuth walk and the discovery document it points at.
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)

  if (req.method === 'OPTIONS' && path === '/mcp') {
    if (!originAllowed) {
      // A preflight with no origin is not a preflight. Refused the way any
      // unrouted method is, and without a CORS header, so nothing is admitted
      // by accident.
      send(res, 405, rpcError(null, -32601, 'Method Not Allowed'), { allow: 'POST' })
      return
    }
    res.writeHead(
      204,
      preflightHeaders({
        origin,
        methods: 'POST, OPTIONS',
        // What this transport reads on top of what every MCP client sends.
        // `mcp-method` and `mcp-name` are mirrored headers it refuses a request
        // for disagreeing with, so a browser that cannot send them cannot call
        // this server at all.
        headers: allowedRequestHeaders(['mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id']),
      }),
    )
    res.end()
    return
  }

  // The path this transport's own 401 names. Served here as well as on the API
  // because a client may be pointed straight at the MCP port — and served from
  // the same document, built once in main, so the two can never disagree about
  // the resource identifier a token is audience-bound to.
  //
  // Not a JSON-RPC route: discovery is plain HTTP GET, and answering it in the
  // RPC envelope would make it unreadable to every client that follows RFC 9728.
  if (req.method === 'GET' && path === PROTECTED_RESOURCE_PATH) {
    res.writeHead(200, { 'content-type': 'application/json' })
    // Per request when the deployment did not pin one. Built here rather than
    // cached: the answer depends on the `Host` this request carried, and two
    // clients reaching the same replica on two names are both entitled to a
    // document that matches the URL they used.
    const origin = originOf(req)
    const metadata =
      options.resourceFromRequest !== undefined && origin !== undefined
        ? options.resourceFromRequest(origin)
        : options.resourceMetadata
    res.end(JSON.stringify(metadata))
    return
  }

  // GET and DELETE reached the endpoint in the revisions that had sessions and
  // a standalone SSE stream. This one has neither, and the specification says
  // what to answer: `405`, not `404`. The difference is load-bearing for a
  // client deciding which era this server speaks — a `404` is one of the
  // signals that sends it down the legacy HTTP+SSE path.
  if (path === '/mcp' && (req.method === 'GET' || req.method === 'DELETE')) {
    send(res, 405, rpcError(null, -32601, 'Method Not Allowed'), { allow: 'POST' })
    return
  }

  if (req.method !== 'POST' || path !== '/mcp') {
    notServed(res, options)
    return
  }

  // `Mcp-Session-Id` and `Last-Event-ID` are ignored rather than refused, which
  // is what the specification asks of a server that implements only this
  // revision: an older client sending them gets an answer about the request
  // rather than about its framing.

  // The 2026-07-28 mirrored headers are **validated when present and never
  // demanded**, and that is a deliberate deviation stated rather than hidden.
  //
  // Demanding `MCP-Protocol-Version` on every POST could not be satisfied at
  // all. The first request a client makes is `initialize`, and at that moment
  // no version is negotiated — it travels in `params.protocolVersion`, because
  // that request is what negotiates it. So the header this server insisted on
  // is one the client is not able to send, and every real client bounced off
  // `-32020 Missing required header: mcp-protocol-version` on its very first
  // POST. `Mcp-Method` and `Mcp-Name` are the same generation and no shipping
  // client sends those either.
  //
  // A conformance stance that no existing client can satisfy is not
  // conformance, it is a transport nobody can reach — and this product exists
  // to be reached by agents. The protection those headers buy is in the
  // *comparison*, not in the demand: an intermediary that routes on a header
  // while the server executes a body must not see two different instructions.
  // That check is below and is unchanged. Refusing the request when the header
  // is absent bought the incompatibility and none of the protection.

  const auth = await authenticate(req.headers.authorization, options.verify, '/mcp', requestId)
  if (auth instanceof Problem) {
    // By the kind presented, never by the reason. Same series and same labels
    // as the REST surface, or a key rotation shows up on one dashboard as two
    // unrelated shapes. `kind="service_key"` is the one that matters here:
    // this transport exists for agents, and an agent presents a service account
    // key, which no JWT rotation should ever touch.
    const presented = req.headers.authorization
    options.observe?.authFailures.inc({
      kind:
        presented === undefined || !presented.startsWith('Bearer ')
          ? 'missing'
          : presented.slice(7).startsWith('nacre_sk_')
            ? 'service_key'
            : 'jwt',
    })
    // RFC 9728: every 401 points at the protected-resource metadata, which is
    // how a client discovers where to get a token. It lives on the API host,
    // never on the apex — static hosting there intercepts /.well-known/*.
    send(res, 401, rpcError(null, -32001, 'Unauthorized'), {
      // The same rule as the document itself: a 401 that points at a metadata
      // URL on another host sends the client somewhere it cannot compare.
      'www-authenticate': `Bearer resource_metadata="${metadataUrlFor(req, options)}"`,
    })
    return
  }

  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    send(res, 400, rpcError(null, -32700, 'Parse error'))
    return
  }

  const rpc = body as JsonRpcRequest | undefined
  const id = rpc?.id ?? null
  if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    send(res, 400, rpcError(id, -32600, 'Invalid request'))
    return
  }

  // The headers have to agree with the body, which is the whole reason they
  // exist and was the half that was missing.
  //
  // The specification is explicit about why: intermediaries route and rate-limit
  // on the header while the server executes the body, so a request whose two
  // halves disagree is one where the balancer and the server acted on different
  // instructions. Demanding the headers and never comparing them bought the
  // incompatibility and none of the protection.
  const mismatch = headerMismatch(req.headers, { method: rpc.method, params: rpc.params, _meta: rpc._meta })
  if (mismatch !== undefined) {
    send(res, 400, rpcError(id, HEADER_MISMATCH, mismatch))
    return
  }

  // A revision this server does not speak is refused with the list of the ones
  // it does — `400` and -32022, both pinned by the schema.
  //
  // The *header* only. `initialize`'s `params.protocolVersion` is a proposal
  // and is answered by counter-offering, which is what the handshake is for;
  // refusing it there would turn a negotiation into a failure. The header is a
  // different statement: it says which revision's transport rules this request
  // was framed by, and if that is one we cannot read then nothing below can be
  // trusted to mean what it appears to.
  const framing = req.headers['mcp-protocol-version']
  if (typeof framing === 'string' && !(PROTOCOL_VERSIONS as readonly string[]).includes(framing)) {
    send(res, 400, {
      jsonrpc: '2.0',
      id,
      error: {
        code: UNSUPPORTED_VERSION,
        message: 'Unsupported protocol version',
        data: { supported: [...PROTOCOL_VERSIONS], requested: framing },
      },
    })
    return
  }

  // A notification has no `id` and takes no result. `notifications/initialized`
  // is the third leg of the handshake and every client sends it immediately
  // after `initialize`; answering it with `-32601` makes a client that just
  // connected believe it did not.
  //
  // 202 with an empty body is what the specification asks for, and it is
  // returned for any `notifications/*` rather than for a list of known ones: a
  // notification this server does not understand is by definition one it may
  // ignore, and refusing it would be inventing an error the sender cannot act
  // on.
  if (rpc.method.startsWith('notifications/')) {
    res.writeHead(202)
    res.end()
    return
  }

  // The organization comes from the token. A params object naming one is not a
  // malformed call, it is an attempt to act as another tenant — same rule as
  // the REST surface, same reason, and it is checked before dispatch.
  const override = findTenantOverride(rpc.params)
  if (override !== undefined) {
    send(res, 403, rpcError(id, -32602, 'The organization comes from the token.'))
    return
  }

  switch (rpc.method) {
    // The handshake. It had never been implemented, and the comment above this
    // server said so as though it were a consequence of being stateless: "there
    // is no `initialize`, no `Mcp-Session-Id`, and nothing kept between
    // requests". Two different things got removed together. Statelessness is
    // real and is what lets any replica serve any request. `initialize` is not
    // state — it is how a client learns the protocol version and what this
    // server can do, and it is answered here without remembering anything: no
    // session id is issued, and nothing about this request is kept.
    //
    // Without it every client failed on its first POST, so **no standard MCP
    // client had ever connected over Streamable HTTP**. The suite could not see
    // it because the suite called `tools/list` directly, which is the second
    // request a client makes and never the first.
    case 'initialize': {
      const asked = (rpc.params as { protocolVersion?: unknown } | undefined)?.protocolVersion
      // Echo what the client asked for when this server speaks it, and
      // otherwise counter-offer the newest **legacy** revision — never the
      // newest revision outright.
      //
      // That distinction is the whole of this fix. Answering with
      // `PROTOCOL_VERSIONS[0]` is what the handshake reads like it should do,
      // and it broke every real client: the current SDK's
      // `SUPPORTED_PROTOCOL_VERSIONS` tops out at `2025-11-25`, so a client
      // proposing that got `2026-07-28` back and threw
      // `Server's protocol version is not supported: 2026-07-28` — a
      // connection refused by the client, on a version the server offered it.
      //
      // A counter-offer is only useful if the other side can take it, and
      // anything arriving on `initialize` is by definition a legacy client
      // with no way to fall forward. The newest revision it might know is the
      // newest one in the legacy list, so that is what it is offered.
      send(res, 200, { jsonrpc: '2.0', id, result: initializeResult(asked, options.serverVersion) })
      return
    }

    // The modern era's entry point, and a MUST for any server claiming this
    // revision: "Servers MUST implement server/discover."
    //
    // It is `initialize` with the handshake taken out. A modern client sends no
    // `initialize` and negotiates nothing — it names a version on every request
    // — so what it needs up front is the list of versions to pick from and the
    // capabilities to expect. Both are static here, which is why this answers
    // without touching a dependency and why `cacheScope` is `public`: unlike
    // `tools/list`, nothing in this result depends on who is asking.
    //
    // Authenticated, like everything else on this endpoint. A client probing
    // before it holds a token gets the same `401` and the same pointer at the
    // metadata document that any other method gets, which is the flow rather
    // than an obstacle to it.
    case 'server/discover': {
      send(res, 200, { jsonrpc: '2.0', id, result: discoverResult(options.serverVersion) })
      return
    }

    // A MUST-respond for both parties in every revision, and the arm this
    // dispatcher was missing: STDIO answered ping and this one fell through
    // to the 404 below, so a client's keep-alive dropped the very connection
    // it was checking. The result is built in results.ts like the others.
    case 'ping': {
      send(res, 200, { jsonrpc: '2.0', id, result: pingResult() })
      return
    }

    case 'tools/list': {
      // A bounded page: the search description names a handful of layers and
      // says there are more, rather than interpolating a catalog that is a
      // million entries on the installations layers are sold for.
      const page = await options.layers.forCaller(auth, { limit: CATALOG_SAMPLE })
      const tools: ToolDefinition[] = [
        ...catalog(page.layers, { more: page.nextCursor !== null }),
      ]
      send(res, 200, { jsonrpc: '2.0', id, result: toolsListResult(tools) })
      return
    }

    case 'tools/call': {
      const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof params.name !== 'string') {
        send(res, 400, rpcError(id, -32602, 'Invalid params'))
        return
      }

      // Dispatch needs a tool's name and permission, and neither depends on
      // the caller's layers — only the search *description* does, and nothing
      // reads a description while dispatching. The full-catalog read that used
      // to sit here made every tool call pay for a listing it never used.
      const definition = dispatchCatalog().find((t) => t.name === params.name)
      if (definition === undefined) {
        send(res, 404, rpcError(id, -32601, 'Not found'))
        return
      }

      // Same limiter, same policies, same keys as REST. Checked after the
      // catalog lookup so an unknown tool is still indistinguishable from one
      // this caller may not see — a 429 on a tool that does not exist would
      // confirm it does.
      const resource = resourceForTool(definition.name)
      if (resource !== undefined && options.limits !== undefined && options.limitPolicies !== undefined) {
        const decision = await options.limits.check(auth.orgId, resource)
        if (!decision.allowed) {
          send(
            res,
            429,
            rpcError(id, -32003, `Rate limit exceeded. Try again in ${decision.reset} seconds.`),
            limitHeaders(decision, options.limitPolicies[resource], resource),
          )
          return
        }
      }

      const started = process.hrtime.bigint()
      try {
        const result = await options.tools.call(
          definition.name,
          (params.arguments ?? {}) as Record<string, unknown>,
          auth,
          requestId,
        )

        const seconds = Number(process.hrtime.bigint() - started) / 1e9
        options.observe?.toolDuration.observe(seconds, { tool: definition.name })
        options.observe?.toolCalls.inc({ tool: definition.name, result: 'ok' })

        // Zero results on a search is what a denial looks like here: invariant 4
        // makes an invisible layer indistinguishable from an absent one, so
        // there is no 403 to count. Same reason and same reason string as the
        // REST surface, or the two do not add up on one dashboard.
        if (definition.name === 'search' && Array.isArray(result) && result.length === 0) {
          options.observe?.aclDenials.inc({ reason: 'search_empty' })
        }

        // A CallToolResult, not the bare value. The protocol requires
        // `content` to be a list of content blocks, and a client that follows
        // it rejects anything else — this server answered with the raw array
        // and no compliant client could read a single result from it. The
        // product's claim is that agents reach it over MCP; the shape of this
        // object is the whole of that claim in practice.
        send(res, 200, { jsonrpc: '2.0', id, result: callToolResult(result) })
      } catch (error) {
        options.observe?.toolDuration.observe(
          Number(process.hrtime.bigint() - started) / 1e9,
          { tool: definition.name },
        )
        options.observe?.toolCalls.inc({ tool: definition.name, result: 'error' })

        // Nothing about what failed reaches the caller. A tool error that names
        // a layer tells them the layer exists, which is the leak invariant I4
        // is about, and an unknown tool must answer the same way.
        //
        // Logged here, though: without this a database that is down looks
        // exactly like a tool that does not exist, from both ends at once —
        // the caller is told nothing, by design, and the operator was told
        // nothing either.
        logger.error('tool call failed', { tool: definition.name,
            request_id: requestId,
            error: String(error) })

        // One carve-out, and it is about the caller's own arguments rather than
        // about anything stored. A `MetadataError` says a key is not a legal
        // name, or a value is not a scalar, or a list is empty — facts the
        // caller already had, naming nothing they did not send. Answering "not
        // found" to a typo in a filter key leaves an agent retrying the same
        // malformed call forever, because the one thing it cannot learn from
        // that answer is that its arguments were wrong.
        //
        // Nothing else is separated out. The moment an error is about what
        // exists, it goes back into the single answer above.
        if (error instanceof MetadataError) {
          send(res, 400, rpcError(id, -32602, error.message))
          return
        }

        send(res, 404, rpcError(id, -32601, 'Not found'))
      }
      return
    }

    default:
      send(res, 404, rpcError(id, -32601, 'Not found'))
  }
}
