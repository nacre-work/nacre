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

import { readFile } from 'node:fs/promises'

import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server'
import { fromJsonSchema, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { ceilingOffers, type AuthContext } from '@nacre.work/api'
import { logger, MetadataError, readFrontmatter } from '@nacre.work/core'

import { INSTRUCTIONS, instructionsFor, type InstructionSkill } from './instructions.js'
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

/**
 * The base skill an agent of this caller is given. docs/skills.md.
 *
 * Optional, so a transport built without a database — the surface suites —
 * serves the built-in instructions alone, which is what every deployment did
 * before skills existed.
 */
export interface SkillSource {
  base(auth: AuthContext): Promise<InstructionSkill>
}

/**
 * A refusal about the caller's own arguments, whose message is safe to send.
 *
 * The wrapper below hides every thrown message, because one naming a layer
 * says the layer exists. These name nothing the caller did not send or could
 * not already read: a skill the format refuses and why, a version that is not
 * the current one, a write this tool does not make. Answering "not found" to
 * any of them leaves an agent retrying a call that can never succeed.
 */
export class ToolArgumentError extends Error {
  override readonly name = 'ToolArgumentError'
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
  /** The base skill for `instructions`. Absent, the built-in text alone. */
  readonly skills?: SkillSource
  /** What `initialize` and `server/discover` report as `serverInfo.version`. */
  readonly serverVersion?: string
  readonly observe?: McpMetrics
  /**
   * Whether the client renders MCP Apps. `false` hides `upload_file`, the one
   * tool that does nothing without a panel; the views and the `_meta.ui` on
   * `search` and `list_layers` stay, because a client that does not render
   * them ignores them. Absent is `true` — see `Verified.ui` in server.ts.
   */
  readonly ui?: boolean
  /**
   * The origin the upload view sends bytes to — the API's canonical URL —
   * which is the one origin a view's CSP has to admit. Absent, the upload
   * view is not served and `upload_file` is not offered: a panel that cannot
   * reach the ticket endpoint is a panel that cannot do its job.
   */
  readonly apiOrigin?: string
}

/**
 * The four views, by the name the tool metadata and the resource list use.
 *
 * `upload` is the only one that makes a network request of its own — the
 * bytes to the ticket URL — so it is the only one whose CSP names an origin.
 * The other two reach the server through the host and nothing else, and a
 * CSP admitting nothing is the secure default the extension specifies.
 */
export const VIEWS = ['upload', 'search', 'layers', 'skill'] as const
export type View = (typeof VIEWS)[number]

export const viewUri = (view: View): string => `ui://nacre/${view}.html`

/**
 * A view's HTML, read from `apps/build/` — one directory above this module
 * whether it runs from `src/` under the test runner or from `dist/` in the
 * package, which is why the path is relative to the module and not to the
 * working directory. Built by `scripts/build-apps.mjs`; a missing file is a
 * build that did not run, and says so.
 */
export async function viewHtml(view: View | 'change'): Promise<string> {
  const at = new URL(`../apps/build/${view}.html`, import.meta.url)
  try {
    return await readFile(at, 'utf8')
  } catch (error) {
    throw new Error(`the ${view} view is not built (${at.pathname}); run the package build`, { cause: error })
  }
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
  const [page, instructions] = await Promise.all([
    build.layers.forCaller(build.auth, { limit: CATALOG_SAMPLE }),
    instructionsOf(build),
  ])
  const definitions = catalog(page.layers, { more: page.nextCursor !== null })

  const server = new McpServer(
    { name: 'nacre', version: versionOf(build.serverVersion) },
    {
      capabilities: CAPABILITIES,
      instructions,
      // Both per caller now. `tools/list` names the caller's layers and is
      // never fresh; `server/discover` carries `instructions`, which carry the
      // organization's own skill, so a shared cache would hand one tenant's
      // text to another. results.ts has the TTLs.
      cacheHints: {
        'tools/list': { ttlMs: TOOLS_TTL_MS, cacheScope: 'private' },
        'server/discover': { ttlMs: DISCOVER_TTL_MS, cacheScope: 'private' },
      },
    },
  )

  const views = build.apiOrigin === undefined ? false : build.ui !== false
  for (const definition of definitions) {
    // The panel tool is offered only where a panel can be rendered and can
    // reach the ticket endpoint. Dropped from the catalog, not refused: a
    // tool a client cannot use is noise in its catalog and a wasted call.
    if (definition.name === 'upload_file' && !views) continue
    // Nor a tool the connection's ceiling refuses. A person who approved a
    // read-only connection approved a search client, and a search client
    // offered `delete_document` is one invited to try it: every call would be
    // refused, so the tool is noise in the catalog, a wasted call, and a
    // screen that says the client may do what the person said it may not.
    //
    // The delegation's ceiling only, deliberately. It is fixed at consent and
    // the same for the token's whole life, so this is exact. A principal's
    // *grants* move between calls while a client lists tools once per
    // session (`listChanged: false`), so hiding by grants would leave a write
    // granted after connecting invisible until somebody reconnects. Every
    // call is still checked; this only ever removes.
    //
    // `ceilingOffers` is the predicate the request path asks — the
    // connection's ceiling for a permission, and `skill-ceiling.ts`'s own
    // answer for the one tool a `skill` box offers — so the catalog and the
    // refusal cannot disagree about what the ceiling admits.
    if (!ceilingOffers(build.auth, definition.ceiling ?? definition.permission)) continue

    const config = {
      title: definition.title,
      description: definition.description,
      // The schema as `tools.ts` writes it — JSON Schema, which the SDK
      // validates arguments against before the callback runs. A schema
      // written once and served verbatim is what keeps `mcp-surface.test.ts`'s
      // "no tool schema accepts an organization" a statement about the wire.
      inputSchema: fromJsonSchema(definition.inputSchema),
      annotations: definition.annotations,
    }
    const callback = async (args: unknown): Promise<CallToolResult> =>
      runTool(build, definition, args as Record<string, unknown>)

    // Three tools carry a view: a host that renders MCP Apps shows it when
    // the tool is called, and a client that does not ignores `_meta`. The
    // helper writes the metadata under both the current and the legacy key,
    // which is what the hosts shipping today read.
    const view = VIEW_OF[definition.name]
    if (view !== undefined && build.apiOrigin !== undefined) {
      registerAppTool(server, definition.name, { ...config, _meta: { ui: { resourceUri: viewUri(view) } } }, callback)
    } else {
      server.registerTool(definition.name, config, callback)
    }
  }

  if (build.apiOrigin !== undefined) {
    for (const view of VIEWS) {
      registerAppResource(
        server,
        `Nacre ${view}`,
        viewUri(view),
        {
          mimeType: RESOURCE_MIME_TYPE,
          description: VIEW_ABOUT[view],
          // `connectDomains` is the one origin the upload view fetches — the
          // ticket URL on the API. The other views declare none, which the
          // extension reads as "no network", and that is the point: they
          // reach the server through the host and nothing else.
          _meta: { ui: { csp: { connectDomains: view === 'upload' ? [build.apiOrigin] : [] } } },
        },
        async (uri) => ({
          contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: await viewHtml(view) }],
        }),
      )
    }
  }

  return server
}

