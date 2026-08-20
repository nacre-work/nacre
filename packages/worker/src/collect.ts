/**
 * Garbage collection for tombstoned vectors.
 *
 * docs/architecture.md: `documents.deleted_at` is set immediately and the
 * points get `deleted: true` in the same transaction; physical removal is a
 * background job, at least hourly. This is that job.
 *
 * **It is not what keeps a deleted document out of results.** Invariant I5 is
 * held by `deleted = false` in every query, and it has to be, because between
 * the delete and this sweep the points are still in the index. Nothing here
 * may be relied on for correctness — if it stops running, the index grows and
 * search stays correct. That ordering is the whole design, and it is why this
 * runs last and quietly rather than urgently.
 *
 * What it does buy: an index that does not grow forever, and a tenant
 * offboarding that eventually means something physical.
 */

export interface PurgeTarget {
  readonly orgId: string
  /** The organization's collection, not derived from its slug. */
  readonly collection: string
  readonly documentId: string
  /** How long it has been tombstoned, for the log and the grace check. */
  readonly deletedAgeSeconds: number
  /**
   * The object holding this document's bytes, when they are not in Postgres.
   *
   * `undefined` for an inline or url document, which is every document on a
   * deployment without object storage. Present means the bucket has a copy that
   * outlives the row unless this sweep removes it — a tombstone that reclaims
   * the vectors and leaves the bytes is a document that is gone from every
   * answer and still on somebody's disk.
   */
  readonly objectKey?: string
}

export interface CollectPorts {
  /**
   * Remove a document's bytes from object storage. Absent is success — the
   * sweep must be able to run twice over the same target.
   *
   * Never called for a deployment without object storage, because no target
   * carries a key there.
   */
  removeObject(key: string): Promise<void>
  /** Documents tombstoned longer than the grace period, oldest first. */
  claim(limit: number, graceSeconds: number): Promise<readonly PurgeTarget[]>
  /**
   * Is this document still tombstoned, right now?
   *
   * Asked again per target, immediately before the destructive step, because
   * `claim` answers for the whole batch at once and the loop below is
   * deliberately serial and slow: ingest resurrects a tombstoned row
   * (`deleted_at = NULL`), so a document re-ingested while the batch works
   * through its predecessors is live by the time its turn comes — and `purge`
   * removes **every** point of a document on purpose, fresh ones included.
   * Skipping a resurrected target costs one wasted claim; purging one is an
   * `indexed` document that answers no search.
   */
  stillDeleted(orgId: string, documentId: string): Promise<boolean>
  /** Remove every point of a document. Physical, not a payload flag. */
  purge(collection: string, documentId: string): Promise<void>
  /** Record that the vectors are gone, so it is not swept twice. */
  markPurged(orgId: string, documentId: string): Promise<void>
  onError(target: PurgeTarget, error: unknown): void
}

export interface CollectResult {
  readonly purged: number
  readonly failed: number
}

/**
 * One sweep.
 *
 * Purge, then mark — the same order as everything else that touches both
 * stores, and for the same reason. Marking first and then failing would record
 * vectors as gone while they are still being returned by nothing but still
 * occupying the index; worse, it would take the document out of this queue
 * permanently, so the points would never be collected by anything.
 *
 * A failure leaves the row unmarked. It comes back on the next sweep, which is
 * the behaviour to want: the cost of retrying a purge is one wasted call, and
 * the cost of dropping one is an orphaned point nobody will ever look for
 * again.
 */
export async function collectOnce(
  ports: CollectPorts,
  batch: number,
  graceSeconds: number,
): Promise<CollectResult> {
  if (batch < 1) throw new Error('batch must be at least 1')
  if (graceSeconds < 0) throw new Error('grace must not be negative')

  const targets = await ports.claim(batch, graceSeconds)
  if (targets.length === 0) return { purged: 0, failed: 0 }

  let purged = 0
  let failed = 0

  // Deliberately serial. Deleting points is the one operation here that is
  // destructive and irreversible, and a sweep that runs it at speed against a
  // vector store also serving search is trading someone's p99 for a job with
  // no deadline. There is nothing waiting on this finishing sooner.
  for (const target of targets) {
    try {
      // A resurrected target is skipped, not failed: ingest brought the
      // document back after the claim, its requeue resets the sweep columns,
      // and the next delete re-claims it. Purging it instead would remove a
      // live document's points — see `stillDeleted` above. Not counted as
      // purged either, because nothing was.
      if (!(await ports.stillDeleted(target.orgId, target.documentId))) continue
      await ports.purge(target.collection, target.documentId)
      // Between the points and the row, and only when there is one. Its own
      // failure fails the whole target, which leaves the row unpurged and the
      // next pass repeating all three — every one of them is idempotent, and
      // an object left behind by a half-finished purge is the leak this step
      // exists to prevent.
      if (target.objectKey !== undefined) await ports.removeObject(target.objectKey)
      await ports.markPurged(target.orgId, target.documentId)
      purged++
    } catch (error) {
      failed++
      ports.onError(target, error)
    }
  }

  return { purged, failed }
}
