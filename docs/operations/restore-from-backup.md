# Restoring from a backup

**Postgres → S3 → Qdrant.** Vectors are restored from Postgres; the reverse
does not hold.

The order is not negotiable. Postgres is the source of truth: it holds chunk
text, permissions, layers and the pointer to the collection. Qdrant holds only
vectors and the payload the filter reads — no text and no grants. So Postgres is
restored from the backup, and Qdrant is **rebuilt**.

**Every `psql` on this page connects as the owning role, through
`$NACRE_PG_URL_OWNER`, and not as `nacre_app`.** The tenant tables —
`documents`, `layers`, `embedding_providers` and the rest — are under
`FORCE ROW LEVEL SECURITY`, and their policy reads `app.current_org`, which a
`psql` session never sets. As `nacre_app` these queries therefore raise
`unrecognized configuration parameter "app.current_org"` instead of answering.
The owning role holds `BYPASSRLS` and reads across organizations — see
[Three roles, and what each is for](../config.md#three-roles-and-what-each-is-for).
In the shipped Compose stack `NACRE_PG_URL` connects as a superuser, so there the
two URLs are the same.

> **How many parts the backup has depends on the deployment, and that has to be
> settled before you start.**
>
> ```bash
> psql "$NACRE_PG_URL_OWNER" -tAc "SELECT source_type, count(*) FROM documents WHERE deleted_at IS NULL GROUP BY 1"
> ```
>
> **No `s3` rows** — there are two parts: Postgres and Qdrant. Document bytes
> live in Postgres itself, in `documents.source_ref` for `inline` and as a URL
> for `url`. That inflates the Postgres backup, and it means there is no separate
> object store to restore. Step 2a below is skipped.
>
> Since 0.4.0 the answer to that question is more and more often "yes" whether
> or not anybody chose it: a PDF can be uploaded since 0.4.0, and its bytes have
> nowhere to live but the bucket — `source_ref` is text and stays text. So a
> deployment that has accepted even one PDF has three parts, however it stores
> text documents.
>
> **There are `s3` rows** — there are three parts, and **the bucket has to be
> restored too**. `source_ref` then holds the object key, and only Postgres knows
> which key belongs to which document: a bucket restored on its own names
> nothing, and rows restored without the bucket survive with their originals
> lost. Documents restored without the bucket cannot be reindexed — the worker
> fails every one of them with "object … is missing from the bucket", and that is
> correct: an empty document quietly taking the place of the real one would
> remove its content from every answer while reporting success.
>
> To check that the variables were read at all: since 0.2.0 `loadConfig` refuses
> half the block — all four of `NACRE_S3_ENDPOINT`, `NACRE_S3_BUCKET`,
> `NACRE_S3_ACCESS_KEY`, `NACRE_S3_SECRET_KEY`, or none. A process that came up
> has read its S3 configuration.

---

## What is lost and what is not

| | Where it lives | If lost |
|---|---|---|
| Document and chunk text | Postgres | cannot be recovered from anywhere |
| Permissions, layers, organizations | Postgres | cannot be recovered from anywhere |
| `organizations.vector_collection` | Postgres | see step 3 — the most common mistake |
| Source bytes, `source_type='inline'` | Postgres | cannot be recovered from anywhere |
| Source bytes, `source_type='s3'` | the bucket | cannot be recovered from anywhere; the row in Postgres survives the loss and goes on naming a missing object |
| Vectors | Qdrant | rebuilt from Postgres |
| TOTP secrets | Postgres, sealed with `NACRE_2FA_KEY` | the rows survive a restore and do not open without the same key |
| WebAuthn keys | Postgres, a public key and a counter | survive a restore whole: there is nothing to seal and no key for them |

A row with `source_type='s3'` is the only thing in this table that is lost
**partially**: the document stays in listings, in permissions and in search over
the vectors already built, and disappears only when somebody tries to reindex or
download it. That is why a lost bucket does not look like an outage until the
first reindex.

**The second-factor key is a third piece, and it is not in the backup.** Since
0.18.0 `user_second_factors` stores the TOTP secret sealed with `NACRE_2FA_KEY`,
and the key itself lives in the secret store, not in the database. A restored
Postgres with a *different* key is an installation where everybody who enabled
TOTP cannot sign in, and the refusal looks like a wrong code rather than a
message about keys. The backup of the key lives where the backup of the signing
key lives, and it is checked the same way: restore it somewhere aside and
confirm that a code from the app is accepted. The recovery codes issued at
enrolment are what a person has in place of the key.

**Since 0.19.0 that is true of TOTP only.** WebAuthn is the second kind of
factor, and nothing seals it: the database holds a public key and a counter,
from which no signature can be produced, so `NACRE_2FA_KEY` has nothing to do
with them and a restore without it does not break them. What does break them is
a change of `NACRE_CANONICAL_URL`: the relying party is taken from its **host**,
and a key registered under one name does not work under another — the browser
refuses before any request is made. A restore under a different name is a
restore without second factors, and no key repairs that.

**Postgres cannot be restored from Qdrant.** A point's payload holds `org_id`,
`layer_id`, `doc_id`, `chunk_id`, `ordinal`, `deleted` and metadata under
`meta.` — identifiers and flags, not a single line of text. A Qdrant backup is
useful only to avoid recomputing embeddings; it never replaces a Postgres
backup.

---

## Step 1. Stop writes

```bash
docker compose stop worker api mcp
```

The worker, the garbage collector and the ingest path write to Qdrant. A
restore with the worker running is a race in which the collection being rebuilt
receives points from documents that are not yet in the restored Postgres.

## Step 2. Restore Postgres

The procedure is [Restoring](../backup.md#restoring) in the backup guide, and
the role is the part that is specific to Nacre. On a new cluster the roles go
back first, because `pg_dump` does not carry them and the dump's `GRANT`s name
them. Then the dump goes back as the owning role, because it carries table
ownership, row-level security policies and grants, and `nacre_app` cannot create
a table:

```bash
# Only on a new cluster: the roles, from pg_dumpall --roles-only.
psql --file=roles.sql "$ADMIN_PG_URL"

pg_restore --dbname="$NACRE_PG_URL_OWNER" --clean --if-exists nacre-YYYY-MM-DD.dump
```

Point-in-time recovery of the whole cluster works too; it brings the roles back
with everything else.

Check that the migrations are in place and that there are as many as the image
ships:

```bash
psql "$NACRE_PG_URL_OWNER" -c "SELECT count(*) FROM schema_migrations;"
docker compose run --rm migrate   # idempotent, brings it up to the current version
```

A backup older than the latest migration is fine: `migrate` brings it up. A
backup **newer** than the image is not: there is nothing to roll migrations back
with, because the schema is forward-only.

## Step 2a. Restore the bucket

Only if the step above found documents with `source_type='s3'`. The order is
after Postgres: the key names come from it, so there is nothing to check the
restored bucket against until the database is up.

```bash
psql "$NACRE_PG_URL_OWNER" -tAc \
  "SELECT source_ref FROM documents WHERE deleted_at IS NULL AND source_type='s3'" \
  > /tmp/expected-keys.txt
wc -l /tmp/expected-keys.txt
```

Check that every key is in place before the worker starts walking them. The
check has to be **signed**: a bucket created the way the `full` profile creates
one is private, so an anonymous `HEAD` answers `403` for every key, present or
not. And in the shipped Compose file the object store is `expose` only, so it is
not reachable from the host at all. Both are answered by asking from inside the
`api` image, with the product's own S3 client and the `NACRE_S3_*` the `api`
service already carries — every document key starts with `org/`, so one listing
covers them:

```bash
docker compose run --rm --no-deps -T api node --input-type=module -e '
import { loadConfig, S3 } from "/app/packages/core/dist/index.js"
const present = new Set(await new S3(loadConfig().s3).list("org/"))
let text = ""
for await (const chunk of process.stdin) text += chunk
const missing = text.split("\n").filter((k) => k !== "" && !present.has(k))
for (const key of missing) console.log("missing", key)
console.log(`${missing.length} missing`)
' < /tmp/expected-keys.txt
```

`run --no-deps` starts a one-off container from the `api` service's definition,
so it works while `api` itself is stopped. In Kubernetes, pipe the same file into
the same `node` invocation through `kubectl exec -i` in an api pod.

`/v1/ready` on the API answers for s3 under a key of its own — the key is
present only when object storage is configured, and `false` in it means an
unreachable bucket or a wrong credential, not "not asked".

A missing key is a document whose original is lost. Its row in Postgres is
intact, so the loss is visible only here and only now.

## Step 3. Check the collection pointer

This is the step people skip, and it is also the most expensive one.

```bash
psql "$NACRE_PG_URL_OWNER" -tA -c "SELECT slug, vector_collection FROM organizations WHERE deleted_at IS NULL;"
docker compose run --rm --no-deps -T api sh -c \
  'wget -qO- --header "api-key: $NACRE_QDRANT_API_KEY" "$NACRE_QDRANT_URL/collections"' \
  | jq -r '.result.collections[].name'
# in Kubernetes: the same sh -c line through kubectl exec in an api pod
```

Qdrant is not reachable from the host: the shipped Compose file gives it
`expose` and no `ports`, deliberately, because it has no per-tenant
authorization of its own. So the request is made from inside the `api` image,
which has BusyBox `wget` and carries `NACRE_QDRANT_URL` and
`NACRE_QDRANT_API_KEY` — the chart sets both on the api pods as well. An empty
`api-key` header is ignored by a Qdrant that has no key configured.

`organizations.vector_collection` is what **every** search and **every** write
resolves through. Three cases:

- **The pointer names a collection that exists.** Do nothing.
- **The pointer names a collection that does not exist.** Rebuild — step 4.
- **The pointer names `org_{slug}`, and Qdrant holds `org_{slug}_v_...`.**
  The Postgres backup was taken **before** a layer reindex, and Qdrant outlived
  it. The suffixed collection is the result of that reindex, and the restored
  Postgres knows nothing about it. Do not move the pointer onto it:
  `layers.vector_name` in the restored copy names the old model, while in the new
  collection the layers that had already moved sit in the new slot. Rebuild
  (step 4) and delete the orphaned collection by hand — the automatic cleanup
  will not reach it: it deletes only what is recorded in `retired_collections`,
  and that table was restored from the same Postgres backup and knows nothing
  about the reindex.
  See [rollback-layer-reindex.md](./rollback-layer-reindex.md#orphaned-collections).

Check that the slot names agree with the layers:

```sql
SELECT l.slug, l.vector_name, p.model, p.dimensions
  FROM layers l JOIN embedding_providers p ON p.id = l.provider_id
 WHERE l.deleted_at IS NULL;
```

`vector_name` must be `v_{model}_{dim}` of its own provider. A mismatch is what
an interrupted reindex leaves behind, and search across such an organization
fails entirely, not for one layer: every model is a branch of one query. The
remedy is in [rollback-layer-reindex.md](./rollback-layer-reindex.md).

## Step 4. Rebuild the collection and requeue the documents

**Since 0.3.0 this is one command**, and nothing has to be created by hand any
more:

```bash
docker compose run --rm api node packages/api/dist/rebuild-collection.js --org <slug>
# in Kubernetes: kubectl exec into any api pod with the same node invocation
```

**If the vector store survived — you restored Postgres onto an installation whose
Qdrant kept running — pass `--replace`.** The collection is there and no longer
matches the database it now sits beside, and both ways it disagrees are silent.
A document deleted after the backup was taken comes back in Postgres while its
points stay flagged deleted, so no search ever finds it; a document added after
the backup leaves points whose chunk rows the restore removed, which search drops
when it hydrates hits — each one a place in `top_k` handed to nobody, so a search
for ten results quietly returns fewer. Measured on a running stack, not reasoned:
after such a restore, a document the archive held was absent from every search.

```bash
docker compose run --rm api node packages/api/dist/rebuild-collection.js --org <slug> --replace
```

`--replace` drops the collection and creates it again from Postgres. It is never
the default, because over a collection that is merely *lost* there is nothing to
replace, and over one that is fine it deletes every vector for nothing.

It does exactly what this runbook used to describe as a manual procedure, and in
the same order:

- it reads the **real** collection name from `organizations.vector_collection`
  and the set of slots from `layers.vector_name` × `embedding_providers.dimensions`
  for every layer of the organization, deleted ones included — which is where
  `init` is unsuitable in principle: it builds `org_{slug}` with one slot from
  the process configuration, and after a move to another model that is the
  wrong name and the wrong slots;
- it creates the collection with the parameters from `vectorParams` (HNSW,
  quantization — a collection with different parameters does not fail, it
  **quietly changes recall**), the payload indexes from `PAYLOAD_INDEXES`, and
  indexes on the metadata keys found in `documents.metadata`;
- it **refuses** if the collection still exists — a rebuild is a create, and
  over a live collection it would delete that collection's vectors — unless
  `--replace` says so (below);
- it sets every live document to `status = 'pending'`, resetting `claimed_at`,
  `attempts`, `error` and `reindexed_vector`. The last reset is about
  correctness, not about the queue: the marker is left over from an interrupted
  reindex, and without the reset the switch of `vector_name` could go through
  over documents the new collection does not hold. The command leaves
  tombstones alone — a deleted document must not come back into the index.

Check the set of slots the command will read (it prints it as well) — this is
its own query:

```sql
SELECT DISTINCT l.vector_name, p.dimensions
  FROM layers l JOIN embedding_providers p ON p.id = l.provider_id
 WHERE l.org_id = :org;
```

There is no `deleted_at` filter, because the command has none: a deleted layer's
slot is created too. That costs a declaration and nothing more — its documents
are tombstones, which the command does not requeue, so nothing is ever written
into it.

Ingest idempotency does not get in the way of the restart: it skips a document
only when `content_hash` matches **and** `status = 'indexed'`. A row in
`pending` is a work order, not work done.

The "drop the collection → rebuild → the document is found again" scenario runs
in the e2e smoke test (`scripts/ci/e2e-smoke.sh`) on every pull request, against
a real Qdrant.

## Step 5. Start and watch

```bash
docker compose start worker api mcp
docker compose logs -f worker
```

```bash
watch -n5 'psql "$NACRE_PG_URL_OWNER" -tAc "SELECT status, count(*) FROM documents WHERE deleted_at IS NULL GROUP BY status"'
```

Done when everything is `indexed` and:

```bash
curl -s localhost:8080/metrics | grep -E 'nacre_documents_total|nacre_tombstones_pending_total'
```

`nacre_tombstones_pending_total` is usually non-zero after a restore: deleted
documents come back from the backup along with everything else, and nothing has
yet cleared their points out of the new index. It should converge to zero on its
own. If it does not, that is
[vector-collection-backlog.md](./vector-collection-backlog.md), not a restore
problem.

There is no separate metric for checking permissions after a restore, and none
is needed: the permitted set is computed from `grants` on every request, so it
is exactly as correct as the restored contents of `grants`. Step 6 checks that.

## Step 6. Check by hand

Tests do not check this — they run against their own fixtures. Check against
real data:

```bash
curl -s -X POST localhost:8080/v1/search -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"query":"…","top_k":5}' | jq '.items | length'
```

Three things, and each one has caught a real defect:

1. **The number of results.** A request for 5 that returns 4 means points from
   an earlier pass are left in the index, or fresh ones are missing.
2. **`text` is not empty.** Hydration reads the text from Postgres by
   `chunk_id`; empty text means the points and the chunks have drifted apart.
3. **A search by a user with no permissions returns nothing, not 403.**
   Invariant 4.

---

## What this runbook does not cover

- **Restoring one organization inside a shared Postgres.** `pg_restore` cannot
  restore part of a database; it takes a restore into a separate database and
  moving the rows across in foreign-key order. Not written, because it has not
  been tested.
- **A point in time between a reindex and the pointer switch.** The window is
  small, but inside it Postgres and Qdrant are consistent only together.
