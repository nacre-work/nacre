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
then a single delete, with no rows to forget. Installations with hundreds of
small tenants can instead share a collection with a mandatory `org_id` payload
filter — `NACRE_VECTOR_TENANCY=collection|shared`, defaulting to `collection`.

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
  "acl_tags":    ["h:a3f1…", "h:9c02…"],   // hashes of principals with read
  "acl_version": 42,
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
acl_tags   keyword, kept in memory — it participates in every single query
```

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
5. Switch that layer's `vector_name` and `provider_id` together, once no live
   document in it lacks the new vector. One statement, so a document ingested
   in between is part of the set rather than a hole.

Steps 1–3 are org-wide and happen once however many layers are migrated; steps
4–5 are per layer and are what `POST /v1/layers/{id}/reindex` starts.
`reindex_state.phase` distinguishes them: `copying` for the first, `embedding`
for the second, and `progress` measures only the second because the first
computes nothing.

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

The old collection is left in place. Rolling the whole organization back is
pointing `vector_collection` at it again; rolling one layer back is a reindex
onto the provider it came from.

**What is not built:** the recall check against a reference query set (step 4 of
the original sequence), and dropping the old vector after a rollback window.
Both are additions to a migration that completes without them — the first is a
gate nobody can run without a query set, and the second is disk.

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

A consistent set is three parts: a PostgreSQL dump, a snapshot of the Qdrant
collections, and the S3 bucket. Restore in the order Postgres → S3 → Qdrant.
When they disagree, **vectors are rebuilt from Postgres and S3** — the reverse
does not hold, because the vector store carries no authoritative content.
Rehearse the restore quarterly, at real volume.
