import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import {
  createMcpHandler,
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type McpHttpHandler,
  type McpRequestContext,
} from '@modelcontextprotocol/server'
import {
  ADMIN_MCP_PATH,
  ADMIN_PROTECTED_RESOURCE_PATH,
  adminAudience,
  adminResourceMetadata,
  allowedRequestHeaders,
  connectionClient,
  corsHeaders,
  inAuditScope,
  logger,
  preflightHeaders,
  PROTECTED_RESOURCE_PATH,
  setAuditClient,
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

import { buildAdminServer } from './admin.js'
import type { AdminRunner } from './admin-services.js'
import { buildServer, type Layers, type McpMetrics, type ToolRunner, type SkillSource } from './factory.js'
import { dispatchCatalog } from './tools.js'

// Re-exported because this module is what the package's entry point and the
// surface tests already import them from.
export {
  DISCOVER_TTL_MS,
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  TOOLS_TTL_MS,
} from './results.js'
export type { Layers, McpMetrics, ToolRunner } from './factory.js'

/**
 * Streamable HTTP, one endpoint, no session.
 *
 * The protocol is `@modelcontextprotocol/server`'s: it classifies a request
 * into the 2026-07-28 era or the legacy one, negotiates `initialize` for a
 * legacy client, answers `server/discover` and `tools/list`, validates tool
 * arguments against their schema, stamps `resultType` and the cache hints,
 * and refuses a mirrored header that disagrees with the body (`-32020`) or a
 * framing revision it cannot read (`-32022`). What this module adds is
 * everything the SDK has no opinion on and this deployment does — which is
 * everything that happens **before** a JSON-RPC envelope is read:
 *
 *   - `/metrics`, on the same terms as the API's;
 *   - `Origin`, validated and then admitted (the two halves of CORS);
 *   - the RFC 9728 document this transport's own `401` names;
 *   - `405` on the verbs the sessionless revision removed, and a plain HTTP
 *     `404` — never the RPC envelope — on every path that is not `/mcp`;
 *   - authentication, per request, with the `401` that starts the OAuth walk;
 *   - the tenant-override refusal, before anything dispatches;
 *   - the rate limit, on the tools that spend a budget.
 *
 * There is no `Mcp-Session-Id` and nothing kept between requests, which is
 * what lets any replica behind a round-robin balancer serve any request: the
 * `McpServer` is built per request by `factory.ts`, for the caller the token
 * names, and discarded with the response.
 */

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
  /** The base skill `instructions` carry. Absent, the built-in text alone. */
  readonly skills?: SkillSource
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
  /** The API's canonical origin, for the MCP App views. See `ServerBuild.apiOrigin`. */
  readonly apiOrigin?: string
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

  /**
   * The administrative MCP at `/mcp/admin`. docs/mcp-admin.md.
   *
   * Absent, the path is not served at all — a plain `404` like any other, and
   * no discovery document for it — which is what a deployment that has not
   * enabled it gets. Present, it is a resource of its own: its discovery
   * document names `…/mcp/admin`, its tokens carry the administrative audience
   * and nothing else is accepted, and its `instructions` carry no skill.
   */
  readonly admin?: {
    readonly tools: AdminRunner
  }
}

/** Which of the two resources a path is, on this deployment. */
type Surface = 'default' | 'admin'

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
  if (tool === 'ingest_document' || tool === 'delete_document' || tool === 'request_upload') return 'ingest'
  return undefined
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown
  readonly id?: unknown
  readonly method?: unknown
  readonly params?: unknown
}

const MAX_BODY_BYTES = 1_000_000

/**
 * What the SDK is handed beside the request, and how the factory gets the
 * caller back out of it.
 *
 * `AuthInfo` is the SDK's shape for a verified bearer token; this
 * deployment's authentication has already run by the time it is built, so
 * `extra` carries the `AuthContext` the factory needs and `requestId` ties
 * every audit row to this request. Nothing below the SDK reads the token.
 */
interface Verified {
  readonly auth: AuthContext
  readonly requestId: string
  /**
   * Whether this client renders MCP Apps, read from the envelope's client
   * capabilities on a modern-era request. A legacy request carries none per
   * request, and the hosts that render apps today are legacy-era clients, so
   * "unknown" is `true`: the tool a view needs is hidden only from a client
   * that said it cannot render one.
   */
  readonly ui: boolean
}

function authInfoFor(verified: Verified, token: string): AuthInfo {
  return {
    token,
    clientId: `${verified.auth.principal.type}:${verified.auth.principal.id}`,
    scopes: [],
    extra: { verified },
  }
}

