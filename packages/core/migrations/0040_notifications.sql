-- 0040 — notifications and alert rules on the administrative MCP.
--
-- docs/mcp-admin.md, "Notifications". Two ways a message leaves this
-- installation for somebody in an organization: an agent on the administrative
-- surface proposes one and a person applies it, or an alert rule the
-- organization keeps fires and the worker sends it. Both go through the outbox
-- below and nothing else, so the bound on who can receive one is in one place.
--
-- **A recipient is a user id, never an address.** Both tables carry `uuid[]`
-- and a flag for "every org_admin"; the address is read from `users` by the
-- worker at the moment of sending, from the notification's own organization,
-- active accounts only. There is no column an address could be written into,
-- which is the whole of T35's argument: an agent asked to send the access log
-- to somebody outside has no field in which to name them.

CREATE TABLE alert_rules (
    id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id         uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    -- What the rule watches. Each is a question the database can answer from
    -- what it already records; none needs a hook in the code that does it.
    kind           text        NOT NULL CHECK (kind IN (
                       'skill_by_agent',    -- a skill version written by an agent
                       'skill_scripts',     -- a skill version adding scripts
                       'admin_connection',  -- an administrative connection approved
                       'denial_spike',      -- one principal denied N times in a window
                       'documents_failed'   -- N documents failed in a window
                   )),
    -- Narrows the kinds that happen inside one layer. NULL is every layer.
    layer_id       uuid,
    -- The two counting kinds carry both; the others carry neither.
    threshold      int         CHECK (threshold BETWEEN 1 AND 100000),
    window_minutes int         CHECK (window_minutes BETWEEN 5 AND 1440),

    recipients     uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(recipients) <= 20),
    to_org_admins  boolean     NOT NULL DEFAULT false,

    created_by     uuid        NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- Removed rather than deleted: a rule is something an agent proposed and a
    -- person applied, and "which rules did this organization have in May" is a
    -- question the access log alone answers badly.
    removed_at     timestamptz,

    -- Everything recorded up to here has been looked at. The worker advances it
    -- only once what it found has reached the outbox, so a pass refused by the
    -- rate limit is looked at again rather than lost.
    checked_until  timestamptz NOT NULL DEFAULT now(),
    -- A counting rule fires at most once per window: a spike that lasts an hour
    -- is one message, not sixty.
    last_fired_at  timestamptz,

    CHECK (to_org_admins OR cardinality(recipients) > 0),
    CHECK ((kind IN ('denial_spike', 'documents_failed')) = (threshold IS NOT NULL AND window_minutes IS NOT NULL)),
    CHECK (layer_id IS NULL OR kind IN ('skill_by_agent', 'skill_scripts', 'documents_failed')),
    UNIQUE (id, org_id),
    FOREIGN KEY (layer_id, org_id)   REFERENCES layers (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (created_by, org_id) REFERENCES users  (id, org_id) ON DELETE CASCADE
);

-- The worker's question, across organizations: which rules are due a look.
CREATE INDEX alert_rules_due_idx ON alert_rules (checked_until) WHERE removed_at IS NULL;
CREATE INDEX alert_rules_org_idx ON alert_rules (org_id, created_at) WHERE removed_at IS NULL;

ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_rules FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON alert_rules
  USING (org_id = current_setting('app.current_org')::uuid);

CREATE TABLE notifications (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

    recipients    uuid[]      NOT NULL DEFAULT '{}' CHECK (cardinality(recipients) <= 20),
    to_org_admins boolean     NOT NULL DEFAULT false,

    -- Plain text, bounded. No control characters but a newline or a tab in the body,
    -- and none at all in the subject, which becomes a header.
    subject       text        NOT NULL CHECK (length(subject) BETWEEN 1 AND 200 AND subject !~ '[[:cntrl:]]'),
    body          text        NOT NULL CHECK (length(body) BETWEEN 1 AND 4000 AND body !~ '[\x01-\x08\x0b-\x1f\x7f]'),

    -- What sent it. An agent's is applied by a person through a connection, and
    -- the message says both; a rule's names the rule.
    source        text        NOT NULL CHECK (source IN ('agent', 'rule')),
    sent_by       uuid,
    consent_id    uuid,
    rule_id       uuid,

    status        text        NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'dropped')),
    attempts      int         NOT NULL DEFAULT 0,
    not_before    timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),
    claimed_at    timestamptz,
    finished_at   timestamptz,
    -- How many addresses it went to. Fewer than it named is somebody disabled
    -- or removed since; none is `dropped`.
    delivered     int,
    error         text        CHECK (length(error) <= 500),

    CHECK (to_org_admins OR cardinality(recipients) > 0),
    CHECK ((source = 'agent') = (sent_by IS NOT NULL AND consent_id IS NOT NULL)),
    CHECK ((source = 'rule') = (rule_id IS NOT NULL)),
    FOREIGN KEY (sent_by, org_id)    REFERENCES users (id, org_id)          ON DELETE CASCADE,
    FOREIGN KEY (consent_id, org_id) REFERENCES oauth_consents (id, org_id) ON DELETE CASCADE,
    FOREIGN KEY (rule_id, org_id)    REFERENCES alert_rules (id, org_id)    ON DELETE CASCADE
);

-- The worker's claim, across organizations.
CREATE INDEX notifications_queued_idx ON notifications (not_before) WHERE status = 'queued';
-- The rate limit: how many this organization has queued in the last hour.
CREATE INDEX notifications_org_recent_idx ON notifications (org_id, created_at);
-- Retention: finished rows past their window.
CREATE INDEX notifications_finished_idx ON notifications (finished_at) WHERE finished_at IS NOT NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE  ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON notifications
  USING (org_id = current_setting('app.current_org')::uuid);

-- The application proposes and applies: it creates rules, removes them by
-- setting `removed_at`, and queues an agent's notification. It never sends.
GRANT SELECT, INSERT, UPDATE ON alert_rules TO nacre_app;
GRANT SELECT, INSERT ON notifications TO nacre_app;

-- The worker evaluates rules, queues what they find, sends, and forgets a
-- finished message after its retention window. DELETE on the outbox is not
-- the audit table's guarantee being given up: what was sent, to whom and why
-- is `notification.sent` in `audit_events`, which stays append-only. What goes
-- here is the body, which is exactly what should not be kept for ever.
-- (`nacre_app` is a member of `nacre_worker` since 0008 and inherits these.)
GRANT SELECT, UPDATE ON alert_rules TO nacre_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO nacre_worker;

-- What the evaluator and the message's last line read, and only read: a skill
-- version's author and whether it carries scripts, and which application an
-- administrative connection is. The worker had no reason to see any of the
-- three until a rule could ask about them.
GRANT SELECT ON skill_versions, oauth_consents, oauth_clients TO nacre_worker;
