# MCP conformance — 2026-07-28

Since 0.28.0 the protocol is served by `@modelcontextprotocol/server` 2.x, the
reference implementation of this revision, and the questions below are asked of
it rather than of a hand-written dispatcher. What this repository still owns is
everything that happens **before** a JSON-RPC envelope is read —
`packages/mcp/src/server.ts` — and the one `McpServer` factory both transports
are built from — `packages/mcp/src/factory.ts`. Each row below says which.

Status is one of **holds** (checked, and a test pins it), **gap** (we do not do
it), or **deviation** (we do something else on purpose, with the reason).

## Transport — Streamable HTTP

| Requirement | Status | Whose |
|---|---|---|
| A single endpoint path | holds — `/mcp`, nothing else | ours |
| `Origin` validated; present-and-invalid is `403` | holds | ours |
| A notification the server accepts gets `202` with no body | holds | SDK |
| An unimplemented RPC method gets `404` **and** JSON-RPC `-32601` | holds — the pair matters: the JSON-RPC body is what separates this from a legacy server's bare `404` | SDK |
| `server/discover` is implemented | holds — a MUST in this revision, and the modern era's opening move | SDK |
| `initialize` negotiates a revision the asking client can speak | holds — see below | SDK |
| A path that is not the MCP endpoint answers HTTP, not an RPC envelope | holds — see below | ours |
| A request gets either a JSON object **or** an SSE stream | holds — JSON, always; see below | ours (`responseMode: 'json'`, `enableJsonResponse`) |
| Every modern-era request carries the `_meta` envelope | holds — missing is `-32602` naming the key | SDK |
| `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` are **required** on a modern-era request and must agree with the body | holds — `-32020` on absent or disagreeing; see below, because this changed | SDK |
| A framing revision the server does not speak is `400` + `-32022`, listing the supported ones | holds | SDK |
| Base64 sentinel `=?base64?…?=` decoded for header values | holds | SDK |
| `resultType` on every result, and `ttlMs`/`cacheScope` on every cacheable one | holds — the SDK stamps them; `result-type.test.ts` reads the wire | SDK |
| No session is required of a stateless server | holds — no `Mcp-Session-Id` is ever issued, in either era | ours |

### Two eras, one factory

The SDK classifies every request into the **modern** era (2026-07-28: the
`_meta` envelope in `params`, mirrored headers, `server/discover`, no
`initialize`) or the **legacy** one (2025-11-25 and earlier: `initialize`,
negotiation, no envelope, no mirrored headers), by the same rules it then
enforces. Both are served from `buildServer`, which builds one `McpServer` for
the caller the token names. The legacy era goes through a per-request
transport in the stateless idiom — no session id generator, JSON responses;
the modern era through `createMcpHandler` with `legacy: 'reject'`, so the
refusal a legacy-shaped request would get there is never what a legacy client
sees.

`transport-parity.test.ts` asks every method of both eras over both
transports and compares the whole result; its last case refuses a second
factory.

### The mirrored headers are required now, and that reverses a deviation

An earlier version of this page recorded accepting a modern-era request with
no `MCP-Protocol-Version`, `Mcp-Method` or `Mcp-Name` as the sanctioned
branch, on the argument that no shipping client sent them. That was true of
the hand-written server's reading and is not what the SDK does: a request
that carries the 2026-07-28 envelope and omits a mirrored header is refused
with `-32020`, and so is one that disagrees. The SDK's own client sends all
three on every modern request, which is what makes the stricter reading
affordable — and the binding's reason for the headers is the comparison, which
a demanded-and-compared header buys in full.

What **is** still lenient is the legacy era. A frame with no envelope is a
legacy client, and a legacy client has no mirrored headers to send: it is
served whatever is or is not beside it, which is the branch the binding
sanctions for a server supporting clients older than 2025-06-18.

### `Accept` is filled in when the client did not name a stream

The binding has a client list `application/json` and `text/event-stream`, and
the SDK answers `406` to a POST that does not — which every shipping client
satisfies and a `curl`, an uptime check or `fetch`'s own default does not.
This server answers JSON on every request regardless, so a caller that did not
ask for a stream is handed the answer it was going to get rather than a
refusal about a header that would not have changed the reply. A caller that
names `text/event-stream` is held to what it sent.

### Not a gap: returning JSON and never SSE

> If the body is a JSON-RPC *request*, the server **MUST** return either
> `Content-Type: application/json` (a single JSON object) or
> `Content-Type: text/event-stream` (an SSE response stream). The client
> **MUST** support both.

The obligation to support both is on the **client**. The server picks one.
This one returns `application/json` in both eras, which is the honest choice
for a surface where every tool answers with a complete result: an SSE stream
carrying a single event and closing would be the same answer in a costlier
envelope. The one place SSE is not optional is `subscriptions/listen`, and this
server declares no subscriptions capability, so no client will ask.

### The counter-offer has to be one the client can take

