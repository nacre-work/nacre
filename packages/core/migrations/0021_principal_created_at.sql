-- 0021 — `groups` and `group_members` get a `created_at`, so they can be listed.
--
-- Every paged collection in this API seeks on `(created_at, id)`. It is not a
-- preference: `docs/api.md` forbids offset paging, the cursor carries the sort
-- key of the last row returned, and `decodeCursor` refuses anything whose first
-- half does not parse as a timestamp. So a table with no `created_at` cannot be
-- paged by the shared machinery at all — which is why `GET /v1/groups` could
-- not be written before this.
--
-- 0001 gave `documents`, `layers`, `workspaces`, `users`, `service_accounts`,
-- `grants` and `audit_events` one and gave these two nothing. Nothing read
-- them back then; the resolver loads the whole membership graph for an
-- organization in one statement and does not care about order.
--
-- `now()` is volatile, so this rewrites both tables and stamps every existing
-- row with the same instant. That is correct rather than merely acceptable: the
-- rows predate the column, so there is no creation time to recover, and the id
-- tie-breaker keeps the ordering total when the timestamps collide — which is
-- exactly the case `Position.id` exists for.
--
-- No RLS change. Both tables have policies and a new column inherits them.
-- The row triggers from 0003 do not fire on an ALTER, so `groups_version` does
-- not move: nothing about who may read what has changed here.

ALTER TABLE groups        ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE group_members ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();

-- The seek key, so paging a large directory sync does not become a sort of the
-- whole table per page. A filter that falls back to a scan does not fail a
-- test; it gets slow at a customer's volume, which is the worst way to find out.
CREATE INDEX groups_org_seek_idx        ON groups        (org_id, created_at, id);
CREATE INDEX group_members_org_seek_idx ON group_members (org_id, group_id, created_at);

COMMENT ON COLUMN groups.created_at IS
  'Sort key for cursor pagination, not a business fact. See docs/api.md on why offset paging is refused.';
COMMENT ON COLUMN group_members.created_at IS
  'When the edge was written. Sort key for paging a group''s membership; a SCIM re-sync that removes and re-adds a member moves it, which is a fact about the edge and not about the member.';
