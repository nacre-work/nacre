/**
 * Moving a layer onto a different embedding model, one batch at a time.
 *
 * Chunks already hold their text and their point id, so this re-parses nothing
 * and re-chunks nothing: it reads stored text, embeds it with the new model,
 * and adds a second **named vector** to points that already exist. The old
 * vector is untouched and search keeps using it — which is what "search stays
 * available throughout" in docs/architecture.md means when you write it down.
 *
 * ## The switch, and the one predicate it depends on
 *
 * `layers.vector_name` changes when no live document in the layer lacks the
 * shadow vector. That is the whole condition, it is one SQL predicate, and it
 * is checked in the same transaction that performs the switch.
 *
 * A document ingested while the reindex runs has no shadow vector either, so it
 * is simply part of the set — which is why this replaces the dual-write the
 * architecture document describes. Dual-write would put a branch on layer state
 * in the ingest hot path forever, to handle a condition true for a few hours in
 * a layer's life; the predicate gets the same guarantee out of machinery that
 * already exists, and is checkable rather than promised.
 *
 * ## What a failure does
 *
 * Nothing irreversible. A batch that fails leaves those documents without the
 * shadow vector, so the next pass tries them again, and the switch cannot
 * happen while any remain. The state carries a `failed` count and the last
 * error so an operator is not left watching a number that has stopped moving
 * with no reason given.
 */

export interface ReindexTarget {
  readonly orgId: string
  /** The organization's collection, not derived from its slug. */
  readonly collection: string
  readonly layerId: string
  readonly documentId: string
  readonly shadowVector: string
  readonly providerId: string
  readonly chunks: readonly { pointId: string; text: string }[]
}

export interface ReindexPorts {
  /**
   * Documents in a reindexing layer that do not yet carry the shadow vector.
   *
   * Cross-tenant, like every other worker claim: a reindex is started per layer
   * and the worker serves every organization.
   */
  claim(limit: number): Promise<readonly ReindexTarget[]>
  /** Embed with the *shadow* provider's model, not the worker's configured one. */
  embed(providerId: string, texts: readonly string[]): Promise<readonly (readonly number[])[]>
  /** Add the named vector to points that already exist. Never a full write. */
  addVector(
    collection: string,
    vectorName: string,
    points: readonly { pointId: string; vector: readonly number[] }[],
  ): Promise<void>
  /** Record that this document now carries it. */
  markReindexed(orgId: string, documentId: string, shadowVector: string): Promise<void>
  /**
   * Switch `vector_name` if nothing in the layer is outstanding.
   *
   * Returns true when it switched. The check and the write are one statement in
   * the implementation — asking first and switching second would let a document
   * ingested in between be excluded from an index that has already become the
   * live one.
   */
  finishIfDone(orgId: string, layerId: string, shadowVector: string): Promise<boolean>
  /**
   * How a pass over one layer went, written where the operator polls.
   *
   * Separate from `onError` because `onError` writes to a log and this writes
   * to `reindex_state`. Both existed in the design; only the log was
   * implemented, so `GET /v1/layers/{id}/reindex` reported `failed: 0,
   * status: running` for a reindex that had failed every document it ever
   * claimed and would go on failing them.
   */
  recordPass(input: {
    orgId: string
    layerId: string
    shadowVector: string
    succeeded: number
    failed: number
    error?: string
  }): Promise<void>
  onError(target: ReindexTarget, error: unknown): void
}

export interface ReindexResult {
  readonly reindexed: number
  readonly failed: number
  readonly switched: number
}

export async function reindexOnce(ports: ReindexPorts, batch: number): Promise<ReindexResult> {
  if (batch < 1) throw new Error('batch must be at least 1')

  const targets = await ports.claim(batch)
  if (targets.length === 0) return { reindexed: 0, failed: 0, switched: 0 }

  let reindexed = 0
  let failed = 0

  /** Per layer, because the state that records it is per layer. */
  const passes = new Map<string, { target: ReindexTarget; succeeded: number; failed: number; error?: string }>()
  const passFor = (t: ReindexTarget) => {
    const key = `${t.orgId}:${t.layerId}:${t.shadowVector}`
    const existing = passes.get(key)
    if (existing !== undefined) return existing
    const fresh: { target: ReindexTarget; succeeded: number; failed: number; error?: string } = {
      target: t,
      succeeded: 0,
      failed: 0,
    }
    passes.set(key, fresh)
    return fresh
  }

  for (const target of targets) {
    try {
      // Serial rather than concurrent, deliberately. Every one of these is an
      // embedding round trip against a model server that a deployment sized for
      // its own ingest rate, and a reindex is background work with no deadline
      // — the documented response to it being slow is to leave it running, not
      // to make it compete with the ingest it shares an endpoint with.
      const vectors = await ports.embed(
        target.providerId,
        target.chunks.map((c) => c.text),
      )

      if (vectors.length !== target.chunks.length) {
        // The same guard the ingest path has, for the same reason: a mismatch
        // means the embedder dropped or reordered something, and writing it
        // would attach the wrong vector to the wrong text. Silent retrieval
        // damage, with no failing test anywhere.
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${target.chunks.length} chunks`,
        )
      }

      await ports.addVector(
        target.collection,
        target.shadowVector,
        target.chunks.map((c, i) => ({ pointId: c.pointId, vector: vectors[i] as readonly number[] })),
      )

      // After the write, never before. Marked first and failed second leaves a
      // document counted as reindexed with no vector — and since the switch
      // depends on the count, that is how `vector_name` moves to a model that
      // cannot answer for part of the layer.
      await ports.markReindexed(target.orgId, target.documentId, target.shadowVector)
      reindexed++
      passFor(target).succeeded++
    } catch (error) {
      failed++
      const pass = passFor(target)
      pass.failed++
      pass.error = String(error)
      ports.onError(target, error)
    }
  }

  // Only for layers this pass actually touched, and only once each. Asking
  // every reindexing layer on every pass would be a query per layer per two
  // seconds for the whole duration of a migration.
  let switched = 0
  for (const pass of passes.values()) {
    const t = pass.target

    // Recorded before the switch is attempted. A layer that just crossed the
    // failure bound is no longer running, and `finishIfDone` requires it to be
    // — so the order is what stops a reindex being marked failed and complete
    // by the same pass.
    await ports.recordPass({
      orgId: t.orgId,
      layerId: t.layerId,
      shadowVector: t.shadowVector,
      succeeded: pass.succeeded,
      failed: pass.failed,
      ...(pass.error === undefined ? {} : { error: pass.error }),
    })

    if (await ports.finishIfDone(t.orgId, t.layerId, t.shadowVector)) switched++
  }

  return { reindexed, failed, switched }
}
