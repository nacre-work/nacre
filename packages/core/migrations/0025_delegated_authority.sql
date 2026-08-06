-- 0025 — an application may act as the person who approved it.
--
-- OAuth exists so a *person* can let an application act for them, and until now
-- the consent flow could only be completed by an `org_admin`: the only thing it
-- could offer was a service account, and both listing and minting one are
-- `org_admin`. A member who followed an MCP client's link reached a screen they
-- could not use — an empty picker, then a 404 after pressing Approve.
--
-- The specification is docs/authz.md, section "Delegated authority". The part
-- this file is responsible for:
--
--   * A delegation is **not** a principal. Nothing is granted to one, so
--     `grants.principal_type` is untouched and still admits exactly `user`,
--     `group` and `service_account`. With no second grant set there is no
--     intersection to compute, and therefore no new way for the resolver to be
--     wrong.
--
--   * A delegation is a *variant of a connection*, not a second mechanism.
--     0024 already built the standing connection, its rotation and its
--     revocation; all this adds is what the connection acts as.

-- ───────────────────────── what a connection acts as ─────────────────────────

-- A discriminator rather than "service_account_id IS NULL means delegation".
-- Inferring a mode from a null is how a later `LEFT JOIN` silently produces a
-- third state nobody designed, and this column is read on the authentication
-- path where a surprise is a security question.
ALTER TABLE oauth_consents
  ADD COLUMN acts_as text NOT NULL DEFAULT 'service_account'
    CHECK (acts_as IN ('service_account', 'user'));

-- Null for a delegation: it acts as `approved_by`, which is already here and
-- already references `users(id)`.
ALTER TABLE oauth_consents ALTER COLUMN service_account_id DROP NOT NULL;

-- The two modes, stated so the database refuses a row that is half of each.
-- Without this, dropping NOT NULL above would admit a service-account
-- connection that names no service account.
ALTER TABLE oauth_consents
  ADD CONSTRAINT oauth_consents_acts_as_shape CHECK (
      (acts_as = 'service_account' AND service_account_id IS NOT NULL)
   OR (acts_as = 'user'            AND service_account_id IS NULL)
  );

-- 0024's `UNIQUE (org_id, client_id, service_account_id)` stops being enough:
-- NULLs are distinct in a unique index, so approving the same application twice
-- as yourself would make a second connection, and ending one would leave the
-- other working. One connection per application per person, same rule as the
-- one 0024 states for agents.
CREATE UNIQUE INDEX oauth_consents_delegation_key
    ON oauth_consents (org_id, client_id, approved_by)
 WHERE acts_as = 'user';

-- ─────────────────────────────── the narrowing ───────────────────────────────

-- Chosen layers, and a row per layer rather than a `uuid[]` column.
--
-- An array cannot carry a foreign key, so a deleted layer would leave an id in
-- it forever — and `DELETE /v1/layers/{id}` exists and already takes the grants
-- naming the layer with it. A join table gets that cascade from the database
-- instead of from whoever remembers to write it.
--
-- No rows for a connection means **no narrowing**, not "narrowed to nothing".
-- The two are opposite and the code must not conflate them: a delegation
-- narrowed to zero layers is one that can reach nothing, and it is not a state
-- this table can express, deliberately — a caller with an empty narrowing gets
-- an empty result without a query, which is what `buildFilter` already refuses
-- to express as a filter.
CREATE TABLE oauth_consent_layers (
    org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consent_id uuid NOT NULL REFERENCES oauth_consents(id) ON DELETE CASCADE,
    layer_id   uuid NOT NULL,

    PRIMARY KEY (consent_id, layer_id),
    -- Composite, so a narrowing cannot name a layer in another organization.
    -- The database refuses it rather than the code that writes the insert —
    -- the rule db-migration states for every foreign key that crosses tenants.
    FOREIGN KEY (layer_id, org_id) REFERENCES layers (id, org_id) ON DELETE CASCADE
);

CREATE INDEX ON oauth_consent_layers (org_id, consent_id);

ALTER TABLE oauth_consent_layers ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_consent_layers FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON oauth_consent_layers
  USING (org_id = current_setting('app.current_org')::uuid);

-- ────────────────────── what the authentication path reads ──────────────────────

-- The check docs/authz.md specifies, as an index rather than as a hope: every
-- request carrying a delegated token joins `oauth_consents` to `users` by
-- primary key, and refuses on a missing row, on `revoked_at`, on
-- `users.disabled`, or on `users.role = 'platform_admin'`.
--
-- It is deliberately **not** cached. The effective-principals cache keys on
-- `organizations.groups_version`, which triggers bump on `groups`,
-- `group_members` and `grants` — and not on `users`. Putting this behind that
-- cache would let a disabled user's delegations keep working for the TTL, which
-- is the lag the ACL tag cache was removed for. One indexed read, on a
-- connection the request already holds.
--
-- `oauth_consents` is already RLS'd to the organization and the token names the
-- organization, so this reads inside `withOrg` like everything else. There is no
-- cross-tenant lookup here and therefore no `app.authenticating` policy: unlike
-- a refresh token, a delegated *access* token says which organization it belongs
-- to before anything is read.
CREATE INDEX ON oauth_consents (org_id, id) WHERE revoked_at IS NULL;

GRANT SELECT, INSERT, DELETE ON oauth_consent_layers TO nacre_app;
