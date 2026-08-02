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
# One of these two. NACRE_JWT_SECRET is symmetric, is what the code reads
# today, and is required — there is no default, because a default signing key is
# one anybody reading the source can forge tokens with. Asymmetric keys through
# NACRE_JWT_PRIVATE_KEY_REF are specified below and not implemented yet.
NACRE_JWT_SECRET=                      # >= 32 bytes; a secret-store reference in production
NACRE_JWT_PRIVATE_KEY_REF=file:///run/secrets/jwt_ed25519   # not implemented yet
NACRE_JWT_ISSUER=https://api.nacre.work   # must match NACRE_CANONICAL_URL in production
NACRE_JWT_AUDIENCE=nacre
NACRE_ACCESS_TOKEN_TTL=900
NACRE_REFRESH_TOKEN_TTL=2592000
NACRE_OAUTH_CIMD_ENABLED=true
NACRE_OAUTH_DCR_ENABLED=false          # legacy; enable deliberately or not at all
NACRE_EMA_ENABLED=false                # ID-JAG, commercial module
NACRE_EMA_TRUSTED_ISSUERS=

# ─── permissions ───
NACRE_ACL_CACHE_TTL=60
NACRE_ACL_PROPAGATION_SLA=60           # alert above this
NACRE_ACL_TAG_HASH_BYTES=8

# ─── the background worker ───
NACRE_GC_GRACE=3600                    # tombstone to physical purge
NACRE_INDEX_LEASE=900                  # a claim older than this is abandoned
NACRE_INDEX_MAX_ATTEMPTS=5             # then the document is failed, not requeued

# ─── limits ───
NACRE_RATE_SEARCH_PER_MIN=60
NACRE_RATE_INGEST_PER_HOUR=600
NACRE_RATE_LOGIN_PER_15MIN=10          # per email address, not per organization
NACRE_MAX_DOCUMENT_BYTES=52428800

