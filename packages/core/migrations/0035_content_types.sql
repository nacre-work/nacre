-- 0035 — the content types the table admits, now that the table has nine rows.
--
-- 0020 added `documents.content_type` with a CHECK naming the two values ingest
-- accepted and said, in its own comment, that extending the list is a
-- migration, deliberately. This is that migration. The edge, the worker and the
-- parser sidecar read `packages/core/formats.ts` since 0.27.0; the schema is
-- the fourth copy and the one the others cannot reach, so a core test holds
-- this list against the table — found by the compose e2e, where a Word
-- document the edge admitted and the sidecar could read was refused by this
-- constraint with a 500, on the row insert.
--
-- Dropped and re-added rather than altered: PostgreSQL has no ALTER for a
-- CHECK's expression. No RLS change — a constraint on a column whose policies
-- already exist. Forward-only; a row written under 0020 satisfies this list.

ALTER TABLE documents DROP CONSTRAINT documents_content_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_content_type_check
    CHECK (content_type IN (
        'text/plain',
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.oasis.opendocument.text',
        'application/vnd.oasis.opendocument.presentation',
        'application/vnd.oasis.opendocument.spreadsheet',
        'application/epub+zip',
        'application/rtf'
    ));

COMMENT ON COLUMN documents.content_type IS
  'What the stored bytes are. text/plain lives inline or in the bucket as UTF-8; every other value lives only in the bucket. The CHECK is the list in packages/core/formats.ts plus text/plain — extending it is a migration, deliberately, and a core test holds the two against each other.';
