import type { Pool } from 'pg'

import { withOrg } from './db/client.js'
import { fromStateJson, reindexProgress } from './reindex.js'
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
      metrics.reindexProgress.reset()
      metrics.collectionsRetired.reset()

      // One series per layer that has ever been reindexed, labelled by slug
      // like every other per-tenant gauge here. Layers with no reindex produce
      // no row and therefore no series: inventing a zero for them would mean
      // every layer in the installation permanently reading "reindex started,
      // gone nowhere".
      //
      // Across organizations in one query rather than per tenant, because this
      // reads `layers` and not `documents` — a handful of rows per tenant at
      // most, and the whole point of the collapse in this collector was that a
      // scrape must not cost a query per organization.
      const { rows: reindexing } = await client.query<{
        slug: string
        layer: string
        state: unknown
      }>(
        `SELECT o.slug, l.slug AS layer, l.reindex_state AS state
           FROM layers l
           JOIN organizations o ON o.id = l.org_id
          WHERE l.reindex_state IS NOT NULL
            AND l.deleted_at IS NULL AND o.deleted_at IS NULL`,
      )
      for (const row of reindexing) {
        const state = fromStateJson(row.state)
        if (state === undefined) continue
        metrics.reindexProgress.set(reindexProgress(state), { org: row.slug, layer: row.layer })
      }

      // Collections a finished migration is still holding, for the same reason
      // and in the same shape as the reindex gauge above: one query across
      // organizations, because `retired_collections` holds a handful of rows in
      // total rather than a handful per tenant, and a scrape must not cost a
      // query per organization.
      //
      // Only organizations that have one produce a series. A zero for everybody
      // else would be true and useless — the number that matters is how much
      // disk a completed migration has not given back, and the alertable shape
      // is one that stops falling, which needs a series to exist at all rather
      // than a floor under every tenant.
      const { rows: retained } = await client.query<{ slug: string; n: string }>(
        `SELECT o.slug, count(*) AS n
           FROM retired_collections r
           JOIN organizations o ON o.id = r.org_id
          GROUP BY o.slug`,
      )
      for (const row of retained) {
        metrics.collectionsRetired.set(Number(row.n), { org: row.slug })
      }

      for (const org of orgs) {
        // One query per organization, not three.
        //
        // It was three — document counts, pending tombstones, propagation lag —
        // each a separate round trip inside its own `withOrg`, so a scrape cost
        // 3N+1 queries and each of those three also paid for a connection
        // checkout and a `SET LOCAL app.current_org`. At five hundred tenants
        // that is fifteen hundred queries every fifteen seconds, on the same
        // pool the request path uses, triggered by an endpoint that anyone who
        // can reach the port may call as fast as they like.
        //
        // All three read `documents` for one organization, so they are one
        // grouped query with FILTERed aggregates. Still per organization and
        // still inside `withOrg`: collapsing across tenants would mean reading
        // every tenant's documents from the API process, and the row-level
        // policies are not something to route around for a gauge.
        const rows = await withOrg(
          pool,
          org.id,
          async (c) =>
            (
              await c.query<{
                status: string
                live: string
                tombstoned: string
                oldest_stale: string | null
              }>(
                `SELECT status,
                        count(*) FILTER (WHERE deleted_at IS NULL)::text AS live,
                        count(*) FILTER (
                          WHERE deleted_at IS NOT NULL AND vectors_purged_at IS NULL
                        )::text AS tombstoned,
                        -- The oldest document whose tags predate the current
                        -- groups_version. chunk_count > 0 is the whole
                        -- correctness of this one, and it was missing once: the
                        -- number is the age of the oldest document still
                        -- carrying tags built from a superseded grant set, which
                        -- only a document with points in the index can do.
                        -- Without the clause a single failed or pending
                        -- document pinned the gauge at its own age forever,
                        -- because the retag loop claims neither and nothing else
                        -- can clear it — the one metric with an alert on it
                        -- became a stuck alert, which is how it gets muted.
                        --
                        -- Deliberately not status = 'indexed'. A document that
                        -- indexed once and failed on a later pass still has the
                        -- earlier pass's points and still carries their tags,
                        -- and is exactly the case this is meant to catch.
                        -- claimStale uses the same predicate; the two must
                        -- agree, or the gauge counts what the loop cannot claim.
                        min(COALESCE(acl_tagged_at, created_at)) FILTER (
                          WHERE deleted_at IS NULL AND chunk_count > 0
                            AND acl_version < $2
                        )::text AS oldest_stale
                   FROM documents
                  WHERE org_id = $1
                  GROUP BY status`,
                [org.id, Number(org.groups_version)],
              )
            ).rows,
          scope,
        )

        let tombstoned = 0
        let oldest: number | undefined
        for (const row of rows) {
          metrics.documents.set(Number(row.live), { org: org.slug, status: row.status })
          tombstoned += Number(row.tombstoned)
          if (row.oldest_stale !== null) {
            const at = Date.parse(row.oldest_stale)
            if (!Number.isNaN(at) && (oldest === undefined || at < oldest)) oldest = at
          }
        }

        metrics.tombstonesPending.set(tombstoned, { org: org.slug })

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
        const lag = oldest === undefined ? 0 : Math.max(0, (Date.now() - oldest) / 1000)
        metrics.aclPropagationLag.set(lag, { org: org.slug })
      }
    } finally {
      client.release()
    }
  }
}
