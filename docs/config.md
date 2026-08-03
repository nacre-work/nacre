# Configuration and deployment

## Environment variables

Secrets are passed as references into a secret store wherever that is possible.
Plaintext values are acceptable in the development profile and nowhere else.

```ini
# ─── base ───
NACRE_ENV=production                   # development | production
NACRE_CANONICAL_URL=https://nacre.work # OAuth issuer, well-known base, links in configs
NACRE_LOG_LEVEL=info
NACRE_LOG_FORMAT=json

# ─── storage ───
NACRE_PG_URL=postgres://nacre:***@postgres:5432/nacre
NACRE_PG_POOL_MAX=20
NACRE_QDRANT_URL=http://qdrant:6333
NACRE_QDRANT_API_KEY=
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
NACRE_RERANKER_ENDPOINT=http://reranker:80
NACRE_RERANKER_ENABLED=false          # true needs an endpoint; minimal has none
NACRE_RERANK_CANDIDATES=50            # fetched from the index, cut to top_k after scoring
NACRE_PARSER_ENDPOINT=http://parser:8090

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
applied and `0006` failed. With `BYPASSRLS` on the same role, all eighteen
applied and `nacre_app` remained unable to create a table, unable to bypass a
policy, and holding only `INSERT, SELECT` on `audit_events`.

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
value every token is bound to, and `NACRE_OAUTH_AUTHORIZATION_SERVER` when a
deployment has an identity provider in front of it. **Absent by default, and
deliberately not pointed at ourselves**: Nacre is a resource server, not an
authorization server — sign-in is email and password, a service account key is
a random string matched against a hash, and neither is an OAuth grant. A client
sent to us for a token endpoint would find nothing, which is the original 404
one redirect further along.

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

## Compose profiles

| Profile | Contains | For |
|---|---|---|
| `minimal` | api, mcp, worker, the migrate job, parser, postgres, qdrant, redis; embeddings via an external endpoint | pilot, laptop, no GPU |
| `full` | plus minio, embedder (TEI), reranker | typical deployment |
| `airgapped` | everything local; email/password sign-in; models pre-seeded | closed network |

MinIO appears only in `full`, and that is a licensing decision as much as a
packaging one — see [licensing.md](./licensing.md).

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

Two variables belong to the Compose file rather than to the product:
**`NACRE_API_HOST_PORT`** (default 8080) and **`NACRE_MCP_HOST_PORT`** (default
8081) are the host-side ports `docker compose` publishes the two surfaces on.
They are read by Compose during interpolation — from the shell or from `.env` —
and never by `loadConfig`: inside the network the ports stay 8080 and 8081
whatever these say, so probes, `PORT` and every in-network reference are
unaffected. They exist because a host with something already on 8080 or 8081
should be a one-line `.env` entry, not an override file.

## Health and observability

- `/v1/health` — liveness, touching no dependency.
- `/v1/ready` — readiness: postgres, qdrant, redis. `200 {status, checks}` or
  `503` with the same shape, so an orchestrator can read the status code and a
  human can read the body. Unauthenticated, like `/metrics`, because a probe has
  no credential to present — so it says which dependency is unhappy and never
  why.

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
