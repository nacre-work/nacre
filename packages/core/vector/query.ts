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

export interface DenseBranch {
  readonly kind: 'dense'
  /** The named vector in the collection, e.g. `v_bge_m3_1024`. */
  readonly using: string
  readonly vector: readonly number[]
}

export interface SparseBranch {
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

  return {
    prefetch: branches.map((branch) => ({
      query:
        branch.kind === 'dense'
          ? [...branch.vector]
          : { indices: [...branch.vector.indices], values: [...branch.vector.values] },
      using: branch.using,
      // The single source. Every branch gets it; there is no path that skips one.
      filter,
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
 * worst way to find out. `acl_tags` stays in memory because it participates in
 * every single query.
 */
export const PAYLOAD_INDEXES = [
  { field_name: 'layer_id', field_schema: 'uuid' },
  { field_name: 'doc_id', field_schema: 'uuid' },
  { field_name: 'org_id', field_schema: 'uuid' },
  { field_name: 'deleted', field_schema: 'bool' },
  {
    field_name: 'acl_tags',
    field_schema: { type: 'keyword', is_tenant: false, on_disk: false },
  },
] as const

/**
 * Collection configuration for one organization.
 *
 * int8 quantization is not a tuning knob: roughly 4x less memory for a recall
 * loss inside one percent, which for corporate search is noise. Originals stay
 * on disk for rescoring.
 */
export function collectionConfig(vectorName: string, size: number) {
  return {
    vectors: {
      [vectorName]: {
        size,
        distance: 'Cosine' as const,
        hnsw_config: { m: 32, ef_construct: 256 },
        quantization_config: {
          scalar: { type: 'int8' as const, quantile: 0.99, always_ram: true },
        },
      },
    },
    sparse_vectors: { bm25: {} },
    optimizers_config: { default_segment_number: 4 },
    on_disk_payload: true,
  }
}

/** `org_{slug}` — offboarding a tenant is then one delete, with no rows to forget. */
export function collectionName(orgSlug: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(orgSlug)) {
    throw new Error(`refusing to build a collection name from: ${orgSlug}`)
  }
  return `org_${orgSlug.replace(/-/g, '_')}`
}
