-- Resolving a credential cannot be scoped to an organization, because the
-- credential is what says which organization it is.
--
-- `PostgresServiceKeys.resolve` reads `service_accounts` by key prefix across
-- every tenant for exactly that reason. It has never worked anywhere the
-- documentation says to deploy it: `org_isolation` calls
-- `current_setting('app.current_org')` in its one-argument form, which raises
-- `unrecognized configuration parameter` rather than returning null, so the
-- query fails outright on any connection that is subject to row-level
-- security. It works in development only because development connects as a
-- superuser — the one configuration `docs/config.md` explicitly forbids:
--
--     $ psql "postgres://nacre_app@…" -c "SELECT id, org_id FROM service_accounts
--                                          WHERE key_prefix = '…'"
--     ERROR:  unrecognized configuration parameter "app.current_org"
--
-- So every service account key stops working the moment an operator follows
-- the rule about not connecting as a superuser. Nothing failed in CI, because
-- CI connects as `postgres` too.
--
-- ─── the fix, and why it is a policy rather than a bypass ───
--
-- The obvious repair is a SECURITY DEFINER function, and it does not work
-- here: these tables carry FORCE ROW LEVEL SECURITY, which applies to the
-- owner as well, so a function running as the owner is still filtered. The
-- alternative — a role with BYPASSRLS — buys a permanent hole in the isolation
-- model to solve a problem that lasts one query.
--
-- Row-level security is the mechanism, so this uses it. A second policy admits
-- the lookup, and only while `app.authenticating` is set on the connection.
-- Policies for the same command are OR'd, so the org-scoped policy is
-- unchanged for every other caller.
--
-- The guard on `org_isolation` is what makes that safe. Without it Postgres
-- may evaluate the org-scoped expression anyway and raise before the second
-- policy is ever consulted; `CASE` short-circuits, so the raising call is not
-- reached while authenticating. It is deliberately left raising in every other
-- case: a query that forgets `withOrg` should fail loudly rather than quietly
-- return nothing, and "quietly returns nothing" is indistinguishable from a
-- permission working correctly, which is the hardest kind of bug to see.

ALTER POLICY org_isolation ON service_accounts
    USING (
        CASE
            WHEN current_setting('app.authenticating', true) = 'on' THEN false
            ELSE org_id = current_setting('app.current_org')::uuid
        END
    );

-- SELECT only. Authentication reads a credential; it never writes one, and a
-- policy that admitted INSERT or UPDATE here would let the one path that runs
-- without an organization create rows in any of them.
CREATE POLICY authenticating ON service_accounts
    FOR SELECT
    USING (current_setting('app.authenticating', true) = 'on');

-- `users` gets neither, and that is a decision rather than an omission. Login
-- resolves the organization from `organizations` — which has no row-level
-- security, because an organization is not inside one — and then reads the
-- user through `withOrg` like everything else. There is no cross-tenant read
-- on the login path, so there is nothing here to open.

-- ─────────────────────── the worker role that was only ever a comment ───────────────────────
--
-- `0001_init.sql` says: "Background worker jobs run under a separate role with
-- BYPASSRLS." No migration ever created it. The worker claims documents across
-- every tenant — that is what a queue is — and those queries run on a raw
-- connection with no organization set, so they raise the same
-- `unrecognized configuration parameter` as the credential lookup did:
--
--     $ psql "postgres://nacre_app@…" -c "SELECT d.id, d.org_id FROM documents d
--                                          JOIN organizations o ON o.id = d.org_id"
--     ERROR:  unrecognized configuration parameter "app.current_org"
--
-- So indexing stops entirely on a deployment that connects as anything but a
-- superuser. The Compose stack has never shown it, because POSTGRES_USER makes
-- the connecting role a superuser — the configuration docs/config.md tells
-- operators not to use.
--
-- BYPASSRLS rather than another policy flag, and the difference from the
-- lookup above is worth being explicit about: authentication reads one column
-- set from one table and never writes, so a narrow SELECT policy fits it. The
-- worker reads and writes documents, chunks and layers across every tenant, so
-- a flag admitting all of that is BYPASSRLS with a worse name and a longer
-- audit trail. The honest thing is to say so in the role.
--
-- Which is also why the worker names org_id explicitly in every query it makes
-- afterwards: with the second line of defence off, the first one is all there
-- is.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nacre_worker') THEN
        CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;
    ELSIF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'nacre_worker') THEN
        ALTER ROLE nacre_worker BYPASSRLS;
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    -- Creating a BYPASSRLS role needs a superuser, and the role running
    -- migrations may not be one. Failing here with the statement to run is the
    -- whole point: the alternative is a worker that starts, claims nothing,
    -- and reports itself healthy.
    RAISE EXCEPTION USING
        MESSAGE = 'nacre_worker could not be created: creating a BYPASSRLS role requires a superuser.',
        HINT    = 'Run this once as a superuser, then re-run migrations: '
                  'CREATE ROLE nacre_worker NOLOGIN BYPASSRLS; '
                  'GRANT nacre_worker TO <the role in NACRE_PG_URL>;';
END
$$;

GRANT USAGE ON SCHEMA public TO nacre_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    organizations, users, groups, group_members, service_accounts,
    embedding_providers, workspaces, layers, documents, chunks, grants
    TO nacre_worker;
GRANT SELECT, INSERT ON audit_events TO nacre_worker;
REVOKE UPDATE, DELETE ON audit_events FROM nacre_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nacre_worker;

-- The application role has to be a member to `SET LOCAL ROLE` to it. Granted
-- rather than assumed: a deployment that manages roles externally will already
-- have done this, and one that does not would otherwise get a worker that
-- connects successfully and cannot claim anything.
GRANT nacre_worker TO nacre_app;
