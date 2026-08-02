-- The query set a reindex is checked against.
--
-- `docs/architecture.md` has carried a step 4 since before there was a reindex
-- — "the recall check against a reference query set" — and has listed it as not
-- built for just as long, with the reason: it is "a gate nobody can run without
-- a query set". This is the query set.
--
-- ─── what the gate is for ───
--
-- A migration onto a new model succeeds mechanically whether or not the new
-- model works. Every document gets a shadow vector, the count reaches zero,
-- `vector_name` moves, and search is now answered by the new slot. If the
-- provider was misconfigured — the right endpoint behind the wrong model name,
-- a truncated dimension, an embedder returning near-constant vectors — every
-- step still reports success and retrieval quietly collapses. There is no
-- failing test, no alert, and no error anywhere, because nothing failed.
--
-- The gate is the only thing in the sequence that asks whether the new model
-- can still answer, rather than whether the write happened.
--
-- ─── why ground truth rather than agreement with the old model ───
--
-- The cheaper design compares the new slot's answers against the old slot's and
-- gates on the overlap. It needs nothing from the operator, and it is wrong:
-- **a better model disagrees with the worse one it replaces**, so a gate on
-- agreement blocks exactly the migrations worth making, and passes a new model
-- that reproduces the old one's mistakes. What an operator means by "search
-- still works" is against documents they picked, which is a thing only they
-- have.
--
-- So the set is theirs and the gate is off until they write one. That is the
-- honest arrangement, and it is why this table exists rather than a constant.
--
-- ─── external ids, not document ids ───
--
-- `expected` names documents the way the operator does. A document deleted and
-- re-ingested is the same reference; a document id would have changed underneath
-- them silently and scored as a miss. The resolution to ids happens when the
-- check runs, and an entry that resolves to nothing **fails the check with that
-- reason** rather than counting as a miss — a stale reference set and a bad
-- model are different problems and must not produce the same number.

-- Composite keys for the cross-tenant foreign key below, the same shape 0002
-- gave `groups` and `users`. Without it a row could name a layer in one
-- organization while claiming another, and only the code writing the insert
-- would stop it.
ALTER TABLE layers ADD CONSTRAINT layers_id_org_key UNIQUE (id, org_id);

CREATE TABLE reference_queries (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    layer_id   uuid        NOT NULL,

    -- Bounded because every one of these is an embedding round trip at the end
    -- of a migration, and because an unbounded text column reached by an API is
    -- a way to store something else.
    query      text        NOT NULL CHECK (length(query) BETWEEN 1 AND 1024),

    -- At most ten, which is the `k` the check retrieves at. A set naming more
    -- expected documents than the check can return could never score 1.0, so
    -- the floor would be unreachable and the operator would read it as a
    -- regression. Refused here as well as at the API, because the two disagree
    -- exactly when someone writes to the database by hand.
    expected   text[]      NOT NULL CHECK (
                             cardinality(expected) BETWEEN 1 AND 10
                             AND array_position(expected, NULL) IS NULL
                           ),

    -- The operator's order, preserved. A reference set is read as a list and a
    -- report that renumbers it every time it is fetched is a report nobody can
    -- compare against the last one.
    ordinal    int         NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT reference_queries_layer_in_org
        FOREIGN KEY (layer_id, org_id) REFERENCES layers (id, org_id) ON DELETE CASCADE,
    CONSTRAINT reference_queries_ordinal UNIQUE (layer_id, ordinal)
);

-- The two questions asked of this table: "the set for this layer" (the API, and
-- the check) and "does this layer have one at all" (the switch predicate).
CREATE INDEX reference_queries_layer ON reference_queries (org_id, layer_id);

-- Tenant data, so RLS, and FORCE because ENABLE alone does not apply to the
-- owner and migrations run as the owner.
ALTER TABLE reference_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE reference_queries FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON reference_queries
    USING (org_id = current_setting('app.current_org')::uuid);

-- `nacre_app` reads and rewrites the set, because the API does. `nacre_worker`
-- only reads: the check must not be able to alter the thing it is checked
-- against, and a sweep that could delete a reference query could turn a failing
-- gate into a passing one by emptying it.
GRANT SELECT, INSERT, DELETE ON reference_queries TO nacre_app;
GRANT SELECT ON reference_queries TO nacre_worker;
