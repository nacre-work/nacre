-- 0037 — a delegation's ceiling may hold `skill`.
--
-- The consent screen offers, per layer, "edit this layer's skill", and only on a
-- layer where the person holds `admin`. It is stored as `skill` in that layer's
-- ceiling, and therefore in the connection's: the consent handler refuses a
-- per-layer set the connection's ceiling excludes, and this value is no
-- exception to that rule. The specification is docs/skills.md, "Who writes
-- what".
--
-- `skill` is **not a permission**. `resolve` never sees it: the API strips it
-- before building a resolve input, so no search, ingest, grant or delete path
-- can be reached through it, and one function reads it — `skill-ceiling.ts`,
-- held there by `lint:skill-ceiling`. It widens nothing by being stored. It
-- only lets a token do what its person may already do on that layer, and only
-- that one thing.
--
-- Why not `admin` in the layer's ceiling, which already lets a delegation write
-- the skill: a token from the consent flow reaches REST as well as MCP, so
-- `admin` would let an MCP client rename the layer, delete it and issue grants
-- on it. Editing what agents are told is a narrower thing to approve.
--
-- The constraints are replaced rather than altered, because Postgres has no
-- ALTER for a CHECK. Every existing row satisfies the new one, since it admits
-- a superset, so this validates without rewriting anything.

ALTER TABLE oauth_consents
  DROP CONSTRAINT oauth_consents_permissions_shape;

ALTER TABLE oauth_consents
  ADD CONSTRAINT oauth_consents_permissions_shape CHECK (
    permissions IS NULL
    OR (cardinality(permissions) > 0
        AND permissions <@ ARRAY['read', 'write', 'admin', 'skill']::text[])
  );

ALTER TABLE oauth_consent_layers
  DROP CONSTRAINT oauth_consent_layers_permissions_shape;

ALTER TABLE oauth_consent_layers
  ADD CONSTRAINT oauth_consent_layers_permissions_shape CHECK (
    permissions IS NULL
    OR (cardinality(permissions) > 0
        AND permissions <@ ARRAY['read', 'write', 'admin', 'skill']::text[])
  );
