import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type { Effect, Grant, Permission, Principal, PrincipalRef } from '../../types.js'
import { referenceAllows } from '../reference.js'
import { resolve } from '../resolve.js'
import { MemoryScopeTree } from '../scope-tree.js'

const ORG = 'org-a'
const PERMISSIONS: readonly Permission[] = ['read', 'write', 'admin']
const EFFECTS: readonly Effect[] = ['allow', 'deny']

/** Two groups and the user, so group grants and cycles both get exercised. */
const PRINCIPALS: readonly Principal[] = [
  { type: 'user', id: 'alice' },
  { type: 'group', id: 'legal' },
  { type: 'group', id: 'eng' },
]
const EFFECTIVE = new Set<PrincipalRef>(['user:alice', 'group:legal', 'group:eng'])

interface World {
  readonly layers: Record<string, string[]>
  readonly documents: Record<string, string>
  readonly grants: Grant[]
}

/**
 * Small worlds on purpose. Two workspaces of up to two layers of up to two
 * documents is enough for every interaction the rules have — inheritance,
 * deny above an allow, a document allowed outside its layer — and small enough
 * that a counterexample fast-check prints is readable rather than a wall.
 */
const world: fc.Arbitrary<World> = fc
  .record({
    shape: fc.array(fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 2 }), {
      minLength: 1,
      maxLength: 2,
    }),
    rawGrants: fc.array(
      fc.record({
        principal: fc.constantFrom(...PRINCIPALS),
        permission: fc.constantFrom(...PERMISSIONS),
        effect: fc.constantFrom(...EFFECTS),
        scopeKind: fc.constantFrom('workspace', 'layer', 'document'),
        pick: fc.nat({ max: 20 }),
      }),
      { maxLength: 8 },
    ),
  })
  .map(({ shape, rawGrants }) => {
    const layers: Record<string, string[]> = {}
    const documents: Record<string, string> = {}
    const workspaceIds: string[] = []
    const layerIds: string[] = []
    const documentIds: string[] = []

    shape.forEach((layerSizes, w) => {
      const ws = `w${w}`
      workspaceIds.push(ws)
      const wsLayers: string[] = []
      layers[ws] = wsLayers
      layerSizes.forEach((docCount, l) => {
        const layer = `w${w}l${l}`
        wsLayers.push(layer)
        layerIds.push(layer)
        for (let d = 0; d < docCount; d++) {
          const doc = `${layer}d${d}`
          documents[doc] = layer
          documentIds.push(doc)
        }
      })
    })

    const pools = { workspace: workspaceIds, layer: layerIds, document: documentIds }
    const grants: Grant[] = []
    for (const g of rawGrants) {
      const pool = pools[g.scopeKind as keyof typeof pools]
      if (pool.length === 0) continue
      grants.push({
        orgId: ORG,
        principal: g.principal,
        permission: g.permission,
        effect: g.effect,
        scope: { type: g.scopeKind as 'workspace', id: pool[g.pick % pool.length] as string },
      })
    }

    return { layers, documents, grants }
  })

/** Does the plan reach this document? The question a search actually asks. */
function planReaches(
  plan: ReturnType<typeof resolve>,
  documentId: string,
  layerId: string,
): boolean {
  if (plan.kind === 'none') return false
  if (plan.kind === 'all') return true
  if (plan.deniedDocs.includes(documentId)) return false
  return plan.layers.includes(layerId) || plan.extraDocs.includes(documentId)
}

// 500 on a pull request, exhaustive on the nightly schedule. The nightly run is
// where a rare interaction of deny and inheritance actually gets found; the PR
// run is there to catch the obvious regression quickly.
const numRuns = Number(process.env.PROPERTY_RUNS ?? 500)

describe('property · resolve agrees with the reference implementation', () => {
  it(`holds over ${numRuns} generated worlds`, () => {
    fc.assert(
      fc.property(world, fc.constantFrom(...PERMISSIONS), (w, permission) => {
        const tree = new MemoryScopeTree({ layers: w.layers, documents: w.documents })
        const input = {
          orgId: ORG,
          role: 'member' as const,
          principals: EFFECTIVE,
          grants: w.grants,
          tree,
        }
        const plan = resolve(input, permission)

        for (const [documentId, layerId] of Object.entries(w.documents)) {
          const fromPlan = planReaches(plan, documentId, layerId)
          const fromRules = referenceAllows(input, { type: 'document', id: documentId }, permission)
          expect(
            fromPlan,
            `document ${documentId} in layer ${layerId}, permission ${permission}\n` +
              `grants: ${JSON.stringify(w.grants)}\nplan: ${JSON.stringify(plan)}`,
          ).toBe(fromRules)
        }
      }),
      { numRuns },
    )
  })

  it('agrees on layers as well as documents', () => {
    fc.assert(
      fc.property(world, fc.constantFrom(...PERMISSIONS), (w, permission) => {
        const tree = new MemoryScopeTree({ layers: w.layers, documents: w.documents })
        const input = {
          orgId: ORG,
          role: 'member' as const,
          principals: EFFECTIVE,
          grants: w.grants,
          tree,
        }
        const plan = resolve(input, permission)

        for (const layerId of Object.values(w.layers).flat()) {
          const inPlan = plan.kind === 'all' || (plan.kind === 'scoped' && plan.layers.includes(layerId))
          const fromRules = referenceAllows(input, { type: 'layer', id: layerId }, permission)
          expect(
            inPlan,
            `layer ${layerId}, permission ${permission}\ngrants: ${JSON.stringify(w.grants)}`,
          ).toBe(fromRules)
        }
      }),
      { numRuns },
    )
  })
})
