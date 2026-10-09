-- 0039 — a change on the administrative MCP is proposed, and a person applies it.
--
-- docs/mcp-admin.md, "A change is proposed, and a person applies it". A write
-- tool on `/mcp/admin` does not write: it stores what it would do here and
-- answers with that, and the change happens only when the person presses
-- Apply — in the panel the host renders beside the tool's result, or on the
-- console's Proposals screen, under the person's own session. A model can get a
-- change as far as a person's screen and no further, which is what makes an
-- instruction planted in somebody's document cost a refusal rather than a grant.
--
-- A table rather than a signed blob handed back to the client, because three
-- properties are the database's: single use (the UPDATE that claims a row is
-- the only way to apply it), expiry (ten minutes, compared by the database
-- clock), and a record of the ones nobody applied — a stream of proposals that
-- expired is what an injection attempt looks like from the outside, and a blob
-- the client threw away leaves nothing to count.

-- The connection a proposal is bound to, by a composite key so the database
-- refuses one naming another organization's connection rather than the code
-- that writes the insert. `oauth_consents` had no such key until now.
ALTER TABLE oauth_consents ADD CONSTRAINT oauth_consents_id_org_key UNIQUE (id, org_id);

CREATE TABLE admin_proposals (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- The administrative connection that proposed it. Only that connection's
    -- panel may apply it, and revoking the connection ends what it proposed.
    consent_id    uuid        NOT NULL,
    -- The person the connection acts for: the one whose console may apply it.
    proposed_by   uuid        NOT NULL,

    -- Which tool, and which module registered it — NULL for the core's own.
    -- Applying looks the tool up by name again, so a module unloaded since
    -- leaves a proposal nothing can apply rather than one applied by guesswork.
    tool          text        NOT NULL CHECK (tool ~ '^[a-z][a-z0-9_]{0,63}$'),
    module        text,

    -- What the person reads before pressing Apply: one sentence, and the facts
    -- under it. Written by the tool from resolved names, never by the model.
    summary       text        NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
    details       jsonb       NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(details) = 'array'),
    -- What `apply` receives: ids, not names, resolved when it was proposed.
    input         jsonb       NOT NULL CHECK (jsonb_typeof(input) = 'object'),

    status        text        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'applying', 'applied', 'failed', 'cancelled', 'expired')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL,
    decided_at    timestamptz,
    -- Where the person decided: the panel beside the conversation, or the
    -- console. Both are the person; the column says which screen.
    decided_through text      CHECK (decided_through IN ('panel', 'console')),
    -- Why an applied proposal did not take, in the words the tool refused with.
    error         text        CHECK (length(error) <= 1000),

    CHECK (expires_at > created_at),
    FOREIGN KEY (consent_id, org_id)  REFERENCES oauth_consents (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (proposed_by, org_id) REFERENCES users (id, org_id) ON DELETE CASCADE
);

-- The console's question: what is waiting for me.
CREATE INDEX admin_proposals_pending_idx ON admin_proposals (org_id, proposed_by, created_at DESC) WHERE status = 'open';
-- The worker's question: what has run out, across every organization.
CREATE INDEX admin_proposals_expiry_idx ON admin_proposals (expires_at) WHERE status IN ('open', 'applying');

ALTER TABLE admin_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_proposals FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON admin_proposals
  USING (org_id = current_setting('app.current_org')::uuid);

-- No DELETE for either role. A proposal is a record of what an agent asked for,
-- and the ones never applied are the interesting ones; it ends in a status and
-- goes with its organization, never before.
GRANT SELECT, INSERT, UPDATE ON admin_proposals TO nacre_app;
-- The worker expires them across organizations and records that it did.
GRANT SELECT, UPDATE ON admin_proposals TO nacre_worker;
