-- 0020 — what the stored bytes are, recorded where the truth lives.
--
-- Binary ingest (docs/architecture.md, "Binary ingest") stores a PDF's bytes
-- in the bucket and needs the worker to know they are a PDF before it decides
-- how to hand them to the parser. The S3 object carries a Content-Type of its
-- own, but reading the answer from object metadata would make a bucket restore
-- load-bearing for correctness — and Postgres is the source of truth, which is
-- the whole restore doctrine. So the type is a column.
--
-- The default is the entire migration story: every existing document is UTF-8
-- text, because until this landed the edge refused anything else. No backfill,
-- no RLS change — the table's policies exist and a new column inherits them.

ALTER TABLE documents
    ADD COLUMN content_type text NOT NULL DEFAULT 'text/plain'
    CHECK (content_type IN ('text/plain', 'application/pdf'));

COMMENT ON COLUMN documents.content_type IS
  'What the stored bytes are. text/plain lives inline or in the bucket as UTF-8; application/pdf lives only in the bucket. The CHECK is the list of formats ingest accepts — extending it is a migration, deliberately.';
