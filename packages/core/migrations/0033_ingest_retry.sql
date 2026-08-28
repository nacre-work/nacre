-- A transient failure stops being a permanent verdict.
--
-- ## What this fixes
--
-- `markFailed` wrote `status = 'failed'` for anything the worker caught, on the
-- first attempt, with no reference to `attempts` or `NACRE_INDEX_MAX_ATTEMPTS`.
-- Both of those existed and were consulted by exactly one caller — the reaper,
-- which handles a worker that *died* mid-document. The far commoner case, where
-- a dependency answered badly, had no retry at all: an embedder restarting, a
-- Qdrant that blinked, a parser timing out, and every document in flight was
-- recorded as permanently failed. Nothing retries `failed`, so those documents
-- sat there until a person re-sent the bytes, and the layer went on answering
-- searches out of the documents that had indexed — quietly worse, with no error
-- anywhere a person looks. That is the shape this repository already recorded
-- once, at twenty-six failures out of fifty.
--
-- The classifier that says which failures are worth retrying has existed the
-- whole time. `classifyIngestFailure` distinguishes `unavailable` — "something
-- the deployment runs was unreachable or refused; re-sending later may work" —
-- from `too_long` and `unreadable`, whose own documentation says re-sending
-- will not help. It was read by the API, to explain a failure to a caller, and
-- never by the worker, to decide what to do about one. Declared, correct, and
-- read by one side: the defect this repository keeps finding.
--
-- ## Why a column rather than retrying immediately
--
-- Without a "not before" time, a bounded retry is spent in a millisecond. An
-- embedder that is down for thirty seconds would burn all five attempts of
-- every queued document inside one poll — five times the load on the service
-- that is already failing, and then a permanent verdict anyway. The bound is
-- only a bound in wall-clock terms if something spaces the attempts out.
--
-- `retry_after` is that. NULL means "claimable now", which is what every
-- existing row is and what a fresh document is, so there is no backfill and no
-- behaviour change for anything that never failed.
--
-- ## The index
--
-- The claim reads `status = 'pending' AND deleted_at IS NULL ORDER BY
-- created_at`, and now also `retry_after`. Partial on the predicate, because
-- the queue is the small end of this table on any installation where it
-- matters: a million indexed documents and a handful pending.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS retry_after timestamptz;

CREATE INDEX IF NOT EXISTS documents_claimable_idx
    ON documents (created_at)
    WHERE status = 'pending' AND deleted_at IS NULL;

COMMENT ON COLUMN documents.retry_after IS
  'When a requeued document becomes claimable again. NULL is claimable now. '
  'Set by the worker when it decides a failure is worth retrying, cleared by a '
  're-ingest and by an operator asking for a retry.';
