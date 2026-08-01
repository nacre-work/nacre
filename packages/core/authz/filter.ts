import type { AccessPlan } from './resolve.js'

/**
 * A Qdrant payload filter. Narrow on purpose — this module builds filters and
 * nothing reads them back apart from the vector client.
 */
export interface VectorFilter {
  readonly must: readonly FilterClause[]
  /**
   * At least one of these must match.
   *
   * That is Qdrant's meaning, not Elasticsearch's: a `should` list is a
   * constraint, and a point that matches none of them does not pass the filter.
   * There is no scalar `min_should` to go with it — Qdrant's `min_should` is an
   * object, `{ conditions, min_count }`, for the "at least N" case. The filter
   * sketch in docs/authz.md carried `min_should: 1` as an integer, which the
   * API rejects outright; every query built from it came back 400.
   *
   * Never emit an empty `should`. An empty list is not "match nothing" — it is
   * no constraint at all, so the filter degrades to `must` alone and the caller
   * sees every point in the collection.
   */
  readonly should?: readonly FilterClause[]
  readonly must_not?: readonly FilterClause[]
}

export type FilterClause =
  | { readonly key: string; readonly match: { readonly value: string | boolean } }
  | { readonly key: string; readonly match: { readonly any: readonly string[] } }

/**
 * Plans that can be turned into a query at all.
 *
 * `AccessPlan` includes `none`, and there is no correct filter for it — the
 * caller must not run the query. Excluding it from this type means a caller who
 * forgets gets a compile error rather than a filter that happens to match
 * everything.
 */
export type QueryablePlan = Exclude<AccessPlan, { kind: 'none' }>

/**
 * Build the pre-filter for a search.
 *
 * This goes into the `filter` field of the Qdrant query, where it is applied
 * *inside* the HNSW traversal. That is what makes `top_k` return k permitted
 * results rather than k results with some removed afterwards — invariant I2 —
 * and it is the reason no part of this codebase filters a result set.
 *
 * In a hybrid query the same filter is repeated in every prefetch branch.
 * Omitting it from one branch is a leak, and the branches are far enough apart
 * in the query document for that to look like a formatting difference.
 */
export function buildFilter(orgId: string, plan: QueryablePlan): VectorFilter {
  // org_id and deleted are unconditional.
  //
  // org_id is duplicated in the payload even when each tenant has its own
  // collection: it is the second line of defense behind picking the right
  // collection, and it costs one clause.
  //
  // deleted is invariant I5. There is a real window between a delete and the
  // garbage collector's sweep, and a query without this clause returns
  // documents from inside it. Depending on GC timing is how that invariant
  // gets broken.
  const must: FilterClause[] = [
    { key: 'org_id', match: { value: orgId } },
    { key: 'deleted', match: { value: false } },
  ]

  if (plan.kind === 'all') return { must }

  // Only non-empty lists become clauses. An empty `any` adds nothing and an
  // empty `should` removes the constraint entirely.
  const should: FilterClause[] = []
  if (plan.layers.length > 0) should.push({ key: 'layer_id', match: { any: plan.layers } })
  if (plan.extraDocs.length > 0) should.push({ key: 'doc_id', match: { any: plan.extraDocs } })

  if (should.length === 0) {
    // A scoped plan that reaches nothing. `resolve` never produces one — it
    // returns `kind: 'none'` instead — so arriving here means the plan was
    // assembled by hand. Refusing is rule I3 applied to the query builder: a
    // permission set that cannot be expressed denies, and the alternative is a
    // filter with no `should` at all, which returns the whole collection.
    throw new Error(
      'refusing to build a filter from a scoped plan that reaches no layer and ' +
        'no document — a plan like this must be kind: "none"',
    )
  }

  return {
    must,
    should,
    ...(plan.deniedDocs.length > 0
      ? { must_not: [{ key: 'doc_id', match: { any: plan.deniedDocs } }] }
      : {}),
  }
}
