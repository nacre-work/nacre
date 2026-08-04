# Upgrading

What to do when a release comes out. The procedure is the same every time; what
changes is the per-version section at the bottom, and that is the part to read
first.

Pre-1.0, so **any `0.x` release may break something** — see
[SECURITY.md](../SECURITY.md). Security fixes ship only for the latest `0.x`, so
a deployment that stays behind stops receiving them. There is no long-term
branch to sit on yet.

## What a release is

A version is a string that every publishable `packages/*/package.json` agrees
on. Merging that agreement to `main` **is** the release — there is no tag to
push and no button to press. The pipeline publishes to npm first and writes the
`v{version}` tag and the GitHub release afterwards, so a tag that exists is a
tag whose artifacts exist.

What comes out of one release:

| Artifact | Where |
|---|---|
| `@nacre.work/core`, `@nacre.work/api`, `@nacre.work/mcp`, `@nacre.work/sdk` | npm, at the same version |
| `ghcr.io/nacre-work/nacre:{version}` and `:latest` | api, mcp, worker and the migrator — one image, four entry points |
| `ghcr.io/nacre-work/nacre-parser:{version}` and `:latest` | the Python sidecar |

`@nacre.work/worker` and `@nacre.work/admin` are `private` and deliberately not
on the registry: the worker is reached through the image's entry point and the
admin UI is a static bundle the `web` front door serves, so neither is something
an application installs. `@nacre.work/sdk` is the one an application does — it
moves with the rest, and a client older than the API is fine for anything the
contract did not change.

Commercial modules are released separately, from `nacre-enterprise`, as tarballs
on a GitHub Release there. They declare the core as a **peer** dependency at a
range — so the core and the modules move together, and a core outside that range
is a refusal at install time rather than a subtle failure at runtime.

## The short version

```bash
# Compose
git pull                              # or edit the image tag you pin
docker compose --profile full pull
docker compose --profile full up -d   # migrate runs first; api/mcp/worker wait
```

```bash
# Helm
helm upgrade nacre nacre/nacre -f values.yaml --set image.tag=0.4.0
# the migration Job is a pre-upgrade hook; it completes before any pod is replaced
```

