-- 0043 — a directory's id names one group, or SCIM writes into whichever it finds.
--
-- `users` has carried `UNIQUE (org_id, external_id)` since 0001, because an
-- identity provider's subject that matched two people would sign in as either.
-- `groups.external_id` never had the same constraint, and nothing wrote the
-- column but SQL until 0.40.0 gave it an API. SCIM addresses a group by it —
-- `PATCH /v1/admin/scim/Groups/{externalId}` — so two groups linked to one
-- directory id would have had membership synced into an arbitrary one of them,
-- and with it the grants that group holds.
--
-- Partial, because an unlinked group has no external id and any number of them
-- may be unlinked. On an installation where somebody linked two groups to one
-- id by hand, this fails and names the index: that is a mapping to resolve, not
-- one for a migration to pick between.

CREATE UNIQUE INDEX IF NOT EXISTS groups_org_id_external_id_key
    ON groups (org_id, external_id)
    WHERE external_id IS NOT NULL;
