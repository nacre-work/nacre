# REST API

Base path `/v1`. The organization comes from the token — never from a request
body, a path, or a header.

## Endpoints

Implemented:

```
POST   /v1/documents                 ingest (json; multipart not built — see below)
GET    /v1/documents/{id}
PATCH  /v1/documents/{id}            metadata only; no re-embed
DELETE /v1/documents/{id}            tombstone
POST   /v1/search
GET    /v1/workspaces    POST /v1/workspaces
GET    /v1/layers        POST /v1/layers        PATCH /v1/layers/{id}
GET    /v1/grants        POST /v1/grants        DELETE /v1/grants/{id}
GET    /v1/service-accounts  POST  /v1/service-accounts  DELETE /v1/service-accounts/{id}
GET    /v1/jobs/{id}
GET    /v1/health        GET /v1/ready           GET /metrics
GET    /.well-known/oauth-protected-resource        RFC 9728, unauthenticated
POST   /v1/auth/login    /v1/auth/refresh        /v1/auth/logout
```

Everything the contract describes is implemented. Multipart upload on
`POST /v1/documents` is the one exception, and it is marked where it applies.

## Errors — RFC 9457 (`application/problem+json`)

```jsonc
{
  "type":   "https://nacre.work/errors/layer-not-found",
  "title":  "Layer not found",
  "status": 404,
  "detail": "Layer contracts does not exist or is not accessible",
  "instance": "/v1/search",
  "request_id": "01JQ8…"
}
```

- `detail` never reveals the existence of an inaccessible object. **No
  permission and no such object produce the same response**, down to the
  wording. That is invariant 4; a different message is the leak.
- No stack traces, no internal service names.
- `request_id` is always present and matches the field in the audit log.

| Code | When |
|---|---|
| 400 | schema violation |
| 401 | missing or expired token |
| 403 | authenticated, and the operation is explicitly forbidden on a **visible** object |
| 404 | the object is absent **or invisible** |
| 409 | version conflict |
| 413 | document over the size limit |
| 422 | document could not be parsed |
| 429 | rate limited |
| 503 | indexing unavailable; or sign-in shed under load, see below |

The 403/404 split is the whole point: 403 says "this exists and you may not
touch it", so it may only be used where the caller can already see the object.

## Signing in

```
POST /v1/auth/login     {email, password, organization?}  → {access_token, token_type, expires_in, refresh_token}
POST /v1/auth/refresh   {refresh_token}                   → the same shape
POST /v1/auth/logout    {refresh_token}                   → 204
```

Email and password. SSO is a commercial module; this is the one every
self-hoster gets. `init` creates the first administrator and prints a generated
password once.

**`organization` is a lookup key, not a claim.** Invariant 1 governs
authenticated requests, and login is the request that has no token yet — so the
body may name an organization to disambiguate the address, but what goes into
the issued token is the `org_id` on the row that authenticated, never the
string the caller sent. Naming one organization while holding an account in
another is a refusal, not a token for either. It may be omitted on a
single-organization installation; omitted, the address must match exactly one
user, and zero or several are the same refusal.

**Every failure is one `401` with one message**, in the same time: unknown
address, wrong password, wrong organization, disabled account, and an account
with no password set. An early return on "no such user" would make the response
time say which addresses have accounts.

Sign-in is rate limited **twice**, and it has to be. Per email address
(`NACRE_RATE_LOGIN_PER_15MIN`, default 10) — there is no organization yet, and
what that defends is one account's password. And per client
(`NACRE_RATE_LOGIN_SOURCE_PER_15MIN`, default 60), because the address limit
does nothing about the attack that is actually run: one password against ten
thousand addresses never repeats a key and never meets it. See
[config.md](./config.md) for `NACRE_TRUST_PROXY`, which is how the client is
identified and why neither default is safe.

