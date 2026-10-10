-- 0044 — a client may be the URL of its own metadata document, and a
-- registration nobody approved does not stay forever.
--
-- ## Client ID Metadata Documents beside registration
--
-- Until now every client arrived through `POST /oauth/register` (RFC 7591) and
-- got a random `client_id`. A client may now instead *be* an https URL — its
-- `client_id` is the address of a JSON document describing it, which the
-- authorization endpoint fetches through the egress guard and caches here. One
-- table rather than two, because everything downstream — a consent, an
-- authorization, the Connections screen, the access log — joins on
-- `client_id` and should not have to know which way a client arrived.
--
-- `source` says which, and `refresh_after` is when a metadata client's cached
-- document is fetched again. A registered client has none, and the CHECK holds
-- the pair together so neither half can be written without the other.
--
-- ## Registrations expire when nobody approved them
--
-- Registration is open — that is what RFC 7591 is for — and a row permits
-- nothing until a person approves it. Nothing ever removed one, so anybody
-- could grow this table at the rate they could post. The worker now deletes a
-- client with no consent and no authorization that has not been seen for seven
-- days; `last_seen_at` is touched by the authorization endpoint, so a client
-- that registered last week and is being approved today is not deleted under
-- the person approving it.
--
-- The two indexes are for that sweep's `NOT EXISTS`, and for the cascade a
-- client's deletion already implies: neither table had one on `client_id`.

ALTER TABLE oauth_clients
    ADD COLUMN source text NOT NULL DEFAULT 'registered'
        CHECK (source IN ('registered', 'metadata')),
    ADD COLUMN refresh_after timestamptz,
    ADD COLUMN last_seen_at timestamptz,
    ADD CONSTRAINT oauth_clients_metadata_refresh
        CHECK ((source = 'metadata') = (refresh_after IS NOT NULL));

CREATE INDEX IF NOT EXISTS oauth_clients_unseen
    ON oauth_clients ((coalesce(last_seen_at, created_at)));
CREATE INDEX IF NOT EXISTS oauth_consents_client_id ON oauth_consents (client_id);
CREATE INDEX IF NOT EXISTS oauth_authorizations_client_id ON oauth_authorizations (client_id);

-- The application caches a metadata document (an upsert, which needs UPDATE on
-- the columns it rewrites) and notes when a client was last seen. It still may
-- not change `source`: a registered client cannot be turned into one whose
-- document somebody else serves.
GRANT UPDATE (client_name, redirect_uris, refresh_after, last_seen_at) ON oauth_clients TO nacre_app;

-- The sweep runs in the worker, across organizations, because whether a client
-- was approved is a question about every tenant's consents at once.
GRANT DELETE ON oauth_clients TO nacre_worker;
