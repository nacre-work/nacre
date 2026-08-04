import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'

import {
  logger,
  MetadataError,
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

import { catalog, type Layer, type ToolDefinition } from './tools.js'

/** The protocol revision this server implements. */
export const PROTOCOL_VERSION = '2026-07-28'

/** tools/list is cached per user for five minutes — see cacheScope below. */
export const TOOLS_TTL_MS = 300_000

export interface Layers {
  /** The layers this caller may read. Drives both list_layers and the search description. */
  forCaller(auth: AuthContext): Promise<readonly Layer[]>
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
 * `Mcp-Method` on every request; `Mcp-Name` only on the three that name
 * something, because requiring it everywhere refuses a `tools/list` that no
 * client can make any other way.
 */
function headerMismatch(
  headers: IncomingMessage['headers'],
  rpc: { method: string; params?: unknown },
): string | undefined {
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
  if (typeof presented !== 'string') {
    return `Header mismatch: Mcp-Name is required for ${rpc.method} and is missing`
  }
  if (decodeHeaderValue(presented) !== expected) {
    return `Header mismatch: Mcp-Name header value does not match body value '${expected}'`
  }
  return undefined
}

async function handle(req: IncomingMessage, res: ServerResponse, options: McpOptions): Promise<void> {
  const requestId = randomUUID()

  const path = (req.url ?? '').split('?')[0]

  // Prometheus, on the same terms as the API's: unauthenticated unless a token
  // is configured, and a wrong token gets 404 rather than 401 so a deployment
  // hiding the endpoint does not confirm it has one.
  if (req.method === 'GET' && path === '/metrics') {
    if (options.metrics === undefined) {
      send(res, 404, rpcError(null, -32601, 'Not found'))
      return
    }
    if (options.metricsToken !== undefined) {
      const header = req.headers.authorization
      const presented = header?.startsWith('Bearer ') === true ? header.slice(7) : ''
      const expected = Buffer.from(options.metricsToken, 'utf8')
      const given = Buffer.from(presented, 'utf8')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        send(res, 404, rpcError(null, -32601, 'Not found'))
        return
      }
    }
    const body = await options.metrics.render()
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
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
    res.end(JSON.stringify(options.resourceMetadata))
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
  if (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin)) {
    send(res, 403, rpcError(null, -32600, 'Origin not allowed'))
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
    send(res, 404, rpcError(null, -32601, 'Not found'))
    return
  }

  // `Mcp-Session-Id` and `Last-Event-ID` are ignored rather than refused, which
  // is what the specification asks of a server that implements only this
  // revision: an older client sending them gets an answer about the request
  // rather than about its framing.

  // The two headers required of *every* request. `Mcp-Name` is not one of them
  // — it is required only for the three methods that name something, and
  // demanding it on `tools/list` refused a request no client can make
  // correctly. Checked after the body is parsed, with the rest of the
  // header-to-body validation.
  for (const header of ['mcp-protocol-version', 'mcp-method']) {
    if (req.headers[header] === undefined) {
      // -32020 HeaderMismatch, which the specification allocates for exactly
      // this and which a client reads to decide whether it is talking to a
      // modern server. -32600 said "invalid request", and a client that gets
      // it falls back to a transport this server does not speak.
      send(res, 400, rpcError(null, HEADER_MISMATCH, `Missing required header: ${header}`))
      return
    }
  }

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
      'www-authenticate': `Bearer resource_metadata="${options.resourceMetadataUrl}"`,
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
  const mismatch = headerMismatch(req.headers, { method: rpc.method, params: rpc.params })
  if (mismatch !== undefined) {
    send(res, 400, rpcError(id, HEADER_MISMATCH, mismatch))
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
    case 'tools/list': {
      const layers = await options.layers.forCaller(auth)
      const tools: ToolDefinition[] = [...catalog(layers)]
      send(res, 200, {
        jsonrpc: '2.0',
        id,
        result: {
          // The catalog depends on this caller's permissions, so the cache is
          // per user. A global cache would serve one caller's catalog — and the
          // layer names inside it — to another.
          tools: tools.map(({ permission, ...tool }) => {
            void permission
            return tool
          }),
          ttlMs: TOOLS_TTL_MS,
          cacheScope: 'user',
        },
      })
      return
    }

    case 'tools/call': {
      const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof params.name !== 'string') {
        send(res, 400, rpcError(id, -32602, 'Invalid params'))
        return
      }

      const layers = await options.layers.forCaller(auth)
      const definition = catalog(layers).find((t) => t.name === params.name)
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
        send(res, 200, {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: false,
          },
        })
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
