import { createPool, withOrg } from '@nacre.work/core'

const AS_APP = { role: 'nacre_app' } as const
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  claimPurgeable,
  claimStranded,
  PostgresDocumentStore,
} from '../adapters.js'

/**
 * Garbage collection, against a real database and a real Qdrant.
 *
 * The claim these check is a `WHERE` clause, and a `WHERE` clause cannot be
 * tested against a fake without testing the fake: whether a tombstone inside
 * its grace period is left alone, and whether one past it is claimed exactly
 * once.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the collector would go untested.')
}
const when = url ? describe : describe.skip

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
    expect(claimed[0]?.collection).toBe('org_gcorg')
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