A client arriving on `initialize` is legacy by definition, and the
specification's compatibility matrix is explicit that legacy clients have no
fall-forward mechanism. The SDK echoes a proposal it speaks and counter-offers
its newest **legacy** revision otherwise — `2025-11-25`, the head of
`SUPPORTED_PROTOCOL_VERSIONS` — and never the modern one. `server/discover`
advertises the modern revisions only, for the mirror-image reason: a client
that sends it is modern and cannot frame a request in a legacy revision.
`PROTOCOL_VERSIONS` in `results.ts` is the two lists joined, and
`mcp-surface.test.ts` holds each half against the wire.

### The RPC envelope belongs to the MCP endpoint and nowhere else

`404` with `-32601` is right for an RPC *method* this server does not
implement. It is wrong for a *path* it does not route: a request to
`/register` or to `/.well-known/oauth-authorization-server` did not come from a
JSON-RPC client, and a client that read such a reply as an RFC 6749 error
surfaced `Invalid OAuth error response: ZodError`. Those paths answer
`{ error, error_description }`, with a description naming where the
authorization server is. One body for all of them, including `/metrics` behind
a wrong token.

### Unknown tool versus failing tool

A tool that failed — a document that is absent, one the caller may not read, a
database that is down — answers a `CallToolResult` with `isError` and the text
`Not found`, and nothing about which; `factory.ts` is what keeps the thrown
error's own message off the wire, where the SDK would otherwise put it. A tool
that does not **exist** answers the SDK's JSON-RPC `-32602`, naming the tool
the caller asked for. The two used to be byte-identical, and the page that
asked for that gave the reason as "a tool error naming a layer is the same leak
as a `403` naming a document" — which is right about the failing tool and does
not reach the unknown one: every caller sees every tool *name*, because the
catalog's names are static and only `search`'s description is per caller, so
saying a name is not in the catalog tells the caller what `tools/list` already
did. Still a `200`, never a `404`: on Streamable HTTP a `404` is "your session
is gone", and a real client dropped its connection over one.

## Authorization

| Requirement | Status |
|---|---|
| The MCP transport is a resource server and issues no token | holds |
| RFC 9728 protected-resource metadata served | holds — by this transport and by the API, from one document |
| RFC 8414 authorization-server metadata served | holds — by the API, which is the authorization server |
| RFC 7591 dynamic client registration (**MAY**, deprecated) | holds — by the API |
| Client ID Metadata Documents (**SHOULD**) | deviation — see below |
| Every `401` carries `WWW-Authenticate` naming that document | holds |
| The `resource` identifier matches the URL the client reached | holds — derived from `Host` unless `NACRE_MCP_CANONICAL_URL` pins it |
| Tokens validated locally, audience-bound | holds — by this repository's `authenticate`, before the SDK sees a frame |
| The verification algorithm is pinned, not read from the token header | holds |

Authentication is deliberately **not** the SDK's `requireBearerAuth`: the
token here may be a JWT, a service account key or a delegation, resolved by the
same `authenticate` the REST surface uses, and a second verifier would be a
second answer about who a caller is. The SDK is handed the caller it resolved.

### Client ID Metadata Documents: a SHOULD we decline, and why

CIMD makes `client_id` an HTTPS URL that the authorization server **fetches**.
That puts an outbound request, to a URL an unauthenticated caller chose, on the
authorization endpoint — a server-side request forgery surface reachable before
anybody has signed in, in a product whose premise is that it runs inside
somebody's network next to their documents, and one incompatible with the
`airgapped` profile by construction. DCR costs nothing comparable: the client
posts its own metadata, we store a row, and that row permits nothing until a
person approves it on the consent screen. Every shipping MCP client supports
DCR.

## Tools

| Requirement | Status |
|---|---|
| `tools/list` returns name, description, input schema | holds — the schemas in `tools.ts`, served verbatim |
| Arguments are validated against the input schema before the tool runs | holds — the SDK's validator; a mismatch is an `isError` result naming the argument |
| `tools/call` returns `content` | holds — a text block with the JSON, plus a `resource_link` block on `get_document` where a presigned `source_url` exists |
| An error in a tool is reported in the result, not as a JSON-RPC error | holds |
| `annotations` on every tool | holds — `tool-annotations.test.ts` |
| `x-mcp-header` annotations on tool parameters | not used — optional for servers |

## Resources

| Requirement | Status |
|---|---|
| `resources/list` and `resources/read` for every declared resource | holds — the three MCP App views, `ui://nacre/*`, read from the package's built `apps/` |
| The MCP Apps extension's media type and `_meta.ui` on tools and resources | holds — `apps.test.ts` reads both off the wire |
| `_meta.ui.csp` on each view names only what it reaches | holds — the upload view names the API's origin; the other two name nothing |

## What this audit did not cover

Elicitation, sampling, prompts, completion, logging, tasks and subscriptions:
none is declared, and a capability that is not declared is one a client will
not call. Declaring one we do not serve is the failure this table exists to
prevent. Tasks in particular were measured rather than declined by preference:
the SDK server refuses `resultType: "task"` from a tool and does not route
`tasks/get` in the 2026-07-28 era.
