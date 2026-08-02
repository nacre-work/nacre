-- 0016 — remove the ACL tag cache.
--
-- `docs/authz.md` 3.6 specified `acl_tags` in the vector payload as a second
-- filter alongside the layer bound: "both the layer filter and the tag filter
-- apply". The filter was never built. `buildFilter` is the only filter builder
-- in the codebase and it emits `org_id`, `deleted`, the plan's layers and
-- documents as a `should`, a `must_not` on denied documents, and the caller's
-- metadata narrowing — and no tag clause. So the whole subsystem kept a payload
-- field fresh that no query read.
--
-- Two things settled it, and only the second is decisive.
--
-- **It saves nothing.** The tags were justified as a speed-up over "joining
-- back to Postgres". Nothing joins back: the resolver computes the caller's
-- whole permitted set from `grants` on every request, so the expensive part has
-- already happened by the time a filter is built. A tag clause would be a
-- second constraint derived from the same table, one request later.
--
-- **It cannot express what the product now sells.** `tagsForLayer` read
-- `effect = 'allow'` grants on the layer and its workspace — document-scoped
-- grants were invisible to it, and so were denies. Applied as the `must` the
-- specification asks for, a caller reaching a document through a
-- document-scoped grant would have been filtered *out*: their principal is not
-- in that layer's tag set. Document-scoped grants are issuable now, through
-- `@nacre.work/enterprise-acl-advanced`, so the specified design and a shipped
-- feature could not both be true.
--
-- Making tags per-document would have fixed that and left the other cost: the
-- tag filter is stale by construction, so a *newly granted* document would stay
-- invisible until the sweep caught up. Revocation is already immediate — the
-- plan is computed per request, and the effective-principals cache is keyed on
-- `organizations.groups_version`, which bumps on every write to `grants` — so
-- the trade was a delay on grants in exchange for nothing on revocations.
--
-- What goes with it: the retag sweep, its lease, the propagation gauge and its
-- alert, `NACRE_ACL_TAG_HASH_BYTES` and `NACRE_ACL_PROPAGATION_SLA`. Invariant
-- I4 is unchanged and is now argued structurally rather than measured
-- temporally: there is no cache between a grant change and the next request.
--
-- `organizations.groups_version` stays. It is the effective-principals cache
-- key, which is read on every request, and its triggers are what make that
-- cache safe.

ALTER TABLE documents DROP COLUMN IF EXISTS acl_version;
ALTER TABLE documents DROP COLUMN IF EXISTS acl_tagged_at;

-- Dropped with its column. Named explicitly because a partial index over a
-- dropped column disappears silently, and a reader of 0004 should be able to
-- find where it went.
DROP INDEX IF EXISTS documents_acl_version_idx;

-- `sweep_claimed_at` **stays**, and 0011's name for it is now misleading rather
-- than wrong. It was added for the retag sweep and the collector took it as
-- well: `claimPurgeable` sets it to lease a tombstone so two workers do not
-- purge the same points, and `markPurged` clears it. Dropping it here removed a
-- column the collector reads — caught by the garbage-collection tests against a
-- real database, which is the only place it could have been caught.
COMMENT ON COLUMN documents.sweep_claimed_at IS
  'Lease held by the garbage collector while it purges a tombstone''s vectors. Cleared by markPurged, and reclaimed after NACRE_INDEX_LEASE if the worker holding it dies. Shared with the retag sweep until 0016 removed that sweep.';

COMMENT ON COLUMN organizations.groups_version IS
  'Permission epoch. Bumped by triggers on groups, group_members and grants. Read as the effective-principals cache key — which is what makes caching a permission input safe, since a change composes a different key rather than expiring an old one.';
