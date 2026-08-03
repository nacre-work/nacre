-- 0019 — a tenant may read the installation-wide embedding provider, never write it.
--
-- `embedding_providers` is the one table where a NULL `org_id` is legitimate: it
-- is the installation-wide default model, and 0002's `org_isolation` lets every
-- organization *read* it, on purpose. 0002 also carried this, two lines down:
--
--     -- Writing a global default is not something a tenant may do.
--     CREATE POLICY org_writes_own ON embedding_providers
--       FOR INSERT WITH CHECK (org_id = current_setting('app.current_org')::uuid);
--
-- and that policy does nothing. A PERMISSIVE policy is OR'd with the other
-- PERMISSIVE policy for the same command, so on INSERT the effective check is
-- `org_writes_own` OR `org_isolation` — and `org_isolation`'s check admits
-- `org_id IS NULL`. `org_writes_own` is a strict subset of what was already
-- allowed, so adding it changed nothing. It was verified inert against a real
-- database: a connection scoped to org A, as `nacre_app`, could INSERT, UPDATE
-- and DELETE the NULL-`org_id` row every other tenant reads as its default.
--
-- The consequence is the shape the whole schema's FORCE RLS exists to prevent,
-- one table over from where it was checked: repoint that endpoint and every
-- other tenant's documents are embedded by an attacker's service; delete it and
-- every tenant relying on the default stops resolving a model. No core endpoint
-- writes this table, so this is the second line of defence rather than a
-- reachable exploit today — but the second line is exactly what a NULL-`org_id`
-- row needs, because the first line (a handler setting `org_id` from the token)
-- cannot cover a row whose `org_id` is meant to be NULL.
--
-- The fix is RESTRICTIVE policies on the three writing commands. A RESTRICTIVE
-- policy is AND'd with the permissive result, so it can only ever remove access
-- — it cannot widen a read. SELECT carries none, so the global row stays
-- readable by every tenant exactly as before.

DROP POLICY IF EXISTS org_writes_own ON embedding_providers;

-- Each names the writing role's own organization and nothing else. `org_id`
-- NULL fails the equality (NULL = uuid is NULL, not true), which is what keeps
-- the global row out of a tenant's reach on every one of the three commands.
CREATE POLICY tenant_writes_own_insert ON embedding_providers
  AS RESTRICTIVE FOR INSERT
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);

CREATE POLICY tenant_writes_own_update ON embedding_providers
  AS RESTRICTIVE FOR UPDATE
  USING (org_id = current_setting('app.current_org')::uuid)
  WITH CHECK (org_id = current_setting('app.current_org')::uuid);

CREATE POLICY tenant_writes_own_delete ON embedding_providers
  AS RESTRICTIVE FOR DELETE
  USING (org_id = current_setting('app.current_org')::uuid);

-- The installation-wide default is still written once, by `init`, and it is a
-- NULL-`org_id` row — so it now goes in under `nacre_worker`, the same
-- BYPASSRLS role the worker's cross-tenant queue uses. `init` is the only
-- writer of that row (a per-organization provider carries the org's own id and
-- passes the policies above unchanged), which is why the exception is one
-- statement in one bootstrap command rather than a hole in the policy.
COMMENT ON POLICY tenant_writes_own_insert ON embedding_providers IS
  'A tenant writes only its own providers. The NULL-org_id installation default is written by init under nacre_worker; see 0019.';
