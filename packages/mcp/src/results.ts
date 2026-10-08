/**
 * What is still this repository's to say about a result, now that the
 * protocol's own results are the SDK's.
 *
 * ## What used to be here
 *
 * `initialize`, `server/discover`, `tools/list` and `ping` were built in this
 * file, by hand, because the two transports had each built their own and
 * diverged — `permission` on one and not the other, two capability sets, a
 * cache hint on one. One builder per result closed that, and the parity suite
 * compared the whole object afterwards.
 *
 * Those four are `@modelcontextprotocol/server`'s now. The version
 * negotiation, the `_meta` envelope, `resultType`, the cache hints on every
 * cacheable result, the `-32020`/`-32022` refusals and the legacy era's
 * `initialize` are all one implementation that both transports are handed
 * through one factory (`factory.ts`), so a divergence needs a second factory
 * rather than a second call site. What survives here is the part the SDK has
 * no opinion on: how a tool's answer is wrapped, and what a failure says.
 */

import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'

/**
 * The revision this server prefers — the head of PROTOCOL_VERSIONS.
 *
 * A literal, because the SDK keeps the two eras apart: its
 * `LATEST_PROTOCOL_VERSION` is the newest **legacy** revision (`2025-11-25`,
 * the one every `initialize` negotiates against), and the modern revision is
 * what `server/discover` advertises. `mcp-surface.test.ts` holds this literal
 * against what `server/discover` actually says, so the two cannot drift.
 */
export const PROTOCOL_VERSION = '2026-07-28'

/**
 * The revisions reachable through `initialize`, newest first.
 *
 * The SDK's own list rather than one written here, because the SDK is what
 * negotiates `initialize` — a list kept beside it would be a second answer to
 * "which revisions", which is the shape that left `2025-11-25` out of the
 * hand-written one while it was the revision every shipping client proposed.
 * A client arriving on `initialize` is legacy by definition and cannot fall
 * forward, so the counter-offer comes from this list and never from the
 * modern head.
 */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [...SUPPORTED_PROTOCOL_VERSIONS]

/** Every revision this server can speak, newest first. */
export const PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS]

/**
 * tools/list is never fresh: `0`, which the caching utility defines as
 * "immediately stale, re-fetch every time it is needed".
 *
 * It was five minutes, and that stayed inert only while nothing honoured it.
 * The hint went out on every tools/list without `resultType`, so a 2026-07-28
 * client could not read the result as one of its own; 0.26.1 added the field
 * and a client that now reads the hint — Claude's connectors did, on the day
 * — served its cached catalog for five minutes after every fetch, and a manual
 * refresh of the tool list did nothing.
 *
 * `0` is also the correct value on its own terms: the catalog is per caller
 * and names the layers they may see, so a grant or a revocation changes it,
 * and this server sends no `list_changed` to say so. A client holding a fresh
 * copy has no way to learn it went stale.
 */
export const TOOLS_TTL_MS = 0

/**
 * `server/discover` is cached for an hour, and publicly.
 *
 * Longer than the tool catalog because it carries less: a version list and a
 * capability set change when this process is replaced, not when a grant moves.
 */
export const DISCOVER_TTL_MS = 3_600_000

/**
 * Tools and resources, and nothing else: no prompts, no sampling, no
 * subscriptions. Declaring a capability this server does not serve is how a
 * client comes back with a call that 404s. The resources are the three MCP
 * App views (`ui://nacre/*`), which is what makes a host render a panel for
 * `search`, `list_layers` and `upload_file`.
 *
 * `listChanged: false` is said rather than left out. This server sends no
 * `list_changed` of either kind — the catalog is per caller and computed on
 * the request, and the views are fixed at build time — and a client reading
 * an absent field has to know the default to reach the same conclusion.
 */
export const CAPABILITIES = { tools: { listChanged: false }, resources: { listChanged: false } } as const

/**
 * `resultType`, which 2026-07-28 makes a MUST on every result. The SDK stamps
 * it on every modern-era result it encodes, so a builder here does not have to
 * — `result-type.test.ts` asks the wire rather than these functions now.
 */
export const COMPLETE = 'complete' as const

/** The shape a tool answers in: MCP's `CallToolResult`, with the payload in a text block. */
export interface ToolResult {
  readonly [extra: string]: unknown
  readonly content: { readonly type: 'text'; readonly text: string }[]
  readonly isError: boolean
}

/**
 * `tools/call`'s envelope: a CallToolResult, never the bare value.
 *
 * The protocol requires `content` to be a list of content blocks, and a
 * client that follows it rejects anything else. Both dispatchers used to
 * spell this object out by hand — two copies of the shape this module exists
 * to make one.
 */
export const callToolResult = (result: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  isError: false,
})

/**
 * `tools/call`'s answer when the call did not succeed: a CallToolResult with
 * `isError: true`, delivered as an ordinary result.
 *
 * It used to be a JSON-RPC error on an HTTP `404`, and on Streamable HTTP a
 * `404` is not "not found" — it is the transport's signal that the *session*
 * is gone. A client that follows the specification drops its connection and
 * starts over, so one `get_document` for a missing id made a real client
 * (Claude Code, and claude.ai's connectors behind it) report "session
 * expired" and then fail to reload its tools. A tool that did not find
 * something is the tool's answer, which is what `isError` is for; the
 * protocol keeps JSON-RPC errors for the request itself being wrong.
 *
 * The message is one string for every failure — a missing document, a layer
 * the caller may not read, a database that is down — which is invariant 4
 * unchanged: the answer names nothing the caller did not send.
 */
export const callToolError = (message = 'Not found'): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
})