function verifiedOf(ctx: McpRequestContext): Verified {
  const verified = (ctx.authInfo?.extra as { verified?: Verified } | undefined)?.verified
  // Every path into the SDK runs through `handle` below, which authenticates
  // first; a factory call without a caller is a wiring error, not a request.
  if (verified === undefined) throw new Error('an unauthenticated request reached the MCP factory')
  return verified
}

/**
 * Whether the request's client declared the MCP Apps extension.
 *
 * Only a modern-era request says: its envelope carries the client's
 * capabilities, and `extensions["io.modelcontextprotocol/ui"]` is the
 * declaration. Anything else — a legacy frame, an envelope without the key
 * — is "unknown", and unknown is admitted; see `Verified.ui`.
 */
function rendersApps(params: unknown): boolean {
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta
  const capabilities = meta?.['io.modelcontextprotocol/clientCapabilities'] as
    | { extensions?: Record<string, unknown> }
    | undefined
  if (capabilities === undefined) return true
  return capabilities.extensions?.['io.modelcontextprotocol/ui'] !== undefined
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
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

/**
 * Where this request should be told to read the protected-resource document —
 * the administrative one for the administrative resource. RFC 9728 puts a
 * resource's document at the well-known path with the resource's own path
 * appended, so a client of `/mcp/admin` that read the root document would be
 * told the ordinary resource and ask for a token this path refuses.
 */
function metadataUrlFor(req: IncomingMessage, options: McpOptions, surface: Surface = 'default'): string {
  const origin = originOf(req)
  const path = surface === 'admin' ? ADMIN_PROTECTED_RESOURCE_PATH : PROTECTED_RESOURCE_PATH
  if (options.resourceFromRequest === undefined || origin === undefined) {
    return surface === 'admin' ? new URL(path, options.resourceMetadataUrl).toString() : options.resourceMetadataUrl
  }
  return new URL(path, origin).toString()
}

/** The document for a resource, built from the request's origin where the deployment did not pin one. */
function metadataFor(req: IncomingMessage, options: McpOptions, surface: Surface): ProtectedResourceMetadata {
  const reached = originOf(req)
  const base =
    options.resourceFromRequest !== undefined && reached !== undefined
      ? options.resourceFromRequest(reached)
      : options.resourceMetadata
  return surface === 'admin' ? adminResourceMetadata(base) : base
}

/**
 * The SDK's two faces over one factory.
 *
 * `modern` serves the 2026-07-28 era and refuses everything else, so the
 * refusal a legacy-shaped request would get there is never what a legacy
 * client sees: `isLegacyRequest` routes it to a per-request legacy transport
 * instead, in the stateless idiom — no session id generator, so no
 * `Mcp-Session-Id` is ever issued — and with JSON responses, because every
 * tool here answers with a complete result and an SSE stream carrying one
 * event and closing would be the same answer in a costlier envelope.
 *
 * Both are built from `buildServer`, which is the whole of the parity
 * argument: a divergence between the eras now needs a second factory.
 */
interface Faces {
  readonly modern: McpHttpHandler
  readonly legacy: (request: Request, authInfo: AuthInfo, parsedBody: unknown) => Promise<Response>
}

type Factory = (ctx: McpRequestContext) => import('@modelcontextprotocol/server').McpServer | Promise<import('@modelcontextprotocol/server').McpServer>

function faces(options: McpOptions): { readonly default: Faces; readonly admin?: Faces } {
  const ordinary: Factory = (ctx) => {
    const verified = verifiedOf(ctx)
    return buildServer({
      auth: verified.auth,
      requestId: () => verified.requestId,
      ui: verified.ui,
      layers: options.layers,
      tools: options.tools,
      ...(options.skills === undefined ? {} : { skills: options.skills }),
      ...(options.serverVersion === undefined ? {} : { serverVersion: options.serverVersion }),
      ...(options.apiOrigin === undefined ? {} : { apiOrigin: options.apiOrigin }),
      ...(options.observe === undefined ? {} : { observe: options.observe }),
    })
  }
  const admin = options.admin
  return {
    default: facesOf(ordinary),
    ...(admin === undefined
      ? {}
      : {
          admin: facesOf((ctx) => {
            const verified = verifiedOf(ctx)
            return buildAdminServer({
              auth: verified.auth,
              requestId: () => verified.requestId,
              ui: verified.ui,
              tools: admin.tools,
              ...(options.serverVersion === undefined ? {} : { serverVersion: options.serverVersion }),
              ...(options.observe === undefined ? {} : { observe: options.observe }),
            })
          }),
        }),
  }
}

function facesOf(factory: Factory): Faces {
  const onerror = (error: Error): void => {
    // Reporting only: the SDK has already answered the request. A rejected
    // frame — a header that lies, a revision nobody speaks — is the client's
    // to read in the reply, and `debug` here is for the operator who is
    // asking why a client cannot connect.
    logger.debug('mcp request rejected', { error: String(error).slice(0, 200) })
  }

  return {
    modern: createMcpHandler(factory, {
      legacy: 'reject',
      responseMode: 'json',
      maxRequestBodySize: MAX_BODY_BYTES,
      onerror,
    }),
    legacy: async (request, authInfo, parsedBody) => {
      const server = await factory({ era: 'legacy', authInfo, requestInfo: request })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      })
      try {
        await server.connect(transport)
        return await transport.handleRequest(request, { authInfo, parsedBody })
      } finally {
        await server.close()
      }
    },
  }
}