# ─── audit ───
NACRE_AUDIT_RETENTION_DAYS=400         # >= 30; the floor is not a tunable
NACRE_AUDIT_QUERY_TEXT=false           # true stores query text verbatim
NACRE_AUDIT_SIEM_WEBHOOK=
```

**`NACRE_PG_URL` must not name a superuser, and should not name the role that
owns the tables.** Row-level security does not apply to a superuser at all, and
applies to the owner only where the table is forced. Connecting as either turns
the tenant-isolation policies into decoration. Migrations run as the owner;
the application runs as `nacre_app`.

### Three roles, and what each is for

| Role | Used by | Row-level security |
|---|---|---|
| the owner | migrations only | applies (tables are `FORCE`d) |
| `nacre_app` | the API and the MCP server | applies |
| `nacre_worker` | the worker's queue only | **bypassed** |

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

- `NACRE_ACL_CACHE_TTL` longer than `NACRE_ACL_PROPAGATION_SLA`. The cache
  would still be serving a revoked grant after the SLA it promises, while
  `nacre_acl_propagation_lag_seconds` reported compliance.
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

These parse, and the code reads none of them. Listed rather than removed,
because each is in the contract and will be built to it — but an operator
should know that setting one changes nothing today:

| Variable | What it would do |
|---|---|
| `NACRE_LOG_LEVEL`, `NACRE_LOG_FORMAT` | all logging is structured JSON at one level |
| `NACRE_AUDIT_QUERY_TEXT` | query text is never written, with or without it |
| `NACRE_ACL_CACHE_TTL` | the resolver cache is written and not wired in, so every search recomputes the group closure. Safe — it errs towards recomputing — and slower than it should be |
| `NACRE_S3_*`, `NACRE_PRESIGN_TTL` | object storage is not wired; document bodies live in Postgres |
| `NACRE_OAUTH_*`, `NACRE_EMA_*` | OAuth discovery, DCR and EMA are not built |
| `NACRE_AUDIT_SIEM_WEBHOOK` | SIEM export is a commercial module and is not written |

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

Neither is urgent and neither blocks anything, so a pass that fails is logged
and retried an hour later. They fail independently: a refused audit prune does
not stop token expiry.

Two variables are **refused** rather than ignored, because ignoring them would
silently overrule a decision about isolation:

- `NACRE_VECTOR_TENANCY=shared` — every collection is named per organization and
  no code path shares one. Accepting it would give you a single-collection
  deployment that believes it is isolated.
- `NACRE_ACL_TAG_HASH_BYTES` other than 8 — the width is fixed in the code that
  writes and matches tags, so setting it changes the collision probability you
  think you have and nothing else.

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

## Compose profiles

| Profile | Contains | For |
|---|---|---|
| `minimal` | api, worker, postgres, qdrant, redis, parser; embeddings via an external endpoint | pilot, laptop, no GPU |
| `full` | plus minio, embedder (TEI), reranker | typical deployment |
| `airgapped` | everything local, zero outbound traffic, local OIDC (Keycloak) | closed network |

MinIO appears only in `full`, and that is a licensing decision as much as a
packaging one — see [licensing.md](./licensing.md).

## Health and observability

- `/v1/health` — liveness, touching no dependency.
- `/v1/ready` — readiness: postgres, qdrant, redis. `200 {status, checks}` or
  `503` with the same shape, so an orchestrator can read the status code and a
  human can read the body. Unauthenticated, like `/metrics`, because a probe has
  no credential to present — so it says which dependency is unhappy and never
  why.

  Not s3, which nothing in the tree reads yet, and not the embedder: that is an
  endpoint you supply, a search fails loudly without it, and making readiness
  depend on somebody else's uptime turns their outage into a rollout that never
  completes.
- `/metrics` — Prometheus.

Required metrics:

```
nacre_acl_propagation_lag_seconds{org}     # target < 60
nacre_documents_total{org,status}
nacre_tombstones_pending_total{org}        # climbing means GC is losing
nacre_search_duration_seconds              # target p95 < 200ms at 10M vectors
nacre_search_results_total
nacre_acl_denials_total{reason}
nacre_ingest_duration_seconds{stage}       # the accept stage; the worker has no registry
```

`nacre_acl_denials_total` counts what a denial looks like on each surface. On
ingest that is a refused layer. On search there is no `403` to count, by design
— invariant 4 makes an invisible layer indistinguishable from an absent one —
so zero permitted results is the denial, under `reason="search_empty"`.

Specified and not registered at all, both tied to reindexing, which is not
built: `nacre_reindex_progress_ratio{layer}`, `nacre_vectors_total{org}`.

The worker emits no metrics of any kind — it serves no port. Its only external
signal is the propagation gauge above, which the API exports.

`nacre_acl_propagation_lag_seconds` is the one to alert on. It is the only
external evidence that invariant I4 still holds.

```
max(nacre_acl_propagation_lag_seconds) > 60
```

Per organization rather than one aggregate, and the reason is not
presentational: a single worst-across-tenants number lets one neglected tenant
pin the gauge and hide every other tenant behind it, and when the alert fires it
does not say who. `max()` is the same alert and does not depend on how many
tenants exist.

Every live organization reports a value on every scrape, zero included. An
absent series and a zero one mean "not being measured" and "caught up", and on
this metric those must not look alike.

The value is the age of the oldest document whose `acl_version` is behind its
organization's `groups_version`. Deleted documents are excluded — invariant I5
already keeps them out of every answer, and counting them would mean an unpurged
tombstone pages someone forever about a propagation problem that does not exist.

OpenTelemetry tracing runs end to end: `request_id` from HTTP is tied to
`trace_id` and lands in the audit log, so an auditor's question and a latency
investigation resolve against the same identifier.

## Backups

See [architecture.md](./architecture.md#backups). The ordering matters:
vectors are rebuilt from Postgres and S3, never the other way round.
