-- 0005 — a grant change moves the permission version too.
--
-- 0003 made groups_version move on membership and group changes. It did not
-- cover the `grants` table, and that leaves a hole precisely where it matters
-- most: `nacre_acl_propagation_lag_seconds` measures documents whose
-- acl_version has fallen behind their organization's groups_version, and it is
-- the evidence offered for invariant I4 — "a revoked grant stops appearing
-- within ACL_PROPAGATION_SLA".
--
-- Revoking a grant is a write to `grants`. Nothing bumped the version, so the
-- lag stayed at zero through the one event the metric is named for. The metric
-- was blind to revocation while reporting on revocation.
--
-- 0001 calls this column "permission cache invalidation", not "group
-- membership counter", so this is within what it was for. The name is now
-- narrower than the meaning; renaming it touches the resolver, the cache key
-- and three documents, and is worth doing separately rather than inside a
-- correctness fix.
--
-- The cost is over-invalidation: the effective-principals cache is keyed on
-- this value and a grant change does not alter the group closure, so those
-- entries are recomputed without needing to be. That is a read the database
-- was already able to serve, and it errs toward denying a stale answer.

CREATE TRIGGER grants_bump_version
    AFTER INSERT OR UPDATE OR DELETE ON grants
    FOR EACH ROW EXECUTE FUNCTION bump_groups_version();

-- 0003 called its triggers statement-level in a comment and then wrote FOR EACH
-- ROW. The code was right and the comment was wrong, so this records the truth
-- rather than quietly changing behaviour: a sync replacing a hundred grants
-- bumps the version a hundred times inside one transaction. Readers only care
-- that it moved, so this is correct but wasteful — a hundred row versions on
-- one organizations row. Converting to statement-level needs transition tables
-- and a trigger per operation, which is a change to make on its own.

COMMENT ON COLUMN organizations.groups_version IS
  'Permission epoch. Bumped by triggers on groups, group_members and grants. Read as the effective-principals cache key and as the target the ACL propagation lag is measured against.';
