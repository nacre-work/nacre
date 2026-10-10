---
name: authz-change
description: Use when changing anything under packages/core/authz, the grants table, the effective-principals cache, or the vector pre-filter — the permission resolver, deny handling, scope inheritance, ACL tags, or the T1-T44 suite. Also use when a change elsewhere could affect who can see what, such as touching search filters, the org_id path, error codes on missing objects, or tombstones. Triggers on "resolver", "grants", "deny rule", "ACL", "pre-filter", "acl_tags", "effective principals", "permission check".
---

# Changing the permission model

This is the module where a mistake is a leaked document that gets discovered in
an auditor's report. `docs/authz.md` is normative — implement it as written and
raise deviations rather than absorbing them.

## Before touching code

Read `docs/authz.md` in full, not the section you think you need. The rules
interact: rule 5 (any deny beats any allow, at any depth) and rule 4
(inheritance downward) together mean a deny on a workspace kills an explicit
allow on a document beneath it. That row is in the truth table and it is the one
people get wrong.

## The check for every diff

Answer all three explicitly in the PR description — the template asks:

1. **Is filtering still applied during index traversal?** Not after ranking, not
   by fetching more and trimming. If your change adds a code path that receives
   results and removes some, it is wrong regardless of what it removes.
2. **What happens when permission evaluation fails?** Every failure — timeout,
   cache miss that cannot be filled, malformed grant — denies. There is no
   fallback that widens access. Look specifically for `catch` blocks that
   continue.
3. **Are "no permission" and "no such object" still indistinguishable?** Same
   status, same body, same timing characteristics where practical. A different
   error string is a leak.

## Rules easiest to break by accident

- **`write` does not imply `read`** (rule 6), while **`admin` implies both**
  (rule 7). Every other permission system trains the opposite instinct. If you
  find yourself writing `if (perm >= read)`, stop — permissions are not ordered.
- **Deny is absolute, not nearest-wins.** Do not implement "most specific scope
  wins"; that is a different model and it grants access the spec denies.
- **`platform_admin` reads no documents** (rule 2). Administering a tenant is
  not access to its data.
- **The vector payload carries no permission cache.** There is no `acl_tags`:
  migration 0016 removed it — `buildFilter` never emitted the clause, and the
  per-layer tags could not express a document-scoped grant. The permitted
  set is computed from `grants` on every request and the bound is `layer_id`
  (plus document-scoped allows and a `must_not` for denied documents). Do not
  reintroduce a cached tag set — it delays grants and does nothing for
  revocations. `docs/authz.md`, "The vector payload carries no permission
  cache".
- **The effective-principals cache is safe only through its key.** It carries
  `organizations.groups_version`, which triggers bump on every write to
  `groups`, `group_members` and `grants`, so a revoked grant composes a
  different key on the next request. The TTL bounds memory, not staleness.

## Tests

The T1-T44 suite in `docs/authz.md` section "Test plan" is the gate. Tests come
**before** the code they cover — written afterwards they get written to match
what was built rather than what was specified.

- Name tests so the groups `acl-invariants.yml` selects find them —
  `baseline`, `saturation`, `adversarial`, `delegation`, `truth table` and the
  rest it lists. Each step runs `pnpm test:acl:group "<name>"`, which is `-t`
  plus a refusal when the selector matched nothing; `--grep` is not a vitest
  flag.
- Saturation tests (T9, T10) are the ones that catch a post-filter. A
  post-filtering implementation passes every baseline test and fails these.
- The property-based test compares `resolve()` against `reference.ts`. Never
  optimize the reference — an optimized reference agrees with the bug.
- New rule, new row in the truth table, new hand-written case. Do not generate
  the matrix from the implementation; it will agree with itself.

## CI

`acl-invariants` is a separate job from `build` on purpose: a leak shows up as
its own line in the checks list rather than as one failure among unit tests.

Do not add `passWithNoTests` to the acl project at any level, and do not make
the job "temporarily" non-blocking to land something. A green leak-test job that
ran nothing is worse than a red one, because it gets believed.

## Review

Two maintainer approvals, and `@nacre-work/security` is a code owner of this
path. If a change here is urgent enough to want an exception, that is the
strongest available signal it needs the second reviewer.
