-- 0028 — a provider's name is unique within its organization.
--
-- `embedding_providers` never had this because nothing but `init` ever wrote to
-- it: one row, guarded by its own `WHERE NOT EXISTS`, and no second writer to
-- collide with. `POST /v1/embedding-providers` is that second writer.
--
-- The name is what a person picks from a list — the id is a uuid nobody reads —
-- so two rows sharing one is a picker with two identical entries and no way to
-- tell which is which. That is the same defect a duplicate service account name
-- produced, arriving in a different table, and it is cheaper to refuse in the
-- schema than to explain in a screen.
--
-- `NULLS NOT DISTINCT` so the installation default is covered too. Without it
-- `org_id IS NULL` rows never collide with each other, and the one row every
-- tenant reads could quietly become several.
CREATE UNIQUE INDEX embedding_providers_org_name
  ON embedding_providers (org_id, name) NULLS NOT DISTINCT;

COMMENT ON INDEX embedding_providers_org_name IS
  'A provider name is what a person chooses from; the id is a uuid nobody reads.';
