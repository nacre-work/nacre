import type { Principal, PrincipalRef } from '../types.js'
import { principalRef } from '../types.js'

/**
 * Group membership for one organization. Groups nest, and the nesting is
 * supplied by an external SCIM sync, which means it is not trusted to be
 * acyclic — see T14.
 */
export interface GroupGraph {
  /** Groups the principal is a direct member of. */
  directGroups(principal: PrincipalRef): readonly string[]
}

export interface GroupGraphData {
  /** principal ref (`user:…` or `group:…`) → group ids it belongs to */
  readonly membership: Readonly<Record<string, readonly string[]>>
}

export class MemoryGroupGraph implements GroupGraph {
  readonly #membership: Map<string, readonly string[]>

  constructor(data: GroupGraphData) {
    this.#membership = new Map(Object.entries(data.membership))
  }

  directGroups(principal: PrincipalRef): readonly string[] {
    return this.#membership.get(principal) ?? []
  }
}

/**
 * The principal plus every group it belongs to, transitively.
 *
 * Cycles terminate. A membership graph arriving from someone else's IdP over
 * SCIM can contain A ⊂ B ⊂ A, and the correct response is to resolve the
 * reachable set and move on — not to throw, and certainly not to recurse until
 * the stack gives out. An exception here would surface as a permission
 * evaluation failure, which denies access (rule I3), so an unrelated
 * directory-hygiene problem in a customer's IdP would read as an outage.
 *
 * Iterative rather than recursive for the same reason: 10 000 principals is a
 * documented case (T15), and that is well past a comfortable stack depth.
 */
export function effectivePrincipals(
  principal: Principal,
  graph: GroupGraph,
): ReadonlySet<PrincipalRef> {
  const self = principalRef(principal)
  const seen = new Set<PrincipalRef>([self])
  const queue: PrincipalRef[] = [self]

  while (queue.length > 0) {
    // Safe: the loop condition guarantees a value, but noUncheckedIndexedAccess
    // does not know that.
    const current = queue.pop() as PrincipalRef
    for (const group of graph.directGroups(current)) {
      const ref: PrincipalRef = `group:${group}`
      if (seen.has(ref)) continue
      seen.add(ref)
      queue.push(ref)
    }
  }

  return seen
}
