-- 0007 — a document being indexed carries a lease and an attempt count.
--
-- The worker claims a document by committing `status = 'parsing'` and then does
-- the work outside that transaction. Committing first is deliberate: holding a
-- row lock across a parse, an embedding call, and a vector upsert would tie a
-- database connection to the slowest thing in the pipeline. But it means the
-- claim outlives the process. A worker killed between the commit and the
-- finish — an OOM on a large PDF, a node drained, a rollout — leaves the row in
-- `parsing`, and nothing claims `parsing`. The document never indexes, the
-- ingest endpoint already answered 202, and the only symptom is a job that
-- stays queued forever.
--
-- Two columns, because a reaper alone turns a document that kills the worker
-- into one that kills it repeatedly:
--
--   claimed_at  when the current attempt started. The lease clock. Not
--               `updated_at`, which other writers touch and which would extend
--               a lease for reasons unrelated to the work.
--   attempts    how many times this document has been claimed. A reaper that
--               resets forever is a poison pill on a loop: the same document
--               takes the worker down, comes back, and takes down its
--               replacement. Past a ceiling the row is failed rather than
--               requeued, and an operator sees it.

ALTER TABLE documents
    ADD COLUMN claimed_at timestamptz,
    ADD COLUMN attempts   int NOT NULL DEFAULT 0;

-- Existing rows mid-flight at the moment of this migration: give them a lease
-- that starts now rather than one that is already expired. Requeueing every
-- in-progress document on deploy is exactly the stampede this guards against.
UPDATE documents SET claimed_at = now() WHERE status IN ('parsing', 'indexing');

-- The reaper's query, and the only one that reads claimed_at. Partial, because
-- the rows it looks for are a vanishing fraction of the table — normally none.
CREATE INDEX documents_expired_claims ON documents (claimed_at)
    WHERE status IN ('parsing', 'indexing');

COMMENT ON COLUMN documents.claimed_at IS
    'When the current indexing attempt was claimed. Cleared on success or failure; a value older than the lease means the worker holding it is gone.';
COMMENT ON COLUMN documents.attempts IS
    'Claims so far. Bounded so a document that crashes the worker is failed rather than retried forever.';
