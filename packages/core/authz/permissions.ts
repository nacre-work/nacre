import type { Permission } from '../types.js'

/**
 * Which permissions a single granted permission satisfies.
 *
 * Two rules from docs/authz.md section 3.2 meet here, and they pull in
 * opposite directions:
 *
 *   rule 6 — `write` does not imply `read`. A service account that only
 *            uploads documents must not be able to search them.
 *   rule 7 — `admin` implies `read` and `write` within its scope.
 *
 * The asymmetry is deliberate and is the single most common thing to get
 * wrong here, because every other permission system in common use treats
 * write as a superset of read. Invariant 6 exists precisely because this one
 * does not.
 */
const IMPLIES: Readonly<Record<Permission, ReadonlySet<Permission>>> = {
  read: new Set<Permission>(['read']),
  write: new Set<Permission>(['write']),
  admin: new Set<Permission>(['read', 'write', 'admin']),
}

/**
 * The set of permissions `granted` satisfies.
 *
 * Returns a copy. Handing out the module's own set would let any caller widen
 * everyone's permissions with one `add()` — a process-wide privilege
 * escalation reachable from a typo. The sets hold at most three elements and
 * this is not the hot path; `satisfies` is, and it never allocates.
 */
export function implied(granted: Permission): ReadonlySet<Permission> {
  return new Set(IMPLIES[granted])
}

/**
 * Does holding `granted` satisfy a request for `requested`?
 *
 * This answers one grant against one request and nothing else. It knows
 * nothing about scopes, inheritance, deny, or tenancy — resolve.ts composes
 * those on top. Keeping it that narrow is what makes it cheap to state as a
 * table and cheap to test exhaustively.
 */
export function satisfies(granted: Permission, requested: Permission): boolean {
  return IMPLIES[granted].has(requested)
}
