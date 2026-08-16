# Configuration and deployment

## Environment variables

Secrets are passed as references into a secret store wherever that is possible.
Plaintext values are acceptable in the development profile and nowhere else.

```ini
# ─── base ───
NACRE_ENV=production                   # development | production
NACRE_CANONICAL_URL=https://nacre.work # OAuth issuer, well-known base, links in configs
NACRE_MCP_CANONICAL_URL=               # only when MCP is on a different origin
NACRE_MCP_ALLOWED_ORIGINS=             # browser origins MCP answers; empty refuses all
NACRE_LOG_LEVEL=info
NACRE_LOG_FORMAT=json

# ─── storage ───
NACRE_PG_URL=postgres://nacre:***@postgres:5432/nacre
NACRE_PG_POOL_MAX=20
NACRE_QDRANT_URL=http://qdrant:6333
NACRE_QDRANT_API_KEY=
NACRE_QDRANT_SHARDS=1                  # fixed at collection creation
NACRE_QDRANT_REPLICATION_FACTOR=1      # fixed at collection creation
NACRE_VECTOR_TENANCY=collection        # collection | shared
NACRE_REDIS_URL=redis://redis:6379/0

NACRE_S3_ENDPOINT=http://minio:9000
NACRE_S3_BUCKET=nacre
NACRE_S3_REGION=us-east-1
NACRE_S3_ACCESS_KEY=***
NACRE_S3_SECRET_KEY=***
NACRE_S3_FORCE_PATH_STYLE=true
NACRE_PRESIGN_TTL=900

# ─── models ───
NACRE_DEFAULT_EMBEDDING_ENDPOINT=http://embedder:80
NACRE_DEFAULT_EMBEDDING_MODEL=bge-m3
NACRE_DEFAULT_EMBEDDING_DIM=1024
NACRE_EMBED_BATCH=32                  # chunks per request; TEI refuses above its own limit
NACRE_EMBED_MAX_TOKENS=512            # per-chunk ceiling; a character is not a token
NACRE_RERANKER_ENDPOINT=http://reranker:80
NACRE_RERANKER_ENABLED=false          # true needs an endpoint; minimal has none
NACRE_RERANK_CANDIDATES=50            # fetched from the index, cut to top_k after scoring
NACRE_PARSER_ENDPOINT=http://parser:8090
NACRE_PARSER_ALLOW_PRIVATE_URLS=      # read by the parser sidecar; see below
NACRE_OAUTH_CONSENT_URL=              # optional; where a browser picks the agent

# ─── the embedding adapter (`hosted` profile only, nothing has a default) ───
NACRE_EMBED_ROUTES=                   # `model=vendor`, comma-separated. Required.
NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT=
NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY=
NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY_FILE=
NACRE_EMBED_CLOUDFLARE_ACCOUNT=
NACRE_EMBED_CLOUDFLARE_API_KEY=
NACRE_EMBED_CLOUDFLARE_API_KEY_FILE=
NACRE_EMBED_GOOGLE_API_KEY=
NACRE_EMBED_GOOGLE_API_KEY_FILE=
# Both model endpoints are base URLs and **a path on one is kept**: the route is
# resolved under it, so `https://api.openai.com/v1` calls /v1/embeddings and
# `http://embedder:80` calls /embeddings. Until 0.5.2 the route was appended from
# the root, which discarded the path — so every hosted OpenAI-compatible API, and
# Ollama and LM Studio, answered 404 while the profiles' own TEI worked.

# ─── authorization ───
# Exactly one of these two, and setting both is refused at startup — they are
# two answers to "what signs a token" and there is no precedence worth
# inventing. Neither has a default: a signing key in the source is one anybody
# reading the source can forge tokens with.
NACRE_JWT_SECRET=                      # >= 32 bytes; a secret-store reference in production
NACRE_JWT_SECRET_PREVIOUS=             # set only while rotating; see below
NACRE_JWT_PRIVATE_KEY_REF=             # file:// to an Ed25519 PEM; the asymmetric mode
NACRE_JWT_PREVIOUS_KEY_REF=            # set only while rotating an asymmetric key
# On a process that only VERIFIES (the MCP transport is a resource server), the
# public key alone. It holds no secret and no private key, so reading its
# environment gets an attacker to "can check tokens" and no further — which is
# the whole reason the asymmetric mode is worth having. The API, which signs,
# takes NACRE_JWT_PRIVATE_KEY_REF above; a verifier takes one of these instead.
NACRE_JWT_PUBLIC_KEY_REF=              # file:// to an Ed25519 PEM public key; verify-only
NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF=     # set only while rotating; the retired public key
NACRE_JWT_ISSUER=https://api.nacre.work   # must match NACRE_CANONICAL_URL in production
NACRE_JWT_AUDIENCE=nacre
NACRE_ACCESS_TOKEN_TTL=900
NACRE_REFRESH_TOKEN_TTL=2592000
NACRE_OAUTH_AUTHORIZATION_SERVER=      # optional; the IdP in front of this installation
NACRE_EMA_ENABLED=false                # ID-JAG, commercial module
NACRE_EMA_TRUSTED_ISSUERS=

# ─── permissions ───
NACRE_ACL_CACHE_TTL=60

# ─── MCP STDIO local mode only ───
# Read by `@nacre.work/mcp` when it runs as a STDIO subprocess, not by any
# server this file otherwise configures — the STDIO transport has no HTTP
# request to authenticate, so it authenticates once from this service account
# key and carries exactly its permissions. Required in that mode and read
# nowhere else; the full contract is in docs/mcp.md.
NACRE_SERVICE_KEY=nacre_sk_…

# ─── the background worker ───
NACRE_GC_GRACE=3600                    # tombstone to physical purge
NACRE_INDEX_LEASE=900                  # any claim older than this is abandoned: indexing, purge
NACRE_INDEX_MAX_ATTEMPTS=5             # then the document is failed, not requeued

# ─── limits ───
NACRE_RATE_SEARCH_PER_MIN=60
NACRE_RATE_INGEST_PER_HOUR=600
NACRE_RATE_LOGIN_PER_15MIN=10          # per email address, not per organization
NACRE_RATE_LOGIN_SOURCE_PER_15MIN=60   # per client; what bounds a spray across addresses
NACRE_TRUST_PROXY=0                    # proxies in front of this process; 0 ignores X-Forwarded-For
NACRE_MAX_DOCUMENT_BYTES=52428800
NACRE_METRICS_TOKEN=                   # unset leaves /metrics open; >= 16 chars if set

# ─── audit ───
NACRE_AUDIT_RETENTION_DAYS=400         # >= 30; the floor is not a tunable
NACRE_COLLECTION_RETENTION_DAYS=7      # >= 1; the reindex rollback window
NACRE_REINDEX_MIN_RECALL=80            # 0-100; the recall gate, off without a query set
NACRE_AUDIT_QUERY_TEXT=false           # true stores query text verbatim
NACRE_AUDIT_SIEM_WEBHOOK=

