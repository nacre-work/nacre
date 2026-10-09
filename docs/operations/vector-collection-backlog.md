# The `nacre_tombstones_pending_total` alert

**A rising value means the background collector has stopped working.** It is the
only metric that shows the worker's background jobs have stalled: deleted
documents accumulate their points in the index and nothing removes them.

The threshold depends on how much you delete. Alert not on the absolute number
but on it growing and not falling:

```
increase(nacre_tombstones_pending_total[30m]) > 0
  and delta(nacre_tombstones_pending_total[30m]) >= 0
```

> **A growing backlog does not mean anybody is reading more than they should.** A
> deleted document leaves the results immediately — `deleted = false` is in every
> query, and the flag in the payload is set *before* the row is written to
> Postgres, in exactly that order. The danger here is Qdrant's disk and memory,
> not access.

---

## What this metric no longer stands in for

This page replaces a runbook for `nacre_acl_propagation_lag_seconds`, which
called that metric "the only external evidence that invariant 4 holds".

**That metric no longer exists, and invariant 4 is stronger for it.** It
measured how far the ACL tag cache in the payload had fallen behind — a cache
that no query read: `buildFilter` never emitted a clause on the tags. Migration
`0016` removed the whole subsystem.

Revoking a grant now shows up in the next search, not "within the SLA": the
permitted set is computed from `grants` on every request, and the only cache in
front of it is keyed on `organizations.groups_version`, which triggers move on
every write to `grants`. There is nothing to wait for, so there is nothing to
measure.

This is verified by tests rather than by observation — the T11 cases in
`acl-invariants`, against a live database, on every run. To check it by hand:

```sql
-- The version must move on any write to grants.
SELECT groups_version FROM organizations WHERE slug = '<slug>';
-- ... issue or revoke a grant ...
SELECT groups_version FROM organizations WHERE slug = '<slug>';
```

If it did not move, that is an incident, and it is about the triggers from
migration `0005`, not about the background loop.

---

## Diagnosis, in order

The SQL below runs as the owning role, through `$NACRE_PG_URL_OWNER` and not as
`nacre_app`: `documents` is under `FORCE ROW LEVEL SECURITY`, and its policy
reads `app.current_org`, which a `psql` session never sets — so a query across
organizations as `nacre_app` raises
`unrecognized configuration parameter "app.current_org"` instead of answering.

### 1. Is the worker alive at all?

```bash
docker compose ps worker
docker compose logs worker --since 5m | tail -30
```

Look for `{"msg":"collected",...}` lines. A pass writes one only when it purged
or failed at least one document, so none in several minutes while the backlog
grows means either that the loop is not turning, or that every tombstone in the
backlog is still inside `NACRE_GC_GRACE` (step 3). `collect pass failed` is the
line for a pass that could not run at all, which in practice means the query
that claims the next batch from Postgres failed; the error it carries says why.

**Silence after one successful line is a separate symptom.** That is what an
unreleased lease looks like: the document is claimed, the work is done,
`sweep_claimed_at` is not cleared, and the next pass cannot claim the same row
until `NACRE_INDEX_LEASE` expires. Exactly this defect was found on a live
stand.

```sql
SELECT count(*) FROM documents
 WHERE sweep_claimed_at IS NOT NULL
   AND sweep_claimed_at < now() - interval '5 minutes';
```

Non-zero and not falling means rows are claimed and not released.

### 2. Does Qdrant answer?

```bash
curl -s localhost:8080/v1/ready | jq
```

Garbage collection is a `delete` of points in Qdrant. An unreachable Qdrant
means every document in every pass fails and the backlog grows linearly. A
failure there is per document: the log has one `purge failed` line for each,
with its `document_id` and the error, and then the pass's own `collected` line
with `purged` at zero and a non-zero `failed`. The documents stay in the queue
and are tried again on the next pass.

### 3. Is the queue bigger than the loop can keep up with?

```sql
SELECT count(*) FROM documents
 WHERE deleted_at IS NOT NULL AND vectors_purged_at IS NULL;
```

The collector takes 20 documents at a time, no more often than once a minute,
and speeds itself up while the batch keeps coming back full. A mass deletion
produces a backlog that drains in tens of minutes — that is normal, and the
alert should clear on its own.

If it does not drain, look at `NACRE_GC_GRACE`: points are not touched until that
long has passed since the deletion. A value of a day means the backlog cannot
start shrinking any sooner, by definition.

### 4. Does the collection exist at all?

```bash
docker compose run --rm --no-deps -T api sh -c \
  'wget -qO- --header "api-key: $NACRE_QDRANT_API_KEY" "$NACRE_QDRANT_URL/collections"' \
  | jq '.result.collections[].name'
```

Qdrant is not reachable from the host — the shipped Compose file gives it
`expose` and no `ports` — so the request is made from inside the `api` image,
which has BusyBox `wget` and carries `NACRE_QDRANT_URL` and
`NACRE_QDRANT_API_KEY`. In Kubernetes, run the same `sh -c` line through
`kubectl exec` in an api pod; the chart sets both variables there.

A document whose collection was deleted by hand is a `Not Found` on every pass,
forever — a `purge failed` line naming it each time. The collector counts that
neither as a success nor as the end of the world: it logs it and moves on, so
one such row does not hold up the rest. But it never leaves the backlog.

---

## What not to do

**Do not delete points in Qdrant by hand.** The row in Postgres stays at
`vectors_purged_at IS NULL`, the metric goes on counting it, and the collector
goes on trying to claim it. The problem turns from "the disk is full" into "the
alert is firing and nobody can tell why".

**Do not reach for `NACRE_GC_GRACE`: raising it cannot quiet this alert.** The
gauge counts every tombstone whose vectors are not yet purged, whether or not it
is still inside the grace period, so a longer grace only makes the backlog larger
and slower to drain — the growth the alert fires on gets worse, not better.

Nor is the grace a recovery window. There is no undelete: no route restores a
deleted document, and sending one again through ingest brings it back by
indexing what was sent, whether or not its old points were purged. What the
grace does keep is the bytes of an `s3` document — the collector removes the
object from the bucket in the same step that purges the points — so until then
an operator can still fetch them from the bucket by hand. An `inline` document's
bytes stay in its Postgres row after the purge regardless.

---

## The limits of this document

**The worker exposes no metrics of its own** — it listens on no port, and opening
one for a liveness check would mean standing up another surface with its own
authentication story. Everything visible about it from outside is exported by the
API.

There used to be a real limit here: a live worker that stalled inside one
document showed up neither in `nacre_documents_total` nor in
`nacre_tombstones_pending_total` — only in the log, as a line that stopped
arriving. That limit is closed. `nacre_document_processing_age_seconds` is the
age of the oldest document currently being indexed, per organization; the API
computes it from `documents.claimed_at`, and the series exists only while
something is in flight and disappears once the document is through. A series
that has passed `NACRE_INDEX_LEASE` is a worker stuck in a document, or one that
went away without the reaper reclaiming its claim; either way, the document
behind it is not being indexed.

```promql
max(nacre_document_processing_age_seconds) > NACRE_INDEX_LEASE
```

The log stays the place where you see *why* it stalled; the metric is the place
where you see *that* it stalled, without waiting for somebody to open the log.
