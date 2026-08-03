# Architecture

## Components

```
nginx        → api (N replicas, stateless), admin-ui
api          → postgres, qdrant, redis, s3, reranker
worker       → postgres, qdrant, s3, parser, embedder   (M replicas)
parser       → Python sidecar: bytes → {text, blocks[], metadata}
embedder     → TEI or vLLM, GPU optional
reranker     → cross-encoder
```

The API is stateless by construction. That follows directly from the MCP core
being stateless: any request is served by any replica behind a round-robin
balancer, and there is no shared session store to lose.

## Data model

Workspaces contain layers; layers contain documents; documents are chunked.
Permissions attach to any of the three scopes — see [authz.md](./authz.md),
which is the document to read first.

A layer is the unit that binds an embedding model. Two layers in the same
organization can use different models and different dimensions at the same
time, which is what makes a model migration a per-layer operation rather than a
whole-index rebuild.

## Vector storage

**One collection per organization**, named `org_{slug}`. Offboarding a tenant is
then a single delete, with no rows to forget. A shared-collection mode for
installations with hundreds of small tenants — one collection with a mandatory
`org_id` payload filter — was designed as `NACRE_VECTOR_TENANCY=shared`, but no
code path shares a collection, so the value is **refused at startup** rather than
accepted: taking it would hand you a single-collection deployment that believes
it is isolated. The only mode is `collection`, which is the default. `docs/config.md`
says the same where the variable is listed.

**Named vectors inside the collection**, one per active layer model, so layers
of different dimensions coexist: `v_bge_m3_1024`, `v_e5_large_1024`. The name
lives in `layers.vector_name`.

```jsonc
PUT /collections/org_acme
{
  "vectors": {
    "v_bge_m3_1024": { "size": 1024, "distance": "Cosine",
                       "hnsw_config": { "m": 32, "ef_construct": 256 },
                       "quantization_config": { "scalar": { "type": "int8", "quantile": 0.99,
                                                            "always_ram": true } } }
  },
  "sparse_vectors": { "bm25": {} },
  "optimizers_config": { "default_segment_number": 4 },
  "on_disk_payload": true
}
```

int8 quantization is not optional: roughly 4× less memory for a recall loss
inside one percent, which for corporate search is noise. Original vectors stay
on disk for rescoring.

### Point payload

```jsonc
{
  "org_id":      "uuid",   // duplicated even with a collection per tenant — second line of defense
  "workspace_id":"uuid",
  "layer_id":    "uuid",
  "doc_id":      "uuid",
  "chunk_id":    "uuid",
  "ordinal":     3,
  "deleted":     false,    // tombstone until garbage collection
  "created_at":  1754006400,
  "meta":        { }       // user fields, filterable
}
```

### Required payload indexes

Without these the permission filter degrades to a scan and latency dies.

```
layer_id   uuid
doc_id     uuid
org_id     uuid
deleted    bool
```

`acl_tags` and `acl_version` were in this payload and in this list until
migration 0016, as a second filter alongside the layer bound. The filter was
never built — `buildFilter` emits no tag clause — and building it would have
broken document-scoped grants, because the tags were computed per layer and a
document-scoped grant is not a layer grant. Two bytes of payload per principal
per point, and an index kept in memory, for a field no query read. The whole
argument is in `docs/authz.md` and in the migration.

Fixed, because the permission filter uses exactly these fields. The fields a
`filters` narrowing reaches are not: they are `meta.<key>` for keys the caller
chose, so their indexes are built when metadata is written — on ingest and on
`PATCH /v1/documents/{id}` — and carried across when a reindex replaces the
collection. All `keyword`: it is the type that helps a tag and a list of tags,
which is what the narrowing exists for, and a number or a boolean under it
indexes nothing and still matches.

Bounded at 64 metadata keys per collection, and past that the filter is answered
by scanning. That is a latency ceiling and never a wrong answer — a filter on an
unindexed field returns exactly the points an indexed one would. Which is also
why a failure to build one is logged and dropped rather than failing the write:
nothing here decides who sees what.

## Search