# ─── modules ───
NACRE_MODULES=                         # commercial modules to load; see docs/extensions.md
```

**`NACRE_PG_URL` must not name a superuser, and should not name the role that
owns the tables.** Row-level security does not apply to a superuser at all, and
applies to the owner only where the table is forced. Connecting as either turns
the tenant-isolation policies into decoration. Migrations run as the owner;
the application runs as `nacre_app`.

### Three roles, and what each is for

| Role | Used by | Row-level security |
|---|---|---|
| the owner | migrations only | **bypassed** — see below |
| `nacre_app` | the API and the MCP server | applies |
| `nacre_worker` | the worker's queue only | **bypassed** |

**The owning role needs `BYPASSRLS`, and this table said the opposite until it
was run.** Every tenant table is `FORCE`d, which is precisely what makes the
policy apply to the owner — and four migrations read a tenant table: `0006`
checks for duplicate layer slugs, `0007` backfills a lease column, `0017`
rewrites a role, `0018` dedupes group members. Each evaluates
`current_setting('app.current_org')`, which is unset during a migration, so
each fails with `unrecognized configuration parameter "app.current_org"` — the
same error, and the same root cause, as the two subsystems below.

Verified by provisioning a plain owner and running the migrator: `0001`–`0005`
applied and `0006` failed. With `BYPASSRLS` on the same role, every migration
applied and `nacre_app` remained unable to create a table, unable to bypass a
policy, and holding only `INSERT, SELECT` on `audit_events`.

A count rather than "every" used to stand here, and it went stale on the next
migration — which is the same shape as anything else in this repository that
records a number the tree keeps changing.

Provisioning, run once as a superuser:

```sql
CREATE ROLE nacre_owner LOGIN PASSWORD '…' BYPASSRLS;
CREATE ROLE nacre_app   LOGIN PASSWORD '…';   -- no BYPASSRLS, no CREATE
CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;
GRANT nacre_worker TO nacre_owner WITH ADMIN OPTION;
CREATE DATABASE nacre OWNER nacre_owner;
```

`WITH ADMIN OPTION` is required and plain membership is not: `0008` grants
`nacre_worker` onward to `nacre_app`, and only a member holding `ADMIN` may do
that. `0008`'s own hint says to grant membership, which does not fix it — that
migration has been applied everywhere and its text is checksummed, so it cannot
be corrected in place. The migrator refuses up front instead, with the block
above, before it applies anything.

**Do not grant the owner's rights to `nacre_app` to save a credential.** The
owner bypasses every policy in the schema; that is the whole reason it is a
separate role.

`nacre_app` sets `app.current_org` for every query through `withOrg`, so the
policies scope it to one tenant. Two paths legitimately cannot be scoped that
way, and each has exactly one mechanism:

- **Resolving a credential.** A service account key is what says which
  organization it belongs to, so the lookup precedes knowing one. A second
  policy admits it while `app.authenticating` is set, `FOR SELECT` only, on
  `service_accounts` alone. It reads the credential columns and nothing joined
  from tenant data.
- **Claiming work.** The worker's queue looks at every tenant's documents,
  because that is what a queue is. It runs under `nacre_worker`, which has
  `BYPASSRLS` — the one place the second line of defence is off, which is why
  every query the worker makes names `org_id` explicitly.

Migration `0008` creates `nacre_worker` and grants it to `nacre_app`. Creating
a role with `BYPASSRLS` needs a superuser; where the migrating role is not one,
the migration fails with the statement to run by hand rather than leaving a
worker that starts, claims nothing, and reports itself healthy.

Until that migration, **neither path worked on a deployment that followed the
rule above.** Both raised `unrecognized configuration parameter
"app.current_org"` — service account keys answered `500`, and the worker
indexed nothing. It went unnoticed because development, CI and the Compose
stack all connect as a superuser, which is the one configuration this section
tells you not to use.

**The application validates the whole configuration at startup and exits if
anything required is missing or contradictory**, reporting every problem at
once rather than the first — one restart per missing variable is how a
deployment takes an afternoon.

Three combinations parse individually and are refused together, because a
per-variable check cannot catch them:

- `NACRE_RERANKER_ENABLED=true` with no endpoint set.
- `NACRE_REFRESH_TOKEN_TTL` no longer than `NACRE_ACCESS_TOKEN_TTL`. A refresh
  token that expires no later than the access token it renews cannot renew
  anything, so every session would end at the first refresh.
- A plaintext or localhost `NACRE_CANONICAL_URL` in production. It is the OAuth
  issuer, it goes into every token ever issued, and over plaintext it is also
  what an attacker rewrites. Silent defaults for secrets and
URLs are not allowed — a default that quietly points at localhost is how a
production deployment ends up talking to nothing and reporting success.

### Accepted and not implemented

This build reads none of them. Listed rather than removed, because each is in
the contract — but an operator should know that setting one changes nothing in
this build:

| Variable | What it would do |
|---|---|
| `NACRE_EMA_*` | ID-JAG is a commercial module; read by that module, not by this code |
| `NACRE_AUDIT_SIEM_WEBHOOK` | SIEM export is a commercial module; read by that module, not by this code |

**"These parse" was wrong about both, and is now corrected.** `loadConfig` has
no field for either, so a malformed value is not caught at startup — it is not
caught here at all. The commercial modules that read them validate them at load,
which is the right place: the check belongs where the value is finally used, and
a variable this build never reads is one this build cannot say anything useful
about.

`NACRE_OAUTH_CIMD_ENABLED` and `NACRE_OAUTH_DCR_ENABLED` **were on this list and
are now gone entirely**, which is a different statement from "not built yet".
Client registration, under either mechanism, is a transaction between a client
and an authorization server, and the section above is unambiguous that Nacre is
not one. There is no registration endpoint here to switch on and no client
record to create; a deployment that wants either gets it from the identity
provider it names in `NACRE_OAUTH_AUTHORIZATION_SERVER`.

A variable for a role the product has declined is worse than a missing feature.
An unimplemented one tells an operator to wait; one like these tells them the
product has a knob it is never going to have, and they set it and believe
something.

### Logging

`NACRE_LOG_LEVEL` is one of `debug`, `info`, `warn`, `error`, and
`NACRE_LOG_FORMAT` is `json` or `text`.

`json` carries `level`, `ts` and `msg` plus the line's own fields — `msg` keeps
its name because every line in this system had it before there were levels, and
anything already grepping for it still works. `text` is `key=value` for a person
at a terminal, with any value containing a space or a quote quoted, so
`error="connection refused"` cannot read as two fields.

`warn` and `error` go to stderr and the rest to stdout. A container that ships
stdout to a log service and leaves stderr on the console is a real deployment,
and a failure written to stdout with everything else is one nobody saw.

Three things deliberately do not go through it:

- **Configuration errors.** They happen before there is a configuration to ask,
  and a process that cannot start must say why whatever the level says.
- **`init` and `migrate` output.** That is program output a person runs and
  reads, like `--help`. Behind a level, `NACRE_LOG_LEVEL=warn` would swallow the
  organization id `init` exists to print.
- **The MCP STDIO transport writes every line to stderr**, including the ones
  that are `info` elsewhere. stdout carries JSON-RPC frames and nothing else; a
  log line in the middle of the stream is a frame the client cannot parse.

#### Why a 401 happened

The response never says — one status, one title and one sentence for every
reason, because distinguishing "expired" from "the connection was forgotten"
tells whoever is guessing which guess was closest. The **log** says, on a line
reading `authentication refused` with the `request_id` the caller was given:

| `reason` | What to look at |
|---|---|
| `no_bearer` | Nothing. A request arrived with no `Authorization` header. |
| `service_keys_unavailable` | This process was wired without the port that resolves a `nacre_sk_` key, so **every** agent key fails here. A deployment problem, not a credential one. |
| `service_key_rejected` | The key is unknown or revoked — `service_accounts`. |
| `unverifiable` | No configured key verified the signature: another installation's token, a rotation that dropped the previous key, or an expiry. |
| `claims_incomplete` | It verified and does not say who it is. A token this deployment signed and no longer understands — check for a version skew between processes. |
| `delegation_claim_malformed` | A `del` claim that is not a string. |
| `delegations_unavailable` | This process was wired without the delegations port, so every *delegated* token fails while service-account keys keep working. |
| `delegation_unresolved` | `oauth_consents` by the logged `delegation` id: no such row, `revoked_at` set (the connection was forgotten), or its person disabled. |
| `delegation_subject_mismatch` | The token's subject and the connection's differ; both ids are on the line. |

The line carries ids and never the credential. `no_bearer` and `unverifiable`
are `debug` because an anonymous caller can produce them at will and a log that
floods is one somebody turns off; every other reason needs a token this
deployment signed, so it says something about the deployment and is `info`.

### Modules

`NACRE_MODULES` is a comma-separated list of package names to load at startup.
Empty by default, which is the whole product this repository builds: everything
the six invariants describe works with nothing loaded.

Read by the API and by both MCP transports, and **not** by the worker — the
worker consults no extension point, so loading a module there would import it
and never ask it anything. That is the state this mechanism exists to prevent,
so it is not done by symmetry.

Each name is imported by name, and the module registers itself. A name that
cannot be imported is a **startup failure**, not a warning: naming a module
means the deployment is paying for what it does, and starting without it is
silently a different product.

The startup line reports what loading actually produced — the resolver, the
providers, the sinks and the route count — rather than what was named. A module
that imports cleanly and registers nothing is the failure worth seeing, and it
is invisible everywhere else.

`docs/extensions.md` is the contract.

### Discovery

`GET /.well-known/oauth-protected-resource` is served by both the API and the
MCP transport, unauthenticated, because it is what a client reads *before* it
has a credential. It is the path every `401` from the MCP transport names in
`WWW-Authenticate`, and for as long as that header existed nothing served it —
a client doing exactly what it was told got a `404`.

The document names the canonical resource identifier, which is the audience
value every token is bound to, and `authorization_servers` — which is
`NACRE_OAUTH_AUTHORIZATION_SERVER` when a deployment has an identity provider in
front of it, and **this installation's own API** otherwise.

That default reverses what this section used to say, and the reversal is the
point rather than a slip. The field was empty on the argument that Nacre is a
resource server and a client sent here for a token endpoint would find nothing —
correct for what existed then, and it is the endpoint that changed: the API runs
the authorization server now, with a consent screen that binds the connection to
a service account rather than to the person who approves it. Never the MCP
transport, which still verifies tokens and issues none.

`NACRE_OAUTH_CONSENT_URL` is where a browser is sent to pick that agent, and its
**fragment is a route**: the admin UI is hash-routed, so the default
`…/#/consent` means the consent screen and the authorization request is appended
to it as `#/consent?client_id=…`. A value with no fragment works too — the
request becomes the whole fragment — which is what a deployment serving the
screen at its own path wants.

Both processes serve the same object, built once. Two builders would drift, and
a client that read one and authenticated against the other would be
audience-bound to a string neither agreed on.

### The limits apply to MCP too

`NACRE_RATE_SEARCH_PER_MIN` and `NACRE_RATE_INGEST_PER_HOUR` used to apply to
REST only, so the MCP transport was unlimited: a client that had spent its
search budget could point at the MCP port and carry on. Two doors into one
authorization service, one of them with a lock.