Separately, this endpoint can answer **`503` with `Retry-After`** — not `401`.
The number of passwords being verified at once is bounded inside the process,
because scrypt runs on libuv's thread pool and that pool is shared with DNS and
file I/O; unbounded, a login flood stops the rest of the API on a name lookup.
Past the bound nothing was decided about the credentials presented, and
answering "not valid" to a request that was never checked is a lie the client
will act on. It is not an oracle: it depends on how loaded the process is and
not at all on whether the account exists.

### The access log is readable

`GET /v1/audit`, newest first, cursor-paged, as JSON, JSONL or CSV by content
negotiation. Filters `from`, `to`, `actor_id`, `action` and `result` are all
applied and a malformed one is a `400`.

`org_admin` sees its organization's log in full. `platform_admin` sees
administrative actions and never the record of who read what — rule 2 applied
to the journal, and not a parameter the caller can drop. A `member` gets `404`.
Reading it is recorded as `audit.read`. Full rules in [audit.md](./audit.md).

### Search parameters

`layers`, `filters` and `include_content` were declared in the contract from the
beginning and read by nothing. Now:

| Parameter | |
|---|---|
| `layers` | Layer slugs. **Narrowing only** — a `must` on `layer_id` inside the index traversal, on top of the permission constraint, so it can never reach a layer a grant does not. Naming a layer you cannot read returns nothing from it and is indistinguishable from naming one that does not exist. Empty or absent means every readable layer. At most 64. |
| `include_content` | `false` omits `text` from every hit, leaving ids and scores. Applied after reranking, because a reranker scores the query against the text. |
| `filters` | Document metadata, key to value. Equality; a list means any of those. **Narrowing only** — each entry is a `must` beside the permission constraint inside the traversal, so it can only remove results the caller could already see. Keys live under a reserved payload namespace, so `filters: {"deleted": false}` narrows on a metadata value named `deleted` and cannot reach the tombstone flag. No negation, no ranges, no disjunction across keys. |

A metadata key named `org_id` is refused with `403` on both ends, by the guard
that scans a request for a tenant override at any depth. That guard predates
metadata and fires on `filters.org_id` and `metadata.org_id` alike, which is the
right answer: invariant 1 says the organization comes from the token and never
from a body, and a caller who sends one anywhere should be told so rather than
having it quietly reinterpreted as a tag.

Document metadata is supplied on `POST /v1/documents` under `metadata`, which
was in the contract with no caveat and dropped by the handler until `filters`
needed it. Keys are lower case letters, digits and underscores — a key becomes a
payload field name, and Qdrant reads `.` as nested access. At most 32 keys, and
values are scalars or lists of them; a nested object is refused rather than
flattened, because flattening would invent a path syntax and a path is a way to
reach a field the caller did not name.

**Which path you use to change a tag decides what it costs.**
`POST /v1/documents` re-parses, re-chunks and re-embeds, because that is what
ingest does — the row and the payload would otherwise disagree and the document
would carry a tag it does not answer to. `PATCH /v1/documents/{id}` changes the
tags and nothing else: one `setPayload` over the document's points, the same
call the ACL retag sweep makes, and not a single embedding computed. A bulk
retagging pass goes through `PATCH`.

`PATCH` needs `write`, and rule 6 means that is not the same set as `read`. It
answers `204` and never the document, for exactly that reason: a caller who may
retag a document and not read it must not learn its title or its layer from a
successful call.

It is a replacement, not a merge. Sending `{"source":"notion"}` after
`{"source":"confluence","team":"legal"}` leaves one tag — merging would leave a
tag the caller removed still matching filters.

Narrowing is still a pre-filter, so invariant 2 is untouched: `top_k` comes back
full from the smaller permitted set rather than being cut down from the larger
one.

### Refresh tokens rotate, and reuse ends the session

Every refresh issues a new token and marks the old one used. A used token
presented again is **not** treated as a client retry: the legitimate holder has
already exchanged it, so a second presentation means two parties hold the same
token and one of them took it. Which one is unknowable, so the whole family
descended from that login is revoked and both sign in again.

