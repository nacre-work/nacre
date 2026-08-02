/**
 * The gate between a finished reindex and the switch that makes it live.
 *
 * `docs/architecture.md` step 4 has named this since before there was a
 * reindex. Everything else in the migration checks that a write happened; this
 * is the only step that asks whether the new model can still answer.
 *
 * ## What it is measuring, and what it is not
 *
 * Recall@k against documents an operator picked, per reference query, averaged
 * over the set. Not agreement with the old model: a better model disagrees with
 * the worse one it replaces, so a gate on agreement blocks the migrations worth
 * making and passes a new model that reproduces the old one's mistakes.
 *
 * The mean is over queries and not over hits. An operator writes a reference
 * set as a list of things search must still do, and a micro-average lets one
 * query with ten expected documents outvote five with one each — which is the
 * opposite of how the list reads.
 *
 * ## Three outcomes, not two
 *
 * - **passed** — the mean is at or above the floor. `finishReindexIfDone` may
 *   switch.
 * - **failed** — below it. The reindex ends at `failed`, the pointer does not
 *   move, the layer stays on the model it was already on, and the shadow
 *   vectors stay in the collection so the numbers can be looked at.
 * - **unresolved** — the reference set names documents that are not there. This
 *   is *not* a low score: a stale reference set and a bad model are different
 *   problems, and scoring a missing document as a miss reports the first as the
 *   second. It fails, and it says which entries did not resolve.
 *
 * ## Why this is not a search path
 *
 * It queries the index with `org_id`, `layer_id` and `deleted = false` and
 * **no ACL filter**, which anywhere else in this repository would be the leak
 * every other rule exists to prevent. It is allowed here for one structural
 * reason: there is no principal. Nothing calls this on behalf of a caller,
 * there is no request, and no document, id, or text leaves it — the return type
 * is numbers and the ids of reference queries.
 *
 * That is why the retrieval port takes a layer and returns document ids rather
 * than taking a filter: there is no argument through which a caller-shaped
 * query could reach the index, and no way to reuse this from the request path
 * by passing something different.
 */

/** The `k` the check retrieves at, and the cap on a reference query's expectations. */
export const RECALL_K = 10

export interface ReferenceQuery {
  readonly id: string
  readonly query: string
  /** Resolved from external ids by the port. Empty is impossible; see `missing`. */
  readonly expected: readonly string[]
  /** External ids in the set that name no live document. Any is a failure. */
  readonly missing: readonly string[]
}

export interface RecallTarget {
  readonly orgId: string
  readonly layerId: string
  /** The organization's collection, read from the pointer, never derived. */
  readonly collection: string
  readonly shadowVector: string
  /** The *new* provider. Embedding the reference queries with the old one measures nothing. */
  readonly providerId: string
  readonly queries: readonly ReferenceQuery[]
}

export interface QueryScore {
  readonly queryId: string
  readonly recall: number
}

export interface RecallVerdict {
  readonly recall: number
  readonly floor: number
  readonly passed: boolean
  readonly queries: number
  readonly scores: readonly QueryScore[]
  /** Present only when the set did not resolve. Then `passed` is false. */
  readonly unresolved?: readonly string[]
}

export interface RecallPorts {
  /**
   * Layers whose reindex has embedded everything and has not been checked yet.
   *
   * Cross-tenant, like every other worker claim. The implementation is what
   * decides "everything" — it is the same `NOT EXISTS` the switch uses, so a
   * layer cannot be checked while a document is outstanding and then switched
   * on a verdict computed before that document existed.
   */
  due(limit: number): Promise<readonly RecallTarget[]>
  /** With the shadow provider's model. The whole point is that it is the new one. */
  embed(providerId: string, texts: readonly string[]): Promise<readonly (readonly number[])[]>
  /**
   * Top-`k` document ids for one embedded query, on the shadow vector, in one
   * layer. Takes no filter — see the note above on why.
   */
  retrieve(target: RecallTarget, vector: readonly number[], k: number): Promise<readonly string[]>
  /** Write the verdict where the operator polls, and let the switch see it. */
  record(target: RecallTarget, verdict: RecallVerdict): Promise<void>
  /**
   * The same `finishReindexIfDone` the embedding pass calls, and the same one
   * statement — gate, completeness predicate and switch together.
   *
   * Called from here because a layer with a reference set and nothing left to
   * embed is never *claimed* by that pass, so nothing else would ever run it.
   * That is the shape of bug `finishCopy` already carries a comment about: a
   * layer whose status stays `running` for good with everything about it
   * already correct.
   */
  finishIfDone(orgId: string, layerId: string, shadowVector: string): Promise<boolean>
  /** End the reindex at `failed`, with a reason a person can act on. */
  fail(target: RecallTarget, reason: string): Promise<void>
  onChecked(target: RecallTarget, verdict: RecallVerdict): void
  onError(target: RecallTarget, error: unknown): void
}

