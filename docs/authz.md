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
- **Delegation** — authority a user hands to an application through the consent
  flow. It is a *token shape*, never a principal: nothing is ever granted to a
  delegation, and `grants.principal_type` does not admit one. See
  "Delegated authority".

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

**I4.** A revoked grant is reflected in the next search. Not eventually and not
within a window: the permitted set is computed per request from `grants`, and
the one cache in front of it is keyed on the organization's permission epoch,
which every write to `grants` moves. This was a 60-second SLA with a metric
attached; the metric measured a cache no query read, and the guarantee is
stronger without it. See "The vector payload carries no permission cache".

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
| T6 | A user is removed from a group | results are empty on the next request |
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
| T11 | A group changes while 1000 queries run concurrently | nothing from the revoked layer on any request after the change |
| T12 | A layer is reindexed during active search | permissions hold on both indexes |
| T13 | A grant issued and revoked in one transaction | no access |
| T14 | Cyclic group nesting (A ⊂ B ⊂ A) | terminates, resolves correctly |
| T15 | 10 000 principals in the filter | search p95 degrades by no more than 2× |

### Delegated authority

A delegation adds a filter clause and an authentication check, so it can fail in
both of the ways this document already guards against, plus one that is its own.

| # | Scenario | Expected |
|---|---|---|
| T16 | A user with grants across two layers, a document-scoped grant and one deny delegates | the delegation resolves exactly what the user resolves — no document more, none fewer |
| T17 | A grant is revoked from the user while a delegation is live | gone from the delegation on the next request, with no renewal in between |
| T18 | The user is disabled, then re-enabled | every delegation refuses with `401` while disabled, and works again after — the grant itself untouched throughout |
| T19 | The application is forgotten while the user's own token keeps working | the delegation refuses; the user is unaffected |
| T20 | A delegation narrowed to layer L, whose user also reads layer M | nothing from M, and never more from L than the user would get |
| T21 | A `platform_admin` attempts to delegate | refused at consent, and a token minted around it refused at validation |
| T22 | 20 layers, the user reads 1, the delegation narrowed to that 1, `top_k=10` | exactly 10 results — the narrowing is inside the traversal, not a trim after it |
| T23 | A delegation with ceiling `{read}`, whose person holds `write` on the layer | reads; every write path answers as it would for a principal with no write at all |
| T24 | A delegation with ceiling `{write}`, whose person holds both | ingests; search returns empty — rule 6 inherited, not collapsed |
| T25 | An `org_admin` delegates with ceiling `{read}` | reads the whole organization, and every `org_admin`-gated endpoint refuses |

T25 is the one that is easy to get half right. A ceiling that bounds documents
and not administration produces a read-only delegation that can mint a service
account key, and the key is then a credential with no ceiling at all.

T22 is the one that matters most and the one a naive implementation passes
everywhere else: a narrowing applied to the result set instead of to the query
returns fewer than `top_k` and looks like "there were only that many". It is the
saturation argument of T9 aimed at the new clause.

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

## The vector payload carries no permission cache

`org_id`, `layer_id`, `doc_id`, `deleted` and the caller's `meta.*` fields, and
nothing else the filter reads. There is no `acl_tags`, and that is a decision
rather than an omission.

**What was specified.** Each chunk was to carry hashes of the principals allowed
to `read` it, as a second constraint alongside the layer bound: "both the layer
filter and the tag filter apply", with a background sweep recomputing them and
`nacre_acl_propagation_lag_seconds` alerting when it fell behind.

**What was built.** The tags, the sweep, its lease, `documents.acl_version`, the
8-byte hashing and the gauge — all of it, and no clause. `buildFilter` is the
only filter builder in the codebase and it never emitted one. So the subsystem
kept a payload field fresh that no query read, and the one alert an operator was
paged by measured the freshness of something unused.

**Why it was removed rather than finished** (migration 0016):

- **It saves nothing.** The justification was avoiding "a join back to
  Postgres". Nothing joins back — the resolver computes the caller's whole
  permitted set from `grants` on every request, so the expensive part has
  already happened by the time a filter is built. A tag clause is a second
  constraint from the same table, one request staler.
- **It cannot express what the product sells.** The tags were computed per
  *layer*, from `effect = 'allow'` grants on the layer and its workspace.
  Document-scoped grants were invisible to them. Applied as the `must` the
  specification asks for, a caller reaching a document through a document-scoped
  grant is filtered *out* — their principal is not in that layer's tag set.
  Document-scoped grants are issuable now, so the specified design and a shipped
  feature could not both hold.
