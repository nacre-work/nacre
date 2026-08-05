-- 0023 — an authorization server, and an owner for a service account.
--
-- Until now this product was a resource server and said so: it verifies tokens
-- and issues none through OAuth. That was honest and it left a hole an operator
-- fell into on day one — an MCP client's whole connect flow is discover, do the
-- OAuth dance, get a token, and the documented alternative was "make a service
-- account by hand, copy its key, paste it into a config file".
--
-- What is built here is deliberately not the usual answer. A consent screen
-- normally mints a token that acts **as the person who signed in**, and that is
-- the opposite of what this product sells: an agent is a principal of its own,
-- with its own grants, and "which documents may this agent read" is a different
-- question from "which documents may you read". So the code issued here is
-- exchanged for a token bound to a **service account**, and the consent screen
-- is where a person chooses or creates one.
--
-- Three tables and one column.

-- ─────────────────────────── who made an agent ───────────────────────────

-- A service account has never had an owner. `grants.created_by` records who
-- issued a grant; nothing recorded who created the principal it names, because
-- only an `org_admin` could and there were few of them.
--
-- Consent changes that: anyone who may issue a grant may now stand one up, and
-- without an owner an organization accumulates `laptop-agent`, `laptop-agent-2`
-- and nobody able to say whose is whose or to revoke their own.
--
-- Nullable, and that is not laziness: every account that already exists was
-- created before this column and by `init` or by an administrator through the
-- API, so there is no owner to recover. Inventing one — the first
-- administrator, say — would be a record that reads as fact and is a guess.
--
-- ON DELETE SET NULL rather than CASCADE. Deleting a person must not delete the
-- agents they set up; those are the organization's, and their access is decided
-- by grants that outlive whoever created them. (`users` are disabled rather
-- than deleted today, so this is a guard rather than a live path.)
ALTER TABLE service_accounts
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- "My agents", which is the whole reason the column exists.
CREATE INDEX ON service_accounts (org_id, created_by) WHERE revoked_at IS NULL;

-- ────────────────────────── registered clients ──────────────────────────

-- A client registers **before anybody has signed in**, so this row carries no
-- tenant data and gets no `org_id` and no RLS. That is the honest shape rather
-- than a shortcut: a client_id is not access to anything. Authority is created
-- only by a consent a signed-in person completes, and that lives in the table
-- below, which is tenant data and is policed like every other.
--
-- Registration is open, which is what RFC 7591 is for and what an MCP client
-- expects to be able to do. The exposure is bounded by that same fact — a row
-- here permits nothing — plus the rate limiter, and a client is displayed to
-- the person consenting with its redirect URI beside its name, because the name
-- is self-asserted and the redirect URI is the thing that actually decides
-- where a code goes.
CREATE TABLE oauth_clients (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id     text NOT NULL UNIQUE,
    client_name   text NOT NULL,
    -- Exact strings, compared exactly. No wildcards and no prefix matching:
    -- a redirect URI is where an authorization code is delivered, and every
    -- relaxation of that comparison is a way to deliver it somewhere else.
    redirect_uris text[] NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CHECK (cardinality(redirect_uris) > 0)
);

-- ─────────────────────── an authorization in flight ───────────────────────

-- Post-consent, and therefore tenant data: it names a service account, which
-- belongs to an organization.
--
-- The pre-consent half of the flow is deliberately **not** stored. An
-- authorization request that nobody has approved is a set of query parameters
-- the browser is already carrying; writing it down would add a table an
-- unauthenticated caller can fill. The parameters are carried through the
-- consent screen and validated when the consent is posted.
-- The composite key the reference below needs, and the reason it is composite:
-- a plain `REFERENCES service_accounts(id)` would let an authorization in one
-- organization name an agent in another, and the database would allow it. This
-- is the rule every cross-tenant foreign key here follows.
ALTER TABLE service_accounts ADD CONSTRAINT service_accounts_id_org_key UNIQUE (id, org_id);