Dense vector plus sparse BM25, fused with Reciprocal Rank Fusion, then a
cross-encoder rerank of the top 50 down to top-k. Reranking buys more quality
than any amount of chunking tuning. It is off unless a deployment configures a
reranker, because `minimal` has none — that is what keeps it runnable on a
laptop without a GPU — and a client may turn it off per request but never on.

```jsonc
POST /collections/{c}/points/query
{
  "prefetch": [
    { "query": <dense>,  "using": "v_bge_m3_1024", "filter": <ACL>, "limit": 50 },
    { "query": <sparse>, "using": "bm25",          "filter": <ACL>, "limit": 50 }
  ],
  "query": { "fusion": "rrf" },
  "limit": 50,
  "with_payload": true
}
```

**The filter is repeated in every prefetch branch. Omitting it from one is a
leak.**

Forbidden, all three for the same reason:

- filtering results after Qdrant has returned them;
- asking for a larger `top_k` and trimming — that is a post-filter that also
  costs more;
- assuming a user has one layer so "the filter will surely match".

**Reranking is not the second of those, and the distinction is worth being
precise about, because it looks like it.** The rule is about what the trim
decides. A post-filter trims on *permission*: it fetches k, drops what the
caller may not see, and returns fewer than k permitted results — so the size of
the answer measures what exists but is invisible, and the index ranked
documents it then threw away. Reranking trims on *relevance*, over a candidate
set the index has already filtered by permission, so it changes which permitted
results come back and never how many.

The test that separates them: **can the answer ever be smaller than the number
of permitted matches, up to k?** For a post-filter, yes. For reranking, no.

Qdrant applies payload filters *inside* the HNSW traversal, which is what makes
`top_k` return k permitted results rather than k results with some removed.
That is invariant I2, and it is the reason the pre-filter is architectural
rather than a matter of taste.

## Reindexing on a model change

A named vector can only be declared when a collection is created.
`update_collection` adjusts the parameters of vectors that already exist — HNSW
settings, quantization, on-disk placement — and refuses an unknown name
outright:

```
PATCH /collections/org_acme  {"vectors":{"v_small_v2_768":{"size":768,...}}}
400 {"error":"Not existing vector name error: v_small_v2_768"}
```

Checked against Qdrant 1.18.3, the version this repository pins, by asking it
directly rather than by reading. Writing a point with an undeclared vector fails
the same way, so there is no route in through `upsert` either. Every sequence
below follows from that one fact.

So the collection is not altered — it is **replaced**, and the expensive half is
what happens afterwards:

1. Create a new collection carrying every named vector the old one has **plus**
   the new one, with identical HNSW and quantization parameters.
2. Copy every point across unchanged, vectors and payload alike. **No embeddings
   are computed.** The new slot stays empty.
3. Switch `organizations.vector_collection` in one statement. Search follows
   that column, so this is the moment the new collection becomes live — and it
   is live with exactly the data the old one had.
4. Re-embed **one layer at a time** into the new slot, adding a named vector to
   points that already exist. `updateVectors`, never `upsert`: an upsert would
   rewrite the payload from a call that knows nothing about acl tags.
5. Score the layer's reference query set against the new slot, where it has one.
6. Switch that layer's `vector_name` and `provider_id` together, once no live
   document in it lacks the new vector **and** the score cleared the floor. One
   statement, so a document ingested in between is part of the set rather than
   a hole, and so is a reference set written a moment ago.

Steps 1–3 are org-wide and happen once however many layers are migrated; steps
4–6 are per layer and are what `POST /v1/layers/{id}/reindex` starts.
`reindex_state.phase` distinguishes them: `copying` for the first, `embedding`
for the second, and `progress` measures only the second because the first
computes nothing.

### The gate at step 5

Every other step in this sequence checks that a write happened. This is the only
one that asks whether the new model can still answer — and the distinction
matters because a migration onto a misconfigured provider succeeds at every
mechanical step. The wrong model name behind the right endpoint, a truncated
dimension, an embedder returning near-constant vectors: each produces a shadow
vector for every document, a count that reaches zero, a `vector_name` that
moves, and retrieval that has quietly collapsed with no error anywhere.

Recall@10 against documents the deployment picked, per reference query,
averaged over the set. **Not agreement with the old model**, which would need
nothing from anyone and would be the wrong measurement: a better model disagrees
with the worse one it replaces, so a gate on agreement blocks the migrations
worth making and passes a new model that reproduces the old one's mistakes.

