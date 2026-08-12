# MCP server

Target specification revision: **2026-07-28**, served **dual-era** — which is
the term that revision uses and the thing to hold on to while reading the rest.

It splits clients in two. A *modern* client names the protocol version on every
request in `_meta`, sends no `initialize`, and learns what a server can do from
`server/discover`. A *legacy* client opens with `initialize` and negotiates
there. This server answers both, on one endpoint, and the specification's
compatibility matrix says that combination works for either kind of client.

The consequences that matter: the protocol is stateless and no `Mcp-Session-Id`
is ever issued; `Mcp-Method` and `Mcp-Name` are required *of a modern client*
and are validated here when sent rather than demanded; and DCR is deprecated in
favour of CIMD — a statement about an **authorization server**, which this
transport is not. See "Authorization" for which half of this product is one and
what it supports.

This opening paragraph said `initialize` was "gone" and the headers "required",
and both readings were taken literally in the code: the headers were demanded
from clients that cannot send them, and `initialize` was answered with a
revision no client speaks. Neither is what the revision asks of a server that
means to be reachable.

## Transport

- Streamable HTTP, one endpoint: `POST /mcp`.
- Request headers: `MCP-Protocol-Version` and `Mcp-Method` on every request;
  `Mcp-Name` **only** on `tools/call`, `resources/read` and `prompts/get` — the
  three that name something. Requiring `Mcp-Name` everywhere is a server that
  refuses `tools/list`, which no client can make any other way, and that is what
  this did until it was pointed at a real one.
- **The headers are validated against the body**, which is the whole reason
  they exist: an intermediary routes and rate-limits on the header while the
  server executes the body, so a request whose halves disagree is one where the
  two acted on different instructions. A missing or contradicting header is
  `400` with JSON-RPC code **`-32020` (`HeaderMismatch`)**, the code the
  specification allocates. It used to answer `-32600`, which a client reads as
  "not a modern server" and follows into a fallback this transport does not
  speak.
- `Mcp-Name` may arrive Base64-encoded in the `=?base64?…?=` sentinel when the
  value is not header-safe, and is decoded before it is compared.
- **`Origin` is validated.** A present origin that is not in
  `NACRE_MCP_ALLOWED_ORIGINS` is `403`; an absent one is allowed, because an
  agent sends none and the attack the rule exists for — DNS rebinding — is by
  definition a browser. The default list is empty, which refuses every browser
  and no agent.
- `GET` and `DELETE` on the endpoint answer **`405`**, not `404`. Both belonged
  to the revisions with sessions and a standalone SSE stream; `404` is one of
  the signals that sends a client down the deprecated HTTP+SSE path, and this
  server is not that.
- `Mcp-Session-Id` and `Last-Event-ID` are **ignored** rather than refused,
  which is what the specification asks of a server implementing only this
  revision.
- No state between requests. Any request is served by any replica behind a
  round-robin balancer; there is no shared session store.
- A tool that needs state between calls returns an explicit descriptor in its
  result, and the model passes it as an argument to the next call. Hidden state
  in the transport is not allowed.
- `server/discover` is supported but not required of clients.
- `tools/list` returns `ttlMs: 300000` and `cacheScope: "user"` — the catalog
  depends on the caller's permissions, so the cache is per user, never global.

## The resource identifier, when the ports are split

This transport serves `/.well-known/oauth-protected-resource` itself, from the
same document the API serves, so the two can never disagree about the audience a
token is bound to. That is right, and it has a consequence: the document names
one resource identifier, and RFC 9728 has the client check it against the URL it
reached.

Behind one origin there is no problem. Two published ports — the Compose default
— is the case where a client pointed at the MCP port is told the resource is the
API's URL and refuses before sending a request. `NACRE_MCP_CANONICAL_URL` on the
MCP process is what that shape needs; see
[config.md](./config.md). It moves the discovery document only, and never what a
token is checked against.

## Authorization

The MCP server is a **resource server**, not an authorization server.

- OAuth 2.1, PKCE S256, audience-bound tokens, validated locally.
- `WWW-Authenticate` on every 401, pointing at
  `/.well-known/oauth-protected-resource` (RFC 9728) — **which is served**, by
  both this transport and the API, from one document built once. It names the
  canonical resource identifier and `authorization_servers`, which names this
  installation's **API** by default and whatever `NACRE_OAUTH_AUTHORIZATION_SERVER`
  names when a deployment has its own identity provider. Never this transport:
  it verifies tokens and issues none. This paragraph said the field was absent
  and deliberately unpointed until the API grew the flow — see "There is an
  authorization server now" below, which had been saying the opposite three
  screens further down.
