import type { AccessPlan } from './resolve.js'

/**
 * A Qdrant payload filter. Narrow on purpose — this module builds filters and
 * nothing reads them back apart from the vector client.
 */
export interface VectorFilter {
  readonly must: readonly FilterClause[]
  readonly should?: readonly FilterClause[]
  readonly must_not?: readonly FilterClause[]
  readonly min_should?: number
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

  return {
    must,
    should: [
      { key: 'layer_id', match: { any: plan.layers } },
      { key: 'doc_id', match: { any: plan.extraDocs } },
    ],
    // At least one of the two `should` clauses has to hold. Without this a
    // Qdrant `should` is a scoring hint rather than a constraint, and every
    // point in the collection satisfies the filter.
    min_should: 1,
    must_not: [{ key: 'doc_id', match: { any: plan.deniedDocs } }],
  }
}