The set lives in `reference_queries` and is written through
`PUT /v1/layers/{id}/reference-queries`. **A layer without one has no gate.**
That is the arrangement rather than an omission — the check needs documents
someone chose, and failing every migration in a deployment that has not chosen
any would make the feature a way to break reindexing.

Three outcomes, and the third is the one worth naming. A score below
`NACRE_REINDEX_MIN_RECALL` ends the reindex at `failed` with the pointer
unmoved. A score at or above it lets step 6 run. And a reference set that names
a document which is not there **fails without being scored**: a stale set and a
model that lost recall are different problems, and counting a missing document
as a miss reports the first as the second. A check that cannot run at all,
because the embedder is unreachable, writes no verdict and is retried.

The retrieval it performs carries `org_id`, `layer_id` and `deleted = false` and
**no ACL filter**, which anywhere else here would be the leak every other rule
exists to prevent. It is allowed for a structural reason rather than a judged
one: there is no principal. Nothing calls it on behalf of a caller, and what
leaves it is a ratio. The port takes a layer and a vector and never a filter, so
there is no argument through which a caller-shaped query could reach the index
— which is what stops it being reused from the request path later.

**Search stays available throughout, and stays one query.** During a migration
the organization holds layers on two models, so the query carries one dense
branch per model, each confined to the layers on it and each embedded by that
layer's own provider. The confinement is a `must` appended to the permission
filter, never a filter of its own — a branch that could carry its own filter is
the leak `buildHybridQuery` exists to make unrepresentable.

Two things follow from the copy not being atomic against concurrent writes. The
worker holds documents at `pending` while their organization is copying, because
a document indexed in between would land in the collection about to be
abandoned. And a layer whose provider has no slot in the collection — created
against a second provider, not reindexed at all — starts the same copy rather
than accepting documents it can never index.

The old collection is left in place **for a window**. Rolling the whole
organization back is pointing `vector_collection` at it again; rolling one layer
back is a reindex onto the provider it came from.

**A reindex that fails still moves the pointer**, and that is a consequence
rather than a bug: steps 1–3 are what moved it and only step 4 failed, so the
new collection holds exactly the old one's data plus an empty slot — live and
correct — and the layer stays on the model it was already on.

### What reclaims what

Two copies survive a completed migration, and each has its own sweep on the same
window, `NACRE_COLLECTION_RETENTION_DAYS`. That window is the rollback window,
not a tidiness delay: both rollbacks above are cheap **only while the thing they
roll back onto still exists**.

**The superseded collection.** Candidates come from `retired_collections`,
written by the same transaction that moves the pointer — so the list is "what a
migration replaced" and never "what nothing points at". The difference is not
cosmetic: the second phrasing describes the *target* of a copy still running,
which is what made the runbook's manual cleanup a way to delete a live
migration. The pointer is checked again immediately before each delete, so a
collection an operator has rolled back onto leaves the list rather than the
disk.

**The superseded vector slot.** A completed reindex leaves every point in the
layer still carrying the vector it used to be searched by — a float per
dimension per point, in memory by default. Qdrant cannot drop a named vector
from a collection's schema, which is the constraint this whole section turns on,
but it can drop the *data* for one over a chosen set of points, which is all
that costs anything. `finishReindexIfDone` records the name it moved away from
in `reindex_state.previous_vector`, and the sweep refuses any slot a layer is
searching now. Verified by asking Qdrant: the slot stays declared, a query on
the live slot is unaffected, and a point missing the queried vector does not
error — it simply does not match, which is exactly why that refusal is not
optional.

Every step of the sequence above is built. What a deployment still has to
supply is the reference query set the gate at step 5 scores against, and until
it does that layer migrates without one.

### Rebuilding a lost collection

The window above protects a collection a migration replaced. It does nothing for
a collection that is simply **gone** — a lost Qdrant volume, a restore that
brought Postgres back and not Qdrant, an operator who dropped the wrong name.
Postgres survives that and Qdrant does not, and Postgres is where the collection
is described: its name in `organizations.vector_collection`, its slots in the
`vector_name` of each layer and the `dimensions` of the provider behind it.

