-- 0003 — make groups_version move on its own.
--
-- 0001 gave organizations a groups_version and described it as "permission
-- cache invalidation", and nothing incremented it. A cache keyed on a value
-- that never changes is a cache that never invalidates, so every effective
-- principals entry would have gone stale on the first membership change and
-- stayed stale until its TTL expired — which is the difference between
-- invariant I4 holding by construction and holding if the clock cooperates.
--
-- Incrementing it in the database rather than in the application is the point.
-- Group membership is written by SCIM, by the admin UI, and by the API, and a
-- version bumped by whichever of those remembered would be a version that
-- lies. There is one writer here: Postgres.

CREATE OR REPLACE FUNCTION bump_groups_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    target uuid;
BEGIN
    target := COALESCE(NEW.org_id, OLD.org_id);
    UPDATE organizations SET groups_version = groups_version + 1 WHERE id = target;
    RETURN NULL;   -- AFTER trigger; the return value is ignored
END
$$;

-- Statement-level, not row-level: a SCIM sync replacing a hundred memberships
-- should move the version once, not a hundred times, and every reader only
-- cares that it moved.
CREATE TRIGGER group_members_bump_version
    AFTER INSERT OR UPDATE OR DELETE ON group_members
    FOR EACH ROW EXECUTE FUNCTION bump_groups_version();

-- Groups themselves matter too: deleting a group revokes everything it granted,
-- and the cascade to group_members does not necessarily fire a statement the
-- reader can see.
CREATE TRIGGER groups_bump_version
    AFTER INSERT OR UPDATE OR DELETE ON groups
    FOR EACH ROW EXECUTE FUNCTION bump_groups_version();

-- The function runs as its definer so it can update organizations, which the
-- application role can read but must not rewrite at will.
ALTER FUNCTION bump_groups_version() SECURITY DEFINER;
REVOKE ALL ON FUNCTION bump_groups_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bump_groups_version() TO nacre_app;

-- Reading the version is on the search path, so it gets an index rather than a
-- sequential scan of organizations on every query.
CREATE INDEX IF NOT EXISTS organizations_groups_version_idx ON organizations (id, groups_version);
