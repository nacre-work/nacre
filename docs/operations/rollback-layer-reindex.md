# Rolling back a layer reindex

A reindex moves a layer onto a different embedding model. What exactly to roll
back depends on how far it got, and that is not a formality: before the pointer
switch and after it, a rollback is done in different ways and costs different
amounts.

How the procedure itself works is in
[Reindexing on a model change](../architecture.md#reindexing-on-a-model-change).
This page covers only what to do when it has to be cancelled.

Two things about the commands below. **Every SQL statement runs as the owning
role**, through `$NACRE_PG_URL_OWNER` and not as `nacre_app`: `layers` and
`documents` are under `FORCE ROW LEVEL SECURITY`, and their policy reads
`app.current_org`, which a `psql` session never sets — so as `nacre_app` they
raise `unrecognized configuration parameter "app.current_org"` instead of
answering. And **Qdrant is reached from inside the `api` image**, because the
shipped Compose file gives it `expose` and no `ports`: the image has `node` and
carries `NACRE_QDRANT_URL` and `NACRE_QDRANT_API_KEY`, and the chart sets both on
the api pods as well.

---

## Step 1. Find out where it stands

```bash
curl -s localhost:8080/v1/layers/$LAYER/reindex -H "authorization: Bearer $TOKEN" | jq
```

```sql
SELECT l.slug,
       l.vector_name,
       p.name AS provider,
       l.reindex_state ->> 'status'             AS status,
       l.reindex_state ->> 'phase'              AS phase,
       l.reindex_state ->> 'shadow_vector'      AS shadow,
       l.reindex_state ->> 'failed'             AS failed,
       l.reindex_state ->> 'error'              AS error,
       l.reindex_state -> 'check' ->> 'passed'  AS check_passed,
       l.reindex_state ->> 'copy_claimed_at'    AS copy_claimed_at
  FROM layers l JOIN embedding_providers p ON p.id = l.provider_id
 WHERE l.org_id = :org AND l.deleted_at IS NULL;
```

And where the organization's pointer stands:

```sql
SELECT slug, vector_collection FROM organizations WHERE deleted_at IS NULL;
```

`status` is one of `running`, `failed` and `complete`, and `phase` is `copying`
or `embedding`. A reindex starts in `copying` when the organization's collection
lacks the new slot — Qdrant cannot add a named vector to a live collection, so a
new collection has to be built with it — and straight in `embedding` when an
earlier reindex already left the slot there. Only a copy moves the pointer, and
it moves it at the end of the copy, not at the end of the reindex.

| `status` / `phase` | The organization's pointer | Rollback |
|---|---|---|
| `running` / `copying` | not moved | [Case A](#case-a-running--copying) |
| `running` / `embedding` | names a collection that has the new slot | [Case B](#case-b-running--embedding) |
| `failed` / `copying` | not moved | [Case C1](#c1-failed--copying-the-copy-failed) |
| `failed` / `embedding` | names a collection that has the new slot | [Case C2](#c2-failed--embedding-the-embedding-or-the-recall-gate-failed) |
| `complete` | as above, and the layer is on the new model | [Case D](#case-d-complete) |

---

## Case A. `running` / `copying`

The worker is building `<collection>_<shadow_vector>` — the current
collection's name with the new slot's name appended — and copying every point
into it. The pointer **has not moved yet**, search runs against the old
collection, and nothing has changed for any client. There is one copy per
organization at a time: the API refuses to start a second while one is copying.

A side effect worth knowing: **ingest for this organization is on hold**. While
any of its layers is `running`/`copying`, the worker claims none of the
organization's `pending` documents and runs no embedding pass for any of its
layers — the copy scrolls the old collection with no snapshot, so a vector
written behind the scroll would never reach the new one. The rows wait in
`pending`; that is a queue, not an error.

The copy is held under a **claim** — `copy_claim` and `copy_claimed_at` inside
`reindex_state` — with `NACRE_INDEX_LEASE` as its lease. The worker renews it
from the copy's own progress, at most every 30 seconds, and `finishCopy` checks
it before it moves the pointer. A `copy_claimed_at` older than the lease means
the worker doing the copy died; another worker claims it and starts the copy
again from the beginning, because a copy is rebuilt, never resumed.

Rollback:

```sql
UPDATE layers SET reindex_state = NULL
 WHERE org_id = :org AND id = :layer
   AND reindex_state ->> 'status' = 'running'
   AND reindex_state ->> 'phase'  = 'copying';
```

Clearing the state takes the claim away, and the worker gives up without marking
anything:

- at its next renewal it stops copying and logs `abandoning copy: the claim
  moved to another worker`;
- if the last page lands first, `finishCopy` finds no claim, refuses to move the
  pointer, and the worker logs `copy finished by another worker`.

Either way the pointer stays where it was, and nothing writes `failed` into the
state you cleared. Ingest resumes on the worker's next tick.

The half-built target is referenced by nothing, and nothing removes it. Delete
it once the worker has logged one of the two lines above (deleting it earlier is
harmless too: the copy's next write fails, the worker logs
`collection copy failed`, finds the claim gone and marks nothing):

```bash
docker compose run --rm --no-deps -T api node -e "fetch(process.env.NACRE_QDRANT_URL + '/collections/' + process.argv[1], { method: 'DELETE', headers: { 'api-key': process.env.NACRE_QDRANT_API_KEY ?? '' } }).then(async (r) => console.log(r.status, await r.text()))" "${COLLECTION}_${SHADOW}"
```

`$COLLECTION` is the organization's `vector_collection` and `$SHADOW` the
layer's `shadow_vector`. BusyBox `wget` in that image cannot send a `DELETE`,
which is why this one is `node`'s `fetch`. Qdrant answers `200` with
`"result": false` for a collection that is already gone.

## Case B. `running` / `embedding`

The organization's collection has the new slot — either the copy finished and
moved the pointer, or the slot was already there and no copy was needed — and
the worker is embedding the layer's documents into it: ten per pass, a pass
every five seconds, sooner while passes come back full. The layer is still on
its old model: `vector_name` and `provider_id` switch together only at the very
end, in the same statement that applies the recall gate.

**If this reindex copied, do not move the pointer back.** The new collection is
the same points plus the new slot; it is live and correct, and everything
ingested since the move is only in it. Moving the pointer back to the old
collection loses those documents silently.

The rollback is to cancel only the embedding:

```sql
UPDATE layers SET reindex_state = NULL
 WHERE org_id = :org AND id = :layer
   AND reindex_state ->> 'status' = 'running';

UPDATE documents SET reindexed_vector = NULL
 WHERE org_id = :org AND layer_id = :layer;
```

Both statements, and the second is the one that matters. `reindexed_vector` is
the marker "this document carries the shadow vector", and the switch is decided
by which documents lack it. Left over from a cancelled run, it counts as done
for the next reindex onto the same model. Since 0.29.4 a re-ingest clears it,
because it replaces the points the vector was on, and a pass marks a document
only if its points are still the ones it wrote to — so the leftover is limited
to documents nobody has touched since. Run the `documents` statement once more
after ten seconds: a pass already in flight when you cancelled still marks the
documents it was working on, up to ten of them.

The layer stays on its model, and search did not change for a second. What stays
behind is the vectors already written into the new slot: nothing reclaims them
automatically — the slot sweep takes only the slot a *completed* reindex moved
away from — so they cost memory on the points that have them and answer no
search. A later reindex onto the same model writes over them.

## Case C. `failed`

A `failed` reindex is never retried by the worker, and it blocks nothing: the
API refuses to start a reindex only while one is `running`, and ingest is held
only while a copy is `running`. What it leaves depends on its phase. The reason
is in `reindex_state ->> 'error'` — up to 500 characters of the error as the
worker caught it.

### C1. `failed` / `copying`: the copy failed

The copy itself threw — most often a Qdrant error — and the worker, still
holding the claim, marked the reindex `failed`. It fails on the first error;
there is no retry bound here. The pointer **has not moved**, search and ingest
run against the old collection as before, and the half-built
`<collection>_<shadow_vector>` is still in Qdrant.

Fix the cause and start again with the same call:

```bash
curl -s -X POST localhost:8080/v1/layers/$LAYER/reindex \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"provider_id\":\"$PROVIDER\"}"
```

The new copy deletes the half-built target and builds it again under the same
name.

Or give up on it: clear the state, and delete the target with the command from
case A. The copy embeds nothing, so no document carries a marker from it.

```sql
UPDATE layers SET reindex_state = NULL
 WHERE org_id = :org AND id = :layer
   AND reindex_state ->> 'status' = 'failed'
   AND reindex_state ->> 'phase'  = 'copying';
```

### C2. `failed` / `embedding`: the embedding or the recall gate failed

The state is the same as case B — the pointer names a collection with the new
slot, the layer is on its old model, search works — and the worker has stopped.
Two things end a reindex here:

- **The embedding pass.** `failed` in the state counts documents that failed
  with no success in between; a pass that re-embeds anything resets it to zero.
  At 20 the reindex is marked `failed`, with the last error in `error` — with a
  batch of ten, that can be two passes. Most often the error is an unreachable
  embedder (`ECONNREFUSED`) or a dimension that does not match the one declared
  on the provider.
- **The recall gate.** `check.passed` is `false`: the mean recall over the
  layer's reference queries was below the floor, or `check.unresolved` lists
  reference entries naming documents that are not there. The shadow vectors
  stay so the numbers can be looked at.

Fix the cause and start again with the same `POST` as in C1. The slot is
already there, so it starts in `embedding`, and documents whose marker names
this slot are not embedded again.

Or give up on it:

```sql
UPDATE layers SET reindex_state = NULL
 WHERE org_id = :org AND id = :layer
   AND reindex_state ->> 'status' = 'failed'
   AND reindex_state ->> 'phase'  = 'embedding';

UPDATE documents SET reindexed_vector = NULL
 WHERE org_id = :org AND layer_id = :layer;
```

The second statement for the same reason as in case B.

## Case D. `complete`

The layer has moved: `vector_name` and `provider_id` already point to the new
model, and search over this layer goes through the new slot. There is no cheap
rollback — only a choice of what to pay with.

### D1. Reindex back (the default)

```bash
curl -s -X POST localhost:8080/v1/layers/$LAYER/reindex \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"provider_id\":\"$OLD_PROVIDER\"}"
```

There is no copy: the old slot is still declared in the collection, so the
phase goes straight to `embedding`. The recomputation costs as much as the move
did, and search works the whole time. Nothing is lost.

This is the right answer almost always.

> **The worker reclaims the old slot's data after
> `NACRE_COLLECTION_RETENTION_DAYS`** — the same window as for collections, and
> for the same reason. It does not affect D1: D1 recomputes the embeddings
> anyway, and the slot itself never leaves the collection's schema — Qdrant
> cannot remove it from there, and that limitation is what the whole migration
> design rests on.
>
> A temptation worth resisting while the data is still there: simply moving
> `vector_name` back, without recomputing. It looks like a free rollback and is
> not one. First, `provider_id` would have to be moved back in the same
> statement — otherwise the layer declares one model and queries with another,
> and Qdrant rejects the organization's **whole** query, not one layer. Second,
> documents ingested after the move carry only the new vector: they are not in
> the old slot, and they silently drop out of results. That is why this option is
> not offered here, and never was.
>
> How many slots are still waiting to be reclaimed:
>
> ```sql
> SELECT o.slug, l.slug, l.reindex_state ->> 'previous_vector',
>        l.reindex_state ->> 'finished_at'
>   FROM layers l JOIN organizations o ON o.id = l.org_id
>  WHERE l.reindex_state ? 'previous_vector';
> ```

### D2. Move the pointer back to the old collection

Instant, and **with data loss**. The old collection is frozen at the moment the
pointer moved away from it: nothing ingested, re-tagged, deleted or reindexed
since is reflected in it. Only a reindex that copied has an old collection to go
back to, and only within `NACRE_COLLECTION_RETENTION_DAYS` of the move.

Do this only when the new collection is damaged, and only wholesale — the
pointer belongs to the organization, not to a layer, so the rollback takes every
other layer back with it.

First record when the pointer moved. That is the row `finishCopy` wrote for the
old collection, in the same transaction that moved the pointer:

```sql
SELECT name, retired_at FROM retired_collections
 WHERE org_id = :org AND name = :old_collection;
```

Then move it back:

```sql
BEGIN;
UPDATE organizations SET vector_collection = :old_collection WHERE id = :org;
UPDATE layers SET vector_name = :old_vector, provider_id = :old_provider,
                  reindex_state = NULL
 WHERE org_id = :org AND id = :layer;
UPDATE documents SET reindexed_vector = NULL WHERE org_id = :org;
COMMIT;
```

**`vector_name` and `provider_id` together, in one statement.** Out of step,
they mean the layer names one slot while its query is embedded by another model;
Qdrant rejects such a query whole, and search fails **across the entire
organization**, not for one layer — every model is a branch of one query. Check
search after this transaction without fail; "it should work" is not a check.

Then bring the old collection up to date. Re-sending the documents does not do
it — ingest requeues a document only when its content or metadata changed, or it
had failed or been deleted — so this is the repair the worker itself runs after a
copy, pointed the other way. `:moved_at` and `$MOVED_AT` are the `retired_at`
read above, `$ORG_ID` is the organization's id, and `$OLD_COLLECTION` is the
collection the pointer now names again.
Every write to a document row sets `updated_at`, so this finds everything that
changed since:

```sql
-- Documents indexed, re-tagged or re-sent since the move: index them again,
-- into the collection the pointer now names.
UPDATE documents
   SET status = 'pending', attempts = 0, error = NULL, updated_at = now()
 WHERE org_id = :org AND deleted_at IS NULL
   AND status = 'indexed'
   AND updated_at >= :moved_at;
```

```bash
# Documents deleted, or purged, since the move: back into the collector's queue.
# -q keeps psql's "UPDATE n" line out of the file, which would otherwise be read as an id.
psql "$NACRE_PG_URL_OWNER" -qtA -c "
UPDATE documents
   SET vectors_purged_at = NULL, sweep_claimed_at = NULL
 WHERE org_id = '$ORG_ID' AND deleted_at IS NOT NULL
   AND (deleted_at >= '$MOVED_AT'
        OR (vectors_purged_at IS NOT NULL AND vectors_purged_at >= '$MOVED_AT'))
RETURNING id" > deleted-ids.txt
```

**That second list is urgent.** A document deleted after the move still has
`deleted: false` on its points in the old collection, so it is back in search
results the moment the pointer moves — and the collector removes it only once
`NACRE_GC_GRACE` has passed since the deletion, on its own clock. Flag those
points now:

```bash
docker compose run --rm --no-deps -T api node --input-type=module -e '
let text = ""
for await (const chunk of process.stdin) text += chunk
const ids = text.split("\n").filter(Boolean)
const r = await fetch(process.env.NACRE_QDRANT_URL + "/collections/" + process.argv[1] + "/points/payload?wait=true", {
  method: "POST",
  headers: { "content-type": "application/json", "api-key": process.env.NACRE_QDRANT_API_KEY ?? "" },
  body: JSON.stringify({ payload: { deleted: true }, filter: { must: [{ key: "doc_id", match: { any: ids } }] } }),
})
console.log(r.status, await r.text(), ids.length, "documents")
' "$OLD_COLLECTION" < deleted-ids.txt
```

That is the same payload write a delete makes. The collector then removes the
points physically on its own clock.

The collection you moved away from is recorded nowhere — `retired_collections`
only ever names a collection a successful copy replaced — so nothing reclaims
it. Delete it by hand, with the command from case A, once you are sure you will
not go back to it.

---

## Checks after any rollback

```sql
SELECT l.slug, l.vector_name, p.model, p.dimensions
  FROM layers l JOIN embedding_providers p ON p.id = l.provider_id
 WHERE l.org_id = :org AND l.deleted_at IS NULL;
```

`vector_name` must be exactly `v_{model}_{dim}` of its own provider — for
**every** row. Then:

```bash
# search across the whole organization
curl -s -X POST localhost:8080/v1/search -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"query":"…","top_k":10}' | jq '.items | length'

# and each layer on its own
curl -s -X POST localhost:8080/v1/search -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"query":"…","top_k":10,"layers":["<slug>"]}' | jq '.items | length'
```

If the organization-wide search answers 500, `vector_name` and `provider_id`
have drifted apart somewhere in the organization. The response body says only
that the request could not be completed, and carries a `request_id` (also in the
`x-request-id` header); the API's `request failed` log line for that
`request_id` names the layer — `layer <id> names vector … but its provider is …`:

```bash
docker compose logs api | grep '<request_id>'
```

An empty answer for one layer while the organization-wide answer is not empty
means that layer's points are not in the collection the pointer looks at.

And ingest, because it takes a different path:

```bash
curl -s -X POST localhost:8080/v1/documents -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"layer":"<slug>","external_id":"rollback-check","content":"…"}'
sleep 10
psql "$NACRE_PG_URL_OWNER" -tAc "SELECT status, attempts, error FROM documents WHERE external_id='rollback-check'"
```

`indexed` is the answer you want. Both failures below are treated as possibly
transient, so the row first goes back to `pending` with `error` set and is
retried with backoff; it becomes `failed` only after `NACRE_INDEX_MAX_ATTEMPTS`.
Read `error`, not `status`:

- `Not existing vector name` — the collection has no slot for the layer's model.
- `Vector dimension error` — the layer names a slot of one model, and its
  provider belongs to another.

---

## Orphaned collections

Every reindex that copies leaves a collection behind: the one the pointer moved
away from, which is the return point for D2. The worker now reclaims it — on the
hourly retention clock, after `NACRE_COLLECTION_RETENTION_DAYS` (7 by default).
Until then D2 works, and after that it does not, which is the whole point of the
window.

How many are still held is visible in the metric:

```bash
curl -s localhost:8080/metrics | grep nacre_collections_retired_total
```

A number that never falls means the worker is not getting this far — not that
there are more collections.

**Nothing needs deleting by hand in the ordinary case, and the old way was
dangerous.** It went like this: take every collection Qdrant has, subtract the
ones something refers to, and treat the rest as orphaned. That description also
fits **the target of a copy that is running right now**: it is already created,
it is filling up, and the pointer has not moved to it yet. Running that cleanup
in the middle of a migration deletes the migration itself.

The worker picks its candidates differently. There is a `retired_collections`
table, and a row is written to it **by the same transaction** that moves the
pointer — so a collection nobody has moved away from yet can never get there at
all. And the pointer is checked again before every delete: if D2 moved back onto
the old collection, the row simply disappears and the collection stays.

```sql
SELECT o.slug, r.name, r.retired_at FROM retired_collections r
  JOIN organizations o ON o.id = r.org_id ORDER BY r.retired_at;
```

**Three collections stay manual**, because none of them has a row: the target
of a copy that was cancelled (case A) or that failed (case C1, unless you
restart it, which rebuilds the target under the same name), and the collection a
D2 moved away from. The worker will not touch them — the rule is deliberately
narrow: "delete only what a successful migration replaced". Before deleting one,
make sure no copy is running and nothing points at it:

```bash
psql "$NACRE_PG_URL_OWNER" -tAc "SELECT reindex_state->>'status', reindex_state->>'phase' FROM layers WHERE deleted_at IS NULL AND reindex_state IS NOT NULL"
psql "$NACRE_PG_URL_OWNER" -tAc "SELECT slug FROM organizations WHERE vector_collection = '$NAME'"
docker compose run --rm --no-deps -T api node -e "fetch(process.env.NACRE_QDRANT_URL + '/collections/' + process.argv[1], { method: 'DELETE', headers: { 'api-key': process.env.NACRE_QDRANT_API_KEY ?? '' } }).then(async (r) => console.log(r.status, await r.text()))" "$NAME"
```

Each collection holds a full copy of the organization's vectors. At a customer's
volume, that is disk that grew with every migration.