- **`initialize` is answered**, statelessly. It had never been implemented:
  the dispatcher knew `tools/list` and `tools/call` and nothing else, and a
  comment justified the absence as a consequence of having no session. Those
  are two different things. Statelessness is real and is what lets any replica
  serve any request; `initialize` is not state — it is how a client learns the
  protocol version and what this server can do, and it is answered without
  remembering anything. No `Mcp-Session-Id` is issued, then or ever.
  `notifications/initialized` is accepted with `202`, as is any other
  notification: one the server does not understand is by definition one it may
  ignore.
- **The version it negotiates is one the asking client can speak.** The
  revisions reachable through `initialize` are `2025-11-25`, `2025-06-18` and
  `2025-03-26`; a proposal among them is echoed, and anything else is
  counter-offered the newest of them — **never** `2026-07-28`. That is not a
  preference. `initialize` belongs to the era the specification calls legacy,
  and its compatibility matrix says legacy clients have no fall-forward
  mechanism: a revision they do not know is a failed connection, not a retry.
  Answering with the newest revision outright is what this server did, and no
  shipping client could connect — each one proposed `2025-11-25`, was handed
  `2026-07-28`, and stopped.
- **`server/discover` is answered**, which 2026-07-28 makes a MUST. It is the
  modern era's opening move: a client that sends no `initialize` reads
  `supportedVersions` and the capability set from here instead. Cached
  `public`, unlike `tools/list` — nothing in it depends on who is asking.
- **A path this transport does not route answers HTTP, not JSON-RPC.** The
  envelope belongs to `/mcp`. A discovery fetch or an OAuth request that lands
  here gets `{ error, error_description }`, RFC 6749's shape, naming where the
  authorization server actually is — because the client that sent it is looking
  for one and cannot read a JSON-RPC error at all.
- **The 2026-07-28 mirrored headers are validated when present and never
  demanded**, which is the branch the binding sanctions and not a deviation: a
  server that supports clients implementing revisions earlier than 2025-06-18
  **MAY** treat a request that omits `MCP-Protocol-Version` as `2025-03-26`,
  and only a server declining those clients must reject it. This one supports
  them. Requiring `MCP-Protocol-Version` on every POST could
  not be satisfied at all: the first request a client makes is `initialize`,
  and at that moment no version is negotiated — it travels in
  `params.protocolVersion`, because that request is what negotiates it. So the
  server demanded a header the client is not able to send, and every real
  client bounced off `-32020` on its first POST. `Mcp-Method` and `Mcp-Name`
  are the same generation and no shipping client sends those either.
  Taking the other branch made the transport unreachable by every shipping
  client. The full reading is in [mcp-conformance.md](./mcp-conformance.md).
  A header that is *sent* and disagrees is still `-32020`, and that now covers
  three fields rather than two: `Mcp-Method`, `Mcp-Name`, and the protocol
  version against `_meta`. A framing revision this server does not speak is
  `400` with `-32022` and the list of the ones it does. The protection those headers buy is in the
  *comparison* — an intermediary must not route on one instruction while the
  server executes another — and that check is unchanged: present and
  disagreeing is still `-32020`.
- **The resource identifier follows the request** unless
  `NACRE_MCP_CANONICAL_URL` pins one. RFC 9728 has the client compare the
  identifier against the URL it reached, so a document built at startup from a
  hostname the operator did not choose refuses every client that used a
  different one — which is what a `localhost` default did to everybody not on
  the server's own machine. `Host` is what the client wrote, and
  `X-Forwarded-Proto` supplies the scheme behind a TLS-terminating proxy.
  Deriving it is not a trust decision: the identifier is not an authorization
  input, and a token is still checked against `NACRE_JWT_AUDIENCE` and
  `NACRE_JWT_ISSUER`, neither of which comes from the request.
- **There is an authorization server now, and it is ours.** A client that gets
  a `401` reads the RFC 9728 document, finds `authorization_servers` naming this
  installation's API, discovers `/oauth/authorize` and `/oauth/token` through
  RFC 8414, registers itself with RFC 7591, and completes the authorization
  code flow with PKCE S256. That is the whole connect sequence an MCP client
  already performs, and until it existed the documented alternative was "create
  a service account by hand, copy its key, paste it into a config file".

  **The token it receives acts as the person who approved it, or as an agent,
  and the screen asks which.** A delegation is the default and is what OAuth is
  for: the client reaches exactly what its person reaches, recomputed on every
  request from `grants`, and a person may restrict it to chosen layers at
  consent. Nothing is granted to a delegation — it holds no grants of its own,
  so there is no second grant set and no intersection to compute.

  An **agent** is the other answer and it is not the same act. A service
  account is a principal with its own grants, so "what may this agent read" is
  a different question from "what may you read", and collapsing the two throws
  away what the permission model is for. An agent belongs to the organization
  and survives any one person, which makes it right for an unattended pipeline
  and wrong for a client on somebody's laptop. Minting one is `org_admin`;
  delegating is anybody's, which is why offering only agents left every member
  at a screen they could not complete.

  A delegation is also **more revocable** than an agent's token, and the
  asymmetry is the right way round. Forgetting an application stops a delegation
  on the next request, because a delegated token consults a table anyway;
  an agent's access token is verified against a key and keeps working until it
  expires. A key pasted into a config file lives for years by design; a person
  lending their own reach is the kind of thing people change their mind about.
  docs/authz.md, "Delegated authority".

  A deployment that would rather use its own identity provider names it in
  `NACRE_OAUTH_AUTHORIZATION_SERVER`, and then the document points there and
  this flow is simply not the one clients take.