export function createMcpServer(options: McpOptions): Server {
  const served = faces(options)
  return createServer((req, res) => {
    // Each request in its own audit scope, so the connection authentication
    // finds is on every row the tools write for it and on no other request's.
    void inAuditScope(() => handle(req, res, options, served)).catch((error: unknown) => {
      logger.error('mcp request failed', { error: String(error).slice(0, 200) })
      if (!res.headersSent) send(res, 500, rpcError(null, -32603, 'Internal error'))
    })
  })
}

/** What the binding has a client say it accepts, and what this server answers in either case. */
const ACCEPT_BOTH = 'application/json, text/event-stream'

/**
 * A web-standard `Request` for the SDK, from what Node handed us.
 *
 * `Accept` is filled in when the client did not name `text/event-stream`.
 * The Streamable HTTP binding has the client list both `application/json`
 * and `text/event-stream`, and the SDK answers `406` to a POST that does not
 * — which every shipping client satisfies, and a `curl`, an uptime check or
 * `fetch`'s own default of any type does not. This server answers JSON on every
 * request regardless (see `faces`), so a caller that did not ask for a
 * stream is given the answer it was going to get anyway rather than a
 * refusal about a header that would not have changed the reply. A caller
 * that names `text/event-stream` is held to what it sent.
 */
function webRequest(req: IncomingMessage, body: Buffer): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v)
  }
  if (!(headers.get('accept') ?? '').includes('text/event-stream')) headers.set('accept', ACCEPT_BOTH)
  return new Request(new URL(req.url ?? '/', originOf(req) ?? 'http://localhost').toString(), {
    method: req.method ?? 'POST',
    headers,
    body,
    // `duplex` is required by undici for a request with a body and absent
    // from the DOM typing of `RequestInit`, hence the cast.
    duplex: 'half',
  } as RequestInit)
}

