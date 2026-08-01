-- 0004 — record which groups_version a document's ACL tags were built from.
--
-- The tags in the vector payload are a cache of the grants table, and
-- invariant I4 promises a revoked grant stops appearing within
-- ACL_PROPAGATION_SLA. Without knowing when each document was last tagged,
-- that promise is unmeasurable: the metric docs/config.md marks as the alerting
-- one, nacre_acl_propagation_lag_seconds, had nothing to compute itself from.
--
-- It is the only external evidence I4 still holds. A promise about time with
-- no measurement is a promise nobody can catch breaking.

ALTER TABLE documents ADD COLUMN acl_version bigint NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN acl_tagged_at timestamptz;

COMMENT ON COLUMN documents.acl_version IS
  'organizations.groups_version at the moment the vector payload was tagged. Behind the current value means the recomputation has not caught up.';

-- The lag query wants the oldest stale document, so the index leads with the
-- comparison that decides staleness rather than with the organization.
CREATE INDEX documents_acl_version_idx
    ON documents (org_id, acl_version, acl_tagged_at)
    WHERE deleted_at IS NULL;

-- Existing rows predate tagging entirely. Leaving them at 0 is honest: they
-- have never been tagged, and the metric should say so rather than report a
-- comfortable zero on its first scrape.
