/**
 * The three results both transports answer with, built in one place.
 *
 * ## The defect
 *
 * `permission` was the first instance: this repository's own bookkeeping, on
 * MCP's `Tool`, returned by STDIO and stripped by Streamable HTTP for the whole
 * life of both. `onTheWire` fixed that and `transport-parity.test.ts` was added
 * against it.
 *
 * Two more were sitting beside it the whole time, and the parity suite could not
 * see either, because each of its cases compares a *projection*:
 *
 *   - `initialize` and `server/discover` declared different capability sets.
 *     `{ tools: {} }` over HTTP, `{ tools: { listChanged: false } }` over
 *     STDIO — one server telling two clients two different things about what it
 *     supports. No case compared `capabilities` at all.
 *
 *   - `tools/list` carried `ttlMs` and `cacheScope` over HTTP and neither over
 *     STDIO, so a STDIO client had no cache hint for the one result here that
 *     is per caller and expensive. The case projected `r.tools`, which is
 *     exactly the part that agreed.
 *
 * A parity case whose projection is narrow enough is a parity case that cannot
 * fail. That is the same defect as reading `location.hash` from a router that
 * never rewrites it, and the same one the first `lint:admin-layout` had —
 * a check that learned the shape of the edit rather than the property.
 *
 * ## The repair
 *
 * Not a third fix in two files. These are results, they belong to the protocol
 * rather than to a transport, and there is exactly one right answer for each —
 * so they are built here and both transports return what they are given. A
 * divergence is then not a thing anybody can write by accident: it needs a
 * second call site, and the parity suite compares the **whole result** now
 * rather than a slice of it.
 *
 * Which way each one was unified:
 *
 *   - **`listChanged: false`**, explicitly. It is a statement about
 *     notifications this server never sends, and both readings are correct in
 *     the specification — but only one of them is a statement. An absent field
 *     leaves a client inferring the default, and the transport that already
 *     said it out loud was saying the truer thing.
 *
 *   - **`ttlMs` and `cacheScope` on `tools/list` over both.** `server/discover`
 *     already carried them on both, which is what makes the asymmetry an
 *     oversight rather than a decision: the catalog depends on who is asking
 *     either way, and `cacheScope: 'user'` is that fact rather than a property
 *     of HTTP.
 */
import { INSTRUCTIONS } from './instructions.js'
import { onTheWire, type ToolDefinition } from './tools.js'

/** The revision this server prefers — the head of PROTOCOL_VERSIONS. */
export const PROTOCOL_VERSION = '2026-07-28'

/** tools/list is cached per user for five minutes — see cacheScope below. */
export const TOOLS_TTL_MS = 300_000

/**
 * `server/discover` is cached for an hour, and publicly.
 *
 * Longer than the tool catalog because it carries less: a version list and a
 * capability set change when this process is replaced, not when a grant moves.
 */
export const DISCOVER_TTL_MS = 3_600_000

/**
 * The revisions reachable through `initialize`, newest first.
 *
 * 2026-07-28 splits clients into two eras, and this list is the older one:
 * a **legacy** client opens with `initialize` and negotiates a version in the
 * result, while a **modern** one carries the version on every request in
 * `_meta` and never sends `initialize` at all. Both transports serve both,
 * which the specification calls dual-era and its compatibility matrix says
 * works.
 *
 * The list matters because of one asymmetry the matrix states outright:
 * **legacy clients have no fall-forward mechanism.** A modern client that
 * hears a version it does not know retries with one from `supported`; a legacy
 * client can only fail. So whatever `initialize` answers has to be a version
 * that generation of client actually speaks.
 */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const

/**
 * Every revision this server can speak, newest first — what `server/discover`
 * advertises and what the `MCP-Protocol-Version` header is checked against.
 *
 * The list is short because the surface is: `tools/list` and `tools/call` are
 * shaped the same in all of them, and nothing here uses a feature that moved.
 * `2025-11-25` was missing and that was not a small omission — it is the
 * newest revision any shipping client knows, so it is the one every real
 * client proposes. See the note on the `initialize` handler.
 */
