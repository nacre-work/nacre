-- A lease on the two background sweeps, so more workers do more work.
--
-- `claimStale` (retag) and `claimPurgeable` (garbage collection) both selected
-- the oldest N rows with no lock and no claim marker. Every replica therefore
-- selected the **same** N rows and did the same work: throughput stayed at one
-- worker's rate however many were running, while the load on Qdrant multiplied
-- by the replica count.
--
-- That matters beyond efficiency. The documented response to a climbing
-- `nacre_acl_propagation_lag_seconds` is to look at the worker — and scaling it
-- out, the obvious move, did nothing at all.
--
-- `FOR UPDATE SKIP LOCKED` alone does not fix it. The lock lives until the
-- transaction commits, and these transactions end the moment the SELECT
-- returns — the actual work (a Qdrant round trip) happens afterwards, outside
-- any transaction. So two replicas polling a second apart still collide.
--
-- ─── one column, because the two states are mutually exclusive ───
--
-- A document is either live and behind its organization's version (retag), or
-- deleted and not yet purged (garbage collection). `deleted_at IS NULL` decides
-- which, and nothing is ever both, so one claim column serves both sweeps.
--
-- Leased rather than owned, exactly like `documents.claimed_at`: a worker that
-- dies mid-sweep must not park a row forever. `NACRE_INDEX_LEASE` bounds it,
-- and the claim is only ever an optimisation — both sweeps are idempotent, and
-- `markTagged`'s version guard and `markPurged`'s `vectors_purged_at IS NULL`
-- guard remain the things that make a double pass harmless.

ALTER TABLE documents ADD COLUMN sweep_claimed_at timestamptz;

-- Partial, and on the claim rather than on the whole table: the sweeps read
-- "unclaimed, or claimed long enough ago to be abandoned", which is a small
-- slice of a large table.
CREATE INDEX documents_sweep_claim ON documents (sweep_claimed_at)
    WHERE sweep_claimed_at IS NOT NULL;
