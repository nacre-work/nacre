# Permissions

> The most consequential document here. Retrieval can be rewritten in a week;
> a mistake in this one is a leaked document that you find out about from an
> auditor's report. Implement it as written. Deviations get discussed first.

## Vocabulary

- **Principal** — a `user`, a `group`, or a `service_account`, written `{type}:{id}`.
- **Scope** — `workspace:{id}`, `layer:{id}`, or `document:{id}`. Scopes form a
  tree: workspace → layer → document.
- **Permission** — `read`, `write`, or `admin`.
- **Effect** — `allow` or `deny`.
- **Grant** — the tuple `(principal, scope, permission, effect)`.
- **Effective principals** of a user — the user, plus every group they belong
  to, transitively.

## Resolution rules

Applied in this order.

1. **Tenant isolation is checked first, and separately.** If
   `token.org_id != resource.org_id` there is no access and no further rule is
   considered. This is not part of the ACL; it is a precondition.
2. **`platform_admin` gets no access to data.** It administers organizations,
   quotas, and the default model. It does not read documents. A separate role
   means a separate audit trail.
3. **`org_admin` holds `admin` on every scope in its organization**, implicitly,
   with no grants.
4. **Inheritance goes down.** A grant on a scope reaches every scope nested
   under it.
5. **Deny beats allow at any level.** Not "nearest wins" — *any* applicable deny
   overrides *any* allow, whatever the depth.
6. **`write` does not imply `read`.** A service account that only uploads
   documents must not be able to search them.
7. **`admin` implies `read` and `write`** within its scope.
8. **Default deny.** No grant means no access.

### Truth table

| On workspace | On layer | On document | Result for the document |
|---|---|---|---|
| allow read | — | — | read |
| allow read | deny read | — | none |
| allow read | — | deny read | none |
| — | allow read | deny read | none |
| deny read | allow read | allow read | **none** — the deny above wins |
| allow write | — | — | write, not read |
| allow admin | — | — | read + write |
| allow admin | deny read | — | write; admin grants write, the deny removes read |
| — | — | allow read | read on that document only |
| — | — | — | none |

Rules 6 and 7 pull against each other on purpose, and the pair is the single
easiest thing to get wrong here — every permission system people have habits
from treats write as a superset of read. `packages/core/authz/permissions.ts`
states the table and nothing else, and its test writes out all nine cases by
hand rather than generating them, so it cannot agree with a wrong
implementation.

## Algorithm

```
effective_principals(user, org) -> Set[Principal]:
    # cached in Redis, TTL 60s, key org:user:groups_version
    return {user} ∪ transitive_groups(user)          # from the SCIM sync

resolve(principals, org, permission) -> AccessPlan:
    grants = SELECT * FROM grants
             WHERE org_id = org AND principal IN principals
               AND permission_implies(granted := permission)

    deny_scopes  = {g.scope for g in grants if g.effect = 'deny'}
    allow_scopes = {g.scope for g in grants if g.effect = 'allow'}

    allow_layers = expand_to_layers(allow_scopes)     # workspace -> its layers
    deny_layers  = expand_to_layers(deny_scopes)
    layers       = allow_layers − deny_layers

    allow_docs   = {s.id for s in allow_scopes if s.type = 'document'}
    deny_docs    = {s.id for s in deny_scopes  if s.type = 'document'}
    # a document denied explicitly is excluded even when its layer is allowed
    return AccessPlan(layers, extra_docs = allow_docs − deny_docs, denied_docs = deny_docs)
```

> **The pseudocode above is incomplete, and the truth table wins.**
>
> `extra_docs = allow_docs − deny_docs` subtracts only *document-scoped*
> denies. It therefore keeps a document that was allowed explicitly while its
> workspace was denied — which is exactly the row
> `deny read | allow read | allow read → none`, the one flagged above as the
> row people get wrong.
>
> `resolve()` checks each granted document against its ancestors instead. Where
> the two disagree, rule 5 governs: any applicable deny beats any applicable
> allow, at any depth. The property-based test compares against the rules, not
> against this sketch, which is how the discrepancy surfaced.
>
> A document whose layer cannot be found is refused rather than allowed —
> invariant I3 applied to a scope that cannot be placed in the tree.

The `AccessPlan` becomes a **pre-filter** on the vector query. Not a
post-filter.

```jsonc
filter = {
  must:     [ {key: "org_id",   match: {value: org}},
              {key: "deleted",  match: {value: false}} ],
  // At least one of these must match — that is what `should` means in Qdrant.
  // Emit only the non-empty ones, and never an empty list: an empty `should`
  // is no constraint at all, so the filter degrades to `must` and returns the
  // whole collection.
  should:   [ {key: "layer_id", match: {any: plan.layers}},
              {key: "doc_id",   match: {any: plan.extra_docs}} ],
  must_not: [ {key: "doc_id",   match: {any: plan.denied_docs}} ]
}
```