export const PROTOCOL_VERSIONS = [PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS] as const

/**
 * Tools and nothing else, which is the whole surface: no resources, no
 * prompts, no sampling. Declaring a capability this server does not serve is
 * how a client comes back with a call that 404s.
 *
 * `listChanged: false` is said rather than left out. This server sends no
 * `notifications/tools/list_changed` — the catalog is per caller and computed
 * on the request — and a client reading an absent field has to know the
 * default to reach the same conclusion.
 */
export const CAPABILITIES = { tools: { listChanged: false } } as const

/** The version a transport reports when its entry point passed none. */
const versionOf = (serverVersion: string | undefined): string => serverVersion ?? '0.0.0'

/**
 * The revision to answer a legacy client with.
 *
 * Echo the proposal when this server speaks it; counter-offer the newest
 * **legacy** revision otherwise, never the newest overall — a client arriving
 * on `initialize` is legacy by definition, and it cannot fall forward to a
 * revision its own generation has never heard of.
 */
export const agreedVersion = (asked: unknown): string =>
  typeof asked === 'string' && (PROTOCOL_VERSIONS as readonly string[]).includes(asked)
    ? asked
    : LEGACY_PROTOCOL_VERSIONS[0]

/** `initialize`'s result: the legacy handshake. */
export const initializeResult = (asked: unknown, serverVersion: string | undefined) => ({
  protocolVersion: agreedVersion(asked),
  capabilities: CAPABILITIES,
  serverInfo: { name: 'nacre', version: versionOf(serverVersion) },
  // The specification's field for "how to use this server", which we sent
  // nothing in until it existed. One string shared by both transports — see
  // instructions.ts.
  instructions: INSTRUCTIONS,
})

/**
 * `server/discover`'s result, a MUST for any server claiming this revision.
 *
 * It is `initialize` with the handshake taken out. A modern client sends no
 * `initialize` and negotiates nothing — it names a version on every request —
 * so what it needs up front is the list of versions to pick from and the
 * capabilities to expect. Both are static, which is why this answers without
 * touching a dependency and why `cacheScope` is `public`: unlike `tools/list`,
 * nothing in this result depends on who is asking.
 */
export const discoverResult = (serverVersion: string | undefined) => ({
  resultType: 'complete',
  supportedVersions: [...PROTOCOL_VERSIONS],
  capabilities: CAPABILITIES,
  _meta: {
    'io.modelcontextprotocol/serverInfo': { name: 'nacre', version: versionOf(serverVersion) },
  },
  ttlMs: DISCOVER_TTL_MS,
  cacheScope: 'public',
})

/**
 * `tools/list`'s result.
 *
 * The catalog depends on this caller's permissions, so the cache is per user. A
 * global cache would serve one caller's catalog — and the layer names inside
 * it — to another.
 */
export const toolsListResult = (tools: readonly ToolDefinition[]) => ({
  tools: onTheWire(tools),
  ttlMs: TOOLS_TTL_MS,
  cacheScope: 'user',
})

/**
 * `ping`'s result: the empty object, by specification.
 *
 * Built here like the other three even though there is nothing to build,
 * because the method itself is what diverged: ping is a MUST-respond for both
 * parties in every revision, and STDIO answered it while Streamable HTTP fell
 * through to its 404 arm for the whole life of both — a client's keep-alive
 * dropping the very connection it was checking, over the transport the
 * product is for. A result the transports share is a result a dispatcher has
 * to name to return, and the parity suite reads both dispatchers' method
 * lists now, so losing the arm again fails there.
 */
export const pingResult = (): Record<string, never> => ({})

/**
 * `tools/call`'s envelope: a CallToolResult, never the bare value.
 *
 * The protocol requires `content` to be a list of content blocks, and a
 * client that follows it rejects anything else. Both dispatchers used to
 * spell this object out by hand — two copies of the shape this module exists
 * to make one.
 */
export const callToolResult = (result: unknown) => ({
  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
  isError: false,
})
