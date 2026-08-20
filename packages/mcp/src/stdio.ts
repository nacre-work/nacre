import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

import { authenticate, Problem, type AuthContext, type VerifyOptions } from '@nacre.work/api'
import { logger } from '@nacre.work/core'

import { catalog } from './tools.js'
// The same three results the HTTP transport answers with, built once. Each was
// hand-built in both files until a capability set and a cache hint diverged.
import { discoverResult, initializeResult, toolsListResult, pingResult, callToolResult } from './results.js'
import { PROTOCOL_VERSION } from './server.js'
import type { Layers, ToolRunner } from './server.js'

/**
 * MCP over STDIO, for a developer agent on a laptop.
 *
 * The transport differs from Streamable HTTP in two ways and no others: the
 * caller is authenticated once from `NACRE_SERVICE_KEY` instead of per request,
 * and messages arrive as newline-delimited JSON on stdin. Everything behind
 * that — the catalog, the tools, the resolver — is the same objects the HTTP
 * server uses.
 *
 * **Local mode gets no relaxation of any kind.** The permissions are exactly
 * the service account's, computed by the same code, and there is no
 * developer-convenience path that skips the layer bound because the process
 * happens to be on the same machine as the operator. docs/mcp.md says so and
 * this is where it would be tempting to differ.
 */

/**
 * stdout carries the protocol and nothing else.
 *
 * A stray `console.log` — a startup banner, a debug line left in — lands in the
 * middle of the message stream and the client fails to parse a frame it did not
 * ask for. Diagnostics go to stderr, which is what a terminal shows anyway.
 */
function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/**
 * Through the process logger, which `stdio-main` has pointed at stderr for the
 * reason stated above. Writing here directly worked and ignored
 * `NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` — a local client run with `text` got
 * JSON from this one file.
 */
const log = (msg: string, extra: Record<string, unknown> = {}): void => {
  logger.info(msg, extra)
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

export interface StdioOptions {
  readonly verify: VerifyOptions
  readonly serviceKey: string
  readonly layers: Layers
  readonly tools: ToolRunner
  readonly input?: NodeJS.ReadableStream
  /** What `initialize` and `server/discover` report. See the note in main.ts. */
  readonly serverVersion?: string
}

/**
 * Serve until stdin closes.
 *
 * Resolves when the stream ends, so a caller can shut its pool down afterwards
 * rather than guessing when the client went away.
 */
export async function serveStdio(options: StdioOptions): Promise<void> {
  // Once, at startup, and the process refuses to run without it. A transport
  // that authenticated per message would be inventing a session model the
  // protocol does not have here.
  const auth = await authenticate(`Bearer ${options.serviceKey}`, options.verify, '/stdio', 'stdio')
  if (auth instanceof Problem) {
    throw new Error(
      'NACRE_SERVICE_KEY did not verify. It is a token for a service account, issued by ' +
        'the installation this is talking to, and local mode carries exactly that ' +
        "account's permissions.",
    )
  }

  log('mcp stdio ready', {
    principal: `${auth.principal.type}:${auth.principal.id}`,
    protocol: PROTOCOL_VERSION,
  })

  const lines = createInterface({ input: options.input ?? process.stdin, crlfDelay: Infinity })

  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue

    let rpc: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
    try {
      rpc = JSON.parse(trimmed) as typeof rpc
    } catch {
      write(rpcError(null, -32700, 'Parse error'))
      continue
    }

    const id = rpc.id ?? null
    if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      write(rpcError(id, -32600, 'Invalid request'))
      continue
    }

    // A notification has no id and takes no reply, per JSON-RPC. `initialized`
    // is the one that arrives in practice; answering it puts an unexpected
    // frame on the stream.
    const isNotification = rpc.id === undefined

    try {
      const result = await dispatch(rpc.method, rpc.params, auth, options)
      if (!isNotification) write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      // Same rule as the HTTP transport: nothing about which tool failed, or
      // why, reaches the caller — that would say whether a tool, and so a
      // layer, exists. The reason goes to stderr for whoever is running this.
      log('call failed', { method: rpc.method, error: String(error) })
      if (!isNotification) write(rpcError(id, -32601, 'Not found'))
    }
  }
}

async function dispatch(
  method: string,
  params: unknown,
  auth: AuthContext,
  options: StdioOptions,
): Promise<unknown> {
  switch (method) {
    // The same negotiation the HTTP transport makes, and it was wrong here in
    // the same way and one step further: this answered `PROTOCOL_VERSION`
    // unconditionally, so a client proposing anything at all was told
    // `2026-07-28` and threw `Server's protocol version is not supported`
    // before it ever reached a tool.
    //
    // `initialize` is the legacy era's opening move by definition, and a legacy
    // client cannot fall forward — so what it hears back has to be a revision
    // its own generation knows. Echo the proposal when this server speaks it;
    // counter-offer the newest legacy revision otherwise.
    case 'initialize':
      return initializeResult(
        ((params ?? {}) as { protocolVersion?: unknown }).protocolVersion,
        options.serverVersion,
      )

    // The modern era's opening move, which 2026-07-28 makes a MUST. On stdio it
    // is also the probe a dual-era client uses to tell the two apart, so a
    // server without it reads as legacy and the client silently drops a
    // revision.
    case 'server/discover':
      return discoverResult(options.serverVersion)

    case 'notifications/initialized':
      return undefined

    case 'ping':
      return pingResult()

    case 'tools/list':
      return toolsListResult(catalog(await options.layers.forCaller(auth)))

    case 'tools/call': {
      const call = (params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof call.name !== 'string') throw new Error('name is required')

      // The catalog is per caller, so a tool this service account cannot see is
      // indistinguishable from one that does not exist — the same property the
      // HTTP surface has, reached the same way.
      const visible = catalog(await options.layers.forCaller(auth))
      if (!visible.some((t) => t.name === call.name)) throw new Error('unknown tool')

      const result = await options.tools.call(
        call.name,
        (call.arguments ?? {}) as Record<string, unknown>,
        auth,
        // One id per call here too. STDIO has no transport-level request id, so
        // this is the only thing tying an audit row to one invocation.
        randomUUID(),
      )
      return callToolResult(result)
    }

    default:
      throw new Error(`unknown method: ${method}`)
  }
}
