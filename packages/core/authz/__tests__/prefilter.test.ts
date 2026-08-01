import { describe, expect, it } from 'vitest'

import { buildFilter } from '../filter.js'
import { buildHybridQuery, type Branch } from '../../vector/query.js'
import { resolve } from '../resolve.js'
import { grant, ORG, tree, user } from './helpers.js'
import type { PrincipalRef } from '../../types.js'

const alice = user('alice')
const principals = new Set<PrincipalRef>(['user:alice'])

const scopedPlan = () => {
  const plan = resolve(
    { orgId: ORG, role: 'member', principals, grants: [grant(alice, 'read', 'layer', 'contracts')], tree },
    'read',
  )
  if (plan.kind === 'none') throw new Error('fixture should grant access')
  return plan
}

const BRANCHES: readonly Branch[] = [
  { kind: 'dense', using: 'v_bge_m3_1024', vector: [0.1, 0.2, 0.3] },
  { kind: 'sparse', using: 'bm25', vector: { indices: [1, 7], values: [0.5, 0.9] } },
]

/**
 * These run without Qdrant because what they check is the query document, not
 * what Qdrant does with it. The leak this guards against is structural — one
 * prefetch branch missing its filter — and it is visible in the JSON.
 *
 * T9 and T10 still need a real index: whether `top_k` returns k *permitted*
 * results is a property of the traversal, and no amount of inspecting the
 * request proves it.
 */
describe('baseline · the pre-filter reaches every branch', () => {
  it('every prefetch branch carries the filter', () => {
    const filter = buildFilter(ORG, scopedPlan())
    const query = buildHybridQuery({ branches: BRANCHES, filter, limit: 10 })

    expect(query.prefetch).toHaveLength(2)
    for (const branch of query.prefetch) {
      expect(branch.filter, 'a branch without the filter is a leak').toBe(filter)
    }
  })

  it('the filter is the same object in every branch, not a copy that can drift', () => {
    const filter = buildFilter(ORG, scopedPlan())
    const query = buildHybridQuery({ branches: BRANCHES, filter, limit: 10 })
    const [first, second] = query.prefetch
    expect(first?.filter).toBe(second?.filter)
  })

  it('there is no way to give one branch a different filter', () => {
    // A Branch carries only what makes a branch different: the vector and the
    // named vector to use. The absence of a `filter` field is the guarantee —
    // if this assertion ever needs changing, the guarantee went with it.
    const branch: Branch = BRANCHES[0] as Branch
    expect(Object.keys(branch).sort()).toEqual(['kind', 'using', 'vector'])
  })

  it('a query with no branches is refused rather than emitted', () => {
    const filter = buildFilter(ORG, scopedPlan())
    expect(() => buildHybridQuery({ branches: [], filter, limit: 10 })).toThrow(/at least one branch/)
  })

  it('top_k is passed through uncorrected', () => {
    // Asking for more and trimming is a post-filter that also costs more. If
    // this ever multiplies `limit`, that is the mistake I2 is written against.
    const filter = buildFilter(ORG, scopedPlan())
    const query = buildHybridQuery({ branches: BRANCHES, filter, limit: 7 })
    expect(query.limit).toBe(7)
  })

  it('org_id and deleted are unconditional, not one option among several', () => {
    const filter = buildFilter(ORG, scopedPlan())
    // Both belong in `must`. In `should` they would be satisfiable by any other
    // clause matching, which for `deleted` means returning tombstoned documents.
    expect(filter.must).toContainEqual({ key: 'org_id', match: { value: ORG } })
    expect(filter.must).toContainEqual({ key: 'deleted', match: { value: false } })
  })

  it('the should list is never empty', () => {
    // An empty `should` is not "match nothing" — Qdrant drops the constraint,
    // and the filter degrades to `must` alone.
    const filter = buildFilter(ORG, scopedPlan())
    expect(filter.should?.length ?? 0).toBeGreaterThan(0)
  })
})

describe('baseline · the tenant is re-checked on the way out', () => {
  it('a foreign row raises rather than being dropped', async () => {
    const { VectorStore } = await import('../../vector/search.js')
    expect(() =>
      VectorStore.assertTenant(ORG, [
        { id: 'p1', score: 0.9, payload: { org_id: ORG } },
        { id: 'p2', score: 0.8, payload: { org_id: 'someone-else' } },
      ]),
    ).toThrow(/tenant mismatch/)
  })

  it('a clean result set passes through unchanged', async () => {
    const { VectorStore } = await import('../../vector/search.js')
    const hits = [{ id: 'p1', score: 0.9, payload: { org_id: ORG } }]
    expect(VectorStore.assertTenant(ORG, hits)).toBe(hits)
  })
})
