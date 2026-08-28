/**
 * When a failed document comes back, and when it does not.
 *
 * A module of its own rather than three functions inside `main.ts`, and the
 * reason is a property of that file: it calls `main()` at the bottom, so
 * importing anything from it starts a worker and ends in `process.exit`. A
 * live case cannot ask a question of a function it cannot import — and the
 * questions here are the database's, which is exactly the kind that must be
 * asked of a real one rather than of my own arithmetic played back.
 *
 * `Claim` stays in `main.ts`; this takes the three fields it reads.
 */
import { classifyIngestFailure, isRetryable, withOrg, type createPool } from '@nacre.work/core'

/** The role every runtime connection here uses. Never a superuser. */
const APP_ROLE = 'nacre_app'

export interface FailedClaim {
  readonly orgId: string
  readonly documentId: string
  /**
   * How many times this document has been tried, *including* this attempt —
   * the claim statement increments it before the work starts.
   */
  readonly attempts: number
}

/**
 * How long a requeued document waits before it can be claimed again.
 *
 * Exponential from thirty seconds, capped at fifteen minutes, with **full
 * jitter** over the whole window. The jitter is not decoration: every document
 * queued when an embedder went down fails at the same instant, so a fixed
 * delay brings the entire backlog back simultaneously — at the service that is
 * still recovering. This is the same argument, and the same shape, the core's
 * S3 client already states for a fleet sharing a bucket.
 *
 * No variable. `NACRE_INDEX_MAX_ATTEMPTS` already bounds how many times this
 * happens, which is the number an operator actually reasons about; a second
 * knob for the spacing would be a value nobody tunes and every deployment has
 * to understand. The cap matters more than the curve: a document must not sit
 * unclaimable for an hour because a dependency was down for a minute.
 */
const RETRY_BASE_MS = 30_000
const RETRY_CAP_MS = 15 * 60_000

export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1))
  return Math.floor(random() * ceiling)
}

/**
 * Record what went wrong, and decide whether it is worth trying again.
 *
 * ## The defect this replaces
 *
 * This function used to write `status = 'failed'` for everything the worker
 * caught, on the first attempt. `attempts` and `NACRE_INDEX_MAX_ATTEMPTS`
 * existed and were read by the reaper alone — the case where a worker *died*
 * holding a document — so the commoner case had no retry at all: an embedder
 * restarting, a Qdrant that blinked, a parser timing out, and every document in
 * flight was permanently failed. Nothing retries `failed`, so they stayed there
 * until somebody re-sent the bytes, while the layer went on answering searches
 * out of whatever had indexed.
 *
 * ## What decides
 *
 * `classifyIngestFailure`, which has always known the answer and was asked only
 * by the API, to explain a failure to a caller. `isRetryable` is its own
 * documentation made executable: `unavailable` and `internal` come back,
 * `too_long`, `unreadable` and `quota` do not, and the reasons are stated
 * beside the classifier rather than here.
 *
 * The verdict is still recorded either way. A requeued document keeps the error
 * text of the attempt that failed, so `GET /v1/jobs/{id}` and `ingest_status`
 * can say what is being retried rather than showing a document mysteriously
 * back in `pending` — and the row says `pending` rather than `failed`, which is
 * the honest status for something that will be tried again.
 *
 * The lease is released either way, for the reason the old comment gave: a row
 * that keeps its claim is reaped, and being reaped is not what recording a
 * failure means. What changed is that a *requeued* row is claimed again by
 * whoever picks it up, after `retry_after`.
 */
export async function recordFailure(
  pool: ReturnType<typeof createPool>,
  // The three fields this reads, and not the whole `Claim`. A `Claim` carries a
  // collection, a provider and a metadata object, none of which decides
  // anything here — and a parameter that asks for more than it uses is a
  // parameter a caller has to assemble before it can be asked a question.
  claim: FailedClaim,
  error: unknown,
  maxAttempts: number,
): Promise<{ retrying: boolean; reason: ReturnType<typeof classifyIngestFailure>['reason'] }> {
  // The message, not the document. A parse failure that quotes the file puts
  // document contents in a column anyone with database access reads.
  const text = String(error).slice(0, 500)
  const { reason } = classifyIngestFailure(text)

  return withOrg(
    pool,
    claim.orgId,
    async (client) => {
      // `attempts` was already incremented when this document was claimed, so
      // the row's own count is how many times it has been tried — including
      // this one. Read and compared in the same statement that writes, because
      // two workers failing two documents of the same organization concurrently
      // must not read the same count and both write it.
      const { rows } = await client.query<{ status: string; attempts: number }>(
        `UPDATE documents
            SET status      = CASE WHEN $4 AND attempts < $5 THEN 'pending' ELSE 'failed' END,
                error       = $3,
                claimed_at  = NULL,
                retry_after = CASE WHEN $4 AND attempts < $5
                                   THEN now() + make_interval(secs => $6)
                                   ELSE NULL END,
                updated_at  = now()
          WHERE org_id = $1 AND id = $2
          RETURNING status, attempts`,
        [
          claim.orgId,
          claim.documentId,
          text,
          isRetryable(reason),
          maxAttempts,
          retryDelayMs(claim.attempts) / 1000,
        ],
      )
      const row = rows[0]
      return { retrying: row?.status === 'pending', reason }
    },
    { role: APP_ROLE },
  )
}

/**
 * The claim's own "not before" clause, so nothing holds a second copy of it.
 *
 * `main.ts` interpolates this into the statement that claims a document, and
 * the live case asserts *this* string rather than spelling the predicate out
 * beside the query it is meant to be checking. A case that writes its own copy
 * of the SQL is a case that passes when the real query loses the clause —
 * which is the narrow-projection defect this repository has recorded in a
 * transport parity suite, in a router's hash, and in a check written the same
 * hour as its own fix.
 *
 * NULL is claimable now: every row that never failed carries NULL, which is
 * what makes the column need no backfill.
 */
export const CLAIMABLE_NOW = '(d.retry_after IS NULL OR d.retry_after <= now())'

