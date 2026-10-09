-- 0038 — a connection to the administrative MCP is a connection of its own.
--
-- docs/mcp-admin.md: `/mcp/admin` is a separate resource with its own token
-- audience, so that `admin` can be on its consent screen without the token
-- reaching REST. The audience is chosen when a token is minted, and a token is
-- minted from a connection — on the first exchange and on every renewal — so
-- the connection has to say which resource it is for. A column rather than a
-- claim carried from the authorization request, because a renewal has no
-- request to read it from.

-- `default` is every connection that exists: the token reaches the API and
-- `/mcp`, as it always has. `admin` reaches `/mcp/admin` and nothing else.
ALTER TABLE oauth_consents
  ADD COLUMN surface text NOT NULL DEFAULT 'default'
  CHECK (surface IN ('default', 'admin'));

-- People only. A service account holds grants and never the `org_admin` role,
-- so an administrative connection acting as one would administer nothing — and
-- a constraint is what makes "nothing" structural rather than a check some
-- future handler has to remember.
ALTER TABLE oauth_consents
  ADD CONSTRAINT oauth_consents_admin_is_delegation CHECK (surface = 'default' OR acts_as = 'user');

-- One connection per application, per person, **per surface**. The same client
-- — Claude, say — connected to both resources is two connections with two
-- ceilings and two refresh-token families, and ending one must not end the
-- other. Without the column in the key, approving the administrative screen
-- would overwrite the person's ordinary connection to the same application.
DROP INDEX oauth_consents_delegation_key;
CREATE UNIQUE INDEX oauth_consents_delegation_key
    ON oauth_consents (org_id, client_id, approved_by, surface)
 WHERE acts_as = 'user';

-- And the access log names the surface. Every call through `/mcp/admin` is
-- recorded as `mcp-admin`, which is what lets an administrator tell what an
-- agent did on their behalf from what they did in the console. Replaced rather
-- than altered, because Postgres has no ALTER for a CHECK; every existing row
-- satisfies the new one, which admits a superset.
--
-- `UPDATE` and `DELETE` stay revoked from the application role: this changes a
-- constraint and grants nothing.
ALTER TABLE audit_events DROP CONSTRAINT audit_events_surface_check;
ALTER TABLE audit_events
  ADD CONSTRAINT audit_events_surface_check CHECK (surface IN ('api', 'mcp', 'mcp-admin', 'admin', 'system'));
