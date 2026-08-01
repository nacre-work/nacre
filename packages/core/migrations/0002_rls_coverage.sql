-- 0002 — extend row-level security to the rest of the tenant tables.
--
-- 0001 enabled RLS on documents, chunks, grants, layers, and workspaces, and
-- stopped there. Six more tables carry org_id and had no policy: users, groups,
-- service_accounts, sso_configs, embedding_providers, and audit_events. The
-- application filters all of them, which is exactly the assumption RLS exists
-- to survive — one forgotten WHERE on `users` leaks a member list, and one on
-- `audit_events` leaks which documents another organization's staff opened.
--
-- group_members carried no org_id at all, so it could not be constrained even
-- in principle. It is the edge in the graph that effective_principals walks: a
-- row joining a group in one organization to a user in another would hand that
-- user every grant the group holds. Nothing writes such a row today, and
-- nothing structural stopped one.

-- ─────────────────── group_members needs a tenant column ───────────────────

ALTER TABLE group_members ADD COLUMN org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;

UPDATE group_members gm SET org_id = g.org_id FROM groups g WHERE g.id = gm.group_id;

ALTER TABLE group_members ALTER COLUMN org_id SET NOT NULL;

-- Both endpoints must live in the org the row claims. A composite foreign key
-- is what makes that checkable by the database rather than by whoever writes
-- the insert.
ALTER TABLE groups            ADD CONSTRAINT groups_id_org_key            UNIQUE (id, org_id);
ALTER TABLE users             ADD CONSTRAINT users_id_org_key             UNIQUE (id, org_id);

ALTER TABLE group_members
    ADD CONSTRAINT group_members_group_in_org
    FOREIGN KEY (group_id, org_id) REFERENCES groups (id, org_id) ON DELETE CASCADE;

ALTER TABLE group_members
    ADD CONSTRAINT group_members_user_in_org
    FOREIGN KEY (member_user, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE;

ALTER TABLE group_members
    ADD CONSTRAINT group_members_nested_group_in_org
    FOREIGN KEY (member_group, org_id) REFERENCES groups (id, org_id) ON DELETE CASCADE;

CREATE INDEX ON group_members (org_id, group_id);

-- ─────────────────────────── the remaining policies ───────────────────────────

ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups              ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE sso_configs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_providers ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON users            USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON groups           USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON group_members    USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON service_accounts USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON sso_configs      USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON audit_events     USING (org_id = current_setting('app.current_org')::uuid);

-- embedding_providers is the one exception, and it is a real one: a row with a
-- NULL org_id is the installation-wide default model, readable by every
-- organization by design. The policy allows exactly that and nothing else — a
-- provider belonging to another tenant stays invisible, including the endpoint
-- and the credentials reference.
CREATE POLICY org_isolation ON embedding_providers
    USING (org_id IS NULL OR org_id = current_setting('app.current_org')::uuid);

-- Writing a global default is not something a tenant may do.
CREATE POLICY org_writes_own ON embedding_providers
    FOR INSERT WITH CHECK (org_id = current_setting('app.current_org')::uuid);

-- ─────────────────────── RLS that actually applies ───────────────────────
--
-- ENABLE ROW LEVEL SECURITY alone protects nothing from the role that owns the
-- tables, and nothing at all from a superuser. Migrations run as the owner, so
-- in any deployment where the application reuses that connection — which is
-- the default until somebody deliberately splits the roles — every policy in
-- 0001 was inert. It was verified inert: a connection scoped to org B could
-- read org A's documents, layers, and users.
--
-- FORCE makes the policies apply to the owner too. Superusers still bypass
-- them, which is why the application must not connect as one.

ALTER TABLE documents           FORCE ROW LEVEL SECURITY;
ALTER TABLE chunks              FORCE ROW LEVEL SECURITY;
ALTER TABLE grants              FORCE ROW LEVEL SECURITY;
ALTER TABLE layers              FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces          FORCE ROW LEVEL SECURITY;
ALTER TABLE users               FORCE ROW LEVEL SECURITY;
ALTER TABLE groups              FORCE ROW LEVEL SECURITY;
ALTER TABLE group_members       FORCE ROW LEVEL SECURITY;
ALTER TABLE service_accounts    FORCE ROW LEVEL SECURITY;
ALTER TABLE sso_configs         FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events        FORCE ROW LEVEL SECURITY;
ALTER TABLE embedding_providers FORCE ROW LEVEL SECURITY;

-- ─────────────────────────── the audit log is append-only ───────────────────────────
--
-- docs/audit.md requires this at the database level rather than by convention.
-- The application role gets INSERT and SELECT; UPDATE and DELETE are not
-- granted, so a bug cannot rewrite history and neither can an attacker holding
-- the application's credentials.
--
-- The role is created here if it does not exist so that a fresh development
-- database behaves like production. Deployments that manage roles externally
-- can drop this block; the REVOKE below is the part that matters.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nacre_app') THEN
        CREATE ROLE nacre_app NOLOGIN;
    END IF;
END
$$;

GRANT SELECT, INSERT ON audit_events TO nacre_app;
REVOKE UPDATE, DELETE ON audit_events FROM nacre_app;
GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO nacre_app;

-- Everything else the application touches. audit_events is deliberately not in
-- this list; it was granted narrowly above and must stay that way.
GRANT USAGE ON SCHEMA public TO nacre_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
    organizations, users, groups, group_members, service_accounts, sso_configs,
    embedding_providers, workspaces, layers, documents, chunks, grants
    TO nacre_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nacre_app;