They share buckets rather than counting per surface, deliberately — separate
counters would hand a caller twice the documented allowance for holding two
clients, which is the same hole one level up. `search` spends the search budget;
`ingest_document` and `delete_document` spend the ingest one. `list_layers` is
unlimited: it is one indexed query, and refusing it breaks discovery for a
client that is otherwise behaving.

A refusal is JSON-RPC error `-32003` with HTTP `429` and the RFC 9331
`RateLimit-*` headers, checked after the catalog lookup so that an unknown tool
stays indistinguishable from one the caller may not see.

### The login endpoint is limited twice

Once per email address and once per client, because either alone leaves a hole.
The address limit bounds guessing at one account and does nothing about the
attack that is actually run — one password against ten thousand addresses never
repeats a key. The client limit bounds that, and is looser because a whole
office behind one NAT is one client here.

`NACRE_TRUST_PROXY` is how the client is identified, and **neither default is
safe**, which is why it is configuration:

- Trusting `X-Forwarded-For` unconditionally keys the limit on a string the
  attacker picks. A fresh value per request is worse than having no limit — it
  costs a Redis round trip to accomplish nothing.
- Ignoring it unconditionally means that behind an ingress every request carries
  the proxy's address, so one bad client rate-limits every user.

So it is the **number of proxies** in front of this process: `0` (the default)
takes the socket address, `1` takes the last entry of `X-Forwarded-For`, `2` the
second from last. **Counted from the right**, because each proxy appends — the
leftmost entries are whatever the client sent, and only the rightmost ones were
added by infrastructure. Setting it too low over-restricts; setting it too high
under-restricts; neither is worse than the default.

IPv6 clients are counted per `/64` rather than per address: a single subscriber
is handed a /64, so counting whole addresses means one allocation is more
buckets than there are requests.

Separately, and independently of any of this, **the number of passwords being
verified at once is bounded inside the process**. scrypt runs on libuv's thread
pool, which is shared with DNS and file I/O, so an unbounded login endpoint
stops the rest of the API on a name lookup — which reads as a database problem
on a dashboard at exactly the wrong moment. Past the bound the endpoint answers
`503` with `Retry-After`, not `401`: nothing was decided about those
credentials, and saying "not valid" to a request that was never checked is a lie
the client will act on.

### Retention

Two tables are swept by the worker, hourly, in bounded batches:

- **`refresh_tokens`**, past `expires_at`. Nothing is lost — an expired token
  and an unknown one are refused identically and at the same place — and reuse
  detection is untouched, because a family is revoked while its tokens are still
  live. This is the sweep migration `0009` described and did not have; until it
  existed the table grew at the rate people signed in.
- **`audit_events`**, past `NACRE_AUDIT_RETENTION_DAYS`, through a
  `SECURITY DEFINER` function rather than a `DELETE`. The application role's
  `DELETE` grant stays revoked. The function takes a number of days and never a
  predicate, so it can expire a window and cannot erase a chosen event — which
  is what the append-only guarantee is actually protecting. **The 30-day floor
  is refused at startup**, not clamped: a deployment configured for a week of
  audit history should not come up believing it has one.

On the same clock, and third, the worker reclaims what a model migration left
behind, past `NACRE_COLLECTION_RETENTION_DAYS`: **the collection it replaced**,
and **the vector slot inside the collection that survived** — a completed
reindex leaves every point in the layer carrying the vector it used to be
searched by, which is a float per dimension per point and in memory by default.
The slot stays declared in the collection's schema, because Qdrant cannot remove
one; only the data goes. Each one is a full
copy of an organization's vectors, and until this existed nothing removed them —
disk that grew with every migration.

The window is a rollback window, not a tidiness delay: the cheap rollback in a
reindex is moving `organizations.vector_collection` back, and that works for
exactly as long as the collection it points back to still exists.

Candidates come from a table written by the same transaction that moves the
pointer, never from "every collection Qdrant has that nothing points at" — a
copy still being built matches that description, and deleting it would destroy
the migration in progress. Before each delete the pointer is checked again, so a
collection an operator has rolled back onto is dropped from the list instead of
dropped from disk.

All three are unurgent and block nothing, so a pass that fails is logged and
retried an hour later. They fail independently: a refused audit prune does not
stop token expiry, and neither stops the collection sweep.

### The reindex recall gate

`NACRE_REINDEX_MIN_RECALL` is the recall a migration must reach before its layer
switches onto the new model, as a whole-number percentage. A fraction would be a
value two parsers disagree about in an environment file; 80 means 0.8.

**It gates nothing until a layer has a reference query set.** A reindex succeeds
mechanically whether or not the new model works — every document gets a shadow
vector, the count reaches zero, `vector_name` moves — so the wrong model name
behind the right endpoint collapses retrieval with every step reporting success.
The gate is the only part of the sequence that asks whether the new model can
still answer. Answering it needs documents someone picked, which is a thing only
the deployment has, so the set is written through
`PUT /v1/layers/{id}/reference-queries` and there is no gate before that.

Not agreement with the old model, which would need nothing from anyone and would
be the wrong measurement: a better model disagrees with the worse one it
replaces, so a gate on agreement blocks the migrations worth making and passes a
new model that reproduces the old one's mistakes.

`0` is allowed and means measure without blocking — the number is still recorded
and still visible on `GET /v1/layers/{id}/reindex`, and every recall clears a
floor of zero. That is arithmetic rather than a special case, which is why this
has no minimum where `NACRE_COLLECTION_RETENTION_DAYS` has one: a low value
there destroys the rollback, and a low value here destroys nothing.

A check that **fails** ends the reindex at `failed` with the numbers recorded.
The pointer does not move, the layer stays on the model it was already on, and
the shadow vectors stay in the collection — so the next step is looking at the
per-query scores rather than starting again. A check that **cannot run**, because
the embedder is unreachable, is not a failure: no verdict is written and the next
pass tries again.

There is no metric for it. A gauge would carry one series per layer, and the
number is read once per migration by someone already polling the reindex
endpoint that carries it.

One variable is **refused** rather than ignored, because ignoring it would
silently overrule a decision about isolation:

- `NACRE_VECTOR_TENANCY=shared` — every collection is named per organization and
  no code path shares one. Accepting it would give you a single-collection
  deployment that believes it is isolated.

`NACRE_ACL_TAG_HASH_BYTES` was refused beside it and is now simply gone, with
the tag cache it described. So is `NACRE_ACL_PROPAGATION_SLA`: nothing
propagates asynchronously any more, so there is no window to bound. Both were
removed rather than left on a "not implemented" list, on the same rule as
`NACRE_OAUTH_CIMD_ENABLED` — a variable for a mechanism the product no longer
has tells an operator it has a knob it will never have.

### What Redis is for

`NACRE_REDIS_URL` holds the rate limit counters and the `Idempotency-Key` cache,
and nothing else. Both are **soft state**: losing it costs a window's counts and
a day's cached responses, and neither is a permission decision or a durable
record.

That is why both fail **open**. If Redis is unreachable the request is served
and the degradation is logged, which is the opposite of the rule for permissions
(invariant 3) and deliberately so — a rate limit is availability protection, and
failing closed would turn a cache restart into an outage. Nothing that decides
access is ever read from here.

It is not a queue. Indexing work is claimed from Postgres under a lease
(`NACRE_INDEX_LEASE`), so a Redis loss cannot strand a document.

### Rotating the signing key

`NACRE_JWT_SECRET_PREVIOUS` is **accepted on verification and never used to
sign**. It exists because there is one signing key and no `kid`, so changing the
secret used to invalidate every outstanding access token at the same instant —
and the SDK does not refresh on a 401, so that reached applications as errors
rather than as a pause.

A rotation is therefore two restarts and no outage:

1. Move the current secret to `NACRE_JWT_SECRET_PREVIOUS`, put the new one in
   `NACRE_JWT_SECRET`, restart **`api` and `mcp` together**. Tokens already out
   keep verifying; everything issued from now on is signed with the new key.
2. After `NACRE_ACCESS_TOKEN_TTL` has elapsed — every token signed with the old
   key has expired by then — unset `NACRE_JWT_SECRET_PREVIOUS` and restart
   again.

Both processes verify with the same secret, so a rotation that reaches one and
not the other gives 401s on part of the traffic and not the rest. Each prints
its key fingerprints at startup for exactly this comparison:

```json
{"msg":"api listening","jwt_key":"sha256:e4758d5c1f1f","jwt_key_previous":["sha256:dfdff7afb059"]}
```

`jwt_key_previous` appears only during a rotation. Its absence after step 2 is
how you know the old key is out — leaving the variable set indefinitely keeps a
retired key valid, which is the whole thing rotation was for.

Refused at startup, both because they are what an operator does when they mean
to rotate and mis-copy a line: a previous secret shorter than 32 bytes, and a
previous secret equal to the current one. The second leaves an installation
that believes it has rotated and has not.

### Signing with an Ed25519 key

`NACRE_JWT_PRIVATE_KEY_REF` points at a PEM private key:

```bash
openssl genpkey -algorithm ed25519 -out /run/secrets/jwt_ed25519
NACRE_JWT_PRIVATE_KEY_REF=file:///run/secrets/jwt_ed25519
```

