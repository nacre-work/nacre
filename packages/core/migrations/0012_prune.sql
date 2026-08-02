-- Two things that grew forever, and the decision about the second one.
--
-- ─── refresh tokens ───
--
-- `0009` said, in a comment on the index built for it: "Expired rows are
-- deleted by a sweep rather than kept forever; ordering by expiry is what makes
-- that sweep cheap." There was no sweep. Every login and every rotation inserts
-- a row and nothing has ever removed one, so the table grows at the rate people
-- sign in — and grows fastest on the deployments that rotate most often, which
-- is to say the ones following the advice.
--
-- Nothing schema-side is needed for that: `nacre_worker` already holds DELETE
-- on `refresh_tokens` from `0009`. The sweep is in the worker. It is mentioned
-- here because this file is where somebody will come looking for it.
--
-- ─── the audit log, which is the actual decision ───
--
-- `NACRE_AUDIT_RETENTION_DAYS` has been validated at startup and read by
-- nothing since it was written, and `docs/audit.md` recorded why: `0002`
-- revokes DELETE on `audit_events` from `nacre_app` on purpose, so retention
-- "has to run as the owner. That is a decision still to be made rather than a
-- line still to be written."
--
-- This is the decision. Retention is implemented, and the append-only guarantee
-- is not weakened, because the two are not in tension once you say what
-- append-only is protecting: it stops history being *rewritten* — a specific
-- inconvenient event erased, a result flipped from deny to allow. Expiring
-- everything older than a published horizon is the opposite of that. It is
-- indiscriminate by construction, it is announced in the configuration, and an
-- auditor can compute exactly which window survives.
--
-- So the grant stays revoked and the pruning goes through one SECURITY DEFINER
-- function whose *shape* is the guarantee, because its shape is the only part
-- that holds against every caller:
--
--   * it takes a retention in days, never a predicate, so no caller can name a
--     row, an actor, an organization, or a result;
--   * it refuses a retention below 30 days, so it cannot be turned into "delete
--     everything" or "delete this morning";
--   * it deletes at most `max_rows` per call, so retention on a long-neglected
--     table is many small transactions rather than one that holds locks for an
--     hour;
--   * it returns the count, so the worker can log what it did and a run that
--     deleted a surprising number is visible rather than silent.
--
-- ─── what the EXECUTE grant below does and does not buy ───
--
-- It states intent and it stops third parties; it does **not** fence the
-- application off, and claiming otherwise here would be worse than not saying
-- it. `0008` grants `nacre_worker` to `nacre_app`, and membership inherits by
-- default, so the API's role can call this function without so much as a
-- SET ROLE. Verified rather than assumed — `SET ROLE nacre_app;
-- SELECT prune_audit_events(400, 10)` succeeds.
--
-- That is fine, and it is fine for a reason worth writing down: the four
-- properties above do not depend on who is calling. `nacre_app` reaching this
-- function can expire a window past a published horizon, which the operator
-- configured and an auditor can compute — and it still cannot erase a chosen
-- event, which is the whole content of the append-only guarantee. Its direct
-- DELETE stays revoked, so the arbitrary path remains closed.
--
-- Anyone with the owner's credentials can still do anything at all. That was
-- already true and no function changes it.

-- 30 days. Below this, retention stops being retention and becomes a way to
-- make recent events go away, which is the thing append-only exists to prevent.
-- Deliberately not configurable: a floor an operator can lower is not a floor.
CREATE FUNCTION prune_audit_events(retention_days integer, max_rows integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned, for the reason 0010 exists: an unqualified name in a definer function
-- resolves through the caller's search_path, and any role may create objects in
-- pg_temp. A shadowed `audit_events` here would be a caller choosing which rows
-- a privileged function deletes.
SET search_path = pg_catalog, public
AS $$
DECLARE
    removed integer;
BEGIN
    IF retention_days < 30 THEN
        RAISE EXCEPTION 'retention below the 30 day floor: %', retention_days
            USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF max_rows < 1 OR max_rows > 100000 THEN
        RAISE EXCEPTION 'max_rows out of range: %', max_rows
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    -- By ctid over a bounded, ordered subquery: the index is
    -- (org_id, occurred_at DESC), so an unbounded `DELETE ... WHERE
    -- occurred_at < cutoff` on a table nobody has pruned in a year is one
    -- statement scanning the lot and holding every row lock it takes until it
    -- commits. Oldest first so repeated calls converge.
    WITH doomed AS (
        SELECT ctid
          FROM audit_events
         WHERE occurred_at < now() - make_interval(days => retention_days)
         ORDER BY occurred_at
         LIMIT max_rows
    )
    DELETE FROM audit_events a USING doomed d WHERE a.ctid = d.ctid;

    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END
$$;

-- The worker, and only the worker. `nacre_app` is the role on the process that
-- serves requests; it has no business pruning anything, and 0002 revoked its
-- DELETE for exactly that reason.
REVOKE ALL ON FUNCTION prune_audit_events(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_audit_events(integer, integer) TO nacre_worker;

-- Expiry alone is not enough to find the sweep's rows cheaply once a family has
-- been revoked for a month and a half: 0009's index is on `expires_at`, which
-- is what the sweep orders by, and that one already exists. Nothing further is
-- needed here — noted so the next person does not add a redundant index.
