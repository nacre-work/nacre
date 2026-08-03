import type { VectorFilter } from '../authz/filter.js'

/**
 * Building the hybrid query.
 *
 * The rule this module exists to enforce is one line in docs/architecture.md:
 * *the filter is repeated in every prefetch branch, and omitting it from one is
 * a leak.* In a hand-written query document those branches sit far enough apart
 * that a missing `filter` key reads as a formatting difference rather than as a
 * hole, and it is the kind of omission that passes every functional test —
 * results still come back, they are simply somebody else's.
 *
 * So the branches are not hand-written. A caller supplies what makes a branch
 * different — the vector and which named vector to use — and the filter is
 * applied to all of them here, once, from a single argument. There is no
 * signature that accepts a per-branch filter, which is what makes the
 * omission unrepresentable rather than merely discouraged.
 */

/**
 * Layers this branch is restricted to, on top of the shared filter.
 *
 * Present because an organization can hold layers on more than one embedding
 * model at once — during a reindex, or simply because two layers were created
 * against different providers — and one named vector cannot answer for both. A
 * query then needs a branch per model, and each branch has to be confined to
 * the layers actually on that model. Without the confinement a layer that has
 * been reindexed still carries its old vector, so it matches *both* branches
 * and reciprocal rank fusion counts it twice.
 *
 * **This narrows and never widens.** The clause is appended to the shared
 * filter's `must`, so it can only remove points from what the permission filter
 * already allowed. There is deliberately no way to hand a branch a filter of
 * its own — that is the omission this whole module exists to make
 * unrepresentable, and a per-branch *restriction* is the opposite of it.
 */
type BranchScope = {
  readonly onlyLayers?: readonly string[]
}

export type DenseBranch = BranchScope & {
  readonly kind: 'dense'
  /** The named vector in the collection, e.g. `v_bge_m3_1024`. */
  readonly using: string
  readonly vector: readonly number[]
}

export type SparseBranch = BranchScope & {
  readonly kind: 'sparse'
  /** The sparse vector name, `bm25` by default. */
  readonly using: string
  readonly vector: { readonly indices: readonly number[]; readonly values: readonly number[] }
}

export type Branch = DenseBranch | SparseBranch

export interface HybridQueryOptions {
  readonly branches: readonly Branch[]
  readonly filter: VectorFilter
  /** How many candidates each branch contributes before fusion. */
  readonly prefetchLimit?: number
  /** How many results the fused query returns. */
  readonly limit: number
  readonly withPayload?: boolean
}

export interface PrefetchClause {
  readonly query: unknown
  readonly using: string
  readonly filter: VectorFilter
  readonly limit: number
}

export interface HybridQuery {
  readonly prefetch: readonly PrefetchClause[]
  readonly query: { readonly fusion: 'rrf' }
  readonly limit: number
  readonly with_payload: boolean
}

/**
 * Reciprocal Rank Fusion over a dense branch and a sparse one, then the caller
 * reranks. Defaults follow docs/architecture.md: 50 candidates per branch.
 */
export function buildHybridQuery(options: HybridQueryOptions): HybridQuery {
  const { branches, filter, limit, prefetchLimit = 50, withPayload = true } = options

  if (branches.length === 0) {
    // An empty prefetch list is a query with no constraints on which points it
    // considers, which is the same failure as a missing filter arriving by a
    // different route. Refuse rather than emit it.
    throw new Error('a hybrid query needs at least one branch')
  }

  for (const branch of branches) {
    if (branch.onlyLayers !== undefined && branch.onlyLayers.length === 0) {
      // Same refusal as buildFilter's, for the same reason: an empty `any` is
      // not "match nothing" in Qdrant. A branch that reaches no layer is a
      // branch the caller should not have asked for, and answering it as if it
      // were unrestricted is how a per-model branch turns into a query over
      // every model at once.
      throw new Error('refusing to build a branch narrowed to no layers')
    }
  }

  return {
    prefetch: branches.map((branch) => ({
      query:
        branch.kind === 'dense'
          ? [...branch.vector]
          : { indices: [...branch.vector.indices], values: [...branch.vector.values] },
      using: branch.using,
      // The single source. Every branch gets it; there is no path that skips
      // one. `onlyLayers` is appended to its `must` rather than replacing
      // anything, so the permission clauses survive intersection by
      // construction.
      filter:
        branch.onlyLayers === undefined
          ? filter
          : {
              ...filter,
              must: [
                ...(filter.must ?? []),
                { key: 'layer_id', match: { any: [...branch.onlyLayers] } },
              ],
            },
      limit: prefetchLimit,
    })),
    query: { fusion: 'rrf' },
    limit,
    with_payload: withPayload,
  }
}