- **It is stale in the wrong direction.** Making the tags per-document would fix
  the point above and leave this one: the intersection of a live plan and a
  cached tag set delays *grants* by up to the sweep interval while doing nothing
  for *revocations*, which the live plan already reflects immediately.
- **The 8-byte truncation conceded the point.** Its safety argument was "the
  query is also bounded by the allowed `layer_id` list" — the layer bound was
  always the thing doing the work.

**Invariant I4 is unchanged, and its evidence moved rather than disappearing.**
It is structural now instead of temporal: there is no cache between a grant
change and the next request. The permitted set is computed per request, and the
one cache in front of it — effective principals — is keyed on
`organizations.groups_version`, which triggers bump on every write to `groups`,
`group_members` and `grants`. A revoked grant is not served stale because the
next request composes a different key, not because something expired.

The T11 cases in `authz/__tests__/propagation.test.ts` assert exactly that,
against a real database and through the adapter rather than the module. That is
a stronger claim than a gauge reading zero, and it is checked on every run
rather than watched.

### There is no `workspace_admin`, and that is deliberate

`users.role` is `platform_admin`, `org_admin` or `member`. It carried a fourth
value, `workspace_admin`, in the schema's CHECK and nowhere else — `OrgRole` has
always been three — so a row holding it read into a type that does not admit it
and behaved as `member`. Safe, and still a role the schema offered that nothing
implemented and nothing refused: setting it silently demoted the user.

Migration 0017 removed it, rather than implementing it, because it is a category
error. `users.role` is organization-wide; administering a workspace is scoped to
one. The model already expresses that, and expresses it better — `admin` on a
`workspace` scope, which one person can hold on several workspaces at once and
which a single column cannot say. A role would have been a second spelling of
one thing, with the resolver deciding which wins.

## Delegated authority

OAuth exists so that a *person* can let an application act for them. Until this
section, the consent flow could only be completed by an `org_admin`, because the
only thing it could offer was a service account and both listing and minting one
are `org_admin`. A member who followed an MCP client's link reached a screen they
could not use. That is the gap this closes.

A **delegation** is authority a user hands to an application. It is deliberately
not a fourth principal type:

> **Nothing is ever granted to a delegation.** `grants.principal_type` still
> admits exactly `user`, `group` and `service_account`. A delegation holds no
> grants of its own, so there is no second grant set, so there is no
> intersection to compute — and therefore no new way for the resolver to be
> wrong.

Service accounts do not go away and are not replaced. An `org_admin` minting an
org-level agent for an unattended pipeline is a different act with a different
lifetime: it belongs to the organization and survives any one person. A
delegation belongs to a person and does not.

### Inheritance

```
authority(delegation) = resolve(delegating user)
filter(delegation)    = buildFilter(authority) ∧ layer_id ∈ narrowing
```

`resolve` is called on the **user**, unchanged — the same effective principals,
the same allow set, the same denies subtracted by ancestry. A delegation
therefore reaches exactly what its user reaches and never one document more.

Four consequences, each of which falls out rather than being enforced:

1. **The token carries the user's id, never a snapshot of the permitted set.**
   Every request re-resolves. A grant revoked, a deny added, a group left — all
   apply on the next request, by the same structural argument invariant I4 rests
   on. Baking the set into the token is the one way to make this wrong, and it
   is forbidden.
2. **Rule 6 is inherited per dimension.** `read`, `write` and `admin` come from
   the user's own resolution. A delegation cannot hold a permission its user
   lacks, because there is no place for one to come from.
3. **The narrowing can only remove.** At consent a person may restrict the
   delegation to chosen layers. That becomes a `must` beside the permission
   filter — the same mechanism `layers` and `filters` already use, and the same
   argument: a narrowing composed wrongly returns *fewer* results, never more.
   It is applied **inside the index traversal**, so invariant I2 holds; a
   narrowing applied to results after they come back is a post-filter and is
   forbidden exactly as any other would be.
4. **The narrowing narrows, and never widens.** There is no way to spend a
   delegation to turn `read` into `write`. Both dimensions are restrictions on
   what the person already holds, applied on top of their resolution; neither
   adds anything.

### The permission ceiling

A person may also restrict a delegation to chosen **permissions**, and this is
the dimension somebody actually asks for first: connecting a search client
should not hand it the ability to delete a document.

