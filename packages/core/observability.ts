import type { Pool } from 'pg'

import { withOrg } from './db/client.js'
import type { Metrics } from './metrics.js'

/**
 * The gauges that are queries rather than counters.
 *
 * Registered as a collector so they are computed on scrape, not on a timer:
 * a timer that stops leaves the last value in place, and a stale gauge reads
 * as a healthy one.
 */
export function collectDatabaseGauges(pool: Pool, metrics: Metrics, role?: string): () => Promise<void> {
  const scope = role === undefined ? {} : { role }

  return async () => {
    const client = await pool.connect()
    try {
      // Across organizations, so it runs outside withOrg under the role that
      // may see them all. Every query below names org_id in its output rather
      // than filtering to one.
      const { rows: orgs } = await client.query<{ id: string; slug: string; groups_version: string }>(
        'SELECT id, slug, groups_version FROM organizations WHERE deleted_at IS NULL',
      )

      metrics.documents.reset()
      metrics.tombstonesPending.reset()
      metrics.aclPropagationLag.reset()

      for (const org of orgs) {
        const counts = await withOrg(
          pool,
          org.id,
          async (c) =>
            (
              await c.query<{ status: string; n: string }>(
                `SELECT status, count(*)::text AS n FROM documents
                  WHERE org_id = $1 AND deleted_at IS NULL GROUP BY status`,
                [org.id],
              )
            ).rows,
          scope,
        )
        for (const row of counts) {
          metrics.documents.set(Number(row.n), { org: org.slug, status: row.status })
        }

        const pending = await withOrg(
          pool,
          org.id,
          async (c) =>
            (
              await c.query<{ n: string }>(
                `SELECT count(*)::text AS n FROM documents
                  WHERE org_id = $1 AND deleted_at IS NOT NULL AND vectors_purged_at IS NULL`,
                [org.id],
              )
            ).rows[0]?.n ?? '0',
          scope,
        )
        metrics.tombstonesPending.set(Number(pending), { org: org.slug })

        // The oldest document whose tags predate the current groups_version.
        // Zero when everything is caught up; the age of the laggard otherwise.
        const lag = await withOrg(
          pool,
          org.id,
          async (c) =>
            (
              await c.query<{ lag: string | null }>(
                // `chunk_count > 0` is the whole correctness of this gauge, and
                // it was missing. The number is meant to be the age of the
                // oldest document still carrying tags built from a superseded
                // grant set — which only a document with points in the index
                // can do. Without the clause it counted every document behind
                // the version, including ones that never reached the index at
                // all: a single `failed` or `pending` document pinned the gauge
                // at its own age forever, because the retag loop claims neither
                // and nothing else can ever clear it. The one metric with an
                // alert on it became a stuck alert, which is how it gets muted.
                //
                // Deliberately not `status = 'indexed'`. A document that
                // indexed once and failed on a later pass still has the
                // earlier pass's points, still carries their tags, and is
                // exactly the case this is supposed to catch — so the predicate
                // is "has points", and `claimStale` uses the same one.
                `SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min(COALESCE(acl_tagged_at, created_at)))), 0)::text AS lag
                   FROM documents
                  WHERE org_id = $1 AND deleted_at IS NULL AND chunk_count > 0
                    AND acl_version < $2`,
                [org.id, Number(org.groups_version)],
              )
            ).rows[0]?.lag ?? '0',
          scope,
        )
        // Per organization, and set even when it is zero.
        //
        // A single worst-across-tenants number was the first shape of this and
        // it was wrong twice over: one neglected tenant pins the gauge and hides
        // every other tenant behind it, and when the alert does fire it does not
        // say who. `max(nacre_acl_propagation_lag_seconds) > 60` is the same
        // alert and is still independent of how many tenants exist, so the
        // aggregate cost nothing and bought nothing.
        //
        // Zero is written rather than omitted: an absent series and a zero one
        // mean "caught up" and "not being measured", and those must not look
        // alike on the one metric that evidences I4.
        metrics.aclPropagationLag.set(Number(lag), { org: org.slug })
      }
    } finally {
      client.release()
    }
  }
}
