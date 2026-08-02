-- 0017 — `users.role` loses `workspace_admin`.
--
-- 0001 wrote `CHECK (role IN ('platform_admin','org_admin','workspace_admin','member'))`
-- and `OrgRole` in the code has always been three values. A row carrying the
-- fourth read into a type that does not admit it and then behaved as `member`,
-- because it matches neither role branch in `resolve` and falls through to
-- grant-based evaluation. Safe — it denies rather than widens — and still a
-- role the schema offered, nothing implemented, and nothing refused: an
-- operator who set it got a silently demoted user and no error.
--
-- Removed rather than implemented, because it is a category error and not a
-- missing feature. `users.role` is organization-wide; "administers a
-- workspace" is scoped to one. The permission model already expresses it, and
-- expresses it better: `admin` on a `workspace` scope, which a person can hold
-- on several workspaces at once and which a single column cannot say. Adding
-- the role would have created a second way to spell one thing, with the
-- resolver having to decide which wins.
--
-- Existing rows are moved to `member`, which is what they already behaved as.
-- The UPDATE runs before the constraint is replaced, or the constraint would
-- refuse the rows it exists to remove.

UPDATE users SET role = 'member' WHERE role = 'workspace_admin';

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('platform_admin', 'org_admin', 'member'));

COMMENT ON COLUMN users.role IS
  'Organization-wide role. Anything scoped to a workspace, a layer or a document is a grant, not a role — see docs/authz.md rules 2 and 3.';
