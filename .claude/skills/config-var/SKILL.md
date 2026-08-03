---
name: config-var
description: Use when adding, renaming, or removing an environment variable, changing startup configuration validation, adding a Compose profile or service, or adding a Prometheus metric. Triggers on "environment variable", "NACRE_", "config", "docker compose", "profile", "metrics", "healthcheck", "readiness".
---

# Adding configuration

Contract: `docs/config.md`.

## Rules

1. **Prefix `NACRE_`.** No exceptions, including in the parser sidecar.
2. **Validate the whole configuration at startup and exit if anything required
   is missing or contradictory.** Not on first use — at boot.
3. **No silent defaults for secrets or URLs.** A default that quietly points at
   localhost is how a production deployment talks to nothing and reports
   success. Defaults are fine for tunables (`NACRE_ACL_CACHE_TTL=60`); they are
   not fine for anything naming a host or carrying a credential.
4. **Secrets are references into a secret store** where the platform allows it —
   `NACRE_JWT_PRIVATE_KEY_REF=file:///run/secrets/…`, not the key itself.
   Plaintext values are for the development profile and nowhere else.

## Every new variable touches four places

- the implementation's startup validation
- `.env.example` — development values only, never a real credential
- `docs/config.md`
- the Compose profile, if a service reads it

A variable that exists in code but not in `docs/config.md` is invisible to the
person deploying this, which for a self-hosted product is the person who
matters most.

## Compose profiles

| Profile | Contains | For |
|---|---|---|
| `minimal` | api, worker, postgres, qdrant, redis, parser | pilot, laptop, no GPU |
| `full` | plus minio, embedder, reranker | typical deployment |
| `airgapped` | everything local, zero outbound traffic | closed network |

**`minimal` must stay runnable on a laptop without a GPU**, and `airgapped` must
make no outbound connection at all — that includes telemetry, update checks, and
model downloads. If a feature cannot work without reaching the internet, it is
off by default and says so.

MinIO belongs only to `full`, and that is a licensing decision as much as a
packaging one: it is AGPLv3, and an AGPL component on the default path turns a
short legal review into a long one. See `docs/licensing.md`.

## Metrics

New behavior that can silently degrade needs a metric before it needs a feature
flag. The required set is in `docs/config.md`.

`nacre_tombstones_pending_total` is the one with an alert on it: it is the only
external evidence that a background pass — the collector that reclaims a deleted
document's vectors — is still running. (Invariant 4 no longer needs a metric:
migration 0016 removed the propagation cache, so a revoked grant is reflected on
the next request and there is no lag to measure — the old
`nacre_acl_propagation_lag_seconds` went with it.) If your change can affect a
background sweep, check that this gauge still measures what its name claims.

## Health endpoints

- `/v1/health` — liveness, touching **no** dependency. A health check that calls
  Postgres turns one slow database into a cascading restart loop.
- `/v1/ready` — readiness: postgres, qdrant, s3, embedder.