`node packages/api/dist/rebuild-collection.js --org {slug}` is the command that
reads that description and puts the collection back. `init` cannot: it names the
collection `org_{slug}` and gives it one slot from the process configuration, and
after a reindex the name no longer follows the slug and the slots are one per
model the layers use — both of which are in the database and neither of which is
in `init`'s arguments. So this reads the real name and the real slots, recreates
the collection with the permission indexes and the caller's metadata indexes
(the two sets a reindex carries across, for the same reason), and **requeues
every live document** — `status = 'pending'`, the lease reset with it — so the
worker re-embeds them into it. The documents are requeued rather than copied
because the vectors are the one thing Postgres does not keep; everything else it
does.

Two refusals make it safe to reach for. It **will not run over a collection that
still exists**, because a rebuild is a create and would delete every vector in a
live one — drop it first if it is corrupt rather than missing. And it leaves
tombstoned documents alone: `deleted_at IS NULL` is on the requeue, so a document
that was on its way out of the index does not come back into it. It is a
one-shot command run where the operator already has credentials, the same shape
as `init` and `migrate` and for the same reason — recreating a collection and
requeuing an organization's documents is not a request the API takes from the
network.

The requeue also clears `reindexed_vector`, and that reset is about correctness
rather than scheduling. The marker records which shadow slot a document was
re-embedded into during a model migration, and the rebuilt collection holds
nothing in any shadow slot — so a disaster that struck mid-reindex would
otherwise leave the completeness predicate above satisfied by markers alone,
and on a layer without a recall gate the switch could move `vector_name` onto
a slot with no data in it. NULL restores the truth the predicate reads:
nothing has been re-embedded into this collection yet, and the interrupted
reindex resumes from the start of its embedding phase rather than from a lie.

The alternative was a collection per layer, which keeps a reindex local but
turns an unscoped search into one Qdrant query per layer — ten to twenty in the
ordinary case, against a p95 under 200 ms. Declaring spare vector slots at
creation time means guessing future models and their dimensions.

## Deletion and garbage collection

`documents.deleted_at` is set immediately and the points get `deleted: true` in
the same queue transaction. Physical removal is a background job, at least
hourly.

**`deleted = false` is mandatory in every query.** Between the delete and the
sweep there is a window in which the document is still in the index, and
depending on GC timing is how invariant I5 gets broken.

## Re-indexing is a replacement

Every indexing pass mints fresh point ids, so an upsert overwrites nothing: the
previous pass's points would stay in the collection with `deleted = false`
unless they are removed. After the upsert, and never before, the writer deletes
every point carrying this `doc_id` that is not in the set just written —
sweeping first would leave the document unsearchable for the length of an
embedding round trip, and a reader landing in that window sees an empty result
rather than a stale one.

Points left behind this way cannot leak text: hydration joins on a chunk row
that no longer exists. What they do is match the permission filter and take
places in `top_k`, so a search asking for ten results silently returns six, and
gets worse with every edit. A collection built before this reconciliation
existed needs a reindex; nothing in the sweep removes points from a pass it did
not perform.

## Backups

Restore Postgres first and rebuild Qdrant from it — the reverse does not hold,
because the payload of a point carries identifiers and flags and not one line of
text. A Qdrant snapshot saves recomputing embeddings and never substitutes for a
Postgres one.

How many parts there are depends on where the document bytes live, which is a
deployment's choice:

- **No object storage** — the default. Two parts: a PostgreSQL dump and a Qdrant
  snapshot. Bytes are in `documents.source_ref`, which is what makes the dump
  larger than it looks.
- **`NACRE_S3_*` configured.** Three parts, and the order is Postgres → S3 →
  Qdrant. `source_ref` holds an object key and `source_type` is `s3`, so
  Postgres is the only thing that knows which key belongs to which document: a
  bucket restored on its own names nothing, and rows restored without the bucket
  survive with their originals gone.

The variables are validated at startup as a group — all four of endpoint,
bucket, access key and secret key, or none. Half is refused, because an endpoint
with no credential parses and then fails later, as a deployment that accepts
documents and cannot store them.

Rehearse the restore quarterly, at real volume.
