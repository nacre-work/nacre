/**
 * The state of a layer's move to a different embedding model.
 *
 * Shared between the API, which starts one and reports on it, and the worker,
 * which does the work — so the shape is defined once rather than agreed twice.
 *
 * ## What is built, and what is not
 *
 * `docs/architecture.md` specifies six steps. Four are here: add the new named
 * vector, reindex existing documents in bounded batches, switch `vector_name`
 * atomically, keep search available throughout.
 *
 * Two are not, and are named rather than quietly skipped:
 *
 * - **The Recall@10 gate.** Step 4 checks the new index against "the layer's
 *   reference query set" before switching. There is no reference query set
 *   anywhere in this product — not a table, not an endpoint, not a
 *   configuration file — so building the gate would mean inventing the surface
 *   it reads from, and a gate that checks against an empty set is a gate that
 *   passes. Until it exists, a switch is a decision the operator makes by
 *   starting the reindex, and `docs/architecture.md` says so.
 * - **Dropping the old vector after a rollback window.** Step 6. The old vector
 *   stays. It costs storage and it is what makes a rollback a one-statement
 *   change, which is worth more than the space while this path is new.
 */

/** What `layers.reindex_state` holds. The migration's check constraint enforces it. */
export interface ReindexState {
  readonly status: 'running' | 'complete' | 'failed'
  /**
   * Which half of the migration is happening.
   *
   * `copying` is org-wide and cheap per point: the organization's collection is
   * rebuilt with room for the new model and every point moves across carrying
   * the vectors it already had. **No embeddings are computed.** It exists
   * because a named vector cannot be added to a live Qdrant collection, so the
   * only way to get one is to create a collection that already has it.
   *
   * `embedding` is per layer and is the expensive half: chunk text is embedded
   * with the new model into the slot the copy created.
   *
   * The split is the whole point of the design. The cheap half happens once for
   * the organization; the expensive half happens per layer, whenever the
   * operator wants, with search running normally throughout.
   */
  readonly phase: 'copying' | 'embedding'
  /**
   * The named vector being written. Also the answer to "reindexed onto what",
   * which is why it is required in every state including `failed` — a failed
   * reindex leaves points behind and the name is how they are found.
   */
  readonly shadowVector: string
  /** The provider whose model produces it. */
  readonly providerId: string
  readonly startedAt: string
  readonly finishedAt?: string
  /** Documents that had no shadow vector when the reindex began. */
  readonly total: number
  /** Documents that have one now. Can exceed nothing; see `progress`. */
  readonly done: number
  readonly failed: number
  readonly error?: string
}

/**
 * How far along, as a ratio, for `nacre_reindex_progress_ratio`.
 *
 * Clamped at 1 rather than allowed past it. `total` is counted once when the
 * reindex starts and documents ingested afterwards are picked up by the same
 * pass, so `done` legitimately overshoots — and a progress gauge reading 1.4
 * makes an operator think the number is broken rather than that more work
 * arrived. A reindex that is complete reads 1 whatever the counts say.
 *
 * Zero documents is 1, not 0. An empty layer is finished, and a gauge that sits
 * at zero forever for a layer with nothing in it is the stuck-alert shape.
 */
export function reindexProgress(state: ReindexState): number {
  if (state.status === 'complete') return 1
  // The copy has no per-document measure — it moves points, and how many an
  // organization has is not the layer's `total`. Reporting zero through it is
  // honest: nothing this layer is waiting for has been done yet.
  if (state.phase === 'copying') return 0
  if (state.total <= 0) return 1
  return Math.min(1, state.done / state.total)
}

/** The JSON shape stored in the column. Snake case, like every other jsonb here. */
export function toStateJson(state: ReindexState): Record<string, unknown> {
  return {
    status: state.status,
    phase: state.phase,
    shadow_vector: state.shadowVector,
    provider_id: state.providerId,
    started_at: state.startedAt,
    ...(state.finishedAt === undefined ? {} : { finished_at: state.finishedAt }),
    total: state.total,
    done: state.done,
    failed: state.failed,
    ...(state.error === undefined ? {} : { error: state.error }),
  }
}

/**
 * Read it back, or `undefined` for a column that holds nothing usable.
 *
 * Undefined rather than a thrown error or a default: a layer with no reindex
 * and a layer whose state cannot be parsed both mean "there is nothing to
 * report", and the caller has no different action to take. The check constraint
 * added in `0013` is what makes the second case not happen.
 */
export function fromStateJson(raw: unknown): ReindexState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>

  const status = o.status
  if (status !== 'running' && status !== 'complete' && status !== 'failed') return undefined
  if (typeof o.shadow_vector !== 'string') return undefined

  return {
    status,
    // Defaulted rather than refused: a state written before the phase existed
    // is an embedding-phase state, because the copy is what introduced it.
    phase: o.phase === 'copying' ? 'copying' : 'embedding',
    shadowVector: o.shadow_vector,
    providerId: typeof o.provider_id === 'string' ? o.provider_id : '',
    startedAt: typeof o.started_at === 'string' ? o.started_at : '',
    ...(typeof o.finished_at === 'string' ? { finishedAt: o.finished_at } : {}),
    total: typeof o.total === 'number' ? o.total : 0,
    done: typeof o.done === 'number' ? o.done : 0,
    failed: typeof o.failed === 'number' ? o.failed : 0,
    ...(typeof o.error === 'string' ? { error: o.error } : {}),
  }
}