**What it buys is that the key which verifies is not the key which signs.**
With `NACRE_JWT_SECRET`, every process that checks a token can also mint one —
`api`, `mcp`, and anything else handed the same environment. With an Ed25519
key, only the process issuing tokens needs the private half, and reading a
container's environment gets an attacker as far as "can check tokens" rather
than "can act as any administrator in any organization".

`file://` and no other scheme, which is the whole of the support and is
deliberate. Every platform with a secret store presents one as a file — Docker
secrets, Kubernetes, systemd credentials — and a `vault://` or `aws-kms://`
scheme would put a network client on the startup path, which is a different
feature with different failure modes.

Ed25519 and no other key type. RSA needs a size check and a padding choice and
EC needs a curve-to-algorithm mapping; each is a place to be wrong about
something a signature depends on, and Ed25519 has no parameters at all. A key of
any other type is refused at startup, by name.

**`GET /.well-known/jwks.json`** publishes the public half, so a gateway or a
sidecar can verify a token without holding a secret. It answers `404` on a
deployment using `NACRE_JWT_SECRET`, and that is the point rather than a gap: a
shared secret has no publishable half, and an endpoint that produced one anyway
would be publishing the key that mints tokens.

Rotating an asymmetric key is the same two restarts as the symmetric one, with
`NACRE_JWT_PREVIOUS_KEY_REF` in place of `NACRE_JWT_SECRET_PREVIOUS`. The
retired key stays in the JWKS for the length of the window, because there are
tokens in the wild signed with it and a verifier outside the process has to be
able to check them.

Every token carries `kid`, derived from the public bytes rather than configured,
so two processes agree on it without anyone keeping two settings in step.

### `NACRE_QDRANT_SHARDS` and `NACRE_QDRANT_REPLICATION_FACTOR`

Both are **fixed when a collection is created.** Qdrant cannot reshard a live
collection, so these decide the shape a deployment lives with — and changing
either afterwards means building a new collection and copying every point into
it.

That is not a one-way door, and it is worth knowing which kind of door it is.
The copy is machinery this system already has: a model migration builds a new
collection carrying both vector slots and moves every point across **without
recomputing embeddings**, then switches `organizations.vector_collection` in one
statement. So a deployment that outgrows one shard can get to more, at the cost
of an organization-wide copy and the disk to hold both collections at once.

Both default to `1`, which is what every collection created before these
variables existed has, and what a single-node deployment should keep:

- **shards above 1 on one node is worse than leaving it.** More segments, no
  more parallelism, and a rebalance with nowhere to go.
- **a replication factor above the number of nodes cannot be met.** Qdrant
  accepts the number and the collection stays under-replicated.

Set them when the cluster exists, not in anticipation of one. They apply to
every collection the process creates — a new organization's, and the target of a
model migration — and to nothing it reads, so raising them affects what is
created next and never what is already there.

They are deliberately absent from `.env.example` and from `docker-compose.yml`,
which is the one place in this repository where the answer is known rather than
chosen: that stack runs a single Qdrant container, and both bullets above say
what a number above `1` does to it. The chart is where they belong, and
`nacre-infra` carries them as `qdrant.shards` and `qdrant.replicationFactor`.

### `NACRE_EMBED_BATCH`

**How many chunks go to an embedding endpoint in one request. Default 32.**

An embedding endpoint does not split a batch that is too large; it refuses it.
Text Embeddings Inference — the embedder every Compose profile here starts —
takes `--max-client-batch-size`, which defaults to **32**, and answers `413`
above it. So the default is that number rather than a guess at good throughput.

Getting this wrong is quiet, which is why it has a section. A document is
chunked at 800 characters with 120 of overlap, so anything past roughly 22 KB of
text produces more than 32 chunks. Both embedding clients used to send the whole
list in one request, and the result was:

```
the embedding endpoint at http://embedder/embeddings answered 413
```

with the document left in `failed` — a status nothing retries. **The layer goes
on answering searches** out of whatever did index, so retrieval is silently
worse and the only sign is a count beside a larger count in the admin UI. Found
that way, at twenty-six failures out of fifty.

Raise it where the endpoint accepts more: OpenAI takes 2048, and the embedding
adapter passes a batch through to whichever vendor is routed. Lowering it below
the endpoint's limit is never wrong, only slower — batches are sent one at a
time, because the endpoint is the bottleneck and is usually a CPU container
sized for one caller.

If you raise the server's limit instead, raise it *above* what the client sends
rather than to the same number. A server that accepts more than any client sends
costs nothing.

### `NACRE_EMBED_MAX_TOKENS`

**The most tokens one chunk may cost the embedding endpoint. Default 512.**

The other bound on the same request, and the one a character count cannot
express. Every embedding model has a hard ceiling on a single input — 512 for
the BGE and E5 families, which is what these profiles start — and **a character
is not a token.** Under an English tokenizer a Cyrillic or CJK character costs
several. Measured against a real `bge-small-en-v1.5`, at the 800-character
chunk this project ships:

| script | tokens for 800 characters |
|---|---|
| English | 149 |
| Hindi | 471 |
| Greek | 642 |
| Russian | 655 |
| Hebrew | 664 |
| Arabic | 676 |
| Chinese | 802 |
| Japanese | 802 |
| Korean | 1094 |

Seven of the eleven scripts tried are over the ceiling before a document is
even long. So a Russian or Korean corpus failed **every document**, with the
endpoint answering `413` and the worker marking each one `failed` — a status
nothing retries — while the API answered `queued`. English was unaffected,
which is why it took a non-English corpus to find.

Chunking is bounded by this as well as by the layer's character size, and a
chunk ends at whichever comes first. English is unchanged: 800 characters costs
149 tokens, so the character size still binds. Cyrillic and CJK chunks get
shorter, automatically and per chunk, so a document mixing scripts is cut long
where it is cheap and short where it is not.

Set it to what your model accepts. A model with a larger window — bge-m3 takes
8192 — gets larger chunks by saying so here, and nothing else changes.

Getting it **too high** is survivable rather than silent: the endpoint refuses,
the worker re-chunks smaller and retries, and it says so in a log line naming
both budgets. The document still indexes; what it costs is the failed request
first, on every document like it. Getting it too low costs only more vectors.

The cost model behind the bound is calibrated rather than provable — ASCII is
charged half a token per character, which is above prose and identifiers and
below a run of pure punctuation — and that trade is why the retry exists. Being
provably safe would mean charging by UTF-8 bytes, which would cut English
chunks by a third for text that was never near the ceiling.

### `NACRE_PARSER_ALLOW_PRIVATE_URLS`

Read by the **parser sidecar**, not by `loadConfig`, and off unless it is
literally `true`.

Ingest by URL makes the parser fetch whatever `POST /v1/documents` was given, so
by default it refuses any URL resolving anywhere private: loopback, link-local
(`169.254.169.254`, the cloud metadata endpoint), the private ranges, multicast
and the reserved blocks, in v4 and v6 alike, and again after every redirect.

Set it where a deployment genuinely indexes an internal wiki, and set it knowing
what it means: **any tenant who can call `POST /v1/documents` can then reach
anything that container can** — the API beside it, the vector store, the
metadata endpoint. It is the one variable here that turns an authenticated
caller into the chooser of an outbound request's destination.

It went undocumented from the day it was added, because the check that holds
this reference against the code knew about TypeScript and the parser is Python.
That is fixed on both sides: `lint:config` reads the sidecars now too.

### The embedding adapter

**Routing a model here means the text of your documents leaves your
installation.**

That sentence is the whole of the decision. A self-hoster on a laptop has no
good embedder — bge-m3 under emulation blows the worker's budget, and "run a
GPU" is not an answer for someone trying the product — and a hosted API is the
alternative. It is a real trade and it is the opposite of what this product
otherwise is, so it is never made by default, never made by a fallback, and
never made by a profile somebody else named.

- **Nothing has a default.** No vendor, no endpoint, no route.
- **An unrouted model is refused by name** and never falls through to whichever
  vendor happens to be configured.
- **With no routes at all the container refuses to start**, naming
  `NACRE_EMBED_ROUTES`.
- **It is absent from `airgapped` rather than disabled in it.** A service that
  is not there cannot connect to anything; a runtime check on a URL is a check
  that has to be right. `pnpm lint:compose` asserts the absence.

It is a sidecar rather than a branch in the worker for three reasons: a vendor
credential would otherwise reach Postgres and therefore every dump; the least
observable loop in the system would grow three response shapes and three error
vocabularies; and the next vendor would be a migration.

**Routing needs no schema change at all.** The request already carries `model`,
and `embedding_providers.model` is a string you already fill in, so that is the
routing key. Point a provider's `endpoint` at the adapter and give it the model
you routed:

```
NACRE_EMBED_ROUTES=text-embedding-3-small=openai-compatible,@cf/baai/bge-m3=cloudflare
NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT=https://api.openai.com/v1
NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY_FILE=/run/secrets/openai
NACRE_EMBED_CLOUDFLARE_ACCOUNT=…
NACRE_EMBED_CLOUDFLARE_API_KEY_FILE=/run/secrets/cloudflare
```

```bash
docker compose --profile hosted up -d
```