/**
 * The built-in text and the base skill, or the built-in text alone when the
 * skill cannot be read.
 *
 * Degrading rather than failing, and that is not invariant 3 being relaxed:
 * the skill is guidance, not a permission input, and a connection whose
 * agent is told less is still held to every rule. A failure that took the
 * whole connection down with it would make a database blip into an agent
 * that cannot search.
 */
async function instructionsOf(build: ServerBuild): Promise<string> {
  if (build.skills === undefined) return INSTRUCTIONS
  try {
    const skill = await build.skills.base(build.auth)
    return instructionsFor(skill, (text) => {
      const read = readFrontmatter(text)
      return 'body' in read ? read.body.trim() : text
    })
  } catch (error) {
    logger.warn('the base skill could not be read; instructions carry the built-in text alone', {
      error: String(error).slice(0, 200),
    })
    return INSTRUCTIONS
  }
}

/** Which tool opens which view. */
const VIEW_OF: Readonly<Record<string, View | undefined>> = {
  search: 'search',
  list_layers: 'layers',
  upload_file: 'upload',
  get_skill: 'skill',
  list_skills: 'skill',
}

const VIEW_ABOUT: Readonly<Record<View, string>> = {
  upload: 'Pick a file to add to a layer; the bytes go to the index and never through the conversation.',
  search: 'The results of a search, with the layer, the document id and the score of every hit — the permitted set.',
  layers: 'The layers this principal may read, with their document counts.',
  skill:
    "A skill as the console shows one: its files as a folder, SKILL.md rendered and as source, who wrote the " +
    'version and whether it carries scripts — and, where the person may write it, loading a folder or a .zip.',
}

/**
 * The document's bytes as a `resource_link`, beside the JSON.
 *
 * `get_document` carries `source_url` — a presigned link to the original
 * bytes, minted after the permission check and only where the deployment
 * keeps bytes in object storage. In the JSON it is a string the model would
 * have to notice; as a `resource_link` content block it is what the 2026-07-28
 * revision has a server say when a result *is* somewhere else, and a client
 * that knows the block fetches it directly — the whole file, out of band,
 * without the text passing through the conversation. The JSON block stays,
 * for every client that reads that and nothing else.
 *
 * `search` deliberately carries none: a presigned URL is a bearer capability
 * that outlives the check which minted it, and ten per search is ten
 * capabilities where the caller wanted an ordering. docs/mcp.md says so.
 */
function withResourceLink(tool: string, result: unknown, wrapped: ToolResult): ToolResult {
  if (tool !== 'get_document' || typeof result !== 'object' || result === null) return wrapped
  const document = result as { source_url?: unknown; title?: unknown; external_id?: unknown; document_id?: unknown }
  if (typeof document.source_url !== 'string') return wrapped
  const name =
    typeof document.title === 'string' && document.title !== ''
      ? document.title
      : typeof document.external_id === 'string' && document.external_id !== ''
        ? document.external_id
        : String(document.document_id ?? 'document')
  return {
    ...wrapped,
    content: [
      ...wrapped.content,
      {
        type: 'resource_link',
        uri: document.source_url,
        name,
        description: 'The original bytes, as a presigned link that expires. Fetch it directly.',
      },
    ],
  }
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

    return withResourceLink(definition.name, result, callToolResult(result))
  } catch (error) {
    build.observe?.toolDuration.observe(elapsed(), { tool: definition.name })
    build.observe?.toolCalls.inc({ tool: definition.name, result: 'error' })

    logger.error('tool call failed', {
      tool: definition.name,
      request_id: requestId,
      error: String(error),
    })

    if (error instanceof MetadataError || error instanceof ToolArgumentError) return callToolError(error.message)
    return callToolError()
  }
}