A fresh login starts a new family, so signing out on one device leaves the
others alone. Disabling an account ends its sessions rather than only stopping
new ones. `logout` answers `204` whether or not the token was live — saying "no
such token" tells whoever holds a stolen one that it is no longer worth using.

Tokens are stored as a SHA-256 and never in the clear: a refresh token outlives
an access token by a month, so a database dump holding them would be a month of
sessions rather than a list of identifiers.

Passwords are hashed with scrypt at OWASP's minimum parameters, which are
carried in the stored record so the cost can be raised without invalidating
every password. Argon2id would be the first choice and needs a native
dependency, which is a thing every operator of a self-hosted security product
inherits; the encoding leaves room to move.

## Idempotency

- `POST /v1/documents` is idempotent on `(layer, external_id)` plus
  `content_hash`. A repeat with identical content returns `200` and the existing
  `document_id` without creating a version. It does **not** take an
  `Idempotency-Key`: the content hash is the stronger guarantee, because it
  survives a cache expiring.
- Every other unsafe method accepts an `Idempotency-Key` header; the result is
  cached for 24 hours and replayed with `Idempotency-Replayed: true`.
- The key is scoped to the organization, **the principal**, the method, the path,
  and a hash of the body. The principal is in that list because two principals in
  one organization see different things — scoped to the tenant alone, either
  could replay the other's response, and a replay is sent before any handler runs.
  Only successful responses are stored: a cached failure makes a transient fault
  permanent for a day and denies the retry this exists to serve. The same key with a different body is `409`, not a replay — a caller who
  changed the payload and kept the key is not asking for the old answer. A
  second attempt while the first is still in flight is `409` for the same
  reason: there is no response to replay yet.
- **`POST /v1/search` is excluded.** It is safe to repeat by definition, so
  idempotency buys it nothing, and its response is made entirely of other
  people's documents — caching it would put chunk text in a store with a
  24-hour TTL and no access control of its own.
- **`POST /v1/service-accounts` is excluded**, and a key sent to it is ignored
  rather than honoured. Its response carries the account key itself, once; the
  key is stored hashed so that it cannot be recovered from the database or from
  a backup, and a copy in the cache would undo that for 24 hours. Retrying it is
  already safe without a cache — a duplicate name answers `409` rather than
  minting a second key.
- The cache is not an authorization control, and it fails **open**: if it is
  unreachable the request is processed normally and uncached.

## Pagination

Cursor-based, never offset. `?limit=50&cursor=…`, response
`{ items, next_cursor }`, `limit` capped at 200. `next_cursor` is `null` on the
last page.

Offset is forbidden: it breaks under concurrent inserts and it invites
enumeration. `?offset=` is **refused with `400`** rather than ignored — ignoring
it hands a client the first page over and over while they believe they are
paging.

The cursor is opaque. It is base64url of a sort key today, which anyone can
decode and which carries nothing that was not already in the response it came
from; it is not signed, because a forged cursor selects a different page of the
caller's own collection. Constructing one rather than passing back `next_cursor`
is a dependency on a format that is allowed to change, and a cursor this API did
not issue is `400`.

**A short page does not mean the end, and neither does an empty one.** Where a
collection is filtered per caller after the database has applied the cursor —
grants are, because who may see one is decided by walking the scope tree —
`next_cursor` is taken from the last row *fetched*, not the last one returned.
It is the only signal that more exist.

## Asynchrony

Ingest returns `202` with a `job_id`. Status at `GET /v1/jobs/{id}`:
`queued | parsing | embedding | indexed | failed`, with progress and an error
message. An HMAC-signed completion webhook is optional.

## Limits

Counted per organization, not per token — per-token limits are bypassed by
issuing more keys.

| Resource | Default |
|---|---|
| search | 60 requests/min |
| ingest | 600 documents/hour |
| document size | 50 MB |
| vectors per organization | from `organizations.quotas` |

