/**
 * Domain vocabulary from docs/authz.md section 3.1.
 *
 * These are contracts, not conveniences. Widening any of them — an extra
 * permission, an extra effect, a scope that is not part of the tree — changes
 * what the resolver is allowed to conclude, so it is a specification change
 * before it is a code change.
 */

/** A principal is identified as `{type}:{id}` wherever it appears as a string. */
export type PrincipalType = 'user' | 'group' | 'service_account'

export interface Principal {
  readonly type: PrincipalType
  readonly id: string
}

/** `user:8f1c…`, `group:2b0a…`. The form ACL tags are hashed from. */
export type PrincipalRef = `${PrincipalType}:${string}`

export function principalRef(p: Principal): PrincipalRef {
  return `${p.type}:${p.id}`
}

/**
 * Scopes form a tree: workspace → layer → document. A grant on a scope reaches
 * everything nested beneath it (rule 4).
 */
export type ScopeType = 'workspace' | 'layer' | 'document'

export interface Scope {
  readonly type: ScopeType
  readonly id: string
}

export type ScopeRef = `${ScopeType}:${string}`

export function scopeRef(s: Scope): ScopeRef {
  return `${s.type}:${s.id}`
}

export type Permission = 'read' | 'write' | 'admin'

export type Effect = 'allow' | 'deny'

export interface Grant {
  /**
   * Carried on the grant itself, not just implied by the query that fetched it.
   * Rule 1 is a precondition rather than part of the ACL, and the resolver
   * re-checks it — a grant that reached the resolver from the wrong tenant is a
   * bug somewhere upstream, and the resolver is the last place to catch it
   * before it becomes a result.
   */
  readonly orgId: string
  readonly principal: Principal
  readonly scope: Scope
  readonly permission: Permission
  readonly effect: Effect
}

/**
 * Roles that bypass the grant table, from rules 2 and 3.
 *
 * `platform_admin` is not "an admin with more power" — it administers
 * organizations and reads no documents at all. Modelling it as a role that
 * short-circuits to *less* access is deliberate; anyone reaching for
 * `if (role === 'platform_admin') allowEverything` has inverted rule 2.
 */
export type OrgRole = 'platform_admin' | 'org_admin' | 'member'
