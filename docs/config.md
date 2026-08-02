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
NACRE_DEFAULT_EMBEDDING_ENDPOINT=http://embedder:8080
NACRE_DEFAULT_EMBEDDING_MODEL=bge-m3
NACRE_DEFAULT_EMBEDDING_DIM=1024
NACRE_RERANKER_ENDPOINT=http://reranker:8081
NACRE_RERANKER_ENABLED=false          # true needs an endpoint; minimal has none
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
NACRE_MAX_DOCUMENT_BYTES=52428800

# ─── audit ───
NACRE_AUDIT_RETENTION_DAYS=400
NACRE_AUDIT_QUERY_TEXT=false           # true stores query text verbatim
NACRE_AUDIT_SIEM_WEBHOOK=
```

**`NACRE_PG_URL` must not name a superuser, and should not name the role that
owns the tables.** Row-level security does not apply to a superuser at all, and
applies to the owner only where the table is forced. Connecting as either turns
the tenant-isolation policies into decoration. Migrations run as the owner;
the application runs as `nacre_app`.

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
- A plaintext or localhost `NACRE_CANONICAL_URL` in production. It is the OAuth
  issuer, it goes into every token ever issued, and over plaintext it is also
  what an attacker rewrites. Silent defaults for secrets and
URLs are not allowed — a default that quietly points at localhost is how a
production deployment ends up talking to nothing and reporting success.

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
- `/v1/ready` — readiness: postgres, qdrant, s3, embedder.
- `/metrics` — Prometheus.

Required metrics:

```
nacre_search_duration_seconds{quantile}    # target p95 < 200ms at 10M vectors
nacre_search_results_total{layer}
nacre_acl_propagation_lag_seconds{org}     # target < 60
nacre_acl_denials_total{reason}
nacre_ingest_duration_seconds{stage}
nacre_documents_total{org,status}
nacre_reindex_progress_ratio{layer}
nacre_vectors_total{org}
nacre_tombstones_pending_total{org}        # climbing means GC is losing
```

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
