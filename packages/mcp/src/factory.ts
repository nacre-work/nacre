/**
 * One `McpServer` per caller, for both transports.
 *
 * This is the whole of what the two transports share, and the reason it is
 * one function rather than two: every divergence this repository has shipped
 * between Streamable HTTP and STDIO — `permission` on one wire and not the
 * other, two capability sets, a cache hint on one, `ping` on one, `initialize`
 * negotiating on one and announcing on the other — was two dispatchers each
 * building a result by hand. The protocol's results are
 * `@modelcontextprotocol/server`'s now: it negotiates `initialize`, answers
 * `server/discover`, builds `tools/list`, validates arguments against the
 * schema, stamps `resultType` and the cache hints, and refuses a mirrored
 * header that lies. What is left for this repository to say is what is on the
 * next hundred lines, and it is said once.
 *
 * The server is built **per request** on HTTP and once per connection on
 * STDIO, because the catalog is per caller: the search description names the
 * layers this principal may read, and a server instance built for one caller
 * and handed to another would hand one tenant's layer names to the other.
 * Building one costs a single bounded page of the layer catalog, which is the
 * same read `tools/list` always made.
 *
 * Statelessness is kept by construction. Nothing here outlives the request
 * that built it; a tool that needs state between calls returns a descriptor
 * and takes it back as an argument.
 */

import { fromJsonSchema, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import type { AuthContext } from '@nacre.work/api'
import { logger, MetadataError } from '@nacre.work/core'

import { INSTRUCTIONS } from './instructions.js'
import {
  CAPABILITIES,
  callToolError,
  callToolResult,
  DISCOVER_TTL_MS,
  TOOLS_TTL_MS,
  type ToolResult,
} from './results.js'
import { CATALOG_SAMPLE, catalog, type Layer, type ToolDefinition } from './tools.js'

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

export interface ServerBuild {
  /** Who is asking. Resolved by the transport before this is called, never here. */
  readonly auth: AuthContext
  /**
   * One id per request on HTTP; one per call on STDIO, where there is no
   * transport-level id and this is the only thing tying an audit row to one
   * invocation.
   */
  readonly requestId: () => string
  readonly layers: Layers
  readonly tools: ToolRunner
  /** What `initialize` and `server/discover` report as `serverInfo.version`. */
  readonly serverVersion?: string
  readonly observe?: McpMetrics
}

/** The version a transport reports when its entry point passed none. */
const versionOf = (serverVersion: string | undefined): string => serverVersion ?? '0.0.0'

/**
 * The catalog for this caller, and a server that serves it.
 *
 * A bounded page: the search description names a handful of layers and says
 * there are more, rather than interpolating a catalog that is a million
 * entries on the installations layers are sold for.
 */
export async function buildServer(build: ServerBuild): Promise<McpServer> {
  const page = await build.layers.forCaller(build.auth, { limit: CATALOG_SAMPLE })
  const definitions = catalog(page.layers, { more: page.nextCursor !== null })

  const server = new McpServer(
    { name: 'nacre', version: versionOf(build.serverVersion) },
    {
      capabilities: CAPABILITIES,
      instructions: INSTRUCTIONS,
      // `tools/list` is per caller and never fresh; `server/discover` is the
      // same for everybody and good for an hour. results.ts has both arguments.
      cacheHints: {
        'tools/list': { ttlMs: TOOLS_TTL_MS, cacheScope: 'private' },
        'server/discover': { ttlMs: DISCOVER_TTL_MS, cacheScope: 'public' },
      },
    },
  )

  for (const definition of definitions) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        // The schema as `tools.ts` writes it — JSON Schema, which the SDK
        // validates arguments against before the callback runs. A schema
        // written once and served verbatim is what keeps `mcp-surface.test.ts`'s
        // "no tool schema accepts an organization" a statement about the wire.
        inputSchema: fromJsonSchema(definition.inputSchema),
        annotations: definition.annotations,
      },
      async (args): Promise<CallToolResult> => runTool(build, definition, args as Record<string, unknown>),
    )
  }

  return server
}

/**
 * One tool call, wrapped the way both transports used to wrap it separately.
 *
 * The SDK would turn a thrown error into an `isError` result carrying the
 * error's own message, and that is the one thing it must not do here: a tool
 * error that names a layer tells the caller the layer exists, which is the
 * leak invariant I4 is about. So nothing thrown reaches the wire — the reason
 * is logged, where an operator can see that a database is down rather than
 * reading it as a tool that does not exist, and the caller gets one answer.
 *
 * One carve-out, and it is about the caller's own arguments rather than about
 * anything stored. A `MetadataError` says a key is not a legal name, or a
 * value is not a scalar, or a list is empty — facts the caller already had,
 * naming nothing they did not send. Answering "not found" to a typo in a
 * filter key leaves an agent retrying the same malformed call forever, because
 * the one thing it cannot learn from that answer is that its arguments were
 * wrong. Nothing else is separated out: the moment an error is about what
 * exists, it goes back into the single answer.
 */
async function runTool(
  build: ServerBuild,
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const requestId = build.requestId()
  const started = process.hrtime.bigint()
  const elapsed = (): number => Number(process.hrtime.bigint() - started) / 1e9

  try {
    const result = await build.tools.call(definition.name, args, build.auth, requestId)

    build.observe?.toolDuration.observe(elapsed(), { tool: definition.name })
    build.observe?.toolCalls.inc({ tool: definition.name, result: 'ok' })

    // Zero results on a search is what a denial looks like here: invariant 4
    // makes an invisible layer indistinguishable from an absent one, so there
    // is no 403 to count. Same reason and same reason string as the REST
    // surface, or the two do not add up on one dashboard.
    if (definition.name === 'search' && Array.isArray(result) && result.length === 0) {
      build.observe?.aclDenials.inc({ reason: 'search_empty' })
    }

    return callToolResult(result)
  } catch (error) {
    build.observe?.toolDuration.observe(elapsed(), { tool: definition.name })
    build.observe?.toolCalls.inc({ tool: definition.name, result: 'error' })

    logger.error('tool call failed', {
      tool: definition.name,
      request_id: requestId,
      error: String(error),
    })

    if (error instanceof MetadataError) return callToolError(error.message)
    return callToolError()
  }
}
