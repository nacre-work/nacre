-- 0036 — skills: what an agent is told about this installation, this
-- organization and a layer. docs/skills.md is the specification.
--
-- ─── versions, not rows ───
--
-- A skill is never updated in place. Every write inserts the next version, and
-- the current skill is the newest one. Three things fall out of that and are
-- the reason for the shape:
--
-- - **Rollback is a write.** Going back copies an old version's files into a
--   new one, so history is linear and nothing in it is ever rewritten.
-- - **A stale writer is refused by the database.** A write names the version it
--   was based on and inserts `based_on + 1`; the unique key on the version
--   number turns two writers racing from the same base into one success and one
--   unique violation, which the API answers as `409`. A read-then-compare in the
--   application would need a lock to mean the same thing.
-- - **Clearing is a version too.** A version with no files is "not set", and
--   the level above applies. That keeps "who cleared it, when, through what" in
--   the same history as everything else.
--
-- ─── two tables, because one level is not a tenant's ───
--
-- An organization's and a layer's skill are tenant data, with RLS like every
-- other tenant table. The installation's belongs to no organization: it is read
-- by every one of them and written by a `platform_admin`. Putting it in the
-- tenant table as `org_id NULL` would need a policy that admits NULL rows to
-- every tenant and a write path outside `withOrg` — and that path is exactly
-- what this repository refuses without naming the mechanism. A table with no
-- `org_id` holds nothing of any tenant's, needs no policy, and is read inside
-- `withOrg` like any shared reference data.

CREATE TABLE skill_versions (
    org_id      uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- NULL is the organization's own skill; a layer id is that layer's.
    layer_id    uuid,
    version     int         NOT NULL CHECK (version >= 1),

    -- `{ "SKILL.md": "…", "references/x.md": "…" }`, exactly as written. The
    -- bounds are the API's — 64 files, 256 KiB each, 1 MiB in all — and the
    -- total is held here as well, because the two disagree exactly when
    -- somebody writes to the database by hand.
    files       jsonb       NOT NULL CHECK (jsonb_typeof(files) = 'object'),
    CONSTRAINT skill_versions_size CHECK (octet_length(files::text) <= 1310720),

    -- Read out of SKILL.md's frontmatter on write, so a listing does not parse
    -- every skill it names. NULL on a cleared version.
    name        text        CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
    description text        CHECK (length(description) BETWEEN 1 AND 1024),
    has_scripts boolean     NOT NULL DEFAULT false,

    -- Who wrote it and through what, which is the whole of "a version written
    -- by an agent says so". `principal` is `{type}:{id}`, the shape the access
    -- log uses; `connection_id` is the delegation when there was one.
    principal     text      NOT NULL,
    surface       text      NOT NULL CHECK (surface IN ('rest', 'mcp', 'mcp-admin')),
    connection_id uuid,
    -- The version a restore copied, so history can say "restored from 3".
    restored_from int,
    created_at  timestamptz NOT NULL DEFAULT now(),

    -- A cleared version carries no name; a written one carries both fields.
    CONSTRAINT skill_versions_named CHECK (
        (files = '{}'::jsonb AND name IS NULL AND description IS NULL)
        OR (files <> '{}'::jsonb AND name IS NOT NULL AND description IS NOT NULL)
    ),
    -- Composite, so a row cannot name a layer in another organization while
    -- claiming this one: 0015 added the key for exactly this.
    CONSTRAINT skill_versions_layer_in_org
        FOREIGN KEY (layer_id, org_id) REFERENCES layers (id, org_id) ON DELETE CASCADE
);

-- One version number per skill. NULLS NOT DISTINCT, because the organization's
-- own skill has a NULL layer and a plain unique index would let two rows claim
-- version 1 of it — the race this key exists to refuse.
CREATE UNIQUE INDEX skill_versions_version
    ON skill_versions (org_id, layer_id, version) NULLS NOT DISTINCT;

ALTER TABLE skill_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE skill_versions FORCE  ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON skill_versions
    USING (org_id = current_setting('app.current_org')::uuid);

-- Insert and read. Never UPDATE or DELETE from the application: a version is a
-- record of what agents were told, and rewriting one rewrites that record. A
-- deleted layer's versions go with it through the cascade, run by the
-- collector.
GRANT SELECT, INSERT ON skill_versions TO nacre_app;

CREATE TABLE installation_skill_versions (
    version       int         PRIMARY KEY CHECK (version >= 1),
    files         jsonb       NOT NULL CHECK (jsonb_typeof(files) = 'object'),
    CONSTRAINT installation_skill_versions_size CHECK (octet_length(files::text) <= 1310720),
    name          text        CHECK (name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(name) <= 64),
    description   text        CHECK (length(description) BETWEEN 1 AND 1024),
    has_scripts   boolean     NOT NULL DEFAULT false,
    principal     text        NOT NULL,
    -- Never 'mcp' or 'mcp-admin': rights spanning tenants stay in the API and
    -- the console, and the constraint says so where a hand-written insert would
    -- otherwise get round it.
    surface       text        NOT NULL CHECK (surface = 'rest'),
    restored_from int,
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT installation_skill_versions_named CHECK (
        (files = '{}'::jsonb AND name IS NULL AND description IS NULL)
        OR (files <> '{}'::jsonb AND name IS NOT NULL AND description IS NOT NULL)
    )
);

GRANT SELECT, INSERT ON installation_skill_versions TO nacre_app;
