-- 0024 — a connection you can see, and end.
--
-- 0023 built the flow and stopped one step short. It recorded an authorization
-- *code* — a thing that lives for ninety seconds and is consumed — and nothing
-- that outlives it. So after the exchange there was no record that an
-- application was connected at all, no screen could list one, and **the token
-- could not be taken back**: it is a JWT verified locally against a key, so it
-- is valid until it expires and nothing consults a table.
--
-- That is the gap this closes, and it closes it the way the product already
-- solves the same problem for a person's own session rather than by inventing a
-- second mechanism: a short access token, a long refresh token that is stored
-- and rotated, and revocation that kills the refresh token. The access token
-- then survives at most its own TTL, which is bounded and stated rather than
-- indefinite.
--
-- A denylist of live JWTs was the alternative and is rejected on the same
-- grounds the effective-principals cache was accepted: this one would put a
-- lookup on every single request to undo something that happens once, and a
-- verification that needs a database is no longer local verification.

-- ───────────────────────── the standing connection ─────────────────────────

CREATE TABLE oauth_consents (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id          text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

    -- What the application acts as. Composite, so the database refuses an agent
    -- from another organization rather than the code that writes the insert.
    service_account_id uuid NOT NULL,

    -- Who approved it, and therefore who is shown it as theirs. Not a
    -- permission — an `org_admin` sees every connection in the organization,
    -- because an agent is the organization's and somebody has to be able to end
    -- one whose approver has left.
    approved_by        uuid NOT NULL REFERENCES users(id),

    created_at         timestamptz NOT NULL DEFAULT now(),
    -- Moved when a refresh is exchanged, which is the only signal available:
    -- an access token is verified locally and its use touches nothing. So this
    -- is "last seen renewing" and the column name says so rather than implying
    -- a precision it does not have.
    last_refreshed_at  timestamptz,
    revoked_at         timestamptz,

    -- One connection per application per agent. Approving twice is the same
    -- connection, not a second one — otherwise a screen fills with duplicates
    -- and ending one leaves the others working.
    UNIQUE (org_id, client_id, service_account_id),
    FOREIGN KEY (service_account_id, org_id) REFERENCES service_accounts (id, org_id) ON DELETE CASCADE
);

CREATE INDEX ON oauth_consents (org_id, approved_by, created_at DESC);

ALTER TABLE oauth_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_consents FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON oauth_consents
  USING (org_id = current_setting('app.current_org')::uuid);

-- The code now points at the connection it belongs to, so the exchange knows
-- which one to hang a refresh token on. Nullable because 0023's rows predate
-- it, and they are all consumed or expired by now — a code lives ninety
-- seconds.
ALTER TABLE oauth_authorizations
  ADD COLUMN consent_id uuid REFERENCES oauth_consents(id) ON DELETE CASCADE;

-- ────────────────────────── the refresh token ──────────────────────────

-- Deliberately **not** the `refresh_tokens` table sign-in uses. That one
-- references `users(id)` and is about a person's browser session; this is about
-- an application acting as an agent. Sharing a table would mean a nullable
-- `user_id`, a nullable `consent_id` and a CHECK to say exactly one is set —
-- three ways to describe one relationship, and a revocation query that has to
-- remember which shape it is looking at.
--
-- The rotation rule is the same and is the part worth copying: a used token
-- replays as an attack, because the legitimate holder has already exchanged it
-- and there is no way to tell which of the two holders is genuine. Replaying
-- one ends the whole family.
CREATE TABLE oauth_refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    consent_id  uuid NOT NULL REFERENCES oauth_consents(id) ON DELETE CASCADE,
    -- Hashed. Same rule as a service account key and an authorization code: a
    -- readable long-lived credential in a backup is one nobody revoked.
    token_hash  text NOT NULL UNIQUE,
    -- Every token descended from one authorization shares this. Replaying a
    -- spent token kills the family, not just the token.
    family_id   uuid NOT NULL,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON oauth_refresh_tokens (consent_id) WHERE used_at IS NULL;
CREATE INDEX ON oauth_refresh_tokens (expires_at);

ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens FORCE  ROW LEVEL SECURITY;

-- The same two-policy shape as `oauth_authorizations` and, before it,
-- `service_accounts`: a refresh token is a credential, and a credential is what
-- says which organization it belongs to. The token endpoint is handed one and
-- nothing else.
CREATE POLICY org_isolation ON oauth_refresh_tokens
  USING (
      CASE
          WHEN current_setting('app.authenticating', true) = 'on' THEN false
          ELSE org_id = current_setting('app.current_org')::uuid
      END
  );

-- SELECT only, and this is the property that must not erode: the one path in
-- this system that reads across tenants stays unable to write. The lookup finds
-- which organization a token belongs to and stops; rotating it happens inside
-- `withOrg`, where the `used_at IS NULL` predicate in the UPDATE is what makes
-- a replay lose the race.
CREATE POLICY authenticating_lookup ON oauth_refresh_tokens
  FOR SELECT
  USING (current_setting('app.authenticating', true) = 'on');

GRANT SELECT, INSERT, UPDATE ON oauth_consents TO nacre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_refresh_tokens TO nacre_app;

-- The worker prunes expired refresh tokens the same way it prunes the ones
-- sign-in issues: a table that only grows is one somebody eventually finds
-- full. Consents are not swept — a revoked connection is a record of something
-- that happened, and the screen showing it is the point.
GRANT SELECT, DELETE ON oauth_refresh_tokens TO nacre_worker;
