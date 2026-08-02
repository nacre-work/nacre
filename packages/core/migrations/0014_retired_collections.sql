-- The collections a reindex leaves behind.
--
-- Every model migration builds a new collection, copies every point across, and
-- moves `organizations.vector_collection` at the end. The old collection is
-- still there afterwards, holding a full copy of the organization's vectors,
-- and nothing has ever removed one. `runbooks/rollback-layer-reindex.md` says
-- so in as many words — "каждая переиндексация оставляет коллекцию … ничего их
-- не подчищает" — and hands the operator a shell loop.
--
-- That loop is also the wrong rule. It reads every collection Qdrant has,
-- subtracts the ones an organization points at, and calls the difference
-- orphaned. During a copy the *target* is exactly that: built, filling up, and
-- not yet pointed at by anything. Running the documented cleanup while a
-- migration is copying deletes the migration.
--
-- ─── so the record is kept, not derived ───
--
-- A row is written when the pointer moves, naming the collection it moved away
-- from. Nothing else is ever a candidate for deletion. A copy in progress has
-- no row, because the row is written by the same statement that supersedes it,
-- so the dangerous case is not merely avoided — it is unrepresentable.
--
-- The delay is the point of the window, not an implementation detail: D2 in the
-- rollback runbook is "move the pointer back", which is instant and only works
-- while the old collection still exists. `NACRE_COLLECTION_RETENTION_DAYS` is
-- how long that stays possible.
--
-- ─── what this does not cover ───
--
-- A copy that was abandoned — the reindex failed partway — leaves a target
-- collection with no row and no pointer, and the sweep will not touch it. That
-- is deliberate for now: the safe rule is "delete only what a successful
-- migration superseded", and widening it to "delete anything unreferenced"
-- brings back the race above. The runbook keeps its manual procedure for that
-- case alone.

CREATE TABLE retired_collections (
    org_id     uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- The Qdrant collection name, which is the whole payload of a row. Not a
    -- reference to anything: by the time this matters the collection may
    -- already be gone, and a dangling name is the normal end state.
    name       text        NOT NULL,
    retired_at timestamptz NOT NULL DEFAULT now(),

    -- One row per name per organization. A second migration away from the same
    -- collection cannot happen — the pointer only ever leaves a name once — but
    -- an idempotent insert is cheaper to reason about than a proof that it
    -- cannot repeat.
    PRIMARY KEY (org_id, name)
);

-- The sweep asks one question: which rows are older than the window. It asks it
-- across organizations, so the index is on the timestamp alone.
CREATE INDEX retired_collections_due ON retired_collections (retired_at);

-- Tenant data, so RLS, and FORCE because ENABLE alone does not apply to the
-- owner and migrations run as the owner.
ALTER TABLE retired_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE retired_collections FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON retired_collections
    USING (org_id = current_setting('app.current_org')::uuid);

-- `nacre_app` inserts, because the pointer moves under `withOrg` in the worker's
-- copy phase and that runs as the application role. `nacre_worker` deletes,
-- because the sweep runs across organizations.
GRANT SELECT, INSERT ON retired_collections TO nacre_app;
GRANT SELECT, INSERT, DELETE ON retired_collections TO nacre_worker;
