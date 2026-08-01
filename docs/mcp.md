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
  `/.well-known/oauth-protected-resource` (RFC 9728).
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
key from an environment variable. **Permissions are exactly the service
account's** — local mode gets no relaxation of any kind.

## Tools

### `search`

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
      "layers":  { "type": "array", "items": { "type": "string" },
                   "description": "Layers to search. Empty means all accessible ones." },
      "top_k":   { "type": "integer", "default": 10, "minimum": 1, "maximum": 50 },
      "filters": { "type": "object", "description": "Filter on document metadata fields" },
      "rerank":  { "type": "boolean", "default": true },
      "include_content": { "type": "boolean", "default": true }
    },
    "required": ["query"]
  }
}
```

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

The transport and the tool catalog are implemented in `packages/mcp`; the tool
bodies are injected and are not written yet. What is under test is the part
that carries the leak risk:

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
- there is no `initialize` and no `Mcp-Session-Id` to be had — a test asserts
  the session cannot be established, because state creeping into the transport
  is what quietly ends the round-robin deployment.
