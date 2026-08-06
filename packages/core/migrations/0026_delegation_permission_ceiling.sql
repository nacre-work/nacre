-- 0026 — a delegation may be restricted to chosen permissions.
--
-- 0025 gave a person one dimension to narrow on: which layers. This is the
-- other, and it is the one somebody asks for first — connecting a search client
-- should not hand it the ability to delete a document.
--
-- The specification is docs/authz.md, "The permission ceiling".

-- A **set**, not a level, and the column type says so. Rule 6 makes permissions
-- unordered: `write` does not imply `read`, so `{write}` alone is a real answer
-- — an ingest pipeline that cannot read back what it wrote — and a smallint
-- level or an ordered enum could not express it. That case is T24, and it is
-- exactly what a ladder would silently lose.
--
-- NULL means **no ceiling**: everything the person holds. That is deliberately
-- a different value from the empty array, which would mean a delegation that
-- can do nothing — and the CHECK below refuses to store one, on the same rule
-- the layer narrowing follows. A restriction that restricts everything is not a
-- restriction anybody meant to write.
ALTER TABLE oauth_consents
  ADD COLUMN permissions text[];

ALTER TABLE oauth_consents
  ADD CONSTRAINT oauth_consents_permissions_shape CHECK (
    permissions IS NULL
    OR (cardinality(permissions) > 0
        AND permissions <@ ARRAY['read', 'write', 'admin']::text[])
  );

-- A ceiling belongs to a delegation. A service-account connection has one
-- already and it is the account's grants, which are an administrator's to set —
-- a column that looked settable here would be a control that does nothing,
-- which is the shape this schema keeps refusing.
ALTER TABLE oauth_consents
  ADD CONSTRAINT oauth_consents_permissions_delegation_only CHECK (
    permissions IS NULL OR acts_as = 'user'
  );

-- Existing rows keep NULL, which is what they were: 0.6.0 shipped delegations
-- with no ceiling, and reading "no column" as "no ceiling" is the one migration
-- of this shape that does not change an answer.