- **`initialize` carries `instructions`.** The specification has a field for
  "how to use this server" and this sent nothing in it, so a client's model got
  tool schemas and no idea that a `404` here is deliberate — it retries,
  rephrases, and eventually reports the server as broken.

  What is in it is what is true of *this server*: that search is filtered inside
  the index traversal so `top_k` returns k permitted results, that an empty
  result is an answer rather than an error, that "not permitted" and "not there"
  are one reply on purpose, that `write` does not imply `read`, and that a
  delegated connection may have been restricted further by the person who
  approved it. Not a workflow — "how to onboard a team" spans this product and
  others, changes on a different clock, and would rot here.

  One string in `instructions.ts`, used by both transports, with a parity case
  that asserts it is present as well as identical: two transports agreeing on
  nothing is still agreement, and that is what the absence looked like.

- **Client registration is not this transport's** — CIMD and DCR are both
  transactions between a client and an *authorization server*, and this
  transport is not one: it verifies tokens and issues none. There is no
  registration endpoint on this port and no client record to create here.
  `/oauth/register` lives on the API, beside the endpoints it belongs with, and
  a deployment naming its own provider in `NACRE_OAUTH_AUTHORIZATION_SERVER`
  registers there instead.

  **Of the two, the API implements DCR and not CIMD**, which is a `MAY` taken
  and a `SHOULD` declined. CIMD makes `client_id` an HTTPS URL the authorization
  server *fetches*, which puts an outbound request to an attacker-chosen address
  on an endpoint reachable before anybody has signed in — in a product that runs
  inside somebody's network next to their documents, and that ships an
  `airgapped` profile making no outbound connection at all. The reasoning is in
  [mcp-conformance.md](./mcp-conformance.md); the practical position is that
  every shipping MCP client speaks DCR.
- `iss` validation (RFC 9207) on the client side; `resource=` on every token
  request, including refresh.

**The whole of the OAuth surface a resource server has is built**: the RFC 9728
document, and local validation of an audience-bound token. There is no third
thing waiting to be written, which is why nothing below lists one.

Because it only verifies, this transport runs on the **public key alone** where
the deployment signs with Ed25519: set `NACRE_JWT_PUBLIC_KEY_REF` here and
`NACRE_JWT_PRIVATE_KEY_REF` on the API. The signing key never reaches the MCP
process, so reading its environment gets an attacker to "can check tokens" and
no private key to mint them with — which is the property the asymmetric mode
exists for. A rotation then updates the API (new private key, previous accepted
during the overlap) and the verifiers (`NACRE_JWT_PUBLIC_KEY_REF` to the new
public key, `NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF` to the old) independently: the
overlap window is what lets them not restart in lockstep. A shared-secret
deployment has no such split — the same `NACRE_JWT_SECRET` verifies and signs —
and that is still supported for a laptop or a Compose run.
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

Template: `Search corporate documents by meaning and by exact term —
identifiers, error codes, part numbers and names match literally. Available:
{layer.name} — {layer.description} ({n} docs); …`

The first sentence names both halves of the hybrid query for the same reason
the catalog is there at all. It said "semantic search" while search was
dense-only, which was accurate; saying it now would cost calls, because a model
asked for `SQLSTATE 23505` reads *semantic* as conceptually similar, decides a
literal string is not what this tool answers, and reaches for a web search.

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

Returns an array of `{ chunk_id, doc_id, layer, title, score, text?, metadata }`.
Permission: `read`.

No `source_url` here, and deliberately. A presigned link is a bearer capability
that outlives the permission check which minted it, so answering a question
about relevance by issuing one per hit hands out ten capabilities where the
caller wanted an ordering — most never followed, each valid for
`NACRE_PRESIGN_TTL`. `get_document` is where a caller asks for a document, and
that is where the link is.

### `list_layers`

The accessible layer catalog with descriptions and document counts. No
arguments. Permission: `read`.

### `get_document`

`{ document_id }` or `{ external_id, layer }`. Returns metadata, and
`source_url` — a presigned link living for `NACRE_PRESIGN_TTL` — where the
deployment stores document bytes in object storage. Absent otherwise, and
absent for a document ingested inline or by URL. Permission: `read`. No
permission → `404`, not `403`.

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
