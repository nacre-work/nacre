import { collectDatabaseGauges, createMetrics, createPool, Registry, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  claimPurgeable,
  claimStale,
  claimStranded,
  PostgresDocumentStore,
  tagsForLayer,
} from '../adapters.js'
import { retagOnce } from '../retag.js'

/**
 * `markTagged`, against a real database.
 *
 * The guard it carries is a `WHERE` clause, and a `WHERE` clause cannot be
 * tested against a fake without testing the fake. What it defends is invariant
 * I4's evidence: `acl_version` walking backwards invents propagation lag that
 * nothing is actually behind on, and a lag gauge that cries wolf is one nobody
 * reads by the time it is right.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the acl_version guard would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '88888888-8888-8888-8888-888888888888'
const ids = {
  ws: '00000000-0000-0000-0000-0000000000e1',
  layer: '00000000-0000-0000-0000-0000000000e2',
  provider: '00000000-0000-0000-0000-0000000000e3',
  doc: '00000000-0000-0000-0000-0000000000e4',
}

const AS_APP = { role: 'nacre_app' } as const
let pool: Pool
let store: PostgresDocumentStore

async function versionOf(id: string): Promise<{ version: number; taggedAt: Date | null }> {
  return withOrg(
    pool,
    ORG,
    async (c) => {
      const { rows } = await c.query<{ acl_version: string; acl_tagged_at: Date | null }>(
        'SELECT acl_version, acl_tagged_at FROM documents WHERE org_id = $1 AND id = $2',
        [ORG, id],
      )
      return { version: Number(rows[0]?.acl_version), taggedAt: rows[0]?.acl_tagged_at ?? null }
    },
    AS_APP,
  )
}

when('PostgresDocumentStore · markTagged', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    store = new PostgresDocumentStore(pool, 'nacre_app')

    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'store','Store','org_store') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'store','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'store','Store',$4,'v') ON CONFLICT DO NOTHING`,
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
      async (c) => {
        await c.query(
          `INSERT INTO documents
             (id, org_id, layer_id, external_id, source_type, content_hash, status, chunk_count)
           VALUES ($1,$2,$3,'doc','inline','sha256:x','indexed',1)
           ON CONFLICT (id) DO NOTHING`,
          [ids.doc, ORG, ids.layer],
        )
      },
      AS_APP,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  // Back to never-tagged before each case. The fixture row outlives the run,
  // and tests that only pass in order — or only on a clean database — are the
  // ones that get marked flaky and then ignored.
  beforeEach(async () => {
    await withOrg(
      pool,
      ORG,
      async (c) => {
        // sweep_claimed_at too: the retag claim is leased, so a row claimed by
        // the previous run is invisible to this one for the length of the
        // lease. That is the point of the lease and it is real state, so a
        // fixture has to reset it like any other.
        await c.query(
          `UPDATE documents SET acl_version = 0, acl_tagged_at = NULL, sweep_claimed_at = NULL
            WHERE org_id = $1 AND id = $2`,
          [ORG, ids.doc],
        )
      },
      AS_APP,
    )
  })

  it('a fresh document starts untagged, and says so', async () => {
    const { version, taggedAt } = await versionOf(ids.doc)

    // Zero and null rather than "now": a row that has never been tagged must
    // not arrive claiming it was, or the gauge reports a comfortable zero on
    // its first scrape for documents whose vectors carry no tags at all.
    expect(version).toBe(0)
    expect(taggedAt).toBeNull()
  })

  it('records the version and when', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    const { version, taggedAt } = await versionOf(ids.doc)

    expect(version).toBe(7)
    expect(taggedAt).not.toBeNull()
  })

  it('releases the sweep lease, so the next revocation is not locked out', async () => {
    // The bug this exists for, found by running a Compose stack rather than by
    // any test here. `claimStale` writes `sweep_claimed_at` so two replicas do
    // not retag one row at once; `markTagged` did not clear it. Held past the
    // work, the claim stops *this* replica coming back — the next revocation
    // makes the document stale again, the claim has not expired, and the row
    // waits out the whole lease. Fifteen minutes by default, against a
    // documented sixty-second propagation SLA, with the alerted gauge climbing
    // the entire time and the worker log silent after one success.
    const claimed = await claimStale(pool, 10)
    expect(claimed.map((c) => c.documentId)).toContain(ids.doc)

    // Claimed: a second worker cannot take it while the first is working.
    expect((await claimStale(pool, 10)).map((c) => c.documentId)).not.toContain(ids.doc)

    await store.markTagged(ORG, ids.doc, 7)

    // And now the *second* revocation, which is the case that was broken.
    // Set above the version just written rather than incremented: the fixture's
    // groups_version is small, so `+ 1` leaves it under 7 and the document is
    // not stale at all — the test would then pass for the wrong reason.
    await withOrg(
      pool,
      ORG,
      (c) => c.query('UPDATE organizations SET groups_version = 8 WHERE id = $1', [ORG]),
      AS_APP,
    )

    const again = await claimStale(pool, 10)
    expect(again.map((c) => c.documentId)).toContain(ids.doc)
  })

  it('a late write with an older version is refused', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    await store.markTagged(ORG, ids.doc, 4)

    // Two ingests of the same document can finish out of order. Letting the
    // loser win would walk acl_version backwards and manufacture lag against a
    // recomputation that already happened.
    expect((await versionOf(ids.doc)).version).toBe(7)
  })

  it('an equal version still refreshes the timestamp', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    const first = (await versionOf(ids.doc)).taggedAt

    await new Promise((r) => setTimeout(r, 10))
    await store.markTagged(ORG, ids.doc, 7)
    const second = (await versionOf(ids.doc)).taggedAt

    // A retag at the same version is real work, and the lag is measured from
    // the timestamp. Freezing it would report the document as ageing while it
    // is being kept current.
    expect(second?.getTime()).toBeGreaterThan(first?.getTime() as number)
  })

  it('a newer version moves it forward', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    await store.markTagged(ORG, ids.doc, 9)
    expect((await versionOf(ids.doc)).version).toBe(9)
  })

  it('the version tags are built from is the organization’s groups_version', async () => {
    const { version } = await tagsForLayer(pool, ORG, ids.layer, 'nacre_app')
    const current = await withOrg(
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

    // The first version of this passed `Date.now()`. It typechecks — both are
    // numbers — and it silently disables the propagation gauge outright: the
    // lag asks whether acl_version has fallen behind groups_version, and a
    // millisecond timestamp is a thousand times larger than that counter will
    // ever reach, so the comparison never fires and the metric reports perfect
    // health forever. Nothing about a wrong number here is visible except this.
    expect(version).toBe(current)
    expect(version).toBeLessThan(1_000_000)
  })

  it('claimStale finds a document behind its organization’s version, and stops finding it once marked', async () => {
    const current = await withOrg(
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

    // Lease 0: every claim is immediately reclaimable, so what this test
    // observes is the *marking*, not the claim. Otherwise the second call
    // would return nothing because of the lease and pass for the wrong reason.
    const mine = async () => (await claimStale(pool, 500, 0)).filter((d) => d.documentId === ids.doc)

    // Left at 0 by beforeEach, so it is behind whatever the version is now.
    expect(await mine()).toHaveLength(1)
    expect((await mine())[0]?.orgSlug).toBe('store')

    await store.markTagged(ORG, ids.doc, current)

    // The loop terminates only because this stops returning what it just
    // handled. If the claim did not narrow on acl_version, the pass would retag
    // the same documents forever, report progress every time, and never drain
    // the lag it is meant to clear.
    expect(await mine()).toHaveLength(0)
  })

  it('claimStale ignores deleted documents', async () => {
    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query('UPDATE documents SET deleted_at = now() WHERE org_id = $1 AND id = $2', [
          ORG,
          ids.doc,
        ])
      },
      AS_APP,
    )

    // I5 keeps them out of every answer already, so retagging one spends a
    // vector-store call on a document nothing can return.
    expect((await claimStale(pool, 500, 0)).filter((d) => d.documentId === ids.doc)).toHaveLength(0)

    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query('UPDATE documents SET deleted_at = NULL WHERE org_id = $1 AND id = $2', [
          ORG,
          ids.doc,
        ])
      },
      AS_APP,
    )
  })

  it('a claimed document is invisible to another worker until its lease expires', async () => {
    // The reason the claim exists. Every replica used to select the same oldest
    // batch and do the same work, so throughput stayed at one worker's rate
    // however many ran — and scaling the worker out, the documented response to
    // a climbing propagation alert, did nothing at all.
    const first = (await claimStale(pool, 500, 900)).filter((d) => d.documentId === ids.doc)
    expect(first).toHaveLength(1)

    // A second worker polling a moment later gets nothing, because the first
    // one holds it. `FOR UPDATE SKIP LOCKED` alone would not do this: the lock
    // ends when the selecting transaction commits, and the actual work happens
    // afterwards.
    const second = (await claimStale(pool, 500, 900)).filter((d) => d.documentId === ids.doc)
    expect(second).toHaveLength(0)

    // And it comes back once the lease is up, so a worker that dies mid-sweep
    // does not park the row forever.
    const afterExpiry = (await claimStale(pool, 500, 0)).filter((d) => d.documentId === ids.doc)
    expect(afterExpiry).toHaveLength(1)
  })

  it('claimStale honours its limit', async () => {
    expect((await claimStale(pool, 1, 0)).length).toBeLessThanOrEqual(1)
  })

  it('a retag pass drains the propagation lag it was built to measure', async () => {
    // The loop closed, end to end: a document behind the version, a gauge that
    // says so, a pass, and a gauge that no longer does. Every piece of this
    // subsystem exists for this one sentence to be true, and each of them is
    // individually capable of being wrong in a way that reports success.
    //
    // Qdrant is the one port faked here — the payload write has no bearing on
    // what Postgres reports, and standing one up would test the client rather
    // than this.
    const written: string[] = []
    const ports = {
      // The real query, narrowed to this fixture's organization afterwards.
      //
      // `claimStale` is cross-tenant by design — one worker drains every
      // tenant — so a test that acted on everything it returned would retag
      // whatever another test file had just set up and assert against. That is
      // not hypothetical: it is what made this suite pass alone and fail beside
      // the observability tests, which stage a stale document and then check
      // the gauge reports it.
      claim: async (limit: number) => (await claimStale(pool, limit, 0)).filter((d) => d.orgId === ORG),
      tagsFor: (orgId: string, layerId: string) => tagsForLayer(pool, orgId, layerId, 'nacre_app'),
      retag: async (input: { documentId: string }) => {
        written.push(input.documentId)
      },
      markTagged: (orgId: string, id: string, version: number) => store.markTagged(orgId, id, version),
      onError: (_d: unknown, error: unknown) => {
        throw error
      },
    }

    const lag = async (): Promise<number | undefined> => {
      const registry = new Registry()
      const metrics = createMetrics(registry)
      registry.collect(collectDatabaseGauges(pool, metrics, 'nacre_app'))
      const line = (await registry.render())
        .split('\n')
        .find((l) => l.startsWith('nacre_acl_propagation_lag_seconds{org="store"} '))
      return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
    }

    // beforeEach reset it to version 0, which is behind.
    expect(await lag()).toBeGreaterThan(0)

    let guard = 0
    for (;;) {
      const pass = await retagOnce(ports, 1000, 4)
      expect(pass.failed).toBe(0)
      if (pass.retagged === 0) break
      if (++guard > 50) throw new Error('the pass never drained; claimStale is not narrowing')
    }

    expect(written).toContain(ids.doc)
    expect(await lag()).toBe(0)
  })

  it('another organization cannot mark this one’s document', async () => {
    await store.markTagged(ORG, ids.doc, 9)
    const other = '99999999-9999-9999-9999-999999999999'

    // It does not raise. Row-level security makes the row invisible to the
    // other tenant, so the UPDATE matches nothing and succeeds — which is the
    // behaviour to want here, not an error: a cross-tenant write that throws
    // tells the caller the document exists. A silent no-op tells it nothing,
    // and that is invariant I4's "indistinguishable" applied to writes.
    await expect(store.markTagged(other, ids.doc, 999)).resolves.toBeUndefined()

    expect((await versionOf(ids.doc)).version).toBe(9)
  })
})

when('garbage collection, against real storage', () => {
  const GC_ORG = '11111111-2222-3333-4444-555555555555'
  const gcIds = {
    ws: '00000000-0000-0000-0000-0000000000f1',
    layer: '00000000-0000-0000-0000-0000000000f2',
    provider: '00000000-0000-0000-0000-0000000000f3',
    doc: '00000000-0000-0000-0000-0000000000f4',
  }
  let gcPool: Pool
  let gcStore: PostgresDocumentStore

  beforeAll(async () => {
    gcPool = createPool({ connectionString: url as string })
    gcStore = new PostgresDocumentStore(gcPool, 'nacre_app')

    const c = await gcPool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [GC_ORG, 'gcorg', 'gcorg', 'org_gcorg'],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'gc','http://e','m',4) ON CONFLICT DO NOTHING`,
        [gcIds.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [gcIds.ws, GC_ORG, 'w', 'W'],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,$4,$5,$6,'v') ON CONFLICT DO NOTHING`,
        [gcIds.layer, GC_ORG, gcIds.ws, 'gc', 'GC', gcIds.provider],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await gcPool?.end()
  })

  beforeEach(async () => {
    await withOrg(
      gcPool,
      GC_ORG,
      async (c) => {
        await c.query('DELETE FROM documents WHERE org_id = $1', [GC_ORG])
        await c.query(
          `INSERT INTO documents
             (id, org_id, layer_id, external_id, source_type, content_hash, status, chunk_count)
           VALUES ($1,$2,$3,'gc-doc','inline','sha256:x','indexed',1)`,
          [gcIds.doc, GC_ORG, gcIds.layer],
        )
      },
      AS_APP,
    )
  })

  const tombstone = async (agoSeconds: number) =>
    withOrg(
      gcPool,
      GC_ORG,
      async (c) => {
        await c.query(
          `UPDATE documents SET deleted_at = now() - make_interval(secs => $2)
            WHERE org_id = $1 AND id = $3`,
          [GC_ORG, agoSeconds, gcIds.doc],
        )
      },
      AS_APP,
    )

  const mine = async (grace: number) =>
    (await claimPurgeable(gcPool, 500, grace, 0)).filter((t) => t.documentId === gcIds.doc)

  it('a live document is never a purge target', async () => {
    expect(await mine(0)).toHaveLength(0)
  })

  it('a tombstone inside the grace period is left alone', async () => {
    await tombstone(60)
    // The grace period is the only thing standing between a delete and an
    // irreversible one, so it has to be respected by the query rather than by
    // whoever calls it.
    expect(await mine(3600)).toHaveLength(0)
    expect(await mine(30)).toHaveLength(1)
  })

  it('a tombstone past the grace period is claimed, with its age', async () => {
    await tombstone(7200)
    const claimed = await mine(3600)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.orgSlug).toBe('gcorg')
    expect(claimed[0]?.deletedAgeSeconds).toBeGreaterThan(7000)
  })

  it('once marked purged it leaves the queue for good', async () => {
    await tombstone(7200)
    expect(await mine(3600)).toHaveLength(1)

    await gcStore.markPurged(GC_ORG, gcIds.doc)

    // The queue is the only thing that would ever look at these points again.
    // A document that stayed in it after a successful purge would be deleted
    // from the vector store once per sweep, forever.
    expect(await mine(3600)).toHaveLength(0)
  })

  it('marking purged does not disturb when it was deleted', async () => {
    await tombstone(7200)
    await gcStore.markPurged(GC_ORG, gcIds.doc)

    const row = await withOrg(
      gcPool,
      GC_ORG,
      async (c) =>
        (
          await c.query<{ deleted_at: Date; vectors_purged_at: Date }>(
            'SELECT deleted_at, vectors_purged_at FROM documents WHERE org_id = $1 AND id = $2',
            [GC_ORG, gcIds.doc],
          )
        ).rows[0],
      AS_APP,
    )

    // When the tombstone happened and when the space came back are different
    // facts, and an operator investigating a delete wants both.
    expect(row?.deleted_at).toBeDefined()
    expect(row?.vectors_purged_at.getTime()).toBeGreaterThan(row!.deleted_at.getTime())
  })

  it('another organization cannot mark this one’s document purged', async () => {
    await tombstone(7200)
    await gcStore.markPurged('99999999-9999-9999-9999-999999999999', gcIds.doc)
    expect(await mine(3600), 'it must still be queued').toHaveLength(1)
  })
})

when('reclaiming abandoned claims, against real storage', () => {
  const REAP_ORG = '9a9a9a9a-0000-4000-8000-000000000001'
  const reapIds = {
    ws: '9a9a9a9a-0000-4000-8000-000000000002',
    layer: '9a9a9a9a-0000-4000-8000-000000000003',
    provider: '9a9a9a9a-0000-4000-8000-000000000004',
    doc: '9a9a9a9a-0000-4000-8000-000000000005',
    other: '9a9a9a9a-0000-4000-8000-000000000006',
  }
  let reapPool: Pool

  beforeAll(async () => {
    reapPool = createPool({ connectionString: url as string })
    const c = await reapPool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'reaporg','Reap','org_reap') ON CONFLICT DO NOTHING`,
        [REAP_ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'reap','http://e','m',4) ON CONFLICT DO NOTHING`,
        [reapIds.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [reapIds.ws, REAP_ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'reap','Reap',$4,'v') ON CONFLICT DO NOTHING`,
        [reapIds.layer, REAP_ORG, reapIds.ws, reapIds.provider],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await reapPool?.end()
  })

  /** A document claimed `agoSeconds` ago, having been claimed `attempts` times. */
  async function claimed(id: string, agoSeconds: number, attempts: number, status = 'parsing'): Promise<void> {
    await withOrg(
      reapPool,
      REAP_ORG,
      async (c) => {
        await c.query(
          `INSERT INTO documents
             (id, org_id, layer_id, external_id, source_type, content_hash, status, claimed_at, attempts)
           VALUES ($1,$2,$3,$7,'inline','sha256:x',$4, now() - make_interval(secs => $5), $6)
           ON CONFLICT (id) DO UPDATE SET
             status     = EXCLUDED.status,
             claimed_at = EXCLUDED.claimed_at,
             attempts   = EXCLUDED.attempts,
             error      = NULL,
             deleted_at = NULL`,
          // `id` twice would be one parameter deduced as both uuid and text,
          // which Postgres refuses rather than coercing.
          [id, REAP_ORG, reapIds.layer, status, agoSeconds, attempts, id],
        )
      },
      AS_APP,
    )
  }

  async function row(id: string) {
    return withOrg(
      reapPool,
      REAP_ORG,
      async (c) =>
        (
          await c.query<{ status: string; attempts: number; claimed_at: Date | null; error: string | null }>(
            'SELECT status, attempts, claimed_at, error FROM documents WHERE org_id = $1 AND id = $2',
            [REAP_ORG, id],
          )
        ).rows[0],
      AS_APP,
    )
  }

  /** Only this fixture's rows; the claim is cross-tenant by design. */
  const mine = async (lease: number, max: number) =>
    (await claimStranded(reapPool, 500, lease, max)).filter((d) => d.orgId === REAP_ORG)

  it('a claim inside the lease is left alone', async () => {
    await claimed(reapIds.doc, 60, 1)
    expect(await mine(900, 5)).toHaveLength(0)
    expect((await row(reapIds.doc))?.status).toBe('parsing')
  })

  it('an expired claim goes back to pending and counts the attempt', async () => {
    await claimed(reapIds.doc, 1800, 1)

    const reaped = await mine(900, 5)
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.attempts).toBe(2)
    // Above the lease, which is what makes it evidence rather than a guess.
    expect(reaped[0]?.heldSeconds).toBeGreaterThan(900)

    const after = await row(reapIds.doc)
    expect(after?.status).toBe('pending')
    // The lease is released, or the next pass would reap it again immediately.
    expect(after?.claimed_at).toBeNull()
  })

  it('a document at the ceiling is failed with an error an operator can act on', async () => {
    await claimed(reapIds.doc, 1800, 4)

    expect(await mine(900, 5)).toHaveLength(1)

    const after = await row(reapIds.doc)
    expect(after?.status).toBe('failed')
    expect(after?.attempts).toBe(5)
    // The row has to say what happened. Nothing else logged anything: the
    // worker stopped existing between two statements.
    expect(after?.error).toMatch(/abandoned/)
    expect(after?.claimed_at).toBeNull()
  })

  it('an indexed document is never reaped, however old its claim column is', async () => {
    await claimed(reapIds.other, 100_000, 1, 'indexed')
    expect((await mine(900, 5)).map((d) => d.documentId)).not.toContain(reapIds.other)
  })

  it('the increment and the decision happen in one statement', async () => {
    await claimed(reapIds.doc, 1800, 4)

    // Two reapers racing. If the read and the write were separate, both would
    // see 4, both would write 5, and the ceiling would be crossed twice —
    // which is how a bounded retry becomes an unbounded one.
    const [a, b] = await Promise.all([mine(900, 5), mine(900, 5)])
    expect(a.length + b.length).toBe(1)
    expect((await row(reapIds.doc))?.attempts).toBe(5)
  })
})