```
POST /v1/embedding-providers
{"name": "openai", "endpoint": "http://embedding-adapter:8091",
 "model": "text-embedding-3-small", "dimensions": 1536}
```

Two organizations can then sit on two vendors with no new machinery, which is
what `embedding_providers.org_id` has offered since migration 0001.

| `vendor` | Upstream | Credential |
|---|---|---|
| `openai-compatible` | Anything answering OpenAI's `/embeddings`: OpenAI, Together, DeepInfra, vLLM, a self-hosted TEI | `NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY` or `NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY_FILE`, with `NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT` |
| `cloudflare` | Workers AI | `NACRE_EMBED_CLOUDFLARE_API_KEY` or `NACRE_EMBED_CLOUDFLARE_API_KEY_FILE`, with `NACRE_EMBED_CLOUDFLARE_ACCOUNT` |
| `google` | Generative Language API | `NACRE_EMBED_GOOGLE_API_KEY` or `NACRE_EMBED_GOOGLE_API_KEY_FILE` |
| `voyage` | Voyage AI | `NACRE_EMBED_VOYAGE_API_KEY` or `NACRE_EMBED_VOYAGE_API_KEY_FILE` |

The first is named for the protocol rather than for a company, which is why its
endpoint is required rather than defaulted at one vendor.

**A route may name the vendor's own spelling of the model**, as
`model=vendor:upstream-model`:

```
NACRE_EMBED_ROUTES=bge-m3=cloudflare:@cf/baai/bge-m3
```

The left-hand side stays the routing key and stays what a caller sends; only
what goes upstream changes. That matters because a layer's named vector is
derived from the model — `v_{model}_{dimensions}` — so an installation already
indexed against `bge-m3` cannot be moved to Cloudflare's copy of the same
weights by renaming the model: that is a different slot, and therefore a reindex
of every layer to move vectors that did not need to move. The weights are
identical and only the vendor's spelling differs, so the spelling is what this
moves. `GET /health` on the adapter reports any substitution in effect.

### When the adapter answers 502

**502 from the adapter means the vendor failed, not the adapter.** It is the one
status this service uses for "somebody else's service did not answer", so a
search or an ingest failing with

```
the embedding endpoint at http://embedding-adapter:8091/embeddings answered 502: cloudflare answered 429
```

has nothing wrong with the route, the credential or the container — those had to
work for the request to get that far. The part after the colon is the adapter's
own sentence and it names the vendor and what the vendor said; the adapter logs
the same line, so `docker logs` or `kubectl logs` on that container has it too,
with a `"level":"error"`.

The half after the colon is why anything is knowable here: it was absent, and
what an operator got instead was a sentence naming the one process in the chain
that had not decided anything, with the adapter's log holding only its startup
line.

What the vendor's status means, and they are three different problems:

| The adapter says | What it is | Where to look |
|---|---|---|
| `<vendor> answered 401`/`403` | the credential this adapter holds was **rejected** | the message names the two variables that could hold it |
| `<vendor> answered 429` | a quota or a rate limit | the vendor's dashboard; nothing here is misconfigured |
| `<vendor> answered 5xx` | the vendor's own outage | their status page |
| `<vendor> could not be reached: …` | DNS or egress from this container | the network, not the vendor |

**A 401 here is the opposite of a 401 from an endpoint you configured
directly.** That one means the endpoint wants a credential and Nacre sends none
— there is no column for one, deliberately, which is what the adapter exists
for. This one means the adapter *did* send a credential and the vendor said no.
The two read alike and point opposite ways, so the message spells it out and
names the variables: `cloudflare answered 401 — it rejected the credential this
adapter holds … Check NACRE_EMBED_CLOUDFLARE_API_KEY or
NACRE_EMBED_CLOUDFLARE_API_KEY_FILE`. The pair is carried from the table entry
that resolved it rather than derived from the vendor's name, because
`cloudflare` is in both tables under different variables and naming the wrong
one sends you to a variable that is not in play.

A token that worked and then stopped is usually one that expired or was rolled.
Worth checking second: a secret updated in the store reaches a running container
only on restart, so the file the adapter read at startup can be the old one.

**Which of those two it is, is a question the adapter answers.** It reports a
fingerprint of each credential it loaded — never the credential — at startup, in
`GET /health`, and in the refusal itself:

```json
{"level":"info","msg":"embedding adapter listening","credentials":{"cloudflare":"sha256:1d4bedd426ab"}}
```

```
cloudflare answered 401, rejecting this adapter's credential sha256:1d4bedd426ab
from NACRE_EMBED_CLOUDFLARE_API_KEY[_FILE]
```

Compare it with the token you deployed:

```bash
printf %s "$TOKEN" | sha256sum | cut -c1-12
```

Equal means this container holds what you think it does and the credential
itself is what the vendor is refusing. Different means the rotation did not
reach it — a `docker compose` `environment:` entry overriding an `env_file:`,
or a Deployment that did not roll. Without the fingerprint those two failures
are identical from outside, which is why a rotation that silently did not take
is the hardest of these to find. Twelve hex characters of SHA-256 give away
nothing: confirming a token against it needs the token already, and deriving
one is a preimage search.

The same shape the core already logs for the JWT signing key, `"jwt_key":
"sha256:…"`, and for the same reason.

**A credential the container cannot use is refused at startup, by name.** Two
shapes reach a vendor as a `401` from a token that is correct where it came
from, and both are quoting accidents rather than wrong credentials: a value
wrapped in quotes — `NACRE_..._API_KEY="cf-token"` written where the quoting is
not removed, which a Kubernetes manifest value and a secret store round-tripping
JSON both do — and one carrying a line break or a non-ASCII character from a
paste. Neither is guessed at and neither is stripped: the refusal names the
variable, because a service that quietly repairs a credential hides the
deployment that produced it.

**Cloudflare has two credential types and only one of them works here.** An
**API Token** is sent as `Authorization: Bearer …`, which is what this adapter
sends. A **Global API Key** is a different scheme — `X-Auth-Email` plus
`X-Auth-Key` — and offering one as a bearer token is a `401` from a credential
that is perfectly valid elsewhere. Alongside that, the token needs `Account →
Workers AI` permission and must be scoped to the account in
`NACRE_EMBED_CLOUDFLARE_ACCOUNT`, which is the 32-character account **ID** and
not the account name.

A 429 is the other one worth knowing about in advance, because it is the failure
a deployment reaches *after* it works — the free Workers AI allocation is a
daily budget, and indexing spends it before a search asks for one more vector.

The adapter never puts a vendor's response body in either the reply or the log,
because a vendor's error can quote the input it rejected and the input is
document text. Its own message — the vendor's name and status — is all that
travels, and the core bounds it again on the way into a log.

