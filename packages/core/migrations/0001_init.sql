-- 0001 — initial schema.
--
-- The source of truth for tenants, permissions, metadata, and audit. Vectors
-- live in Qdrant and originals in S3; this holds only what needs transactions.
--
-- Specification: docs/authz.md and docs/architecture.md.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ─────────────────────────── tenants ───────────────────────────

CREATE TABLE organizations (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                citext UNIQUE NOT NULL,
    name                text NOT NULL,
    vector_collection   text NOT NULL,          one Qdrant collection per organization
    quotas              jsonb NOT NULL DEFAULT '{}'::jsonb,
    groups_version      bigint NOT NULL DEFAULT 1,  permission cache invalidation
    created_at          timestamptz NOT NULL DEFAULT now(),
    deleted_at          timestamptz
);

CREATE TABLE sso_configs (
    org_id       uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    protocol     text NOT NULL CHECK (protocol IN ('oidc','saml')),
    issuer       text NOT NULL,
    metadata     jsonb NOT NULL,
    scim_enabled boolean NOT NULL DEFAULT false,
    scim_token_hash text,
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    external_id  text,                          sub from the IdP
    email        citext NOT NULL,
    role         text NOT NULL DEFAULT 'member'
                 CHECK (role IN ('platform_admin','org_admin','workspace_admin','member')),
    password_hash text,                         NULL when SSO-only
    disabled_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, email),
    UNIQUE (org_id, external_id)
);

CREATE TABLE groups (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    external_id text,
    name        text NOT NULL,
    UNIQUE (org_id, name)
);

-- Nested groups. Cycles are the resolver's problem to terminate on, not the
-- schema's to prevent: see docs/authz.md, T14.
CREATE TABLE group_members (
    group_id     uuid NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    member_user  uuid REFERENCES users(id) ON DELETE CASCADE,
    member_group uuid REFERENCES groups(id) ON DELETE CASCADE,
    CHECK (num_nonnulls(member_user, member_group) = 1),
    UNIQUE (group_id, member_user, member_group)
);

CREATE TABLE service_accounts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    name          text NOT NULL,
    key_hash      text NOT NULL,
    key_prefix    text NOT NULL,                first 8 characters, for display only
    last_used_at  timestamptz,
    revoked_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, name)
);
CREATE INDEX ON service_accounts (key_prefix) WHERE revoked_at IS NULL;

-- ─────────────────────── data structure ───────────────────────

CREATE TABLE embedding_providers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid REFERENCES organizations(id) ON DELETE CASCADE,  NULL = global default
    name        text NOT NULL,
    endpoint    text NOT NULL,                  OpenAI-compatible URL
    model       text NOT NULL,
    dimensions  int  NOT NULL,
    credentials_ref text,                       a reference into the secret store, never the secret
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug       citext NOT NULL,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz,
    UNIQUE (org_id, slug)
);

CREATE TABLE layers (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug          citext NOT NULL,
    name          text NOT NULL,
    -- This text is what the MCP search tool's generated description is built
    -- from, so it is user-facing copy, not an internal note.
    description   text NOT NULL DEFAULT '',
    provider_id   uuid NOT NULL REFERENCES embedding_providers(id),
    vector_name   text NOT NULL,                named vector inside the collection
    chunk_config  jsonb NOT NULL DEFAULT '{"size":800,"overlap":120,"strategy":"recursive"}'::jsonb,
    reindex_state jsonb,                        -- {"status":"running","shadow_vector":"v2",...}
    created_at    timestamptz NOT NULL DEFAULT now(),
    deleted_at    timestamptz,
    UNIQUE (workspace_id, slug)
);

CREATE TABLE documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    layer_id      uuid NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    external_id   text,                         client-side idempotency key
    source_type   text NOT NULL CHECK (source_type IN ('s3','url','external_id','inline')),
    source_ref    text,
    title         text,
    content_hash  text NOT NULL,
    version       int  NOT NULL DEFAULT 1,
    status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','parsing','indexing','indexed','failed')),
    error         text,
    metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
    chunk_count   int NOT NULL DEFAULT 0,
    deleted_at    timestamptz,                  tombstone; GC clears the vectors
    vectors_purged_at timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (layer_id, external_id)
);
CREATE INDEX ON documents (layer_id) WHERE deleted_at IS NULL;
CREATE INDEX ON documents (org_id, status);
CREATE INDEX ON documents (content_hash);
-- The garbage-collection queue.
CREATE INDEX ON documents (deleted_at) WHERE deleted_at IS NOT NULL AND vectors_purged_at IS NULL;

-- Chunks are kept for returning text and for tracing. The vector itself is in
-- Qdrant; this table never holds one.
CREATE TABLE chunks (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal       int  NOT NULL,
    text          text NOT NULL,
    token_count   int,
    point_id      uuid NOT NULL,                point id in Qdrant
    UNIQUE (document_id, ordinal)
);

-- ─────────────────────────── permissions ───────────────────────────

CREATE TABLE grants (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    principal_type text NOT NULL CHECK (principal_type IN ('user','group','service_account')),
    principal_id   uuid NOT NULL,
    scope_type     text NOT NULL CHECK (scope_type IN ('workspace','layer','document')),
    scope_id       uuid NOT NULL,
    permission     text NOT NULL CHECK (permission IN ('read','write','admin')),
    effect         text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
    source         text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','scim','api')),
    created_by     uuid REFERENCES users(id),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, principal_type, principal_id, scope_type, scope_id, permission)
);
CREATE INDEX ON grants (org_id, principal_type, principal_id);
CREATE INDEX ON grants (org_id, scope_type, scope_id);

-- ─────────────────────────── audit ───────────────────────────
-- Event schema: docs/audit.md. Append-only — UPDATE and DELETE must be revoked
-- from the application role, not merely avoided by it.

CREATE TABLE audit_events (
    id          bigserial PRIMARY KEY,
    org_id      uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_type  text NOT NULL,
    actor_id    uuid,
    actor_label text NOT NULL,
    action      text NOT NULL,
    surface     text NOT NULL CHECK (surface IN ('api','mcp','admin','system')),
    client      text,                           MCP client name from _meta
    target      jsonb NOT NULL,
    result      text NOT NULL CHECK (result IN ('allow','deny','error')),
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    request_id  text
);
CREATE INDEX ON audit_events (org_id, occurred_at DESC);
CREATE INDEX ON audit_events (org_id, actor_id, occurred_at DESC);
CREATE INDEX ON audit_events USING gin (target);

-- ─────────── second line of defense: RLS ───────────
--
-- The application already filters by org_id. RLS exists so that one forgotten
-- check is a query returning nothing rather than a cross-tenant leak. The
-- application role sets app.current_org on the connection.
--
-- This is defense in depth, not the mechanism. Invariant I1 is enforced in the
-- application and verified again at serialization; do not treat RLS as a
-- reason to skip either.

ALTER TABLE documents  ENABLE ROW LEVEL SECURITY;
ALTER TABLE chunks     ENABLE ROW LEVEL SECURITY;
ALTER TABLE grants     ENABLE ROW LEVEL SECURITY;
ALTER TABLE layers     ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON documents  USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON chunks     USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON grants     USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON layers     USING (org_id = current_setting('app.current_org')::uuid);
CREATE POLICY org_isolation ON workspaces USING (org_id = current_setting('app.current_org')::uuid);

-- Background worker jobs run under a separate role with BYPASSRLS and are
-- required to name org_id explicitly in every query. That role is the one place
-- the second line of defense is off, so it gets the most review.
