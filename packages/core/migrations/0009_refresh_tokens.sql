-- Refresh tokens, for the login flow.
--
-- ─── stored hashed, like every other credential here ───
--
-- The column holds a SHA-256 of the token and never the token. A refresh token
-- outlives an access token by a month, so a database dump that contained them
-- would be a month of sessions rather than a list of identifiers.
--
-- ─── rotation, and what reuse means ───
--
-- Every refresh issues a new token and marks the old one used. A used token
-- presented again is not a client bug worth tolerating: the legitimate holder
-- has already exchanged it, so a second presentation means two parties hold the
-- same token, and one of them stole it. There is no way to tell which, so the
-- whole family is revoked and both are made to sign in again. Annoying once
-- beats a silent, indefinite session for whoever took it.
--
-- `family_id` is what makes that possible: it is the same value for every token
-- descended from one login, so revoking a family ends that session and no other.

CREATE TABLE refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Not unique across the table by accident: it is unique because the token
    -- is 32 bytes from the CSPRNG, and the constraint says so rather than
    -- leaving a collision to become two users sharing a session.
    token_hash  text NOT NULL UNIQUE,
    family_id   uuid NOT NULL,
    issued_at   timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    revoked_at  timestamptz
);

-- The lookup on every refresh: by hash, which is also the uniqueness above.
-- The family index is for revocation, which touches every row of one family.
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id) WHERE revoked_at IS NULL;
-- Expired rows are deleted by a sweep rather than kept forever; ordering by
-- expiry is what makes that sweep cheap.
CREATE INDEX refresh_tokens_expiry ON refresh_tokens (expires_at);

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

-- Scoped like everything else. A refresh token names the organization it was
-- issued for, and the endpoint that redeems one has already resolved that
-- organization from the token's own row — through the authenticating policy
-- below, which is the same mechanism service account keys use and for the same
-- reason: the credential is what says which tenant it belongs to.
CREATE POLICY org_isolation ON refresh_tokens
    USING (
        CASE
            WHEN current_setting('app.authenticating', true) = 'on' THEN false
            ELSE org_id = current_setting('app.current_org')::uuid
        END
    );

CREATE POLICY authenticating ON refresh_tokens
    FOR SELECT
    USING (current_setting('app.authenticating', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO nacre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO nacre_worker;

-- ─── the password column gets a check it never had ───
--
-- `users.password_hash` has existed since 0001 and nothing has ever written to
-- it. Now that something does, an empty string must not be storable: it is
-- falsy in application code and truthy in SQL, which is exactly the shape of
-- difference that becomes an account anyone can sign into.
ALTER TABLE users ADD CONSTRAINT users_password_hash_not_blank
    CHECK (password_hash IS NULL OR length(password_hash) >= 16);