export interface RecallResult {
  readonly passed: number
  readonly failed: number
  /** Could not be evaluated — the embedder or the index was unreachable. */
  readonly errored: number
  /** Layers whose switch this pass performed, having passed the gate. */
  readonly switched: number
}

/**
 * Score one layer's reference set.
 *
 * Exported for the tests, which is most of what there is to test here: the
 * arithmetic, and the three outcomes it has to distinguish.
 */
export function score(
  queries: readonly ReferenceQuery[],
  retrieved: readonly (readonly string[])[],
  floor: number,
): RecallVerdict {
  if (queries.length !== retrieved.length) {
    throw new Error(`scored ${retrieved.length} results against ${queries.length} queries`)
  }

  const unresolved = queries.flatMap((q) => [...q.missing])
  const scores: QueryScore[] = queries.map((q, i) => {
    // A Set, because a reference set may legitimately name a document twice
    // across two queries and an index may return a document once per chunk. The
    // score is over documents either way.
    const hits = new Set(retrieved[i] ?? [])
    const found = q.expected.filter((id) => hits.has(id)).length
    return { queryId: q.id, recall: q.expected.length === 0 ? 0 : found / q.expected.length }
  })

  const recall =
    scores.length === 0 ? 0 : scores.reduce((sum, s) => sum + s.recall, 0) / scores.length

  return {
    recall,
    floor,
    // Unresolved fails regardless of the number, because the number is not
    // about the model. `>=` and not `>`: a floor of 0.8 means 0.8 passes, which
    // is what an operator who typed it meant, and a floor of 0 means measure
    // and never block — arithmetic rather than a special case for "disabled".
    passed: unresolved.length === 0 && recall >= floor,
    queries: scores.length,
    scores,
    ...(unresolved.length === 0 ? {} : { unresolved }),
  }
}

export async function recallOnce(
  ports: RecallPorts,
  floor: number,
  batch: number,
): Promise<RecallResult> {
  if (floor < 0 || floor > 1) throw new Error('floor must be between 0 and 1')
  if (batch < 1) throw new Error('batch must be at least 1')

  const targets = await ports.due(batch)
  let passed = 0
  let failed = 0
  let errored = 0
  let switched = 0

  for (const target of targets) {
    try {
      if (target.queries.length === 0) {
        // `due` is supposed to exclude these — a layer with no reference set has
        // no gate at all and the switch predicate says so. Reaching here would
        // mean scoring an empty set, which averages to zero and would fail every
        // migration in the deployment.
        throw new Error('a layer with no reference queries reached the recall check')
      }

      // One embedding call for the whole set. These are short strings and there
      // are at most a few dozen; a round trip each would make the gate the
      // slowest step in a migration that is otherwise bounded by re-embedding
      // the corpus.
      const vectors = await ports.embed(
        target.providerId,
        target.queries.map((q) => q.query),
      )
      if (vectors.length !== target.queries.length) {
        // The same guard the ingest and reindex paths carry. Here it matters
        // more than usual: a dropped vector would silently shift every
        // subsequent query onto the wrong expectations and produce a plausible,
        // meaningless number.
        throw new Error(
          `embedder returned ${vectors.length} vectors for ${target.queries.length} queries`,
        )
      }

      const retrieved: (readonly string[])[] = []
      for (const [i] of target.queries.entries()) {
        retrieved.push(await ports.retrieve(target, vectors[i] as readonly number[], RECALL_K))
      }

      const verdict = score(target.queries, retrieved, floor)

      // Recorded either way, and before anything acts on it. A failed migration
      // whose numbers were never written is one an operator can only re-run to
      // understand.
      await ports.record(target, verdict)
      ports.onChecked(target, verdict)

      if (verdict.passed) {
        passed++
        // Immediately, and not on the next embedding pass. For a layer with
        // documents that pass would come round in five seconds; for a layer
        // with none it never comes at all, because nothing claims it. The
        // switch statement re-evaluates everything — the gate it just wrote,
        // and the completeness predicate — so calling it here cannot make it
        // switch anything it would otherwise refuse.
        if (await ports.finishIfDone(target.orgId, target.layerId, target.shadowVector)) {
          switched++
        }
      } else {
        failed++
        await ports.fail(
          target,
          verdict.unresolved === undefined
            ? `recall ${verdict.recall.toFixed(3)} is below the floor of ${floor}`
            : `the reference set names ${verdict.unresolved.length} document(s) that do not exist: ` +
              `${verdict.unresolved.slice(0, 5).join(', ')}`,
        )
      }
    } catch (error) {
      // Not a failure of the migration. The embedder being unreachable says
      // nothing about the new model's recall, and ending the reindex on it would
      // turn a restart into a re-run of the whole corpus. No verdict is written,
      // so the next pass tries again — which is the same shape as every other
      // retry in the worker.
      errored++
      ports.onError(target, error)
    }
  }

  return { passed, failed, errored, switched }
}
