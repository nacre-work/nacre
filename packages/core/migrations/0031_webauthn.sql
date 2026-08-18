-- 0031 — a second factor you cannot be phished out of.
--
-- TOTP bounds a stolen password and does not bound a convincing page: six
-- digits typed into `nacre-work.com` work exactly as well there as here, and
-- the person who typed them has no way to know. WebAuthn is the factor whose
-- signature covers the origin, so an assertion produced for the wrong site does
-- not verify at the right one — that is the whole reason to carry a second kind
-- rather than more of the first.
--
-- Everything docs/authz.md says about a second factor is unchanged and applies
-- to this one: it decides whether a session starts, it grants nothing, it is
-- enrolled per person and never on their behalf, and a service account and a
-- delegation are refused. Nothing in packages/core/authz reads any of it.

-- ─────────── the kind ───────────
--
-- 0029 wrote `CHECK (kind IN ('totp'))` and said in its own comment that
-- WebAuthn would widen it "in its own migration rather than being written here
-- on speculation". This is that migration.
ALTER TABLE user_second_factors DROP CONSTRAINT user_second_factors_kind_check;
ALTER TABLE user_second_factors ADD CONSTRAINT user_second_factors_kind_check
  CHECK (kind IN ('totp', 'webauthn'));

-- ─────────── what a WebAuthn factor is made of ───────────
--
-- A TOTP factor is a sealed shared secret; a WebAuthn factor is a public key
-- and has no secret at all. That asymmetry is the feature — a database dump
-- hands over nothing that can produce an assertion — and it is why `secret`
-- becomes nullable below rather than these columns being squeezed into it.
ALTER TABLE user_second_factors
  -- The credential the authenticator minted, base64url as the browser reports
  -- it. Bytes would be tidier in the abstract and worse here: every comparison
  -- this column takes part in arrives as the string a browser sent.
  ADD COLUMN credential_id text,

  -- The public key, as a JWK. COSE and JWK are the same parameters under
  -- different names, and `node:crypto` imports the second directly — so storing
  -- the converted form means the verification path does no parsing at all on a
  -- value that has already been through it once.
  ADD COLUMN public_key jsonb,

  -- The COSE algorithm: -7 ES256, -257 RS256, -8 EdDSA. Kept beside the key
  -- rather than derived from it, because "which algorithm did this credential
  -- register with" is a question about the registration and not about the
  -- key's shape — and an RSA key alone does not say whether PKCS#1 or PSS was
  -- agreed.
  ADD COLUMN alg integer,

  -- The authenticator's own counter. A value that goes backwards is the one
  -- signal WebAuthn offers for a cloned authenticator. Most platform
  -- authenticators never move it, which is allowed and is why this is not
  -- NOT NULL DEFAULT 0 with a monotonic constraint — see the verifier.
  ADD COLUMN sign_count bigint;

-- A TOTP factor has a secret and no key; a WebAuthn factor has a key and no
-- secret. Stated as a constraint rather than left to the application, because
-- the application is one caller and a row with neither is a factor that can
-- never answer.
ALTER TABLE user_second_factors ALTER COLUMN secret DROP NOT NULL;
ALTER TABLE user_second_factors ADD CONSTRAINT user_second_factors_shape CHECK (
  (kind = 'totp'     AND secret IS NOT NULL AND credential_id IS NULL AND public_key IS NULL AND alg IS NULL)
  OR
  (kind = 'webauthn' AND secret IS NULL AND credential_id IS NOT NULL AND public_key IS NOT NULL AND alg IS NOT NULL)
);

-- Within one organization a credential id names one factor. Not installation
-- wide, and that is the point: an assertion here is the *second* step of a
-- sign-in, so the organization and the person are already known and the lookup
-- reads through `withOrg` like everything else. A globally unique index would
-- be a cross-tenant read waiting for somebody to write the query.
CREATE UNIQUE INDEX user_second_factors_credential
  ON user_second_factors (org_id, credential_id)
  WHERE credential_id IS NOT NULL;

-- ─────────── the challenge ───────────
--
-- Every ceremony takes a challenge this server issued, and it has to be
-- **single-use**: the signature covers it, so an assertion captured on the wire
-- is replayable for as long as its challenge is. Nothing else in the ceremony
-- stops that.
--
-- A table rather than a signed, stateless value. A stateless challenge would
-- have to be spent somewhere anyway to be single-use, and a store that only
-- prevents replay is the same store as one that also carries the value — with
-- the difference that this one can be read to see what is outstanding.
CREATE TABLE webauthn_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,

  -- 'register' or 'authenticate'. A challenge issued for enrolment must not be
  -- spendable on a sign-in: the first is asked for by somebody already signed
  -- in, and letting the two share a pool would let a session mint the input to
  -- a ceremony it is not in.
  purpose    text NOT NULL CHECK (purpose IN ('register', 'authenticate')),

  -- base64url, exactly as it goes into `clientDataJSON` and comes back out, so
  -- the comparison is a string equality and never an encoding round trip.
  challenge  text NOT NULL,

  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,

  -- Spending one is a single UPDATE with no read in front of it that another
  -- request could race, which is the same shape `password_reset_tokens` uses.
  UNIQUE (org_id, challenge)
);

CREATE INDEX ON webauthn_challenges (expires_at) WHERE used_at IS NULL;

-- ─────────── second line of defense ───────────
ALTER TABLE webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE webauthn_challenges FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON webauthn_challenges USING (org_id = current_setting('app.current_org')::uuid);

-- The application reads and writes it; nothing else does. No grant to
-- `nacre_worker`, for the reason 0029 gives: the worker has no question about
-- who signed in, and a privilege nothing reads is the shape this repository
-- keeps removing.
GRANT SELECT, INSERT, UPDATE, DELETE ON webauthn_challenges TO nacre_app;
