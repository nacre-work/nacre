-- 0018 — `group_members` can actually hold a member only once.
--
-- 0001 wrote `UNIQUE (group_id, member_user, member_group)` with a CHECK that
-- exactly one of the two member columns is non-null. **In Postgres a unique
-- index treats NULLs as distinct by default**, so two rows with the same
-- `group_id` and `member_user` and a NULL `member_group` do not conflict — and
-- every row this table holds has one of the two columns NULL, by construction.
--
-- The constraint therefore deduplicated nothing at all, in either direction.
-- `ON CONFLICT DO NOTHING` against it is a no-op, which is exactly how it was
-- found: a SCIM group sync adding the same member twice produced two rows and
-- an idempotent re-sync doubled a group's membership every time it ran.
--
-- Not a permission bug. `effectivePrincipals` walks the graph into a `Set`, so
-- a duplicated edge resolves to the same principal set and grants nothing
-- extra. What it is: a table that grows without bound under a directory sync,
-- a membership count that is wrong wherever one is shown, and — worse than
-- either — a uniqueness guarantee the schema appears to make and does not, so
-- the next writer reaches for `ON CONFLICT` and gets silence.
--
-- `NULLS NOT DISTINCT` needs Postgres 15; the Compose image is 17 and
-- docs/config.md has always named 17. Dropping to a pair of partial unique
-- indexes would work on older versions and is not worth carrying a version
-- floor nothing else needs.
--
-- Duplicates are collapsed before the constraint is replaced, or the constraint
-- refuses the rows it exists to prevent. `ctid` is the only thing that
-- distinguishes them, which is what "duplicate" means here.

DELETE FROM group_members a
 USING group_members b
 WHERE a.ctid > b.ctid
   AND a.group_id = b.group_id
   AND a.org_id = b.org_id
   AND a.member_user IS NOT DISTINCT FROM b.member_user
   AND a.member_group IS NOT DISTINCT FROM b.member_group;

ALTER TABLE group_members
    DROP CONSTRAINT IF EXISTS group_members_group_id_member_user_member_group_key;

ALTER TABLE group_members
    ADD CONSTRAINT group_members_member_unique
    UNIQUE NULLS NOT DISTINCT (group_id, member_user, member_group);

COMMENT ON CONSTRAINT group_members_member_unique ON group_members IS
  'NULLS NOT DISTINCT, deliberately: exactly one of member_user and member_group is non-null on every row, so the default NULLS DISTINCT made this constraint match nothing.';