CREATE TABLE oauth_authorizations (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    client_id          text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,

    -- Who the token will act as. Composite so the database refuses an agent
    -- from another organization, rather than the code that writes the insert.
    service_account_id uuid NOT NULL,

    -- Who approved it. An audit answer to "why does this agent have a token",
    -- and the reason a person can be shown their own consents.
    approved_by        uuid NOT NULL REFERENCES users(id),

    -- The code, hashed. Same rule as a service account key and for the same
    -- reason: a readable authorization code in a backup is a token nobody
    -- revoked. Unique so a hash collision is a constraint violation rather than
    -- two authorizations answering to one code.
    code_hash          text NOT NULL UNIQUE,

    -- PKCE. S256 only — `plain` is in the RFC and defeats the mechanism, so it
    -- is refused at the endpoint and cannot be represented here.
    code_challenge     text NOT NULL,

    -- Compared exactly against the one presented at the token endpoint. RFC
    -- 6749 requires it and it is what stops a code being redeemed through a
    -- different registered client's redirect.
    redirect_uri       text NOT NULL,

    -- RFC 8707. The resource the token is bound to, so an audience-bound token
    -- minted for this installation cannot be replayed at another.
    resource           text,

    -- Short. A code is a bearer capability that exists only long enough to be
    -- exchanged, and the exchange happens within a second of the redirect.
    expires_at         timestamptz NOT NULL,
    -- Set on first exchange. A second attempt is refused **and** is a signal:
    -- either the code leaked or the client is retrying, and neither should
    -- produce a second token.
    consumed_at        timestamptz,
    created_at         timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (service_account_id, org_id) REFERENCES service_accounts (id, org_id) ON DELETE CASCADE
);

-- The lookup the token endpoint makes, and the sweep the worker makes.
CREATE INDEX ON oauth_authorizations (expires_at) WHERE consumed_at IS NULL;
CREATE INDEX ON oauth_authorizations (org_id, approved_by, created_at DESC);

ALTER TABLE oauth_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorizations FORCE  ROW LEVEL SECURITY;

-- The same two-policy shape migration 0008 gave `service_accounts`, and for the
-- identical reason: an authorization code is a credential, and a credential is
-- what says which organization it belongs to. The token endpoint is handed a
-- code and nothing else, so it cannot scope the lookup before it has done it.
--
-- `CASE` and not `AND`: without the guard Postgres may evaluate the org-scoped
-- expression anyway and raise `unrecognized configuration parameter` before the
-- second policy is consulted. Left raising in every other case on purpose — a
-- query that forgot `withOrg` should fail loudly rather than quietly return
-- nothing.
CREATE POLICY org_isolation ON oauth_authorizations
  USING (
      CASE
          WHEN current_setting('app.authenticating', true) = 'on' THEN false
          ELSE org_id = current_setting('app.current_org')::uuid
      END
  );

-- **SELECT only**, which is the load-bearing half. The cross-tenant path reads
-- the code to learn which organization it belongs to and stops there; marking
-- it consumed happens afterwards inside `withOrg`, under that organization,
-- where the `consumed_at IS NULL` predicate in the UPDATE is what makes a
-- second exchange return no rows.
--
-- Splitting it that way is not a weakening. The lookup decides nothing — the
-- UPDATE does, atomically, and a replay loses the race against it. What the
-- split buys is that the one path in this system which spans tenants stays
-- unable to write, which is the property migration 0008 established and which
-- an UPDATE here would have quietly ended.
CREATE POLICY authenticating_lookup ON oauth_authorizations
  FOR SELECT
  USING (current_setting('app.authenticating', true) = 'on');

-- The application role reads and writes both, and can never rewrite a code that
-- has already been issued: `UPDATE` is granted because consumption sets one
-- column, and the endpoint sets only that one.
GRANT SELECT, INSERT ON oauth_clients TO nacre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_authorizations TO nacre_app;

-- The worker sweeps expired authorizations, the same way it prunes refresh
-- tokens: a code nobody exchanged is inert, and a table that only grows is a
-- table somebody eventually finds full.
GRANT SELECT, DELETE ON oauth_authorizations TO nacre_worker;