/**
 * The payload indexes the permission filter needs.
 *
 * Without them the filter is evaluated by scanning, which does not fail a test
 * — it just gets slow enough to matter at a customer's volume, which is the
 * worst way to find out.
 *
 * `acl_tags` used to be here, as a keyword index the propagation cache filtered
 * on. Migration 0016 removed that whole subsystem — nothing writes `acl_tags`
 * to a point and `buildFilter` never emits a clause on it — so the index was
 * being built, and kept in memory, for a field that is never present and never
 * queried. It is gone with the rest of the cache.
 */
export const PAYLOAD_INDEXES = [
  { field_name: 'layer_id', field_schema: 'uuid' },
  { field_name: 'doc_id', field_schema: 'uuid' },
  { field_name: 'org_id', field_schema: 'uuid' },
  { field_name: 'deleted', field_schema: 'bool' },
] as const

/**
 * Collection configuration for one organization.
 *
 * int8 quantization is not a tuning knob: roughly 4x less memory for a recall
 * loss inside one percent, which for corporate search is noise. Originals stay
 * on disk for rescoring.
 */
/**
 * The settings one named vector gets.
 *
 * Factored out because a reindex creates a collection carrying *several* — the
 * ones the old collection had, plus the one being migrated to — and they have
 * to be configured identically. A copy that quietly used different HNSW
 * parameters would change recall, which shows up as "search got worse after the
 * migration" and is very hard to attribute.
 */
export function vectorParams(size: number) {
  return {
    size,
    distance: 'Cosine' as const,
    hnsw_config: { m: 32, ef_construct: 256 },
    quantization_config: {
      scalar: { type: 'int8' as const, quantile: 0.99, always_ram: true },
    },
  }
}

export function collectionConfig(vectorName: string, size: number) {
  return {
    vectors: {
      [vectorName]: vectorParams(size),
    },
    sparse_vectors: { bm25: {} },
    optimizers_config: { default_segment_number: 4 },
    on_disk_payload: true,
  }
}

/**
 * The named vector for a model and dimension: `v_{model}_{dim}`.
 *
 * One function because there are three callers that must agree — the API and
 * MCP search paths derive it from configuration, and a layer stores it in a
 * column the worker reads when writing points. They disagreed: layers created
 * through `POST /v1/layers` got the literal `default`, so the worker wrote to a
 * vector the collection did not have and every upsert failed with `Bad
 * Request`, while search looked for the configured name and would have found
 * nothing even if the write had worked.
 *
 * A mismatch here is not a type error and not a test failure; it is an empty
 * index. Deriving it in more than one place is what made that possible.
 */
export function vectorName(model: string, dimensions: number): string {
  return `v_${model.replace(/[^a-z0-9]/gi, '_')}_${dimensions}`
}

/** `org_{slug}` — offboarding a tenant is then one delete, with no rows to forget. */
export function collectionName(orgSlug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(orgSlug)) {
    throw new Error(`refusing to build a collection name from: ${orgSlug}`)
  }
  return `org_${orgSlug.replace(/-/g, '_')}`
}