/** The SDK's reply, written onto Node's response with the CORS headers already set on it. */
async function reply(res: ServerResponse, response: Response): Promise<void> {
  for (const [name, value] of response.headers) res.setHeader(name, value)
  res.writeHead(response.status)
  res.end(Buffer.from(await response.arrayBuffer()))
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: McpOptions,
  served: { readonly default: Faces; readonly admin?: Faces },
): Promise<void> {
  const requestId = randomUUID()

  const path = (req.url ?? '').split('?')[0]
  // The administrative resource exists only where the deployment built one;
  // otherwise its path is as unserved as any other.
  const surface: Surface | undefined =
    path === '/mcp' ? 'default' : path === ADMIN_MCP_PATH && served.admin !== undefined ? 'admin' : undefined

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
  // **Nothing changes with the list empty**, which is the default: no origin is
  // allowed, so no header below is ever emitted and a preflight is refused
  // exactly as it was.
  // `packages/core/cors.ts`, not a second copy: the API admits a browser for
  // the same flow — a client registering and exchanging its code — and two
  // implementations would disagree about which headers a caller may read.
  const cors = corsHeaders(origin, options.allowedOrigins ?? [])

  // Set once rather than at every call site. `writeHead` merges what it is
  // given over what was set here, and nothing below sets an `access-control-*`
  // header — so every reply from this point carries them, including the 401
  // that starts the OAuth walk and the discovery document it points at.
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)

  if (req.method === 'OPTIONS' && surface !== undefined) {
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
  //
  // Per request when the deployment did not pin one. Built here rather than
  // cached: the answer depends on the `Host` this request carried, and two
  // clients reaching the same replica on two names are both entitled to a
  // document that matches the URL they used.
  const documentFor: Surface | undefined =
    path === PROTECTED_RESOURCE_PATH
      ? 'default'
      : path === ADMIN_PROTECTED_RESOURCE_PATH && served.admin !== undefined
        ? 'admin'
        : undefined
  if (req.method === 'GET' && documentFor !== undefined) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(metadataFor(req, options, documentFor)))
    return
  }

  // GET and DELETE reached the endpoint in the revisions that had sessions and
  // a standalone SSE stream. This one has neither, and the specification says
  // what to answer: `405`, not `404`. The difference is load-bearing for a
  // client deciding which era this server speaks — a `404` is one of the
  // signals that sends it down the legacy HTTP+SSE path.
  if (surface !== undefined && (req.method === 'GET' || req.method === 'DELETE')) {
    send(res, 405, rpcError(null, -32601, 'Method Not Allowed'), { allow: 'POST' })
    return
  }

  if (req.method !== 'POST' || surface === undefined) {
    notServed(res, options)
    return
  }

  // `Mcp-Session-Id` and `Last-Event-ID` are ignored rather than refused, which
  // is what the specification asks of a server that implements only this
  // revision: an older client sending them gets an answer about the request
  // rather than about its framing.

  const presented = req.headers.authorization
  // The administrative resource takes its own audience and only an
  // administrative connection — T31. `/mcp` takes the installation's audience,
  // which an administrative token does not carry, and `authenticate` refuses an
  // administrative connection anywhere but here as well, so neither half rests
  // on the other.
  const verify: VerifyOptions =
    surface === 'admin'
      ? { ...options.verify, audience: adminAudience(options.verify.audience), surface: 'admin' }
      : options.verify
  const auth = await authenticate(presented, verify, path ?? '/mcp', requestId)
  if (auth instanceof Problem) {
    // By the kind presented, never by the reason. Same series and same labels
    // as the REST surface, or a key rotation shows up on one dashboard as two
    // unrelated shapes. `kind="service_key"` is the one that matters here:
    // this transport exists for agents, and an agent presents a service account
    // key, which no JWT rotation should ever touch.
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
      'www-authenticate': `Bearer resource_metadata="${metadataUrlFor(req, options, surface)}"`,
    })
    return
  }
  if (auth.delegation !== undefined) setAuditClient(connectionClient(auth.delegation.id))

  let body: Buffer
  try {
    body = await readBody(req)
  } catch {
    send(res, 413, rpcError(null, -32600, 'Request body too large'))
    return
  }

  let parsed: unknown
  try {
    parsed = body.length === 0 ? undefined : JSON.parse(body.toString('utf8'))
  } catch {
    send(res, 400, rpcError(null, -32700, 'Parse error'))
    return
  }

  const rpc = parsed as JsonRpcRequest | undefined
  const id = rpc?.id ?? null
  if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
    send(res, 400, rpcError(id, -32600, 'Invalid request'))
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

  // Same limiter, same policies, same keys as REST. On the tools that spend a
  // budget, and only for a name the catalog has: an unknown tool goes to the
  // SDK and gets its answer about the tool, because a 429 on a tool that does
  // not exist would confirm it does.
  if (
    surface === 'default' &&
    rpc.method === 'tools/call' &&
    options.limits !== undefined &&
    options.limitPolicies !== undefined
  ) {
    const name = (rpc.params as { name?: unknown } | undefined)?.name
    const definition = typeof name === 'string' ? dispatchCatalog().find((t) => t.name === name) : undefined
    const resource = definition === undefined ? undefined : resourceForTool(definition.name)
    if (resource !== undefined) {
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
  }

  const token = presented?.startsWith('Bearer ') === true ? presented.slice(7) : ''
  const authInfo = authInfoFor({ auth, requestId, ui: rendersApps(rpc.params) }, token)
  const request = webRequest(req, body)

  // The era decides the face, and the SDK decides the era — from the `_meta`
  // envelope and the mirrored headers, by the same rules it then enforces.
  const face = surface === 'admin' && served.admin !== undefined ? served.admin : served.default
  const legacy = await isLegacyRequest(request, parsed)
  const response = legacy
    ? await face.legacy(request, authInfo, parsed)
    : await face.modern.fetch(request, { authInfo, parsedBody: parsed })
  await reply(res, response)
}
