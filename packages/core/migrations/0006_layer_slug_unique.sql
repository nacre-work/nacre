-- 0006 — a layer slug is unique within an organization, not within a workspace.
--
-- 0001 made layers unique on (workspace_id, slug). The REST and MCP surfaces
-- address a layer by slug alone — `{"layer": "handbook"}` — and resolve it with
-- `SELECT id FROM layers WHERE org_id = $1 AND slug = $2`. Those two facts
-- disagree: two workspaces in one organization could each hold a `handbook`,
-- and that query would return whichever row the planner reached first.
--
-- The permission check is applied to the id that query returns, so this is not
-- a way to write into a layer you may not write to. It is worse in a quieter
-- way: a caller with write access to their own `handbook` gets a 404 when the
-- lookup lands on the other one, and a caller with access to both writes into
-- whichever the planner picked that day. Neither reports anything wrong.
--
-- Making the slug organization-unique matches how the API already treats it.
-- Addressing layers by workspace-qualified path instead would be the other
-- resolution, and it is a breaking change to every surface that names a layer.

-- Fail loudly rather than let a CREATE UNIQUE INDEX report a duplicate key with
-- no indication of which rows or why it matters.
DO $$
DECLARE
    dup text;
BEGIN
    SELECT string_agg(format('%s (%s)', slug, n), ', ')
      INTO dup
      FROM (
        SELECT slug, count(*) AS n
          FROM layers
         WHERE deleted_at IS NULL
         GROUP BY org_id, slug
        HAVING count(*) > 1
      ) d;

    IF dup IS NOT NULL THEN
        RAISE EXCEPTION
          'layer slugs are not unique per organization: %. Rename them before applying this migration; the API addresses layers by slug alone and cannot tell these apart.', dup;
    END IF;
END
$$;

-- Partial on deleted_at: a deleted layer keeps its slug, and refusing to reuse
-- the name of something nobody can see would be a puzzle with no visible cause.
CREATE UNIQUE INDEX layers_org_slug_key ON layers (org_id, slug) WHERE deleted_at IS NULL;

-- The workspace-scoped constraint stays. It is implied by the new one for live
-- rows, and it still covers deleted ones, which the partial index does not.