> An earlier version of this sketch carried `min_should: 1` alongside `should`.
> Qdrant has no scalar field of that name — `min_should` is an object,
> `{ conditions, min_count }`, for the "at least N of these" case — and the API
> rejects the query outright. Plain `should` already means at least one.

## Invariants

Breaking any of these is an incident, not a bug.

**I1.** No search result carries an `org_id` other than `token.org_id`. Checked
by the filter and then *again* when the response is serialized: a mismatch is a
500 and a journal entry, not a quiet drop. Silently filtering hides the bug that
produced it.

**I2.** The number of results does not depend on whether the filter ran before
or after ranking. A user with access to 1 layer of 20 asking for `top_k=10` gets
10 results — not 10 minus whatever was stripped.

**I3.** A failure to evaluate permissions denies access. There is no "couldn't
compute it, let it through" path — not in the resolver, not in the cache, not in
a degraded mode.

**I4.** A revoked grant is reflected in results within `ACL_PROPAGATION_SLA`
(default 60s). The lag is exported as a metric.

**I5.** A deleted document is never returned, including in the window before
vector garbage collection runs.

**I6.** A request without permission is indistinguishable from a request for
something that does not exist: `404`, never `403`. Otherwise enumerating IDs
tells you which documents exist, which is its own leak.

## Test plan

Ordinary tests do not catch these. All of them are required in CI; any failure
blocks a release.

### Baseline

| # | Scenario | Expected |
|---|---|---|
| T1 | A user of org A searches with an org A token against an index containing org B documents | nothing from B |
| T2 | An org A token with `org_id` swapped to org B in the request body | 403, attempt journaled |
| T3 | `read` on a workspace, `deny read` on one layer | that layer never appears, for any query |
| T4 | `write` without `read` | ingest succeeds, search returns empty |
| T5 | `read` on one document, nothing on its layer | that document is found, its neighbours are not |
| T6 | A user is removed from a group | results are empty within 60s |
| T7 | A document is deleted | not found immediately, before GC |
| T8 | A direct request for another org's `document_id` | 404, not 403 |

### Result saturation

| # | Scenario | Expected |
|---|---|---|
| T9 | 20 layers, access to 1, `top_k=10` | exactly 10 results from the accessible layer |
| T10 | The accessible layer holds 5 documents, `top_k=10` | 5 results, no topping up from elsewhere |

### Adversarial

| # | Scenario | Expected |
|---|---|---|
| T11 | A group changes while 1000 queries run concurrently | nothing from the revoked layer after the SLA |
| T12 | A layer is reindexed during active search | permissions hold on both indexes |
| T13 | A grant issued and revoked in one transaction | no access |
| T14 | Cyclic group nesting (A ⊂ B ⊂ A) | terminates, resolves correctly |
| T15 | 10 000 principals in the filter | search p95 degrades by no more than 2× |

### Property-based test

One is mandatory. Generate random scope trees and grant sets; for every
document, compare `resolve()` against a naive reference implementation written
straight from the rules above. At least 10 000 cases in the nightly build.

`reference.ts` must never be optimized. Its whole value is being obviously
correct: when the optimized `resolve.ts` drifts, the property test catches the
drift. An optimized reference just agrees with the bug.

## The second line of defense

Every table carrying `org_id` has a row-level security policy keyed on
`app.current_org`, set per transaction by `withOrg`. The application filters by
organization anyway, and invariant I1 is re-checked at serialization; RLS is
there so that one forgotten `WHERE` returns nothing rather than another
tenant's rows.

Two details decide whether it works at all:

- **`FORCE ROW LEVEL SECURITY`, not just `ENABLE`.** Policies do not apply to
  the role that owns the tables, and migrations run as the owner. Until
  migration 0002 this schema had policies that were enabled and inert.
- **The application must not connect as a superuser.** Superusers bypass RLS
  whatever the tables say.

There is an integration test for each of those, and a test that no table is
left enabled-but-not-forced.

## Denormalization into the vector payload

Each chunk's payload carries `acl_tags`: hashes of the principals allowed to
`read` it. This speeds up filtering and creates a desynchronization risk.

- `acl_tags` is a **cache, not the source of truth**. The source is the `grants`
  table.
- A grant change enqueues a background recomputation of the affected documents,
  with bounded concurrency.
- Until that finishes, queries are additionally constrained by `plan.layers`
  from Postgres — both the layer filter and the tag filter apply.
- `nacre_acl_propagation_lag_seconds` is mandatory, with an alert above the SLA.

Tags are truncated to 8 bytes. A collision produces a false tag match, but the
query is also bounded by the allowed `layer_id` list, so a single collision
cannot leak.

