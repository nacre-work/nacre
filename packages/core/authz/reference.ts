import type { Grant, OrgRole, Permission, PrincipalRef, Scope } from '../types.js'
import { principalRef } from '../types.js'
import { satisfies } from './permissions.js'
import { ancestry, type ScopeTree } from './scope-tree.js'

/**
 * The reference implementation: the rules of docs/authz.md 3.2, written out
 * one at a time, for one scope at a time.
 *
 * **Do not optimize this file.** Its only value is being obviously correct by
 * inspection, so that the property-based test can catch `resolve.ts` drifting
 * away from it. An optimized reference agrees with the bug it was supposed to
 * find, and the test goes quiet exactly when it matters.
 *
 * It answers one question — "may these principals do X to this one scope?" —
 * and answers it in time proportional to the number of grants. `resolve.ts`
 * answers a different question, "what is the whole permitted set?", which is
 * what a pre-filter needs and what cannot be built by asking this per document.
 */
export interface ReferenceInput {
  readonly orgId: string
  readonly role: OrgRole
  readonly principals: ReadonlySet<PrincipalRef>
  readonly grants: readonly Grant[]
  readonly tree: ScopeTree
}

export function referenceAllows(
  input: ReferenceInput,
  scope: Scope,
  permission: Permission,
): boolean {
  const { orgId, role, principals, grants, tree } = input

  // Rule 2. platform_admin administers organizations and reads no documents.
  // Checked before anything else so no later rule can grant it access.
  if (role === 'platform_admin') return false

  // Rule 3. org_admin holds admin on every scope in its organization,
  // implicitly. Rule 7 then makes that cover read and write.
  if (role === 'org_admin') return true

  // Rule 1 is a precondition, not part of the ACL: a grant from another tenant
  // is not weighed against anything, it is discarded.
  const mine = grants.filter(
    (g) => g.orgId === orgId && principals.has(principalRef(g.principal)),
  )

  const chain = ancestry(scope, tree)
  const covers = (granted: Scope): boolean =>
    // Rule 4. A grant reaches everything nested under it, so it applies when
    // its scope is the target or any of the target's ancestors.
    chain.some((s) => s.type === granted.type && s.id === granted.id)

  const applicable = mine.filter(
    // Rules 6 and 7 live entirely in `satisfies`: write does not imply read,
    // admin implies both.
    (g) => covers(g.scope) && satisfies(g.permission, permission),
  )

  // Rule 5. Any applicable deny beats any applicable allow, at any depth. Note
  // what this is not: it is not "the most specific scope wins". Depth is never
  // compared, which is why the check is a plain `some` over the whole set.
  if (applicable.some((g) => g.effect === 'deny')) return false

  // Rule 8. Default deny — an empty set of allows is no access.
  return applicable.some((g) => g.effect === 'allow')
}
