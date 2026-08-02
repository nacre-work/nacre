-- Reindexing a layer onto a different embedding model.
--
-- `layers.reindex_state` has been in the schema since 0001 with a comment
-- describing its shape, and nothing has ever written it. This is what writes it,
-- plus the one column the pass needs to know what is left to do.
--
-- ─── what a reindex is, mechanically ───
--
-- Chunks already hold their text and their Qdrant point id. So reindexing is
-- not re-parsing anything: it is reading stored chunk text, embedding it with
-- the new model, and adding a second **named vector** to the points that are
-- already there. The old vector stays where it is and search keeps using it,
-- which is what "search stays available throughout" in docs/architecture.md
-- means in practice.
--
-- When every live document in the layer carries the new vector, `vector_name`
-- switches in one statement and the next query uses it.
--
-- ─── one column, and why not dual-write ───
--
-- `reindexed_vector` records which named vector a document has most recently
-- been reindexed onto. The pass selects documents in a reindexing layer where
-- it is distinct from the shadow vector; the switch happens when that set is
-- empty.
--
-- docs/architecture.md step 2 says "put the layer in dual-write: new documents
-- are indexed by both models". This does not do that, and the deviation is
-- deliberate. Dual-write means the ingest path carries reindex awareness
-- permanently — a branch on layer state in the hot path, for a condition that
-- is true for a few hours in a layer's life. Selecting on "lacks the shadow
-- vector" gets the same guarantee out of machinery that already exists: a
-- document ingested mid-reindex simply has no shadow vector yet, so the same
-- pass picks it up, and the switch cannot happen while it is outstanding.
--
-- The resulting invariant is stronger and easier to check than dual-write's:
-- **`vector_name` only ever changes when no live document in the layer lacks
-- the new vector.** One predicate, verifiable in SQL, rather than a promise
-- about two write paths staying in step.

ALTER TABLE documents ADD COLUMN reindexed_vector text;

-- Partial and on the layer, because the pass always asks the same question:
-- "in this layer, which documents do not yet carry this vector". Live documents
-- with chunks are the only ones that can — the rest have no points to add a
-- vector to.
CREATE INDEX documents_reindex_pending ON documents (layer_id, reindexed_vector)
    WHERE deleted_at IS NULL AND chunk_count > 0;

-- ─── the state, and the one shape it is allowed to take ───
--
-- A check constraint rather than a convention. `reindex_state` is jsonb, which
-- means anything at all fits in the column, and the failure mode of a free-form
-- status field is a typo that reads as "not running" — leaving a reindex that
-- has stopped looking exactly like one that never started.
--
-- NULL means no reindex has ever run, which is different from one that finished
-- and is why the column is nullable rather than defaulted.
ALTER TABLE layers ADD CONSTRAINT layers_reindex_state_shape CHECK (
    reindex_state IS NULL
    OR (
        reindex_state ? 'status'
        AND reindex_state ->> 'status' IN ('running', 'complete', 'failed')
        AND reindex_state ? 'shadow_vector'
    )
);