Then read [the checks](#after) below. If either command's migration step fails,
**stop** — the section on [when a migration fails](#when-a-migration-fails) is
the one that matters, and starting the new code anyway is the mistake this
document exists to prevent.

## Migrations run first, and nothing checks that they did

Both deployment shapes enforce the order structurally:

- **Compose** — `migrate` is a one-shot service in every profile, and api, mcp
  and worker each carry `condition: service_completed_successfully` on it. It is
  a separate service rather than a step inside the API on purpose: three
  replicas racing to migrate means two of them report a failure that is not one.
- **Helm** — the migration Job is annotated `helm.sh/hook: pre-install,pre-upgrade`
  at `hook-weight: "-5"`, so it runs and completes before any Deployment is
  updated. `hook-delete-policy: before-hook-creation` removes the previous Job so
  an upgrade is not blocked by an immutable object; a **failed** Job is
  deliberately kept, because `kubectl logs` on it is the whole diagnosis.

Outside those two shapes the order is yours to enforce, and there is now one
safety net:

> **`/v1/ready` refuses while the schema is behind the image.** It compares the
> migrations this build ships against `schema_migrations` and reports
> `schema: false` — so a pod started against an unmigrated database is `503`
> and never enters rotation, instead of reporting ready and failing every
> request. Under an orchestrator that is the difference between a rollout that
> halts and one that replaces working pods with broken ones.

A database that is **ahead** stays ready, which is the middle of a rolling
upgrade: the migrator has run for the newer build and the old replica has to
keep serving. Only what the running build ships and the database lacks counts.

The missing migration's name goes to the log and never into the response —
`/v1/ready` is unauthenticated, and a probe does not need to be told which
migration a deployment is missing.

This is a check, not a handshake: it says the schema is at least as new as the
code, and nothing stops you starting an old build against a new schema. The
per-version notes below say which releases that is safe for.

## What the migrator does

`node packages/core/dist/migrate-main.js`, the same image as everything else.

- **Forward-only. There is no down path** — no `--down`, no revert file, no
  generated inverse. Getting back to a previous schema is a restore, which is
  why [rolling back](#rolling-back) is a section about backups rather than about
  a command.
- **Idempotent.** Every already-recorded file is skipped; a re-run on an
  up-to-date database applies nothing and prints
  `{"msg":"migrations complete","applied":0,...}`.
- **Each migration and its ledger row commit together.** A failure rolls that
  one back and stops, so the database is never left holding a migration the
  ledger does not know about.
- **An applied migration cannot be edited.** The text is checksummed; changing a
  file that has run anywhere is refused by name, because the databases that
  already ran the old text would never receive the change.
- **`lock_timeout` is 10 s per migration**, so a migration needing an
  `ACCESS EXCLUSIVE` lock waits behind a long-running transaction for ten
  seconds and then gives up rather than queueing behind it and blocking every
  reader in the meantime. A `55P03` is not a broken migration — it is a lock it
  could not get, and re-running once the holder is gone is the whole remedy.
  `statement_timeout` is deliberately not set: a migration that legitimately
  takes minutes should be allowed to.

### The role, and why a wrong one only bites at upgrade time

The migrator connects as the role in `NACRE_PG_URL`, and that role must be a
**superuser or hold `BYPASSRLS`**. Several migrations read tenant tables; every
tenant table is `FORCE ROW LEVEL SECURITY`, which applies the policy to the
table's *owner* too, and the policy reads `app.current_org` — unset during a
migration.

The migrator refuses up front, naming the provisioning it needs. It is worth
knowing exactly when that refusal happens:

> **The privilege check runs only when there is something to apply.** A re-run
> against an up-to-date database is a no-op whatever role it connects as. So a
> deployment provisioned with the wrong role can migrate cleanly for months and
> fail on the first release that adds a migration.

If you are seeing that refusal for the first time during an upgrade, nothing is
broken and nothing has been half-applied — the check is before the first
statement. Provision the role and re-run:

```sql
ALTER ROLE <the role in NACRE_PG_URL> BYPASSRLS;
CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;              -- if it does not exist
GRANT nacre_worker TO <the role in NACRE_PG_URL> WITH ADMIN OPTION;
```

`WITH ADMIN OPTION` is required and plain membership is not: migration `0008`
grants `nacre_worker` onward to `nacre_app`, and only a member holding ADMIN may
do that.

This is **not** the role the application connects as. The three roles and what
each may do are in [config.md](./config.md); the short form is owner → migrations
only, `nacre_app` → API and MCP with RLS applying, `nacre_worker` → the worker's
queue. In Helm the Job takes `postgres.migrations` and the workloads take
`postgres`, and the chart refuses if the Job is enabled and the second is unset.
Deployments with one role for both set `reuseApplicationCredential=true`
explicitly — it is an opt-in, never a fallback.

### When a migration fails

1. Read the message. It names the migration and says whether it was rolled back.
2. `55P03` — a lock it could not get. Find the holder
   (`SELECT * FROM pg_stat_activity WHERE state <> 'idle'`), let it finish,
   re-run. Nothing was applied.
3. The privilege refusal — provision the role above and re-run. Nothing was
   applied.
4. Anything else — the failing migration is rolled back, the ones before it are
   committed and recorded. **Do not start the new code.** The previous version's
   code against a partially-migrated schema is the state with the fewest
   guarantees. Roll the image tag back to the running version, which is safe as
   long as the migrations that did apply are additive, and open an issue with
   the message.

In Helm the failed Job is kept on purpose; `kubectl logs job/<release>-migrate`
is the message. `backoffLimit` is 3 and there is no `activeDeadlineSeconds`, so
a genuinely slow migration is not killed for being slow.

## Rolling back

**Rolling the schema back is a restore, not a command.** Take the backup
described in the restore runbook before an upgrade, not after it goes wrong.

Rolling the *code* back while leaving the schema forward is safe **only** where
every migration in between was additive. This is a per-release fact and it is in
the per-version notes below; the shape to look for is a migration that drops a
column, tightens a `CHECK` or a unique constraint, or adds a `RESTRICTIVE` RLS
policy. Old code meets those as errors, not as missing features.

Three things move on a clock rather than on your command, and each closes a door
behind it:

- **`NACRE_COLLECTION_RETENTION_DAYS`** (default 7) is a *rollback window*, not
  a tidiness delay. The cheap way back from a layer reindex is moving
  `organizations.vector_collection` to the previous collection, and that works
  only while the previous collection still exists. The worker also reclaims the
  superseded vector slot inside the surviving collection on the same window, and
  that half is not reversible. See the reindex rollback runbook for the four
  states.
- **`NACRE_GC_GRACE`** (default 3600) is how long a deleted document's points
  survive before the collector purges them. A code rollback during a purge
  backlog is fine; the purge itself is not undone.
- **`NACRE_AUDIT_RETENTION_DAYS`** (default 400, floor 30) prunes the access
  log hourly. Deletion is irreversible and the retention floor is refused at
  startup rather than clamped.

## Mixed versions during the rollout

In Helm, api and mcp roll normally, so **two versions of the API answer requests
at the same time** for the length of the rollout. That is fine for an additive
release and is the thing to think about for one that changes a response shape —
a client can see both.

The worker uses `strategy: Recreate` deliberately: a rolling update would
briefly run two versions claiming from one queue.

In Compose there is no rollout — `up -d` replaces containers.

## After

```bash
curl -fsS localhost:8080/v1/health          # liveness, touches no dependency
curl -fsS localhost:8080/v1/ready           # postgres, qdrant, redis, s3
docker compose logs migrate | tail -1       # {"msg":"migrations complete",...}
```

Then drive one real thing rather than trusting the checks: a search that returns
a known document, and an ingest that reaches `indexed`. Both surfaces —
`/v1/search` and the MCP tool — because they are two code paths and a release
has broken one of them before.

`/v1/ready` returning 200 now covers the schema as well as the dependencies,
which is most of what used to make it weak. It still cannot tell you that a
release behaves the way you expect — that is what driving one real search and
one real ingest is for.

---

## Per-version notes

Each section says what the version asked of an operator. A release that asked
nothing says so.

### Unreleased

**`/v1/ready` now reports the schema.** A pod on a database this build's
migrations have not reached answers `503` rather than reporting ready and
failing per request. Nothing to do — but if a readiness probe starts failing
right after an upgrade with every dependency healthy, this is what it is telling
you, and `migrate` is the answer.

Migration `0022` grants the application role `SELECT` on `schema_migrations`,
which is what makes that check possible: the ledger is created by the migrator
and `nacre_app` held no privilege on it at all. Read-only, and it is not tenant
data.

Migration `0021` adds `created_at` to `groups` and `group_members`. It
**rewrites both tables** — `now()` is volatile, so the column is not a
metadata-only add — under an `ACCESS EXCLUSIVE` lock bounded by the 10 s
`lock_timeout`. On a large directory sync that is the one migration so far worth
scheduling rather than running at any moment.

Additive for old code. `/v1/users`, `/v1/groups` and `DELETE /v1/layers/{id}`
are new endpoints; nothing existing changes shape.

The `full` Compose profile gains a `minio-init` one-shot that creates the
bucket. api and worker depend on it with `required: false`, so the other
profiles are unaffected.

### 0.4.0 — binary ingest

- **New parser dependency, and the pin is a security decision.** `pypdf` is
  pinned exactly, at a version chosen for its DoS fixes, because it runs
  attacker-supplied bytes. A deployment building the sidecar itself must take
  the pin rather than a range.
- **A PDF upload requires object storage.** With `NACRE_S3_*` unset the API
  refuses a binary upload on the request, naming the variables — so `s3.enabled`
  stopped being only a question of how much you store. Text-only deployments are
  unaffected and remain the default.
- Migration `0020` adds `documents.content_type` with a default. Additive.
- No new environment variables.

### 0.3.0 — breaking

The one release so far that removes things.

- **The ACL tag cache is gone.** Migration `0016` drops
  `documents.acl_version` and `documents.acl_tagged_at`. Code from 0.2.x reads
  and writes those columns, so **0.2.x cannot run against a 0.3.0 schema** —
  this is the upgrade to take a backup before.
- **Variables removed**: `NACRE_ACL_PROPAGATION_SLA` and
  `NACRE_ACL_TAG_HASH_BYTES`. The `nacre_acl_propagation_lag_seconds` metric and
  its alert are gone with them; the replacement alert watches
  `nacre_tombstones_pending_total`.
- **Variables added**: `NACRE_MODULES`, `NACRE_REINDEX_MIN_RECALL`.
- `NACRE_S3_*` moved to commented-out in `.env.example` — setting
  `NACRE_S3_ENDPOINT` is what turns object storage on.
- Migration `0017` rewrites any `users.role = 'workspace_admin'` to `member` and
  narrows the CHECK. `0018` deletes duplicate `group_members` rows before
  replacing the unique constraint. `0019` adds `RESTRICTIVE` write policies on
  `embedding_providers`. All three refuse writes that the previous version
  allowed.
- **The `BYPASSRLS` requirement shipped here**, with the up-front refusal. This
  is the change most likely to stop an existing upgrade job that had been
  working — see [the role](#the-role-and-why-a-wrong-one-only-bites-at-upgrade-time).
- The `web` front door (nginx serving the admin UI and proxying `/v1`) was added
  to Compose.

### 0.2.0 — object storage wired

- **New variable**: `NACRE_COLLECTION_RETENTION_DAYS` (default 7).
- **`NACRE_S3_*` reaches configuration validation for the first time.** The
  `minio` service had existed in the `full` profile since 0.1.0 and was talking
  to nobody. From here a wrong endpoint or a missing credential is a **startup
  refusal**, and the four values are validated as a group — all four or none. A
  deployment that had them set to something approximate finds out at boot.
- Migration `0014` adds `retired_collections`. Additive.
- Backups gained a second part: with object storage on, Postgres alone no longer
  restores a working deployment.

### 0.1.0

First release.
