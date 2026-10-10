-- 0041 — proposals on the administrative MCP are kept as long as the access log.
--
-- 0039 granted no DELETE on `admin_proposals` to either role and said a
-- proposal "goes with its organization, never before". The reason holds: the
-- proposals nobody applied are the interesting ones, because a run of them is
-- what an injection attempt looks like from the outside. What that comment did
-- not weigh is that the access log carries the same record (`proposal.created`
-- with its summary, then `proposal.applied`, `.cancelled` or `.expired`) and
-- *is* pruned, at `NACRE_AUDIT_RETENTION_DAYS`. So a deployment that set ninety
-- days kept every proposal's details and input forever: a skill's whole text,
-- an address, a note. That is a second, longer retention nobody configured.
--
-- So a decided proposal goes when the access log's record of it would. Through
-- a function rather than a grant, for the same reasons as `prune_audit_events`
-- in 0012: it takes a number of days and never a predicate, so it can expire a
-- window and never erase a chosen proposal. And a `DELETE` granted to
-- `nacre_worker` would reach `nacre_app` too, which inherits that role's grants
-- — the API process would then hold a delete on the table it writes proposals
-- into. The function is the narrower thing.
--
-- `open` and `applying` are never touched, whatever their age: one is waiting
-- for a person and the other is a change in flight, and the expiry sweep is
-- what ends both.

CREATE INDEX admin_proposals_decided_idx ON admin_proposals (decided_at)
    WHERE status IN ('applied', 'failed', 'cancelled', 'expired');

CREATE FUNCTION prune_admin_proposals(retention_days integer, max_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- `pg_temp` last, or it is searched first: 0034 is the reason this line is
-- spelled out rather than copied from 0012.
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    removed integer;
BEGIN
    -- The access log's floor, for the access log's reason: below it retention
    -- becomes a way to make a recent proposal go away.
    IF retention_days < 30 THEN
        RAISE EXCEPTION 'retention below the 30 day floor: %', retention_days
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF max_rows < 1 OR max_rows > 100000 THEN
        RAISE EXCEPTION 'max_rows out of range: %', max_rows
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    WITH doomed AS (
        SELECT id
          FROM admin_proposals
         WHERE status IN ('applied', 'failed', 'cancelled', 'expired')
           AND decided_at < now() - make_interval(days => retention_days)
         ORDER BY decided_at
         LIMIT max_rows
    )
    DELETE FROM admin_proposals p
     USING doomed
     WHERE p.id = doomed.id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION prune_admin_proposals(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_admin_proposals(integer, integer) TO nacre_worker;
