import type { Grant, OrgRole, Permission, PrincipalRef } from '../types.js'
import { principalRef } from '../types.js'
import { satisfies } from './permissions.js'
import type { ScopeTree } from './scope-tree.js'

/**
 * What the caller may reach, in the shape a pre-filter needs.
 *
 * A discriminated union rather than a struct with an `all` flag, so that the
 * "no access at all" case cannot be handed to the filter builder by accident.
 * `buildFilter` does not accept `none`; forgetting to check is a type error
 * rather than a query that quietly returns the whole index.
 */
export type AccessPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'all' }
  | {
      readonly kind: 'scoped'
      /** Layers the caller may reach in full. */
      readonly layers: readonly string[]
      /** Documents reachable outside those layers. */
      readonly extraDocs: readonly string[]
      /** Documents excluded even inside an allowed layer. */
      readonly deniedDocs: readonly string[]
    }

export interface ResolveInput {
  readonly orgId: string
  readonly role: OrgRole
  readonly principals: ReadonlySet<PrincipalRef>
  /** Grants for these principals. Extra rows are tolerated and filtered here. */
  readonly grants: readonly Grant[]
  readonly tree: ScopeTree
}

/**
 * Turn grants into the set of things the caller may reach.
 *
 * Where this differs from `reference.ts`: the reference answers "may they touch
 * this one scope?", which is the question the rules are written in. A search
 * needs the inverse — the whole permitted set, up front, so it can go into the
 * query as a pre-filter. Computing it by asking the reference per document
 * would be a post-filter with extra steps.
 *
 * The property-based test exists because these two are different algorithms
 * answering the same question, and only one of them is obviously correct.
 */
export function resolve(input: ResolveInput, permission: Permission): AccessPlan {
  const { orgId, role, principals, grants, tree } = input

  // Rule 2, before anything else: platform_admin reads no documents.
  if (role === 'platform_admin') return { kind: 'none' }
  // Rule 3, with rule 7 making admin cover read and write.
  if (role === 'org_admin') return { kind: 'all' }

  // Rule 1 is a precondition. A grant from another tenant is discarded, not
  // weighed. Rules 6 and 7 are entirely inside `satisfies`.
  const applicable = grants.filter(
    (g) =>
      g.orgId === orgId &&
      principals.has(principalRef(g.principal)) &&
      satisfies(g.permission, permission),
  )

  const denied = { workspaces: new Set<string>(), layers: new Set<string>(), docs: new Set<string>() }
  const allowed = { workspaces: new Set<string>(), layers: new Set<string>(), docs: new Set<string>() }

  for (const g of applicable) {
    const side = g.effect === 'deny' ? denied : allowed
    switch (g.scope.type) {
      case 'workspace': side.workspaces.add(g.scope.id); break
      case 'layer': side.layers.add(g.scope.id); break
      case 'document': side.docs.add(g.scope.id); break
    }
  }

  // Rule 4 downward: a denied workspace denies each of its layers.
  const deniedLayers = new Set(denied.layers)
  for (const workspace of denied.workspaces) {
    for (const layer of tree.layersOf(workspace)) deniedLayers.add(layer)
  }

  // Rule 5: subtract, never compare depth. A layer allowed explicitly under a
  // denied workspace stays denied — "most specific wins" would allow it, and
  // that is a different model from the one specified.
  const layers = new Set<string>()
  for (const workspace of allowed.workspaces) {
    for (const layer of tree.layersOf(workspace)) {
      if (!deniedLayers.has(layer)) layers.add(layer)
    }
  }
  for (const layer of allowed.layers) {
    if (!deniedLayers.has(layer)) layers.add(layer)
  }

  // Document-scoped allows. The pseudocode in the specification subtracts only
  // document-scoped denies here, which loses the truth-table row where a deny
  // on the workspace beats an allow on a document beneath it. Ancestors are
  // checked instead — see the note in docs/authz.md.
  const extraDocs = new Set<string>()
  for (const doc of allowed.docs) {
    if (denied.docs.has(doc)) continue
    const layer = tree.layerOf(doc)
    // An unplaceable document cannot be checked against its ancestors, so it
    // is denied. Rule I3: a permission that cannot be evaluated is refused.
    if (layer === undefined) continue
    if (deniedLayers.has(layer)) continue
    const workspace = tree.workspaceOf(layer)
    if (workspace !== undefined && denied.workspaces.has(workspace)) continue
    if (layers.has(layer)) continue // already covered by the layer grant
    extraDocs.add(doc)
  }

  if (layers.size === 0 && extraDocs.size === 0) return { kind: 'none' }

  return {
    kind: 'scoped',
    layers: [...layers].sort(),
    extraDocs: [...extraDocs].sort(),
    // Kept even when the document sits outside every allowed layer: it costs
    // one clause and it is the difference between "excluded" and "excluded
    // unless someone later widens the layer set".
    deniedDocs: [...denied.docs].sort(),
  }
}