> **This section describes something the tree does not do, and the tree is not
> the one that is wrong yet.**
>
> `buildFilter` is the only filter builder in the codebase, and it emits
> `org_id`, `deleted`, the caller's `layers`/`extraDocs` as a `should`, a
> `must_not` on `deniedDocs`, and whatever `filters` narrowed. **There is no
> `acl_tags` clause anywhere.** So the whole tag subsystem — the worker's retag
> sweep, its lease, `documents.acl_version`, the 8-byte hashing, and
> `nacre_acl_propagation_lag_seconds` with its alert — keeps a payload field
> fresh that no query reads.
>
> It is **not a leak**, and the reason is worth stating rather than assumed. The
> tag filter would be an *additional* narrowing, and the `should` it would sit
> beside is computed per request from `grants` — which is strictly fresher than
> a cache of `grants`. Anything the tags would exclude, the live plan already
> excludes. Revocation is reflected immediately, by the plan, not within the SLA
> by the sweep.
>
> What that costs is the second line of defence this section is describing, and
> what it makes misleading is the SLA: the gauge measures how far behind a cache
> is, and the runbook offers it as "the only external evidence that revocation
> still propagates". Revocation propagates by a different mechanism, and the
> gauge is silent about that one.
>
> Deciding between building the clause and deleting the subsystem is a change to
> the permission model: it needs the two approvals this path requires, a new row
> in the truth table, and T-cases. Until then this paragraph says which of the
> two disagrees with the other, which is the rule this document is held to.

### `workspace_admin` is in the schema and in nothing else

`users.role` is `CHECK (role IN ('platform_admin','org_admin','workspace_admin','member'))`
and `OrgRole` is three values. A row carrying `workspace_admin` reads into a type
that does not admit it and then behaves as `member`, because it matches neither
of the two role branches in `resolve` and falls through to grant-based
evaluation.

That direction is the safe one — it denies rather than widens — and it is still
a fourth role the schema offers, nothing implements, and nothing refuses. An
operator who sets it gets a silently demoted user and no error. Either the rules
here gain a fourth role or the constraint loses one; both are changes to this
document first.

## Current state

`packages/core/authz/` holds the resolver (`resolve.ts`), the reference
implementation (`reference.ts`), effective principals (`principals.ts`), the
pre-filter builder (`filter.ts`), and the implication table
(`permissions.ts`).

**All 15 cases run**, against a real Postgres, a real Qdrant, and the HTTP
surface over a real socket. T1–T10 and T13–T15, plus the full truth table
checked against both implementations and a property-based comparison between
them. `test-plan.ts` is the inventory, and `packages/core/authz/__tests__/coverage.test.ts`
fails if a case is marked implemented without a test carrying its marker — so
the list cannot drift in either direction. `pnpm authz:pending` prints what is
outstanding, and the CI job prints it on green runs too.

Nothing in the plan is outstanding. That makes `acl-invariants` a gate on what
this document specifies — and only on that. A case nobody has thought to write
down is still unguarded, and adding one here is how that changes.

**T11 is satisfied more strongly than it asks.** The specification allows a
revoked grant to be served for up to `ACL_PROPAGATION_SLA`; the effective
principals cache is keyed on `organizations.groups_version`, which database
triggers increment on every change to `groups`, `group_members` and `grants`,
so a revoked grant cannot be served at all. The stale entry is not invalidated —
it is simply never asked for again, because the next request composes a
different key. The TTL is a memory bound, not the correctness mechanism.

The column is the permission epoch rather than a group counter; the name is
narrower than the meaning. `grants` was added to the list in migration 0005,
and until then a revocation moved nothing — which left
`nacre_acl_propagation_lag_seconds` reporting zero through the one event it is
offered as evidence about.

`acl_tags` remains a cache the SLA does bound, which is why the layer filter
and the tag filter both apply until a recomputation finishes.

The recomputation runs in the indexing worker, in the gaps between documents:
`claimStale` returns documents whose `acl_version` is behind their
organization's, oldest first, and each is retagged with `setPayload` rather than
re-embedded. Indexing has priority — a document nobody can find yet is a worse
outage than a permission cache a few seconds behind, and the SLA has room for
the wait.

A document that fails to retag is left behind rather than marked. It keeps its
old `acl_version`, stays in the next claim, and keeps contributing to the lag.
The alternative is a document that quietly stops being retried while the gauge
reports everything is fine, which is the failure this subsystem exists to make
impossible.

**T9 and T10 were the ones to weigh, and they now run.** They are what catches
a post-filter: an implementation that fetches k results and removes the ones the
caller may not see passes every other case in this suite and fails these two.
The pre-filter is also structural rather than conventional — `buildHybridQuery`
takes one filter and applies it to every prefetch branch, and a `Branch` has no
field for a filter of its own, so the "forgot it in one branch" leak is
unrepresentable rather than merely discouraged.