The ceiling is a **set**, not a level, because rule 6 makes permissions
unordered. `{read}` is a client that searches. `{write}` alone is an ingest
pipeline that cannot read back what it wrote — which is the shape rule 6 exists
to make expressible, and it would be lost by modelling this as a ladder.
Absent means no ceiling: everything its person holds.

```
authority(delegation) = { p ∈ ceiling : resolve(user, p) }
```

Two things it has to close, and only the first is obvious.

**Documents.** `resolve(user, p)` is `none` when `p` is outside the ceiling.
That is a field on the resolver's input rather than a check in front of each
call, on the same argument the recall gate makes for being a predicate inside
the switch statement: a check in front of N call sites is a check missing from
the N+1th.

**Administration.** `org_admin` reaches every scope with no grants at all — rule
3 — and its other powers, minting a user, creating a service account, reading
the access log, are gated on the *role* rather than on a scope. A ceiling of
`{read}` that left those open would be a read-only delegation that can mint a
credential, which is worse than not having a ceiling.

So the ceiling bounds the role as well, and it is **not** done by rewriting the
role to `member`. An `org_admin` with a `{read}` delegation must still read the
whole organization, and `member` reaches only what grants give — rewriting the
role would silently take away what the person came to delegate. Role and
ceiling are two facts and stay two:

```
administers(auth) = auth.role = 'org_admin' ∧ 'admin' ∈ ceiling
```

Every handler that gated on `auth.role === 'org_admin'` asks that instead. The
comparison is what a lint check now refuses outside that one function — a rule
that has to hold in fifteen handlers, with nothing that knows fifteen, is the
defect this repository keeps re-deriving.

**`read` alone is what a fresh connection proposes.** A consent screen whose
default is everything is a consent screen nobody reads, and a person connecting
an MCP client means "let it search".

**`admin` is a real ceiling value and is not on that screen**, which is a
statement about the screen rather than about the mechanism. The MCP surface has
no administrative tool — its tools resolve with `read` or `write` — so the
choice would do nothing where the person is looking and a great deal through the
REST API, where they are not. That is worse than a control that does nothing.

It stays in the ceiling because it is not an escalation. A ceiling cannot exceed
what its person already holds, so only an `org_admin` can obtain an
administrative delegation, and that is a *weaker* act than the service account
they could mint instead: a delegation stops the moment they are disabled, and a
key pasted into a config file does not.

**`platform_admin` is never delegable.** It spans tenants in the multi-tenancy
module, so a delegation of it would be an escalation out of the organization the
consent screen is scoped to — the same argument that already refuses minting one
from an org-scoped endpoint. Refused at consent *and* again at token validation:
the first is the reachable path, the second is the one that still holds if a
token is ever minted another way.

### Blocking

This is where a delegation differs from everything before it, and the difference
has to be stated rather than inherited.

**Today `disabled` means "cannot sign in", not "cannot act."** `PostgresGrants.issue`
says so in as many words — *"A disabled user is accepted — disabling is
reversible and the grant is meant to survive it"* — and that has been safe
because every existing authority either passes through sign-in or belongs to a
service account carrying its own `revoked_at`. Nothing needed to ask whether a
user may still act *after* a token existed.

A delegation breaks that. It is authority derived from a user, held by a third
party, and renewed without the user present. So on this path, and only on this
path, `disabled` gains a second meaning.

Every request presenting a delegated token performs **one read, before
`resolve`**:

```sql
SELECT d.revoked_at, u.disabled_at, u.role
  FROM delegations d
  JOIN users u ON u.id = d.user_id AND u.org_id = d.org_id
 WHERE d.org_id = $1 AND d.id = $2
```

It refuses when there is no row, when `revoked_at` is set, when the user is
disabled (`users.disabled_at` — the column is a timestamp, not a flag), or when the user's role is `platform_admin`.

**The refusal is `401`, not `404`.** Invariant I4 governs the visibility of
*objects*; this is authentication, and a token that no longer authenticates
reveals nothing about what the organization holds. `401` is also what sends an
MCP client back through discovery and the consent flow, which is the outcome a
person whose access was restored actually wants.

**It is not cached, deliberately.** The effective-principals cache keys on
`organizations.groups_version`, which bumps on `groups`, `group_members` and
`grants` — and **not** on `users`. Putting this check behind that cache would let
a disabled user's delegations keep working for the TTL. That is precisely the lag
the ACL tag cache was removed for, and re-introducing it on the one check whose
whole purpose is immediacy would be worse than not having the check. One indexed
read by primary key, on a connection the request already holds.

