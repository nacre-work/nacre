/**
 * Taking the next document off the queue.
 *
 * A module of its own for the reason `retry.ts` beside it gives: `main.ts`
 * calls `main()` at the bottom, so importing anything from it starts a worker
 * and ends in `process.exit`. A live case cannot ask a question of a function
 * it cannot import — and the question here is one only a database answers,
 * because the count this hands over comes from a SELECT and an UPDATE that
 * have to agree.
 */
import { acrossOrganizations, type createPool } from '@nacre.work/core'

import { CLAIMABLE_NOW } from './retry.js'

export interface Claim {
  readonly orgId: string
  /** The organization's collection, not derived from its slug. */
  readonly collection: string
  readonly documentId: string
  readonly layerId: string
  readonly externalId: string
  readonly vectorName: string
  /** The layer's embedding provider. Never this process's configuration. */
  readonly providerId: string
  /** What the caller tagged the document with. Written into every point's payload. */
  readonly metadata: Record<string, unknown>
  readonly sourceRef: string | null
  readonly sourceType: string
  /** What the stored bytes are. Decides how the s3 branch hands them to the parser. */
  readonly contentType: string
  /**
   * How many times this document has been tried, *including* this claim — the
   * claim statement increments it. The backoff grows from it, so a document
   * that keeps meeting a service that is still down waits longer each time
   * rather than at a fixed interval.
   */
  readonly attempts: number
}

export async function claimNext(pool: ReturnType<typeof createPool>): Promise<Claim | undefined> {
  // No org scope here on purpose: this runs under the worker role, which the
  // schema gives BYPASSRLS, because it has to see every tenant. That is the one
  // place the second line of defense is off, which is why org_id is named
  // explicitly in every query the worker makes afterwards.
  //
  // The role has to actually be set, and for a long time it was not — 0001 said
  // the role existed and no migration created it, so this ran as whoever
  // connected. On a superuser that is invisible; on the unprivileged role
  // docs/config.md requires, it raised on every poll and the worker indexed
  // nothing.
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      id: string
      org_id: string
      collection: string
      layer_id: string
      external_id: string | null
      vector_name: string
      provider_id: string
      metadata: Record<string, unknown> | null
      source_ref: string | null
      source_type: string
      content_type: string
      attempts: number
    }>(
      `SELECT d.id, d.org_id, o.vector_collection AS collection, d.layer_id, d.external_id, l.vector_name,
              l.provider_id, d.metadata, d.source_ref, d.source_type, d.content_type, d.attempts
         FROM documents d
         JOIN organizations o ON o.id = d.org_id
         JOIN layers l        ON l.id = d.layer_id
        WHERE d.status = 'pending' AND d.deleted_at IS NULL
          -- Not before a requeued document's backoff has elapsed. NULL is
          -- claimable now, which every row that never failed carries and which
          -- is what makes this column need no backfill.
          AND ${CLAIMABLE_NOW}
          -- Not while this organization's collection is being copied.
          --
          -- The copy scrolls the old collection and the pointer moves when it
          -- finishes, so a document indexed in between lands in the collection
          -- that is about to be abandoned: Postgres says 'indexed', the new
          -- collection has never heard of it, and nothing queues it again.
          -- Silent, permanent, and proportional to how long the copy takes.
          --
          -- Waiting is the whole fix. The row stays 'pending', which is a
          -- queue and not an error, and the copy is the only thing it waits
          -- on. It also covers the case the copy exists for: a layer created
          -- against a provider the collection has no slot for yet, whose
          -- documents would otherwise fail every attempt with
          -- "Not existing vector name".
          AND NOT EXISTS (
            SELECT 1 FROM layers c
             WHERE c.org_id = d.org_id
               AND c.reindex_state ->> 'status' = 'running'
               AND c.reindex_state ->> 'phase'  = 'copying'
          )
        ORDER BY d.created_at
        LIMIT 1
        FOR UPDATE OF d SKIP LOCKED`,
    )

    // `acrossOrganizations` owns the transaction, so there is no COMMIT here.
    // The row lock taken by FOR UPDATE is held until it commits, which is what
    // makes SKIP LOCKED mean anything with several workers running.
    const row = rows[0]
    if (row === undefined) return undefined

    // claimed_at starts the lease. Without it a worker that stops existing
    // between here and the finish leaves this row in `parsing`, and nothing
    // claims `parsing` — see reap.ts.
    await client.query(
      `UPDATE documents
          SET status = 'parsing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [row.id],
    )

    return {
      orgId: row.org_id,
      collection: row.collection,
      documentId: row.id,
      layerId: row.layer_id,
      externalId: row.external_id ?? row.id,
      vectorName: row.vector_name,
      providerId: row.provider_id,
      metadata: row.metadata ?? {},
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      contentType: row.content_type,
      // `+ 1`, because the SELECT above reads the row *before* the UPDATE
      // increments it. Without this the field is one behind its own
      // documentation, and both readers are wrong in the same direction: the
      // log tells an operator `attempts: 0` on a first attempt, against a
      // `max_attempts: 3` printed beside it, and the backoff's exponent starts
      // a step low, so the first two attempts share one thirty-second ceiling
      // instead of doubling.
      //
      // The *bound* was never affected and is not computed from this: the
      // `CASE` in `recordFailure` compares the row's own post-increment
      // `attempts` inside the statement that writes the verdict. Which is
      // exactly why nothing failed — found by starting the released image
      // against a dependency that was down and reading the worker's own log.
      attempts: row.attempts + 1,
    }
  })
}
