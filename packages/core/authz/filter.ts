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
  | { readonly key: string; readonly match: { readonly value: string | number | boolean } }
  | {
      readonly key: string
      readonly match: { readonly any: readonly (string | number | boolean)[] }
    }

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
/**
 * A restriction the *caller* asked for, on top of the one the permissions
 * impose.
 *
 * Only ever narrowing, and the type is what says so: a list of layer ids that
 * results must be in. It becomes a `must` clause, which intersects with the
 * permission `should` rather than replacing it — a caller asking for a layer
 * they cannot read still gets nothing from it, because both constraints apply.
 *
 * The alternative shape, and the one to avoid, is narrowing `plan.layers`
 * before building. That looks equivalent and is not: a scoped plan also carries
 * `extraDocs` from document-level grants, which sit in the same `should`, so
 * narrowing the plan would leave those documents matching regardless of which
 * layers the caller asked for. `must` is the constraint the caller meant.
 *
 * An empty list must never reach here. `[]` as a `must` on `layer_id` matches
 * nothing at all, which is the right answer for "you asked for layers you
 * cannot read" — but it is the caller's job to spot that and skip the query, so
 * that "no such layer" and "no permitted results" stay the same answer. This
 * function refuses it rather than encoding the distinction.
 */
/** A value a caller may narrow a search to. Scalars and lists of them, nothing else. */
export type MetadataValue = string | number | boolean | readonly (string | number | boolean)[]

/**
 * Where a caller's metadata lands in the vector payload.
 *
 * Every key a caller supplies is written and read under this one object, so
 * `meta.org_id` is a different field from `org_id` and there is no key a caller
 * can choose that reaches a permission field. That is the whole reason for the
 * prefix: without it, `filters: {"deleted": false}` would be a caller reaching
 * invariant I5's clause, and `metadata: {"acl_tags": [...]}` on ingest would be
 * a caller writing their own permission tags.
 *
 * Structural, not a check. A denylist of forbidden keys would have to stay in
 * step with every payload field ever added; a namespace cannot fall out of step
 * with anything.
 */
export const METADATA_PREFIX = 'meta'

export interface Narrowing {
  readonly layers?: readonly string[]
  /**
   * Document metadata the caller asked to restrict to, key to value.
   *
   * Equality only, and every entry becomes a `must` — so like `layers`, this can
   * only ever remove results. There is deliberately no negation, no range and no
   * disjunction across keys: each of those is a way to *widen* if it is ever
   * composed wrongly, and none of them is needed to answer "only documents from
   * this source".
   */
  readonly metadata?: Readonly<Record<string, MetadataValue>>
}

export function buildFilter(
  orgId: string,
  plan: QueryablePlan,
  narrow?: Narrowing,
): VectorFilter {
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

  if (narrow?.layers !== undefined) {
    if (narrow.layers.length === 0) {
      // See Narrowing. An empty `any` is not "match nothing" in Qdrant, it is a
      // clause that matches nothing *usefully* — and relying on that would put
      // the "the caller asked for a layer they cannot see" case in the query
      // builder, where it becomes one refactor away from being dropped. The
      // caller returns no results without querying.
      throw new Error(
        'refusing to build a filter narrowed to no layers — the caller must ' +
          'return an empty result instead of querying',
      )
    }
    // A `must`, so it intersects with the permission constraint rather than
    // replacing it. This can only ever remove results.
    must.push({ key: 'layer_id', match: { any: [...narrow.layers] } })
  }

  for (const [key, value] of Object.entries(narrow?.metadata ?? {})) {
    // Namespaced, always. The caller chooses the key and never the field: a
    // filter on `deleted` becomes a filter on `meta.deleted`, which is a
    // different field and cannot touch invariant I5's clause.
    const field = `${METADATA_PREFIX}.${key}`

    if (Array.isArray(value)) {
      if (value.length === 0) {
        // Same refusal as an empty layer list, for the same reason: an empty
        // `any` is not "match nothing" in Qdrant. The caller decides what an
        // impossible restriction means, and answers empty without querying.
        throw new Error(
          `refusing to build a filter narrowed to no values for ${key} — the ` +
            'caller must return an empty result instead of querying',
        )
      }
      must.push({ key: field, match: { any: [...value] } })
    } else {
      must.push({ key: field, match: { value: value as string | number | boolean } })
    }
  }

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