| An administrator… | The delegation… | When |
|---|---|---|
| revokes a grant from the user | loses it | next request |
| adds a deny | is bound by it | next request |
| removes the user from a group | loses what came with it | next request |
| **disables the user** | **is suspended, all of them** | next request |
| re-enables the user | works again | next request |
| deletes the user | — see below | — |
| forgets the application | stops | next request |
| revokes the refresh token | cannot renew | at once |

**Suspended, not revoked**, and that reconciles with the sentence above rather
than contradicting it: the *grant* survives a disabling, exactly as
`PostgresGrants.issue` intends. What does not survive is the ability to exercise
it through a delegation while its holder cannot sign in. Disabling is reversible,
so this is too.

**A user is never deleted, and that is structural rather than policy.**
`audit_events` names a user id and `grants.created_by` references `users(id)`
with no cascade, so a deleted administrator is an unresolvable reference in the
one record that must not have one. `DELETE` on a user *is*
`PATCH {"disabled": true}`, through one call, which is what makes the
last-administrator guard hold. So "the user was deleted" is not a state a
delegation has to survive, and the delegation's own foreign key to `users(id)`
keeps it that way.

### A delegation is more revocable than a service account

Worth naming, because it looks like an inconsistency and is not. The connections
screen admits that an access token minted for a service account cannot be taken
back before it expires: it is a JWT verified against a key, and nothing consults
a table when it is presented. A delegation *does* consult a table, because it has
to anyway for the check above — so forgetting an application stops it on the next
request rather than at expiry.

That asymmetry is the right way round. A service account key is pasted into a
config file and lives for years by design; a delegation is a person lending their
own reach to something else, and lending it is the kind of thing people change
their mind about.

## Current state

`packages/core/authz/` holds the resolver (`resolve.ts`), the reference
implementation (`reference.ts`), effective principals (`principals.ts`), the
pre-filter builder (`filter.ts`), and the implication table
(`permissions.ts`).

**T1–T15 run**, against a real Postgres, a real Qdrant, and the HTTP surface
over a real socket, plus the full truth table checked against both
implementations and a property-based comparison between them. `test-plan.ts` is
the inventory, and `packages/core/authz/__tests__/coverage.test.ts` fails if a
case is marked implemented without a test carrying its marker — so the list
cannot drift in either direction. `pnpm authz:pending` prints what is
outstanding, and the CI job prints it on green runs too.

**T16–T25 run**, against a real PostgreSQL, and each was checked by removing
the thing it guards and watching it go red — including the ceiling's two halves
separately: taking it out of the resolver fails T23 and T24, taking it out of
`administers` fails T25, and nothing else moves. They were written before the
implementation on purpose: a test written after the code it covers gets written
to match what was built rather than what was specified.

Delegated authority is built, in both dimensions. A connection may act as the
person who approved it, restricted to chosen layers and to chosen permissions; the token carries their id and the connection's, never a permitted set; the
authentication path asks the database on every request whether that authority
may still be exercised; and the narrowing is enforced wherever a layer id and a
document meet — as a `must` inside the index traversal on search, and as a
refusal on the paths that hold one row and have no traversal to put a clause
inside of.

That makes `acl-invariants` a gate on what this document specifies — and only on
that. A case nobody has thought to write down is still unguarded, and adding one
here is how that changes.

**T11 holds by construction.** The effective-principals cache is keyed on
`organizations.groups_version`, which database triggers increment on every
change to `groups`, `group_members` and `grants`, so a revoked grant cannot be
served at all. The stale entry is not invalidated — it is never asked for again,
because the next request composes a different key. The TTL is a memory bound,
not the correctness mechanism.

The column is the permission epoch rather than a group counter; the name is
narrower than the meaning. `grants` was added to the list in migration 0005, and
until then a revocation moved nothing.

Nothing else sits between a grant change and a query. The payload holds no
permission cache, so there is no second thing to wait for and nothing to
measure a lag against — that whole subsystem is gone, and the reasoning is two
sections up.

**T9 and T10 were the ones to weigh, and they now run.** They are what catches
a post-filter: an implementation that fetches k results and removes the ones the
caller may not see passes every other case in this suite and fails these two.
The pre-filter is also structural rather than conventional — `buildHybridQuery`
takes one filter and applies it to every prefetch branch, and a `Branch` has no
field for a filter of its own, so the "forgot it in one branch" leak is
unrepresentable rather than merely discouraged.
