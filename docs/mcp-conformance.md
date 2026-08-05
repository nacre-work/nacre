# MCP conformance — 2026-07-28

Read against the published revision rather than from memory: the Streamable HTTP
binding, the authorization page and the tools page were fetched and each
normative sentence checked against `packages/mcp/src/server.ts`.

Status is one of **holds** (checked, and a test pins it), **gap** (we do not do
it), or **deviation** (we do something else on purpose, with the reason).

## Transport — Streamable HTTP

| Requirement | Status |
|---|---|
| A single endpoint path | holds — `/mcp`, nothing else |
| `Origin` validated; present-and-invalid is `403` | holds |
| A notification the server accepts gets `202` with no body | holds |
| An unimplemented RPC method gets `404` **and** JSON-RPC `-32601` | holds — the pair matters: the JSON-RPC body is what separates this from a legacy server's bare `404` |
| A request gets either a JSON object **or** an SSE stream | holds — see below, and this entry was wrong when first written |
| `MCP-Protocol-Version` absent may be treated as `2025-03-26` | holds, and this is the sanctioned branch — see below |
| The header must match `_meta`'s `io.modelcontextprotocol/protocolVersion` | holds |
| A framing revision the server does not speak is `400` + `-32022`, listing the supported ones | holds |
| `Mcp-Method` / `Mcp-Name` must agree with the body when sent | holds |
| Base64 sentinel `=?base64?…?=` decoded for header values | holds |
| No session is required of a stateless server | holds — no `Mcp-Session-Id` is ever issued |

### The missing-header question, settled

An earlier version of this repository's notes called accepting a request with no
`MCP-Protocol-Version` a *deviation*. It is not. The binding says:

> A server that supports clients implementing protocol versions earlier than
> `2025-06-18` (which did not define the `MCP-Protocol-Version` header) **MAY**
> treat a request that omits the header as protocol version `2025-03-26`. A
> server that does not support such clients **MUST** reject a request without
> the header.

Two branches, and we are the first: this server supports earlier clients, so
accepting the omission is exactly what the specification permits. Rejecting was
the other branch, and taking it made the transport unreachable by every shipping
client — including on `initialize`, where the header cannot exist at all because
that request is what negotiates the version.

The comparison is unchanged and is where the value is: a header that is *sent*
and disagrees with the body is still `-32020`.

### Not a gap: returning JSON and never SSE

The first version of this page listed this as an unmet MUST. It read the
sentence wrong, and the correction is worth keeping because the misreading is
easy:

> If the body is a JSON-RPC *request*, the server **MUST** return either
> `Content-Type: application/json` (a single JSON object) or
> `Content-Type: text/event-stream` (an SSE response stream). The client
> **MUST** support both.

The obligation to support both is on the **client**. The server picks one. This
one returns `application/json`, which is the honest choice for a surface where
every tool answers with a complete result: an SSE stream carrying a single event
and closing would be the same answer in a costlier envelope.

The place SSE is not optional is `subscriptions/listen`, whose response *is* a
long-lived stream — and this server declares no subscriptions capability, so no
client will ask. Declaring one it does not serve is the failure the capability
table exists to prevent.

`X-Accel-Buffering: no` is likewise a SHOULD for a server *initiating* an SSE
stream, and does not arise.

### Closed: the two comparisons that were missing

Both are now checked and both have tests.

`MCP-Protocol-Version` is compared against
`_meta["io.modelcontextprotocol/protocolVersion"]`, and a disagreement is `400`
with `-32020`. It was the third mirrored comparison and the only one still
absent after `Mcp-Method` and `Mcp-Name` went in — the same defect as demanding
a header and never reading it, one field along.

A framing revision this server does not speak is `400` with `-32022` and a body
carrying both `supported` and `requested`, which the schema pins. Listing what
we do speak is the point: a bare refusal leaves a client with nothing to retry.
The header is deliberately treated differently from `initialize`'s
`params.protocolVersion` — that one is a proposal and is answered with a
counter-offer, because refusing a proposal turns a negotiation into a failure.

## Authorization

| Requirement | Status |
|---|---|
| Resource server, not authorization server | holds, and is a product decision — see `docs/mcp.md` |
| RFC 9728 protected-resource metadata served | holds |
| Every `401` carries `WWW-Authenticate` naming that document | holds |
| The `resource` identifier matches the URL the client reached | holds — derived from `Host` unless `NACRE_MCP_CANONICAL_URL` pins it |
| Tokens validated locally, audience-bound | holds |
| The verification algorithm is pinned, not read from the token header | holds |

**`authorization_servers` is absent unless a deployment names one**, and is
never pointed at Nacre. That is a deliberate product position rather than a gap:
this is a resource server and issues no OAuth token, so a client sent here for a
token endpoint would find nothing. A deployment with an identity provider names
it in `NACRE_OAUTH_AUTHORIZATION_SERVER` and the whole flow — including dynamic
client registration, which is a transaction between a client and *that* server —
works through it.

## Tools

| Requirement | Status |
|---|---|
| `tools/list` returns name, description, input schema | holds |
| `tools/call` returns `content` | holds |
| An error in a tool is reported in the result, not as a JSON-RPC error | holds |
| `x-mcp-header` annotations on tool parameters | not used — optional for servers |

## What this audit did not cover

Elicitation, sampling, resources, prompts, completion and logging: none is
declared in `initialize`, and a capability that is not declared is one a client
will not call. Declaring one we do not serve is the failure this table exists to
prevent.