**`voyage` has its own entry although its wire format is OpenAI's**, and the
reason is who asks for it. [Anthropic publishes no embeddings
API](#there-is-no-anthropic-vendor-and-there-cannot-be) and points at Voyage
instead, so "embeddings from Anthropic" resolves here — and a vendor reachable
only by knowing to type `https://api.voyageai.com/v1` under a different name is
one nobody finds. Naming the vendor is choosing the endpoint, exactly as it is
for `cloudflare` and `google`.

`_API_KEY` and `_API_KEY_FILE` together is refused rather than resolved by
precedence — two answers to one question leaves the losing one configured,
apparently in use, and ignored, which is the same rule `NACRE_JWT_SECRET` beside
a key reference gets.

Nothing here is seeded in `.env.example`, deliberately: a seeded route is this
repository choosing a vendor on your behalf, which is the one thing this whole
surface exists not to do.

**You may not need it — but read the next paragraph before deciding that.**
Anything already speaking OpenAI's contract works by pointing
`embedding_providers.endpoint` straight at it, and always has: a TEI or a vLLM
you run, an Ollama on your laptop, a colleague's server on the network.

**What the direct path cannot do is authenticate.** The request carries a
content-type and nothing else — no `Authorization` header — and there is
nowhere to put one, because `embedding_providers` has no column for a
credential and deliberately never will: a vendor key there would reach every
database dump, which is the whole reason the adapter is a sidecar rather than
a branch in the worker. So an endpoint pointed straight at OpenAI, Voyage,
Together or any other hosted vendor **cannot work**, however correct the URL
is, and this paragraph used to say the opposite by omission — with OpenAI named
in the vendor table directly above it. Somebody read it, did the thing it
implies, and got a `401` that explained none of this. The refusal now names the
cause; `modelEndpointRefused` is where it is written, and `lint:endpoint-errors`
keeps all three callers going through it.

So: **no credential wanted → point straight at it. Credential wanted → the
adapter, or a proxy.** LiteLLM in front is the documented alternative and needs
no code from this repository at all; the adapter exists because this repository
has twice chosen to own a small thing rather than take a dependency on the path
that reads other people's documents, and there is exactly one operation here.

### There is no `anthropic` vendor, and there cannot be

**Anthropic publishes no embeddings API and no reranking API.** Their own
documentation points at Voyage AI for embeddings, which is why `voyage` is in
the table above and `anthropic` is not.

This is stated rather than left as an absence because the absence is the
confusing part: Anthropic is the vendor most people using this product already
have a key for, and a missing route reads as an omission somebody will file a
bug about. It is not one. There is nothing to route to.

The same holds for reranking and takes two more vendors with it: **OpenAI,
Anthropic and Google publish no reranking API either.** `NACRE_RERANK_VENDOR`
refuses all three by name for that reason, rather than only listing the four
that work — a refusal that says "pick from this list" invites the reader to
assume their vendor was forgotten.

### Reranking through a vendor

The same sidecar answers **TEI's `/rerank`**, so a deployment with no GPU can
rerank without running a cross-encoder. Nothing in the core changes: point
`NACRE_RERANKER_ENDPOINT` at the adapter instead of at a TEI container.

```
NACRE_RERANK_VENDOR=cohere
NACRE_RERANK_MODEL=rerank-v3.5
NACRE_RERANK_COHERE_API_KEY_FILE=/run/secrets/cohere
```

and on the API and MCP processes:

```
NACRE_RERANKER_ENABLED=true
NACRE_RERANKER_ENDPOINT=http://embedding-adapter:8091
```

| `NACRE_RERANK_VENDOR` | Upstream | Credential |
|---|---|---|
| `cloudflare` | Workers AI | `NACRE_RERANK_CLOUDFLARE_API_KEY` or `NACRE_RERANK_CLOUDFLARE_API_KEY_FILE`, with `NACRE_RERANK_CLOUDFLARE_ACCOUNT` |
| `cohere` | Cohere Rerank | `NACRE_RERANK_COHERE_API_KEY` or `NACRE_RERANK_COHERE_API_KEY_FILE` |
| `jina` | Jina Reranker | `NACRE_RERANK_JINA_API_KEY` or `NACRE_RERANK_JINA_API_KEY_FILE` |
| `voyage` | Voyage Rerank | `NACRE_RERANK_VOYAGE_API_KEY` or `NACRE_RERANK_VOYAGE_API_KEY_FILE` |

**One reranker per adapter rather than a routing table**, and that asymmetry
with embeddings is forced rather than chosen. TEI's `/rerank` request carries a
query and its texts and **no model name** — a TEI container is one model — so
there is no routing key in the request to dispatch on. Inventing one would mean
changing the core's reranker client, which is the thing this service exists to
avoid. `NACRE_RERANK_MODEL` names the cross-encoder; setting one of the two
variables without the other is refused, since a vendor with no model is a guess
about which cross-encoder and a model with no vendor has nowhere to go.

The credentials are **separate from the embedding ones** even where the vendor
is the same. Reusing `NACRE_EMBED_VOYAGE_API_KEY` for `voyage` reranking would
mean a deployment that only reranks has to set an embedding variable, and the
two are independent jobs — an adapter with `NACRE_RERANK_VENDOR` set and no
`NACRE_EMBED_ROUTES` at all starts, serves `/rerank`, and refuses `/embeddings`
by name.

Three properties are worth knowing because each fails silently otherwise:

- **Scores are the vendors' normalized relevance, not TEI's raw logits.** Safe
  because the caller uses them to *order* an already-permitted candidate set and
  never as a threshold. `raw_scores` in the request is accepted and ignored,
  because there is no raw score to give.
- **Every candidate must come back scored.** The adapter refuses an answer that
  scores fewer inputs than it sent, naming the vendor and the counts. A vendor
  that truncated — honouring a `top_n` nobody sent — would otherwise leave the
  unscored candidates at the bottom of the results with no error anywhere.
- **A batch over 512 texts is refused rather than split.** Splitting embeddings
  is safe because each vector comes from one text; a reranker is not promised to
  be, and a vendor normalizing scores across the documents in one call would
  produce two sets that cannot be compared. That is a wrong *ordering* with no
  symptom. `NACRE_RERANK_CANDIDATES` is 50 by default, so the limit is far
  above anything a search sends.

Reranking stays **off unless configured** and still fails open: an unreachable
reranker degrades a search to fusion order with a counter and a log line, which
is the existing behaviour and is unchanged by the upstream being a vendor.

## Compose profiles

| Profile | Contains | For |
|---|---|---|
| `minimal` | api, mcp, worker, web, the migrate job, parser, postgres, qdrant, redis; embeddings via an external endpoint | pilot, laptop, no GPU |
| `full` | plus minio, embedder (TEI), reranker | typical deployment |
| `airgapped` | everything local; email/password sign-in; models pre-seeded | closed network |
| `hosted` | adds the embedding adapter | embeddings from a vendor's API rather than a local model |
| `demo` | minimal, plus a small English embedder (bge-small-en-v1.5) and a one-shot seed | seeing it work in two minutes, with a corpus and three logins already in it |

`demo` is the only profile that needs nothing configured — no embedding
endpoint, no `.env`. It brings a 33M-parameter model that answers on a laptop
CPU, indexes an example corpus across three layers, and creates three people
whose grants differ, so the same query returns three different answers. The
credentials are printed by the seed, because the API generates passwords and
refuses to accept one; `docker compose --profile demo logs demo-seed` has them.

It is a demonstration and not a deployment: the model is English-only, the
corpus is fiction, and resetting is `--profile demo down -v`. An installation
picks its own embedder, which is what every other profile is about.

The seed reads two variables of its own, and they are here because
`docker/demo/seed.sh` ships inside the image — `lint:config` reads it now for
the same reason it learned to read the Python sidecars, and found one of these
undocumented on the day it was taught to.

| Variable | Default | What it does |
|---|---|---|
| `NACRE_DEMO_EMAIL_DOMAIN` | `demo.local` | the domain the seeded identities live at, so they read as `engineer@demo.local`. A public stand that owns a domain sets it to that; a local demo has no use for one, and `.local` is obviously not deliverable, which is right for invented people. A domain and never a full address — the local parts are the seed's, and letting a deployment set those would make the credentials it prints unpredictable |
| `NACRE_VERSION` | unset | what the seed reports it ran against. Set by the image build; nothing depends on it |

**Profiles are additive, and that is the sentence this table was missing.** They
are not four deployments to choose between: `--profile` may be given more than
once, and each one adds its services to the set. A deployment that wants MinIO
*and* a hosted embedder names both —

```bash
docker compose --profile full --profile hosted up -d
```

— and the `hosted` row above says "adds" rather than "`minimal` plus" for that
reason. It described a whole deployment, which read as an alternative to the
others, and the combination is the ordinary case.

**A service in a profile you did not name is not touched, including one that is
running.** This is the part that costs an afternoon. `docker compose --profile
full up -d` on a deployment whose adapter came up earlier under `--profile
hosted` leaves that container exactly as it was — old image, old environment —
reports success, and says nothing about it, because Compose does not mention
services outside the profiles it was given. Everything else updates and one
thing silently does not.

**Changing a credential needs the container recreated, not restarted.** The
services here take their environment through `env_file`, which Compose reads
when it **creates** a container and bakes into it. `docker compose restart`
re-runs the same container with the same baked values and re-reads nothing; a
plain `up -d` recreates only if it decides the configuration changed, which
depending on the Compose version does not include the contents of an env file.
So after rotating a secret:

```bash
docker compose --profile full --profile hosted up -d --force-recreate embedding-adapter
```

The embedding adapter reports a fingerprint of each credential it loaded — never
the credential — in its first log line and in `GET /health`, so "did the new
token reach the container" is a question with an answer rather than a guess. See
["When the adapter answers 502"](#when-the-adapter-answers-502).

MinIO appears only in `full`, and that is a licensing decision as much as a
packaging one — see [licensing.md](./licensing.md).

**On arm64 the embedder and the reranker are the exception, and only those two.**
Text Embeddings Inference publishes no arm64 image, so `full` and `airgapped`
run those containers emulated on an Apple Silicon Mac or an arm64 node;
everything else in every profile — this repository's four images since 0.5.2,
Postgres, Qdrant, Redis, nginx, MinIO and Keycloak — is native.

Emulated only because `docker-compose.yml` names the platform. Without that key
a plain `docker compose --profile full up -d` on an arm64 host fails at the pull
with `no matching manifest for linux/arm64/v8` — there is no arm64 to resolve
and Compose asks for the host's — so `platform: linux/amd64` on those two
services is what turns a failure into an emulated container. On an amd64 host it
does nothing.

**There is one command, and it is the same on every platform:**

```bash
docker compose --profile minimal up -d
```

macOS or Linux, amd64 or arm64, with no flags, no `COMPOSE_FILE` and no second
file to select. That is a change: the two arm64-relevant keys — the `platform:`
above and `host.docker.internal` on the application services — lived in a
`docker-compose.apple-silicon.yml` overlay until recently, and both are harmless
where they are not needed, so the overlay bought a second file, a different
command on different machines, and a footgun (see [Local
overrides](#local-overrides)) in exchange for nothing.

The arrangement that avoids the emulation altogether is `minimal` with an
embedder on the host, and [apple-silicon.md](./apple-silicon.md) has it. That is
now a choice about speed rather than a different way of starting the stack.

**`airgapped` is airgapped only after two one-time steps, and the profile now
says so rather than implying it happens by itself.**

- The embedder and reranker are Text Embeddings Inference images pointed at
  `BAAI/bge-m3` and `BAAI/bge-reranker-base`. On a first boot those weights are
  fetched from the Hugging Face Hub — outbound traffic a closed network does not
  have. Populate the `models` volume once from a machine that does have it, then
  set `HF_HUB_OFFLINE=1` (the Compose file passes it through to both) so the
  containers use the cached weights and never reach for the network. With it set
  and the volume empty, they fail at startup rather than silently downloading,
  which is the behaviour an airgapped deployment wants.
- **Sign-in is email and password**, the built-in mechanism, not OIDC. The
  Keycloak container in this profile is a placeholder for the commercial `sso`
  module — the open core has no code path that accepts a token Keycloak issues,
  so nothing here consumes it. The earlier "local OIDC (Keycloak)" was a
  capability the open product does not have.

Three variables belong to the Compose file rather than to the product:
**`NACRE_API_HOST_PORT`** (default 8080), **`NACRE_MCP_HOST_PORT`** (default
8081) and **`NACRE_WEB_HOST_PORT`** (default 8082) are the host-side ports
`docker compose` publishes the API, the MCP transport and the admin UI's `web`
front-door on. They are read by Compose during interpolation — from the shell or
from `.env` — and never by `loadConfig`: inside the network the ports stay 8080,
8081 and 80 whatever these say, so probes, `PORT` and every in-network reference
are unaffected. They exist because a host with something already on one of those
ports should be a one-line `.env` entry, not an override file.

## The command line client

Two variables, and they are the only ones in this reference that no server
reads. `@nacre.work/cli` is something a person or a pipeline runs *against* an
installation rather than a process the installation starts, so nothing here
reaches `loadConfig` and setting either changes nothing about a deployment.

| Variable | Default | |
|---|---|---|
| `NACRE_API_URL` | — | the installation to talk to, e.g. `https://api.example` |
| `NACRE_TOKEN` | — | a service account key or an access token |

Both override the stored session in `~/.config/nacre/config.json`, which is what
`nacre login` writes at mode `0600`. That is the split they exist for: on a
laptop a person signs in and the file renews itself, and in CI there is no
terminal to sign in from and nothing that could write a renewed token down, so
the environment is the whole session.

`NACRE_TOKEN` set on its own is a complete session — the file's refresh token is
deliberately **not** paired with it. Renewing would produce a token with nowhere
to go, so carrying a second credential for it would buy nothing.

They are documented here rather than only in `nacre --help` because this is the
file that answers "what does `NACRE_*` mean", and a reader who finds twenty-six
of them here and two only in a binary's help text has been given a reference
with a hole in it. Finding that hole is what made `lint:config` discover its
readers instead of naming three files — see the note in
`scripts/check-config-docs.mjs`.

## Local overrides

`docker-compose.override.yml` is Compose's own mechanism for what one machine
wants and no other. It is loaded automatically, merged over
`docker-compose.yml`, and it is gitignored here, so it is a local fact rather
than a commit.

The case it is for is a service inside a profile you otherwise want. `full` is
api, mcp, worker, minio **and** the two Text Embeddings Inference containers; a
laptop with an embedder on the host wants the first four and neither of the last
two, and there is no profile for that because the arrangement is one person's.
Start them with no containers:

```yaml
# docker-compose.override.yml
services:
  embedder:
    scale: 0
  reranker:
    scale: 0
```

**`scale: 0` rather than moving them into a profile nobody names**, and the
difference is a check rather than a preference. `scripts/check-compose.mjs` pins
the exact service list of every profile and renders it with Compose's *default*
file resolution — which includes this file. A `profiles:` key changes that list,
so `pnpm lint:compose` would fail on the machine holding the override and
nowhere else, which is the worst kind of red. `scale: 0` leaves the service in
its profile: the rendered list is unchanged and only the container count
differs. It also removes those containers if they are already running, which a
profile change does not — a service outside the enabled profiles is one Compose
ignores, and an ignored emulated container is still an emulated container.

**Naming `COMPOSE_FILE` turns the automatic loading off**, which is why nothing
here does. The variable replaces Compose's default resolution entirely, so the
override file Compose would have picked up on its own is no longer picked up at
all — with no message, because nothing is missing as far as Compose is
concerned.

This is not hypothetical: `COMPOSE_FILE` was how an arm64 install used to select
`docker-compose.apple-silicon.yml`, so following the documented Apple Silicon
setup switched off an override the same person had written, silently. Folding
that overlay into `docker-compose.yml` removed the reason anybody had to set the
variable, and this paragraph is what is left of the trap.

If you set it anyway — a second machine-specific file, a compose file kept
outside the repository — the override has to be named too, and last:

```ini
COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml
```

A file named there and absent is a hard error naming the path, which is the
other half of why `.env.example` ships no such line: the override is gitignored,
a fresh clone has none, and a shipped default that refuses to start is worse
than one that starts two containers you did not want.

## Two origins, or one

`/.well-known/oauth-protected-resource` names a **resource identifier**, and
RFC 9728 has the client compare it against the URL it actually reached. The API
and the MCP transport serve one document, built once, so the two can never
disagree about the audience a token is bound to — which is right, and which
makes the identifier wrong for whichever of them is not at
`NACRE_CANONICAL_URL`.

Behind one origin — a proxy in front of both, which is what a real deployment
has — there is nothing to set. `docker compose up` is the other case: it
publishes 8080 and 8081 with nothing in front, so a client pointed at the MCP
port is told the resource is the API's URL and refuses to authenticate before it
sends a single request. That is not a misconfiguration the operator made; it is
the default shape.

`NACRE_MCP_CANONICAL_URL` on the **mcp** process is the answer for that shape:

```yaml
mcp:
  environment:
    NACRE_MCP_CANONICAL_URL: http://10.8.0.1:8081
```

It moves the discovery document and nothing else. What a token is checked
against is `NACRE_JWT_ISSUER` and `NACRE_JWT_AUDIENCE`, and **those stay
identical on both processes** — the MCP transport verifies what the API signed,
so a difference there is 401s on part of the traffic and not the rest.

`NACRE_MCP_ALLOWED_ORIGINS` is a comma-separated allow-list of browser origins.
Empty is the default and refuses every browser and no agent: validating `Origin`
is required of an MCP server to stop DNS rebinding — a page in somebody's
browser reaching a server on their network — and an agent sends no `Origin` at
all, so it is unaffected. Set it only if a browser talks to this transport
directly.

Naming an origin here does two things, and for a while it did only the first.
The transport stops refusing that origin, **and** it answers the CORS preflight
and returns `Access-Control-Allow-Origin` on every reply to it — without which a
browser discards a response it was allowed to receive. `WWW-Authenticate` is
exposed, because that header is where a browser client reads the RFC 9728
pointer that starts the OAuth flow; a client that cannot read it stops at
"unauthorized" with nowhere to go.

Credentials are never allowed. This transport authenticates with a bearer token
in a header and never with a cookie, so `Access-Control-Allow-Credentials` would
buy nothing and would let a page on an allowed origin act as whoever is signed
in there. With the list empty no header above is emitted at all and a preflight
is refused, which is exactly what a deployment that never sets it sees.

`NACRE_API_ALLOWED_ORIGINS` is the same list for the REST API, and empty by
default for the same reason: the admin console is served from the API's own
origin, so nothing has ever needed one. A **browser** MCP client does — it
registers and exchanges its authorization code at `/oauth/register` and
`/oauth/token`, both by `fetch` from a page on another origin, so without this
the walk stops after the `401` that starts it.

Two variables rather than one, because these are two processes with two
configurations and, on a split deployment, two hostnames: a single list would
admit an origin on a surface the operator did not mean to open. Both are read
by one implementation — `packages/core/cors.ts` — so they cannot disagree about
which headers a caller may read.

**`*` is refused at startup**, by name, on either list. Nothing here treats it
as a wildcard — an origin is admitted by exact match — so a `*` would be a list
that matches nothing while reading as one that opened the surface to everybody.
On an authorization boundary that is the dangerous direction to be wrong in.

## Health and observability

- `/v1/health` — liveness, touching no dependency.
- `/v1/ready` — readiness: postgres, qdrant, redis, and **schema**.
  `200 {status, checks}` or `503` with the same shape, so an orchestrator can
  read the status code and a human can read the body. Unauthenticated, like
  `/metrics`, because a probe has no credential to present — so it says which
  dependency is unhappy and never why.

  `schema` is the one that is not a dependency. It compares the migrations this
  build ships against `schema_migrations`, and is `false` while the database is
  **behind** — so a pod started before the migrator has run answers `503` and
  never enters rotation, rather than reporting ready and failing every request.
  A database that is *ahead* is `true`: that is the middle of a rolling upgrade
  and the old replica has to keep serving. The missing migration's name goes to
  the log, never into this response.

  It needs `SELECT` on `schema_migrations`, which migration `0022` grants to
  `nacre_app` — the ledger is created by the migrator, so before that the
  application role held no privilege on it at all and the check would have
  reported every correctly-split deployment as not ready.

  `s3` appears only when a deployment configured object storage, and then it is
  checked: ingest writes the bytes before it writes the row, so an unreachable
  bucket or a wrong credential is a surface that accepts nothing. A deployment
  without it reports no `s3` key rather than `true` — "not configured" and
  "configured and healthy" must not read the same.

  Not the embedder: that is an endpoint you supply, a search fails loudly
  without it, and making readiness depend on somebody else's uptime turns their
  outage into a rollout that never completes.
- `/metrics` — Prometheus. Unauthenticated by default, and carrying nothing
  that is not already a count: no document ids, no query text, no organization
  ids — organizations appear by slug, which is in the URL of every request that
  tenant makes anyway.

  **`NACRE_METRICS_TOKEN`** requires a bearer token on this path. Unset is the
  default, because requiring one would break every existing scrape config and
  because the default is right for the deployment this is designed around — the
  port is on an internal network. It stops being right the moment the API goes
  behind a public ingress without carving `/metrics` out, which is the situation
  the variable exists for. A wrong or absent token gets `404`, not `401`: a
  deployment hiding its metrics endpoint should not confirm it has one, and
  there is nothing to authenticate *into*, so a challenge would only say "keep
  guessing". Minimum 16 characters, or unset — a short token reads as protection
  and is a moment's guessing.

  **Collected values are reused for ten seconds.** The gauges below are database
  queries, one per organization, so without a bound whoever can reach the port
  decides how often the API queries every tenant's `documents` table, on the
  same pool the request path uses — a scrape loop is a denial of service that
  looks like monitoring. Ten seconds is shorter than any sensible scrape
  interval, so a real Prometheus never sees a cached value; it only collapses
  the excess. Concurrent scrapes share one collection rather than each starting
  their own.

  One query per organization. It was three — counts, tombstones, lag — each in
  its own `withOrg`, which on eighteen organizations measured 271 statements per
  scrape against 91 after they were merged. The lag half is gone entirely now.

Required metrics:

```
nacre_documents_total{org,status}
nacre_tombstones_pending_total{org}        # climbing means GC is losing
nacre_collections_retired_total{org}       # superseded collections still on disk
nacre_document_processing_age_seconds{org} # oldest in-flight doc; past the lease = worker wedged
nacre_search_duration_seconds              # target p95 < 200ms at 10M vectors
nacre_search_results_total
nacre_acl_denials_total{reason}
nacre_ingest_duration_seconds{stage}       # the accept stage; the worker has no registry
nacre_reindex_progress_ratio{layer}        # 0 to 1; absent for a layer never reindexed
nacre_auth_failures_total{kind}            # missing | jwt | service_key
nacre_rate_limit_unavailable_total{resource}  # requests let through with Redis down
```

`nacre_rate_limit_unavailable_total` is the one to alert on for the rate limiter,
because the limiter **fails open**: when Redis is unreachable the request is
allowed rather than refused, since a rate limit is availability protection and
not an authorization control. That is the right call and it is also invisible —
the request succeeds, so nothing else marks it. This counter is the mark. A
non-zero rate means the limits are not being enforced, on both surfaces (REST and
MCP share the limiter and the series).

`nacre_auth_failures_total` is labelled by the kind of credential presented and
**never by why it failed**. The `401` itself carries one message for every
reason — an expired token, a forged signature and a revoked service account key
are one answer, deliberately — and a `reason` label would hand that distinction
back through an endpoint that is unauthenticated by default.

It exists for key rotation. `kind="jwt"` is the series a rotation moves;
`kind="service_key"` staying flat across the same window is the check that it
touched only what it was meant to. Nothing here logs requests, so before this
there was no way to see either.

`nacre_acl_denials_total` counts what a denial looks like on each surface. On
ingest that is a refused layer. On search there is no `403` to count, by design
— invariant 4 makes an invisible layer indistinguishable from an absent one —
so zero permitted results is the denial, under `reason="search_empty"`.

`nacre_reindex_progress_ratio` carries one series per layer that has ever been
reindexed and none for the rest — a layer nobody has migrated has no progress to
report, and inventing a zero for it would make every layer in the installation
read "reindex started, gone nowhere". It reads 0 for the whole `copying` phase,
which computes no embeddings, and only moves during `embedding`.

`nacre_vectors_total{org}` is **not** exposed, and deliberately so rather than as
a gap left open. A per-organization vector count has no cheap source on the
scrape path: Postgres does not hold it, and asking Qdrant per organization on
every scrape is the shape of the per-tenant `/metrics` query this project already
treats as a denial of service dressed as monitoring. If a deployment needs the
number it reads it from Qdrant directly, out of band. The metric is off the
required set, not owed.

**The MCP server has its own `/metrics`**, on its own port, with its own
registry:

```
nacre_mcp_tool_duration_seconds{tool}
nacre_mcp_tool_calls_total{tool,result}
nacre_acl_denials_total{reason}           # the same name and reasons as REST
nacre_auth_failures_total{kind}           # likewise, so one dashboard adds up
```

Not the database gauges: those are one process's job, and a second exporter
publishing the same series would be two answers to one question. It honours
`NACRE_METRICS_TOKEN` on the same terms as the API's endpoint.

It recorded nothing at all before — no registry, no endpoint — so everything
above was true of REST and silent on the transport the product is actually for.
An agent's search was not slow or failing; it was absent.

The worker emits no metrics of any kind — it serves no port, and giving it one
would be a surface with its own authentication story for the sake of a checkbox.
What it does is visible through the API's gauges: `nacre_documents_total` by
status, `nacre_tombstones_pending_total` climbing when collection is losing, and
`nacre_document_processing_age_seconds` — the age of the oldest document a worker
is currently indexing, computed on the API's side from `documents.claimed_at`. A
worker wedged inside one document used to show up only in the log line that
stopped; it is a series here now, and one that climbs past `NACRE_INDEX_LEASE` is
a worker stuck or gone with the reaper not reclaiming its claim. It is absent
while nothing is in flight, the same as the reindex and retired-collection
gauges are silent about tenants with nothing to report.

**There is no propagation alert, and that is the change worth reading twice.**
`nacre_acl_propagation_lag_seconds` was here, described as "the only external
evidence that invariant I4 still holds", with `max(...) > 60` as the rule. It
measured how far the ACL tag cache had fallen behind — and no query ever read
that cache. Migration 0016 removed it.

I4 is now stronger and is not a metric. A revoked grant is reflected in the next
search because the permitted set is computed per request and the one cache in
front of it is keyed on the permission epoch, which every write to `grants`
moves. There is nothing asynchronous left to fall behind, so there is nothing to
watch — the evidence is the T11 cases in `acl-invariants`, checked on every run
rather than observed after the fact.

`nacre_tombstones_pending_total` is the gauge to alert on instead. It is the one
number that climbs when a background job has stopped working, and unlike the
lag gauge it corresponds to something a query can observe: a tombstoned
document's vectors are still on disk until it drains.

The value is the age of the oldest document whose `acl_version` is behind its
organization's `groups_version`. Deleted documents are excluded — invariant I5
already keeps them out of every answer, and counting them would mean an unpurged
tombstone pages someone forever about a propagation problem that does not exist.

OpenTelemetry tracing runs end to end: `request_id` from HTTP is tied to
`trace_id` and lands in the audit log, so an auditor's question and a latency
investigation resolve against the same identifier.

## Backups

See [architecture.md](./architecture.md#backups). The ordering matters: vectors
are rebuilt **from Postgres**, never the other way round — the payload of a
point carries identifiers and flags and not one line of text, so a Qdrant backup
saves recomputing embeddings and never substitutes for a Postgres one.

Where the document bytes are depends on whether you configured object storage,
and the backup has one part or two because of it.

**Without `NACRE_S3_*`** — the default — bytes live in `documents.source_ref`.
That is what makes the Postgres backup larger than it looks, and it means there
is no separate object store to restore.

**With it**, `source_ref` holds an object key and `source_type` is `s3`. The
bucket then belongs in the backup: Postgres knows which key each document has
and nothing else does, so losing the bucket loses the originals even though
every row survives. Restore Postgres first and the bucket second — the chain is
still driven by Postgres, and a bucket restored alone names nothing.

Either way, vectors are rebuilt from what is in Postgres and Qdrant is never
the source.

`NACRE_S3_*` is validated at startup as a group: all four of endpoint, bucket,
access key and secret key, or none of them. Half is refused rather than
accepted, because an endpoint with no credential parses fine and fails later, as
a deployment that accepts documents and cannot store them.

**The bucket has to exist, and on `--profile full` it is created for you.** A
complete configuration is not a usable one: MinIO does not create a bucket
because a client named it, and neither does the client. Ingest writes the bytes
before the row, so a missing bucket is a `NoSuchBucket` on the first document
and the caller sees `500` — the reason is in the API's log and nowhere else.
`/v1/ready` reports `s3: false` first, because it HEADs the bucket rather than
the endpoint. Compose's `full` profile runs a `minio-init` one-shot that creates
`NACRE_S3_BUCKET` beside MinIO; pointing these variables at any other S3 makes
the bucket yours to create.

**Binary ingest requires it.** A PDF's bytes have exactly one home — the
bucket; `documents.source_ref` is text and stays text. A PDF uploaded to a
deployment without `NACRE_S3_*` is refused at the edge with a `400` naming
these variables, so the caller learns on the request rather than from a
`failed` row. Text-only deployments are unaffected: without object storage
everything behaves exactly as before.
