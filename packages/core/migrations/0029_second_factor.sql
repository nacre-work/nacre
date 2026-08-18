-- 0029 — a second factor, and the codes that get you back in without one.
--
-- Everything that authenticates a person here has been one secret: a password,
-- or an ID token from an issuer the operator trusts. A password that leaks is
-- an account, and on this product an account is a set of documents somebody
-- decided who may read.
--
-- The specification is docs/authz.md, "Authentication", and the rule it does
-- **not** change: a second factor decides whether a session starts. It grants
-- nothing. Every permission is still computed per request from `grants`.

-- ─────────── the factors ───────────
--
-- One row per enrolled authenticator, so a person can carry two and lose one.
-- `kind` admits only 'totp' today; WebAuthn widens this CHECK in its own
-- migration rather than being written here on speculation — a column shaped for
-- a feature nobody has built is a column the next person has to guess about.
CREATE TABLE user_second_factors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('totp')),

  -- The shared secret, sealed. See `packages/core/authn/totp.ts`: AES-256-GCM
  -- under a key from `NACRE_2FA_KEY_REF`, with the nonce and the tag inside the
  -- value the way `password_hash` carries its scrypt parameters. A database
  -- dump is a thing that happens; a dump that hands over every second factor in
  -- plaintext is a second factor that was never one.
  secret       text NOT NULL,

  -- What a person calls it, because "which of my two phones is this" is a
  -- question they will have and the database cannot answer.
  label        text NOT NULL,

  -- Enrolment is two steps and this is the second: a secret that has never
  -- produced a correct code is a secret the person has not actually got into
  -- their authenticator, and treating it as live is how somebody locks
  -- themselves out at the moment they turn 2FA on. Nothing counts an
  -- unconfirmed row.
  confirmed_at timestamptz,

  -- The time step of the last accepted code. TOTP without this accepts the same
  -- six digits for the whole window, so an attacker who sees one over a
  -- shoulder — or in a phishing proxy — can replay it. Monotonic per factor.
  last_step    bigint,

  -- Brute force is bounded here rather than in Redis. The rate limiter fails
  -- **open** by design, on the argument that it is not an authorization control
  -- and a cache restart must not be an outage. This one is an authorization
  -- control: six digits is a million, and a limiter that forgets is a limiter
  -- an attacker waits out.
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,

  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,

  -- Composite, so a row cannot join a factor in one organization to a user in
  -- another. `group_members` had the plain version of this shape and it would
  -- have handed a foreign user every grant a group held.
  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,

  -- Two authenticators called the same thing is a person unable to tell which
  -- one they are removing.
  UNIQUE (user_id, kind, label)
);

CREATE INDEX ON user_second_factors (user_id) WHERE confirmed_at IS NOT NULL;

-- ─────────── the way back in ───────────
--
-- One row per code, spent once. They are the whole of the answer for the
-- account this installation cannot e-mail: the platform administrator has no
-- organization to administer, and a deployment with no SMTP configured has no
-- recovery link for anybody.
--
-- Hashed with SHA-256 and deliberately **not** with scrypt. A recovery code is
-- 128 bits from the CSPRNG, so there is no dictionary to slow down and no
-- password to protect — the cost parameter would buy nothing and would make
-- issuing ten of them a second of CPU on a request.
CREATE TABLE user_recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL,
  code_hash  text NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  FOREIGN KEY (user_id, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE,

  -- Within one installation a code is unique, so spending one is a single
  -- UPDATE with no read in front of it that another request could race.
  UNIQUE (code_hash)
);

CREATE INDEX ON user_recovery_codes (user_id) WHERE used_at IS NULL;

-- ─────────── second line of defense ───────────
ALTER TABLE user_second_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_second_factors FORCE  ROW LEVEL SECURITY;
ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_recovery_codes FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON user_second_factors USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON user_recovery_codes USING (org_id = current_setting('app.current_org')::uuid);

-- The application reads and writes both; nothing else does. No grant to
-- `nacre_worker`: the worker has no question about who signed in, and a
-- privilege nothing reads is the shape this repository keeps removing.
GRANT SELECT, INSERT, UPDATE, DELETE ON user_second_factors TO nacre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_recovery_codes TO nacre_app;
