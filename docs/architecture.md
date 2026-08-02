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

1. Add a new named vector `v_{model}_{dim}` to the collection.
2. Put the layer in dual-write: new documents are indexed by both models.
3. A background job reindexes existing documents in batches, with bounded
   concurrency and quota awareness.
4. On completion, check against the layer's reference query set: Recall@10 of
   the new index is no lower than the old minus a tolerance.
5. Switch `layers.vector_name` atomically.
6. Drop the old vector after a rollback window (7 days by default).

Search stays available throughout. Progress lives in `layers.reindex_state`.

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
