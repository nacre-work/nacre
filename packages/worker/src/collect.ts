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
  readonly orgSlug: string
  readonly documentId: string
  /** How long it has been tombstoned, for the log and the grace check. */
  readonly deletedAgeSeconds: number
}

export interface CollectPorts {
  /** Documents tombstoned longer than the grace period, oldest first. */
  claim(limit: number, graceSeconds: number): Promise<readonly PurgeTarget[]>
  /** Remove every point of a document. Physical, not a payload flag. */
  purge(orgSlug: string, documentId: string): Promise<void>
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
      await ports.purge(target.orgSlug, target.documentId)
      await ports.markPurged(target.orgId, target.documentId)
      purged++
    } catch (error) {
      failed++
      ports.onError(target, error)
    }
  }

  return { purged, failed }
}
