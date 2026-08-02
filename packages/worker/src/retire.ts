/**
 * Reclaiming the collections a model migration left behind.
 *
 * A reindex builds a new collection, copies every point into it, and moves
 * `organizations.vector_collection` at the end. What it points away from is
 * still there — a full copy of the organization's vectors — and until this
 * existed, nothing ever removed one. `rollback-layer-reindex.md` said as much
 * and handed the operator a shell loop over every collection Qdrant has.
 *
 * That loop is the rule this deliberately does not use. "Everything Qdrant has
 * that no organization points at" includes the *target* of a copy that is still
 * running, so the documented cleanup, run at the wrong moment, deletes the
 * migration it was meant to tidy up after. Here the candidates come from
 * `retired_collections`, which is written by the same transaction that moves the
 * pointer — so a collection nothing has been migrated away from yet has no row
 * and can never be selected.
 *
 * ─── the check before the delete ───
 *
 * `isLive` is not paranoia about the table, it is D2 in the runbook. The cheap
 * rollback is "move the pointer back to the old collection", and afterwards the
 * row for that name is still sitting here with its original timestamp. A sweep
 * that trusted the row would delete the collection the organization had just
 * rolled back onto, which is the one irreversible mistake available in this
 * whole path. So the pointer is asked, every time, and a name that is live
 * again is simply no longer retired.
 */

export interface RetiredCollection {
  readonly orgId: string
  readonly name: string
}

export interface RetirePorts {
  /** Rows past the window, oldest first. */
  due(retentionDays: number, limit: number): Promise<readonly RetiredCollection[]>
  /** Whether any organization currently points at this collection. */
  isLive(name: string): Promise<boolean>
  /** Remove the collection. Must tolerate one that is already gone. */
  drop(name: string): Promise<void>
  /** Forget the row. */
  forget(collection: RetiredCollection): Promise<void>
  onDropped(collection: RetiredCollection): void
  /** A name that came back — a pointer rollback, not an error. */
  onRevived(collection: RetiredCollection): void
  onError(collection: RetiredCollection, error: unknown): void
}

export interface RetireResult {
  readonly dropped: number
  readonly revived: number
  readonly failed: number
}

export async function retireOnce(
  ports: RetirePorts,
  retentionDays: number,
  batch: number,
): Promise<RetireResult> {
  if (batch < 1) throw new Error('batch must be at least 1')
  if (retentionDays < 1) throw new Error('retentionDays must be at least 1')

  let dropped = 0
  let revived = 0
  let failed = 0

  for (const collection of await ports.due(retentionDays, batch)) {
    try {
      if (await ports.isLive(collection.name)) {
        // Rolled back onto. Forget the row rather than leaving it to be
        // reconsidered every pass — it is not retired, and a row that is
        // re-examined forever is a log line forever.
        await ports.forget(collection)
        revived++
        ports.onRevived(collection)
        continue
      }

      // Dropped before the row goes. The other order loses the only record
      // that the collection exists: a forget that succeeded and a drop that
      // failed leaves it on disk with nothing naming it, which is the state
      // this file exists to end. This way the worst case is a row whose
      // collection is already gone, and `drop` tolerates that.
      await ports.drop(collection.name)
      await ports.forget(collection)
      dropped++
      ports.onDropped(collection)
    } catch (error) {
      // Per collection. One organization's Qdrant refusing a delete must not
      // stop the others, and the row stays so the next pass tries again.
      failed++
      ports.onError(collection, error)
    }
  }

  return { dropped, revived, failed }
}