A `429` carries `Retry-After` and the `RateLimit-*` headers (RFC 9331). Every
counted response carries `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset` and `RateLimit-Policy` — not only the refusals, so a client can
slow down before it is refused rather than after.

Search and ingest are counted; reads of metadata are not. The window is fixed
rather than sliding, so a client that spends its budget at the end of one window
and the start of the next can briefly exceed the nominal rate. That is the
accepted cost of a counter that is one `INCR`.

Limiting fails **open**: if the counter is unreachable the request is allowed and
the degradation is logged. This is the opposite of the rule for permissions
(invariant 3) and deliberately so — a rate limit is availability protection, not
an authorization control, and failing closed would turn a Redis restart into an
outage.

## Versioning

Major version in the path. Breaking changes only with `/v1` → `/v2` and at least
12 months of parallel operation, mirroring the MCP deprecation policy.

## Current state

The OpenAPI document at [`openapi.yaml`](./openapi.yaml) is the contract and is
validated in CI. It still runs slightly ahead of the code, but no longer by
much, and this section said "nothing in `packages/api` is implemented" for a
long time after that stopped being true — which is its own kind of wrong, since
a reader who believes it goes looking for a server that is already there.

Implemented and driven by hand against a real PostgreSQL and a real Qdrant:

| | |
|---|---|
| `POST /v1/search` | pre-filtered by the caller's plan, `top_k` uncorrected |
| `POST /v1/documents` | `202` with a job id, `200` for an unchanged repeat |
| `DELETE /v1/documents/{id}` | tombstones the index and the row, in that order |
| `GET /v1/documents/{id}`, `GET /v1/jobs/{id}` | resolved per caller |
| `GET`/`POST /v1/workspaces` | a layer needs a workspace id, and until this existed the only way to have one was the line `init` printed |
| `GET`/`POST /v1/layers`, `PATCH /v1/layers/{id}` | `provider_id` optional on create; PATCH takes name and description and nothing that decides how the vectors were built |
| `GET`/`POST /v1/layers/{id}/reindex` | `202` and a path to poll; `copying` then `embedding` |
| `GET /v1/audit` | newest first, cursor-paged, JSON/JSONL/CSV by content negotiation |
| `GET`/`POST /v1/grants`, `DELETE /v1/grants/{id}` | |
| `GET`/`POST /v1/service-accounts`, `DELETE /v1/service-accounts/{id}` | |
| `GET /v1/health`, `GET /v1/ready`, `GET /metrics` | |
| `Idempotency-Key` on unsafe methods | 24 hours, `409` on reuse, service accounts excluded |
| `429` and the `RateLimit-*` headers | search and ingest, counted per organization; sign-in, counted per address **and** per client |
| Cursor pagination | layers, grants, service accounts |
| `POST /v1/auth/login`, `/refresh`, `/logout` | email and password, rotating refresh tokens |

Not implemented, and the document describes them anyway because they are the
contract they will be built to: OAuth discovery and dynamic client
registration, and multipart upload on `POST /v1/documents`.

### What multipart upload actually costs

Worth stating, because the one-line "not built" above reads like a missing
handler and it is not. **No binary document can be ingested today except by
URL**, and the reason is that the whole ingest path carries text:

- `Parser.parse` takes `{ content?: string, url?: string }`. There is no bytes
  argument, so the sidecar that exists to turn bytes into text can only be
  handed a string or an address to fetch.
- `documents.source_ref` is `text`. Without object storage there is nowhere in
  the schema to put bytes at all.
- `content_hash` is computed over the parsed text, so idempotency is defined on
  the text rather than on what was uploaded.

So it is an end-to-end change — the parser port, the sidecar's contract, the
ingest signature, and the hash — not a branch in the request handler. And it
implies a rule worth deciding deliberately rather than discovering: **binary
upload requires `NACRE_S3_*`**, because that is the only place bytes can live.

The half that would work today without any of that is a multipart envelope
around a *text* document, which is the half nobody needs: JSON already carries
text.
