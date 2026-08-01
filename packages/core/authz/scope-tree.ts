import type { Scope } from '../types.js'

/**
 * A read-only view of the scope tree for one organization: workspace → layer →
 * document.
 *
 * The resolver needs this to apply rules 4 and 5. Inheritance runs downward, so
 * a grant on a workspace reaches its layers; deny beats allow at any depth, so
 * an explicit allow on a document has to be checked against denies on its
 * ancestors. Neither is decidable from the grants alone.
 *
 * Only documents named in a grant ever need placing, so `layerOf` is called a
 * handful of times per query, not once per document in the index. Nothing here
 * enumerates documents.
 */
export interface ScopeTree {
  /** Layers directly under a workspace. Empty for an unknown workspace. */
  layersOf(workspaceId: string): readonly string[]
  /** The workspace a layer belongs to, or undefined if the layer is unknown. */
  workspaceOf(layerId: string): string | undefined
  /** The layer a document belongs to, or undefined if the document is unknown. */
  layerOf(documentId: string): string | undefined
}

export interface ScopeTreeData {
  /** workspace id → layer ids */
  readonly layers: Readonly<Record<string, readonly string[]>>
  /** document id → layer id */
  readonly documents: Readonly<Record<string, string>>
}

/**
 * In-memory tree, used by tests and by anything holding a small catalog.
 *
 * An unknown id resolves to undefined rather than throwing. That is not
 * laziness: a grant can outlive the layer it referenced, and the resolver's
 * behaviour for an unplaceable scope has to be *deny*, which reads more clearly
 * as "we could not place it, so it grants nothing" than as an exception the
 * caller might catch and continue past.
 */
export class MemoryScopeTree implements ScopeTree {
  readonly #layersByWorkspace: Map<string, readonly string[]>
  readonly #workspaceByLayer = new Map<string, string>()
  readonly #layerByDocument: Map<string, string>

  constructor(data: ScopeTreeData) {
    this.#layersByWorkspace = new Map(Object.entries(data.layers))
    for (const [workspace, layers] of this.#layersByWorkspace) {
      for (const layer of layers) this.#workspaceByLayer.set(layer, workspace)
    }
    this.#layerByDocument = new Map(Object.entries(data.documents))
  }

  layersOf(workspaceId: string): readonly string[] {
    return this.#layersByWorkspace.get(workspaceId) ?? []
  }

  workspaceOf(layerId: string): string | undefined {
    return this.#workspaceByLayer.get(layerId)
  }

  layerOf(documentId: string): string | undefined {
    return this.#layerByDocument.get(documentId)
  }
}

/**
 * The chain from a scope up to the organization root, the scope itself first.
 *
 * Used to answer "is any ancestor of this denied?", which is what makes deny
 * absolute rather than nearest-wins.
 */
export function ancestry(scope: Scope, tree: ScopeTree): readonly Scope[] {
  switch (scope.type) {
    case 'workspace':
      return [scope]
    case 'layer': {
      const workspace = tree.workspaceOf(scope.id)
      return workspace === undefined
        ? [scope]
        : [scope, { type: 'workspace', id: workspace }]
    }
    case 'document': {
      const layer = tree.layerOf(scope.id)
      if (layer === undefined) return [scope]
      return [scope, ...ancestry({ type: 'layer', id: layer }, tree)]
    }
  }
}
