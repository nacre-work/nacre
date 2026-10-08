import { randomUUID } from 'node:crypto'
import { PassThrough, type Readable } from 'node:stream'

import { serveStdio as serveWithSdk, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import type { JSONRPCMessage, MessageExtraInfo, Transport } from '@modelcontextprotocol/server'
import { authenticate, findTenantOverride, Problem, type VerifyOptions } from '@nacre.work/api'
import { logger } from '@nacre.work/core'

import { buildServer, type Layers, type ToolRunner } from './factory.js'
import { PROTOCOL_VERSION } from './results.js'

/**
 * MCP over STDIO, for a developer agent on a laptop.
 *
 * The transport differs from Streamable HTTP in two ways and no others: the
 * caller is authenticated once from `NACRE_SERVICE_KEY` instead of per request,
 * and messages arrive as newline-delimited JSON on stdin. Everything behind
 * that — the catalog, the tools, the resolver — is the same `McpServer` the
 * HTTP transport builds, from the same factory.
 *
 * **Local mode gets no relaxation of any kind.** The permissions are exactly
 * the service account's, computed by the same code, and there is no
 * developer-convenience path that skips the layer bound because the process
 * happens to be on the same machine as the operator. docs/mcp.md says so and
 * this is where it would be tempting to differ.
 *
 * stdout carries the protocol and nothing else. The SDK's transport writes
 * frames there; diagnostics go through the process logger, which `stdio-main`
 * has pointed at stderr — a stray line in the middle of the stream is a frame
 * the client cannot parse.
 */

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
 * The one check this transport makes on every frame before the SDK sees it.
 *
 * The organization comes from the token. A params object naming one is not a
 * malformed call, it is an attempt to act as another tenant — the same rule as
 * the REST surface and the HTTP transport, and it is checked before dispatch
 * on all three. The SDK has no seam for it, so the transport is wrapped: a
 * frame carrying an override is answered here and never forwarded.
 *
 * The wrapper is also what lets `serveStdio` know when it is finished. The
 * SDK's handle closes when stdin does, but a response may still be in flight
 * at that moment; this counts the requests it has forwarded against the
 * responses it has written, and resolves only when stdin has ended **and**
 * nothing is outstanding — which is what the parity suite, feeding one frame
 * and reading the answer, depends on.
 */
class GuardedStdio implements Transport {
  onclose?: (() => void) | undefined
  onerror?: ((error: Error) => void) | undefined
  onmessage?: (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void) | undefined

  readonly #inner: StdioServerTransport
  readonly #pending = new Set<string | number>()
  #ended = false
  #closed = false
  #settle: (() => void) | undefined
  readonly done = new Promise<void>((resolve) => {
    this.#settle = resolve
  })

  constructor(inner: StdioServerTransport, input: Readable) {
    this.#inner = inner
    // stdin ending is not the connection ending. A client that writes its
    // frames and closes the pipe — a script, the parity suite — has closed
    // the input while the answers are still being computed; the SDK's
    // transport closes itself the moment its stdin does and refuses to write
    // afterwards, and the SDK drops every queued message the moment it hears
    // `onclose`. So the SDK's transport is fed a stream that never ends (see
    // `serveStdio`), the end is watched here, and it is forwarded only once
    // every request on the wire has been answered — which is also when
    // `done` settles.
    input.once('end', () => {
      this.#ended = true
      this.#maybeDone()
    })
  }

  async start(): Promise<void> {
    this.#inner.onerror = (error) => this.onerror?.(error)
    this.#inner.onclose = () => {
      this.#ended = true
      this.#maybeDone()
    }
    this.#inner.onmessage = (message: JSONRPCMessage) => {
      const frame = message as { id?: unknown; params?: unknown; method?: unknown }
      const hasId = typeof frame.id === 'string' || typeof frame.id === 'number'
      if (typeof frame.method === 'string' && findTenantOverride(frame.params) !== undefined) {
        if (hasId) {
          void this.send({
            jsonrpc: '2.0',
            id: frame.id as string | number,
            error: { code: -32602, message: 'The organization comes from the token.' },
          })
        }
        return
      }
      if (hasId && typeof frame.method === 'string') this.#pending.add(frame.id as string | number)
      this.onmessage?.(message)
    }
    await this.#inner.start()
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as { id?: unknown }).id
    if (typeof id === 'string' || typeof id === 'number') this.#pending.delete(id)
    await this.#inner.send(message)
    this.#maybeDone()
  }

  close(): Promise<void> {
    return this.#inner.close()
  }

  #maybeDone(): void {
    if (!this.#ended || this.#pending.size !== 0 || this.#closed) return
    this.#closed = true
    this.#settle?.()
    this.onclose?.()
  }
}

/**
 * Serve until stdin closes.
 *
 * Resolves when the stream has ended and every request on it has been
 * answered, so a caller can shut its pool down afterwards rather than guessing
 * when the client went away.
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

  logger.info('mcp stdio ready', {
    principal: `${auth.principal.type}:${auth.principal.id}`,
    protocol: PROTOCOL_VERSION,
  })

  // Through a PassThrough, which turns whatever the input yields into bytes
  // and is never ended. The SDK's reader slices Buffers; `process.stdin`
  // hands it those, and a test's `Readable.from([...strings])` hands it
  // strings — which is a TypeError on every chunk, re-raised forever, and the
  // process out of memory within a second. Found by running it. The end of
  // the input is `GuardedStdio`'s to notice, for the reason given there.
  const input = (options.input ?? process.stdin) as Readable
  const bytes = new PassThrough()
  input.pipe(bytes, { end: false })
  const transport = new GuardedStdio(new StdioServerTransport(bytes, process.stdout), input)

  // One server for the connection, from the same factory the HTTP transport
  // uses per request. The SDK serves both eras over it: a legacy client's
  // `initialize` and a modern client's `server/discover` probe alike.
  const handle = serveWithSdk(
    () =>
      buildServer({
        auth,
        // One id per call. STDIO has no transport-level request id, so this is
        // the only thing tying an audit row to one invocation.
        requestId: () => randomUUID(),
        layers: options.layers,
        tools: options.tools,
        ...(options.serverVersion === undefined ? {} : { serverVersion: options.serverVersion }),
      }),
    {
      transport,
      legacy: 'serve',
      onerror: (error) => {
        logger.warn('mcp stdio', { error: String(error).slice(0, 200) })
      },
    },
  )

  try {
    await transport.done
  } finally {
    await handle.close()
  }
}
