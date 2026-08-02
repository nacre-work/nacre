import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool, withOrg } from '../db/client.js'
import { createMetrics, Registry } from '../metrics.js'
import { collectDatabaseGauges } from '../observability.js'

/**
 * The gauges, against a real database.
 *
 * `nacre_acl_propagation_lag_seconds` is the only external evidence that
 * invariant I4 holds — a revoked grant stops being visible within
 * ACL_PROPAGATION_SLA — and an alert is meant to fire on it. A metric with an
 * alert on it needs a test more than most code does: wrong, it reports healthy
 * while a revocation is late, and the failure is silent by construction. There
 * is nothing else watching.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. The propagation gauge would go untested, ' +
      'and it is the only external evidence invariant I4 still holds.',
  )
}
const when = url ? describe : describe.skip

const ORG = '77777777-7777-7777-7777-777777777777'
const ids = {
  ws: '00000000-0000-0000-0000-0000000000d1',
  layer: '00000000-0000-0000-0000-0000000000d2',
  provider: '00000000-0000-0000-0000-0000000000d3',
  fresh: '00000000-0000-0000-0000-0000000000d4',
  stale: '00000000-0000-0000-0000-0000000000d5',
  gone: '00000000-0000-0000-0000-0000000000d6',
}

const AS_APP = { role: 'nacre_app' } as const
let pool: Pool

/** The value of one gauge in a scrape, or undefined when it is absent. */
function gauge(text: string, name: string, labels = ''): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${name}${labels} `))
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
}

async function scrape(): Promise<string> {
  const registry = new Registry()
  const metrics = createMetrics(registry)
  registry.collect(collectDatabaseGauges(pool, metrics, 'nacre_app'))
  return registry.render()
}

/** Sets a document's tagging state directly, standing in for the worker. */
async function tag(id: string, aclVersion: number, agoSeconds: number): Promise<void> {
  await withOrg(
    pool,
    ORG,
    async (c) => {
      await c.query(
        `UPDATE documents SET acl_version = $2, acl_tagged_at = now() - make_interval(secs => $3)
          WHERE org_id = $1 AND id = $4`,
        [ORG, aclVersion, agoSeconds, id],
      )
    },
    AS_APP,
  )
}

when('observability · the database gauges', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'obs','Obs','org_obs') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'obs','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'obs','Obs',$4,'v') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }

    await withOrg(
      pool,
      ORG,
      async (client) => {
        for (const [id, external] of [
          [ids.fresh, 'fresh'],
          [ids.stale, 'stale'],
          [ids.gone, 'gone'],
        ] as const) {
          await client.query(
            `INSERT INTO documents
               (id, org_id, layer_id, external_id, source_type, content_hash, status, chunk_count)
             VALUES ($1,$2,$3,$4,'inline','sha256:x','indexed',1)
             ON CONFLICT (id) DO NOTHING`,
            [id, ORG, ids.layer, external],
          )
        }
        // Deleted but not yet purged: a tombstone, and invisible to the lag.
        await client.query(
          `UPDATE documents SET deleted_at = now(), vectors_purged_at = NULL
            WHERE org_id = $1 AND id = $2`,
          [ORG, ids.gone],
        )
        await client.query('UPDATE organizations SET groups_version = 5 WHERE id = $1', [ORG])
      },
      AS_APP,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('a document tagged at the current version contributes no lag', async () => {
    await tag(ids.fresh, 5, 600)
    await tag(ids.stale, 5, 600)

    // Both are ten minutes old and both are current. Age alone is not lag —
    // a gauge that counted it would fire on a quiet, correct system.
    expect(gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')).toBe(0)
  })

  it('a document behind the current version reports its age', async () => {
    await tag(ids.fresh, 5, 600)
    await tag(ids.stale, 4, 120)

    const lag = gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')
    expect(lag).toBeGreaterThanOrEqual(120)
    expect(lag).toBeLessThan(180)
  })

  it('the worst laggard is what is reported, not the newest', async () => {
    await tag(ids.fresh, 4, 30)
    await tag(ids.stale, 4, 900)

    // An alert asks "is anything behind", so the oldest straggler is the
    // answer. Averaging would let one ancient document hide behind a hundred
    // fresh ones, which is precisely the case worth paging someone for.
    const lag = gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')
    expect(lag).toBeGreaterThanOrEqual(900)
  })

  it('a deleted document never contributes lag', async () => {
    await tag(ids.fresh, 5, 10)
    await tag(ids.stale, 5, 10)
    await tag(ids.gone, 0, 100_000)

    // It is deleted, so invariant I5 already keeps it out of every answer.
    // Counting it would mean a tombstone nobody has purged pages the on-call
    // engineer forever about a propagation problem that does not exist.
    expect(gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')).toBe(0)
  })

  it('a document with no points in the index never contributes lag', async () => {
    await tag(ids.fresh, 5, 10)
    await tag(ids.stale, 5, 10)

    // Saved and restored: this fixture is shared with the tests below, which
    // assert on status counts.
    const before = await withOrg(
      pool,
      ORG,
      async (c) =>
        (
          await c.query<{ status: string; chunk_count: number }>(
            'SELECT status, chunk_count FROM documents WHERE org_id = $1 AND id = $2',
            [ORG, ids.stale],
          )
        ).rows[0],
      AS_APP,
    )

    // A document that never reached the index — `pending`, or `failed` before
    // its first successful pass — has no points, so it carries no tags and can
    // leak no revoked grant. It also cannot be drained: the retag loop claims
    // on the same predicate, so counting it pinned the gauge at that document's
    // age forever. The one metric with an alert on it became a stuck alert,
    // which is how an alert gets muted.
    await withOrg(
      pool,
      ORG,
      (c) =>
        c.query(
          `UPDATE documents SET acl_version = 0, chunk_count = 0, status = 'failed',
                                acl_tagged_at = now() - make_interval(secs => 100000)
            WHERE org_id = $1 AND id = $2`,
          [ORG, ids.stale],
        ),
      AS_APP,
    )

    expect(gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')).toBe(0)

    // And one that *does* have points is still counted, whatever its status —
    // a document that indexed once and failed on a later pass still has the
    // earlier pass's points, which is the case this metric exists for.
    await withOrg(
      pool,
      ORG,
      (c) =>
        c.query(`UPDATE documents SET chunk_count = 3 WHERE org_id = $1 AND id = $2`, [ORG, ids.stale]),
      AS_APP,
    )

    expect(
      gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}'),
    ).toBeGreaterThanOrEqual(99_000)

    await withOrg(
      pool,
      ORG,
      (c) =>
        c.query('UPDATE documents SET status = $3, chunk_count = $4 WHERE org_id = $1 AND id = $2', [
          ORG,
          ids.stale,
          before?.status ?? 'indexed',
          before?.chunk_count ?? 1,
        ]),
      AS_APP,
    )
  })

  it('revoking a grant makes the lag visible', async () => {
    // The scenario the metric is named for, end to end. Everything current,
    // then a grant is revoked; the version moves and the documents are behind
    // it until something re-tags them.
    //
    // Until migration 0005 this reported zero. groups_version was bumped by
    // triggers on groups and group_members but not on grants, so a revocation —
    // the one event invariant I4 is about — moved nothing, and the gauge stayed
    // flat through exactly the window it exists to expose.
    const version = async () =>
      withOrg(
        pool,
        ORG,
        async (c) =>
          Number(
            (
              await c.query<{ groups_version: string }>(
                'SELECT groups_version FROM organizations WHERE id = $1',
                [ORG],
              )
            ).rows[0]?.groups_version,
          ),
        AS_APP,
      )

    const before = await version()
    await tag(ids.fresh, before, 30)
    await tag(ids.stale, before, 30)
    expect(gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')).toBe(0)

    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query(
          `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
           VALUES ($1,'user',$2,'layer',$3,'read','allow')`,
          [ORG, ids.ws, ids.layer],
        )
        await c.query(`DELETE FROM grants WHERE org_id = $1 AND scope_id = $2`, [ORG, ids.layer])
      },
      AS_APP,
    )

    expect(await version()).toBeGreaterThan(before)
    expect(gauge(await scrape(), 'nacre_acl_propagation_lag_seconds', '{org="obs"}')).toBeGreaterThan(0)
  })

  it('tombstones are counted separately, where a purge backlog belongs', async () => {
    const text = await scrape()
    expect(gauge(text, 'nacre_tombstones_pending_total', '{org="obs"}')).toBe(1)
  })

  it('documents are counted by organization and status, excluding the deleted', async () => {
    const text = await scrape()
    expect(gauge(text, 'nacre_documents_total', '{org="obs",status="indexed"}')).toBe(2)
  })

  it('a scrape leaves no gauge behind when its rows go away', async () => {
    await scrape()
    const before = gauge(await scrape(), 'nacre_documents_total', '{org="obs",status="indexed"}')
    expect(before).toBe(2)

    // Gauges are set, never accumulated, so a series has to be cleared between
    // scrapes. Without the reset a document that moved status — or an
    // organization that was offboarded — would keep reporting its last value
    // forever, and the exposition would slowly fill with rows about nothing.
    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query(`UPDATE documents SET status = 'failed' WHERE org_id = $1 AND id = $2`, [
          ORG,
          ids.fresh,
        ])
      },
      AS_APP,
    )

    const text = await scrape()
    expect(gauge(text, 'nacre_documents_total', '{org="obs",status="indexed"}')).toBe(1)
    expect(gauge(text, 'nacre_documents_total', '{org="obs",status="failed"}')).toBe(1)

    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query(`UPDATE documents SET status = 'indexed' WHERE org_id = $1 AND id = $2`, [
          ORG,
          ids.fresh,
        ])
      },
      AS_APP,
    )
  })
})
