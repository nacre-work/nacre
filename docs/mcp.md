# MCP server

Target specification revision: **2026-07-28**. The consequences that matter:
the protocol is stateless, `initialize`/`initialized` and `Mcp-Session-Id` are
gone, the `Mcp-Method` and `Mcp-Name` headers are required, and DCR is
deprecated in favour of CIMD.

## Transport

- Streamable HTTP, one endpoint: `POST /mcp`.
- Required request headers: `MCP-Protocol-Version`, `Mcp-Method`, `Mcp-Name`.
- No state between requests. Any request is served by any replica behind a
  round-robin balancer; there is no shared session store.
- A tool that needs state between calls returns an explicit descriptor in its
  result, and the model passes it as an argument to the next call. Hidden state
  in the transport is not allowed.
- `server/discover` is supported but not required of clients.
- `tools/list` returns `ttlMs: 300000` and `cacheScope: "user"` — the catalog
  depends on the caller's permissions, so the cache is per user, never global.

## Authorization

The MCP server is a **resource server**, not an authorization server.

- OAuth 2.1, PKCE S256, audience-bound tokens, validated locally.
- `WWW-Authenticate` on every 401, pointing at
  `/.well-known/oauth-protected-resource` (RFC 9728) — **which is served**, by
  both this transport and the API, from one document built once. It names the
  canonical resource identifier and, when a deployment configures one,
  `authorization_servers`. That field is absent by default and is deliberately
  not pointed at Nacre: this is a resource server, and sending a client here
  for a token endpoint would be the same dead end as not serving the document
  at all.
- Client registration is **CIMD**. DCR is kept as a legacy branch behind a flag.
- `iss` validation (RFC 9207) on the client side; `resource=` on every token
  request, including refresh.
- **EMA** (`io.modelcontextprotocol/enterprise-managed-authorization`): the
  server advertises the `id-jag` grant profile, accepts an ID-JAG from a
  corporate IdP, and exchanges it for an access token (RFC 7523).

Where the line falls: **EMA authorizes the connection. Permission on a specific
document is computed by the Nacre authorization service on every call.** Holding
a valid token grants access to no document by itself.

`/.well-known/*` and the OAuth issuer belong on `api.nacre.work`, not on the
apex — static hosting on the apex intercepts the discovery path before the API
sees it. The domain is baked into the issuer URL of every token ever issued, so
moving it later breaks every client's configuration at once.

## Local mode

STDIO, for developer agents on a laptop. Authentication is a service account
key from `NACRE_SERVICE_KEY`. **Permissions are exactly the service account's**
— local mode gets no relaxation of any kind.

**It needs the server's configuration, because it is the server.** There is no
HTTP hop: the process connects to Postgres, Qdrant, Redis, the parser and the
embedder itself and runs the same search path in-process. `NACRE_SERVICE_KEY`
alone is not enough to start it, and the refusal at startup lists every variable
that is missing. In practice that means running it with the same environment the
server has:

```bash
set -a && . ./.env && set +a
NACRE_SERVICE_KEY=nacre_sk_… npx @nacre.work/mcp
```

A consequence worth knowing before you plan a deployment: an agent running local
mode holds your database credentials. That is the trade for no network hop, and
it is why the Streamable HTTP transport exists for anything that is not a
laptop.

The key is opaque, prefixed `nacre_sk_`, and stored only as a SHA-256 hash
beside a non-secret prefix used for the lookup. It is returned once, when the
account is created, and is not recoverable afterwards from the API, the
database, or a backup. A service account carries the `member` role always;
everything it can reach comes from a grant, which is what the sentence above
has to mean if it means anything.

Revocation takes effect on the next request. There is no TTL to wait out —
that is the trade for a credential that does not expire on its own.

## Tools

### `search`

## Limits and metrics

The rate limits are the API's, shared: `search` spends
`NACRE_RATE_SEARCH_PER_MIN`, `ingest_document` and `delete_document` spend
`NACRE_RATE_INGEST_PER_HOUR`, and the counters are the same keys the REST
surface increments. Shared rather than per-surface on purpose — separate buckets
would give a caller twice the documented allowance for holding two clients.
`list_layers` is unlimited: one indexed query, and refusing it breaks discovery.

A refusal is JSON-RPC `-32003` over HTTP `429`, with the RFC 9331 `RateLimit-*`
headers. It is checked **after** the catalog lookup, so a tool the caller may
not see answers the same way as one that does not exist — a `429` on an unknown
tool would confirm it exists.

This process serves `/metrics`: `nacre_mcp_tool_duration_seconds{tool}`,
`nacre_mcp_tool_calls_total{tool,result}`, and `nacre_acl_denials_total{reason}`
with the same reason strings the REST surface uses, so the two add up on one
dashboard. Zero results from `search` is what a denial looks like here —
invariant I4 leaves no `403` to count.

**The description is generated dynamically** from the layer catalog visible to
the caller. A generic "searches the knowledge base" pushes the model to fall
back on web search instead of querying the index.

Template: `Semantic search over corporate documents. Available: {layer.name} —
{layer.description} ({n} docs); …`

