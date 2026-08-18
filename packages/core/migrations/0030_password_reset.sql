-- 0030 — a password somebody can recover, without a `psql` session.
--
-- `POST /v1/users/{id}/password` has existed since there were users, and it is
-- an *administrator* setting somebody else's. The person who forgot theirs at
-- the weekend had no route at all, and on a single-administrator installation
-- — which the open core mostly is — the administrator who forgets theirs had
-- no route that did not go through the database.
--
-- The specification is docs/api.md, "Recovering a password".

-- ─────────── the token ───────────
--
-- One row per issued link, spent once.
--
-- **No cross-tenant read, and that is why the token carries its organization.**
-- Resolving a credential outside `withOrg` has exactly two mechanisms here and
-- both are narrow on purpose — `0008`'s own words are that `users` gets neither
-- "as a decision rather than an omission". A token shaped `<org_id>.<secret>`
-- means redemption knows the organization before it reads anything, so this
-- table is read through `withOrg` like every other, and nothing here opens a
-- second door into a table that a stranger can reach unauthenticated.
--
-- The organization id is not a secret from the person holding the link: it is
-- in their own `/v1/me`. What is secret is the half beside it.
CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,

  -- SHA-256 of the whole token. Fast on purpose: the secret half is 32 bytes
  -- from the CSPRNG, so there is no dictionary to slow down — the same
  -- reasoning the recovery codes in 0029 carry, and the opposite of a password.
  token_hash text NOT NULL,

  expires_at timestamptz NOT NULL,
  -- Spent by the UPDATE that finds it, so two requests cannot spend one.
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,

  -- Unique across the installation, so redemption is one statement with no read
  -- in front of it that another request could race.
  UNIQUE (token_hash)
);

-- The sweep reads by expiry; redemption reads by hash, which the constraint
-- above already indexes.
CREATE INDEX ON password_reset_tokens (expires_at);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON password_reset_tokens
  USING (org_id = current_setting('app.current_org')::uuid);

-- The application issues, spends and prunes them. Not granted to
-- `nacre_worker`: the worker has no question about who is signing in, and a
-- privilege nothing reads is the shape this repository keeps removing.
GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_tokens TO nacre_app;
