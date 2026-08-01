/**
 * Reclaiming documents whose worker never came back.
 *
 * A claim commits `status = 'parsing'` and then the work happens outside that
 * transaction — deliberately, because holding a row lock across a parse, an
 * embedding call, and a vector upsert ties a database connection to the slowest
 * thing in the pipeline. The cost is that the claim outlives the process. Kill
 * a worker mid-document and the row sits in `parsing`, which nothing claims,
 * with a job the API already answered `202` for.
 *
 * There is no symptom. Search returns fewer documents than were ingested, the
 * job says `parsing` forever, and no error is logged anywhere because nothing
 * failed — a process stopped existing between two statements.
 *
 * This is the other half of that design. It is deliberately dull: expire a
 * lease, put the row back, count the attempt, and fail it past a ceiling.
 */

export interface StrandedDocument {
  readonly orgId: string
  readonly documentId: string
  /** How long the claim has been held, for the log. */
  readonly heldSeconds: number
  readonly attempts: number
}

export interface ReapPorts {
  /**
   * Documents claimed longer ago than the lease. Both the requeue and the fail
   * happen inside this call, per row, because the decision depends on the
   * attempt count that the same statement increments — splitting it would let
   * two reapers each read 4 and each write 5.
   */
  claim(limit: number, leaseSeconds: number, maxAttempts: number): Promise<readonly StrandedDocument[]>
  onReaped(document: StrandedDocument, outcome: 'requeued' | 'failed'): void
}

export interface ReapResult {
  readonly requeued: number
  readonly failed: number
}

export async function reapOnce(
  ports: ReapPorts,
  batch: number,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<ReapResult> {
  if (batch < 1) throw new Error('batch must be at least 1')
  // A zero lease reclaims a document the instant it is claimed, which is not a
  // fast reaper — it is a loop that never lets any document finish.
  if (leaseSeconds < 1) throw new Error('lease must be at least 1 second')
  if (maxAttempts < 1) throw new Error('maxAttempts must be at least 1')

  const stranded = await ports.claim(batch, leaseSeconds, maxAttempts)

  let requeued = 0
  let failed = 0
  for (const document of stranded) {
    // The port already wrote the row; this classifies what it did so the caller
    // can log it. A document at the ceiling is failed, and `attempts` is what
    // the port compared, so the boundary is decided in one place.
    if (document.attempts >= maxAttempts) {
      failed++
      ports.onReaped(document, 'failed')
    } else {
      requeued++
      ports.onReaped(document, 'requeued')
    }
  }

  return { requeued, failed }
}