```jsonc
{
  "name": "search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":   { "type": "string", "description": "Natural-language query" },
      "layers":  { "type": "array", "items": { "type": "string" }, "maxItems": 64,
                   "description": "Layer slugs to restrict the search to. Empty or absent means every layer you can read." },
      "top_k":   { "type": "integer", "default": 10, "minimum": 1, "maximum": 50 },
      "rerank":  { "type": "boolean", "default": true },
      "include_content": { "type": "boolean", "default": true,
                   "description": "false omits the chunk text, leaving ids and scores." }
    },
    "required": ["query"]
  }
}
```

`layers` narrows and can never widen: it becomes a `must` on `layer_id` inside
the index traversal, on top of the permission constraint, so naming a layer you
cannot read returns nothing from it — and is indistinguishable from naming one
that does not exist, which is invariant I4 applied to a query parameter.

**`filters` was advertised, read by nothing, then removed, and is back now that
it works.** A client that filtered a search and got everything back believed it
had narrowed the query, which for an agent is worse than for a person: an agent
acts on the answer without looking at it, and a tool schema is what a model
plans against.

It narrows exactly as `layers` does — each entry becomes a `must` on a
namespaced payload key beside the permission constraint, so a filter can only
remove documents the caller could already read. Keys are lower case letters,
digits and underscores, and they live under a reserved namespace: filtering on
`deleted` narrows on a metadata value with that name and cannot reach the
tombstone flag. Equality only; a list value means any of those.

Returns an array of `{ chunk_id, doc_id, layer, title, score, text?, source_url?,
metadata }`. `source_url` is presigned, living for `NACRE_PRESIGN_TTL`.
Permission: `read`.

### `list_layers`

The accessible layer catalog with descriptions and document counts. No
arguments. Permission: `read`.

### `get_document`

`{ document_id }` or `{ external_id, layer }`. Returns metadata plus full text
or a presigned link. Permission: `read`. No permission → `404`, not `403`.

### `ingest_document`

```jsonc
{
  "name": "ingest_document",
  "inputSchema": {
    "type": "object",
    "properties": {
      "layer":       { "type": "string" },
      "external_id": { "type": "string", "description": "Idempotency key" },
      "title":       { "type": "string" },
      "content":     { "type": "string", "description": "Text directly" },
      "url":         { "type": "string", "description": "Link to fetch" },
      "metadata":    { "type": "object" }
    },
    "required": ["layer"]
  }
}
```

Exactly one of `content` / `url` / an uploaded file. Idempotent on
`(layer, external_id)` plus `content_hash`: a repeat with identical content is a
no-op. The response is asynchronous: `{ document_id, job_id, status }`.
Permission: `write`.

`metadata` is what `search`'s `filters` reads back, and was dropped by the
server for as long as `filters` did nothing. Keys are lower case letters, digits
and underscores, at most 32 of them; values are scalars or lists of them, and a
nested object is refused rather than flattened. Changing it alone re-indexes the
document, because it is written into the payload of every chunk.

### `delete_document`

`{ document_id }` or `{ external_id, layer }`. Writes a tombstone; the document
leaves results immediately. Permission: `write`.

## What a call answers with

A `CallToolResult`, always — `{ content: [...], isError }` — with the payload
JSON-encoded into a text block. Not the bare value. A client that follows the
protocol rejects anything else, so this is not a stylistic point: the server
returned raw arrays for its first several revisions, every test in the suite
passed, and no compliant client could have read a single result.

An error is the exception rather than a variant of the result: a failing tool
and an unknown one both answer with a JSON-RPC error carrying nothing about
which, because distinguishing them tells the caller whether a tool — and so a
layer — exists. The reason is logged on the server, where an operator can see
that a database is down rather than reading it as a tool that does not exist.

## What tools may not do

- Return error messages that reveal the existence of inaccessible objects.
- Accept `org_id` as an argument. The organization comes from the token.
- Bypass the authorization service "for speed" on the search path.

## Current state

Both transports are implemented in `packages/mcp`, and the tool bodies behind
them are wired to the same resolver, search service and audit sink the REST API
uses — one set of objects, built in `services.ts` and shared, because a second
copy is a second place for rule 6 to drift.

Local mode authenticates once from `NACRE_SERVICE_KEY` and then carries exactly
that service account's permissions. It reaches the same per-caller catalog, so a
tool the account cannot see is indistinguishable from one that does not exist —
the relaxation this file warns about would be easy to add here and looks like a
convenience, so there is a test that fails if the check is removed.

What is under test is the part that carries the leak risk:

- the catalog is built **per caller**, so one tenant cannot learn another's
  layer names through a shared `tools/list` — the same fact as
  `cacheScope: "user"`, and there is a test for each;
- a caller with no layers is told exactly that and nothing about what exists
  elsewhere;
- a failing tool call and an unknown tool return **byte-identical** answers,
  because a tool error naming a layer is the same leak as a `403` naming a
  document;
- no tool schema accepts an organization at any depth, and `params` carrying
  one is refused before dispatch;
- there is no `initialize` and no `Mcp-Session-Id` to be had over HTTP — a test
  asserts the session cannot be established, because state creeping into the
  transport is what quietly ends the round-robin deployment. STDIO answers
  `initialize` because a pipe is a session by construction: there is one client,
  one process, and nothing to route.

Both transports answer a successful call with a `CallToolResult`, and stdout in
local mode carries protocol frames and nothing else — a stray log line lands
mid-stream and the client fails on a frame nobody sent. There is a test for
each, both written after the HTTP one shipped returning bare values that no
compliant client could read.
