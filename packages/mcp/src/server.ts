import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { authenticate, findTenantOverride, Problem, type AuthContext, type VerifyOptions } from '@nacre.work/api'

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
  call(name: string, args: Record<string, unknown>, auth: AuthContext): Promise<unknown>
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

async function handle(req: IncomingMessage, res: ServerResponse, options: McpOptions): Promise<void> {
  const requestId = randomUUID()

  if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/mcp') {
    send(res, 404, rpcError(null, -32601, 'Not found'))
    return
  }

  for (const header of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
    if (req.headers[header] === undefined) {
      send(res, 400, rpcError(null, -32600, `Missing required header: ${header}`))
      return
    }
  }

  const auth = await authenticate(req.headers.authorization, options.verify, '/mcp', requestId)
  if (auth instanceof Problem) {
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

      try {
        const result = await options.tools.call(
          definition.name,
          (params.arguments ?? {}) as Record<string, unknown>,
          auth,
        )

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
        // Nothing about what failed reaches the caller. A tool error that names
        // a layer tells them the layer exists, which is the leak invariant I4
        // is about, and an unknown tool must answer the same way.
        //
        // Logged here, though: without this a database that is down looks
        // exactly like a tool that does not exist, from both ends at once —
        // the caller is told nothing, by design, and the operator was told
        // nothing either.
        console.error(
          JSON.stringify({
            msg: 'tool call failed',
            tool: definition.name,
            request_id: requestId,
            error: String(error),
          }),
        )
        send(res, 404, rpcError(id, -32601, 'Not found'))
      }
      return
    }

    default:
      send(res, 404, rpcError(id, -32601, 'Not found'))
  }
}
