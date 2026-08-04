-- 0022 — the application role may read the migration ledger.
--
-- `/v1/ready` reported that Postgres, Qdrant, Redis and the bucket answer, and
-- said nothing about whether the schema matches the code. A pod started against
-- a database the migrator has not reached **reports ready and then fails every
-- request** — and in Kubernetes that is worse than an error, because the
-- rollout takes the answer at face value and carries on replacing working pods
-- with broken ones.
--
-- The check is "does this database carry every migration this build ships",
-- which needs one thing the application could not do: read `schema_migrations`.
-- The table is created by the migrator, so it is owned by the owning role, and
-- `nacre_app` had no privilege on it at all — verified against a real
-- PostgreSQL before this was written, because a readiness probe that only works
-- as a superuser is the same defect in reverse as the two subsystems this
-- project has already found that way.
--
-- SELECT, and nothing else. The ledger is the migrator's to write; a process
-- that could write it could tell the next migrator a migration had run.
--
-- Nothing here is tenant data, so there is no RLS to add and none to bypass:
-- the rows are file names and checksums of SQL that ships in a public
-- repository. What they disclose is the schema version, which any client can
-- infer from behaviour and which the operator already knows.

GRANT SELECT ON schema_migrations TO nacre_app;

-- Deliberately not `nacre_worker`. The worker has the same question and no
-- surface to answer it on: no readiness endpoint, so the only thing it could do
-- with the answer is refuse to start, which is a different decision with its
-- own failure mode during a partial upgrade. Granting a privilege nothing reads
-- is the same shape as a variable accepted and never read, so the grant waits
-- for the reader — a migration then, not a guess now. Every supported shape
-- already starts the worker after the migrator.

COMMENT ON TABLE schema_migrations IS
  'The migrator''s ledger: one row per applied file, with the checksum that makes editing an applied migration a refusal. Readable by the application role so readiness can tell a database that is behind this build from one that is merely slow; writable only by the role that runs migrations.';
