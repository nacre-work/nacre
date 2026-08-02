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
    // `onlyLayers` is the one addition, and it restricts: it becomes a `must`
    // alongside the filter's own, never a filter of its own.
    const branch: Branch = BRANCHES[0] as Branch
    expect(Object.keys(branch).sort()).toEqual(['kind', 'using', 'vector'])
  })

  it('a per-branch restriction intersects the filter rather than replacing it', () => {
    // An organization can hold layers on more than one embedding model — during
    // a reindex, or because two layers were created against different providers
    // — and one named vector cannot answer for both. Each branch is then
    // confined to the layers on its model, and the question this asks is
    // whether the permission clauses survive that.
    const filter = buildFilter(ORG, scopedPlan())
    const query = buildHybridQuery({
      branches: [{ kind: 'dense', using: 'v_small_v2_768', vector: [0.1], onlyLayers: ['layer-a'] }],
      filter,
      limit: 10,
    })

    const branch = query.prefetch[0]
    // Everything the shared filter had, still there.
    expect(branch?.filter.must).toEqual(
      expect.arrayContaining([
        { key: 'org_id', match: { value: ORG } },
        { key: 'deleted', match: { value: false } },
      ]),
    )
    expect(branch?.filter.should, 'the permission constraint must survive').toEqual(filter.should)
    // Plus the restriction, as a `must` so it can only remove.
    expect(branch?.filter.must).toContainEqual({ key: 'layer_id', match: { any: ['layer-a'] } })
  })

  it('a branch restricted to no layers is refused rather than emitted', () => {
    // An empty `any` is not "match nothing" in Qdrant. Emitting it would turn a
    // per-model branch into a query over every model at once.
    const filter = buildFilter(ORG, scopedPlan())
    expect(() =>
      buildHybridQuery({
        branches: [{ kind: 'dense', using: 'v', vector: [0.1], onlyLayers: [] }],
        filter,
        limit: 10,
      }),
    ).toThrow(/narrowed to no layers/)
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

/**
 * Narrowing, which is the caller's own restriction rather than a permission.
 *
 * `layers` was declared in the contract and in the MCP tool schema from the
 * beginning and read by nothing, so a client scoping a search to one layer
 * silently searched all of them. For a product whose whole claim is that a
 * search returns only what you may see, a scoping parameter that does nothing
 * is the worst kind of no-op: the caller believes they narrowed it.
 *
 * These are about the one property that matters — it can only ever remove.
 */
describe('narrowing', () => {
  it('adds a must, leaving the permission constraint alone', () => {
    // 'contracts' is the layer the fixture grants, so this is the ordinary
    // case: a caller narrowing to something they can actually read.
    const filter = buildFilter(ORG, scopedPlan(), { layers: ['contracts'] })

    // A `must`, so it intersects. Not a replacement for the permission
    // `should`, which is still there and still decides what is reachable.
    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: ['contracts'] } })
    expect(filter.should).toBeDefined()
    expect(filter.should?.length).toBeGreaterThan(0)
  })

  it('cannot reach a layer the plan does not permit', () => {
    // The whole safety property. A caller naming a layer they have no grant on
    // gets a filter where `must` demands that layer and `should` demands one
    // they may read — no point satisfies both, so nothing comes back. The
    // permission constraint is never widened by what the caller asked for.
    const filter = buildFilter(ORG, scopedPlan(), { layers: ['some-other-layer'] })

    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: ['some-other-layer'] } })
    const permitted = filter.should?.find((c) => c.key === 'layer_id')
    expect(permitted).toBeDefined()
    expect(permitted).not.toEqual({ key: 'layer_id', match: { any: ['some-other-layer'] } })
  })

  it('narrows an unrestricted plan too', () => {
    // `kind: 'all'` returns early with no `should` at all, so the narrowing has
    // to be in place before that return or an admin's search ignores it.
    const filter = buildFilter(ORG, { kind: 'all' }, { layers: ['contracts'] })
    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: ['contracts'] } })
    expect(filter.should).toBeUndefined()
  })

  it('keeps org_id and deleted regardless', () => {
    // Invariants I1 and I5 are not negotiable by a query parameter.
    const filter = buildFilter(ORG, scopedPlan(), { layers: ['contracts'] })
    expect(filter.must).toContainEqual({ key: 'org_id', match: { value: ORG } })
    expect(filter.must).toContainEqual({ key: 'deleted', match: { value: false } })
  })

  it('refuses an empty narrowing rather than encoding it', () => {
    // "You asked for layers you cannot read" is an empty result the caller
    // returns without querying, so that it stays indistinguishable from "no
    // permitted matches". Encoding it here would put that distinction in the
    // query builder, one refactor away from being dropped.
    expect(() => buildFilter(ORG, scopedPlan(), { layers: [] })).toThrow(/narrowed to no layers/)
  })

  it('is absent when the caller asked for nothing', () => {
    const filter = buildFilter(ORG, scopedPlan())
    expect(filter.must.filter((c) => c.key === 'layer_id')).toEqual([])
  })
})
