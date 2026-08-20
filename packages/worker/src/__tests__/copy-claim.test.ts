import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { claimCopyable, finishCopy, renewCopyClaim, repairAfterCopy } from '../adapters.js'

/**
 * The collection copy's claim, against a real database.
 *
 * The copy begins by deleting its target and ends by making it live, so two
 * replicas running it concurrently destroy each other's work — in the worst
 * interleaving, the collection something is already searching. The claim is a
 * lease plus a fencing token, and every property here is a `WHERE` clause:
 * a second claim refused while the lease holds, a renewal refused for a token
 * that is not the holder's, and a finish refused for one — which is what
 * stops a worker that stalled past its lease from finishing over the replica
 * that took the copy from it.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the copy claim would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'c0bbc1a1-0000-4000-8000-000000000001'
const ids = {
  ws: 'c0bbc1a1-0000-4000-8000-000000000002',
  layer: 'c0bbc1a1-0000-4000-8000-000000000003',
  provider: 'c0bbc1a1-0000-4000-8000-000000000004',
  indexed: 'c0bbc1a1-0000-4000-8000-000000000005',
  purged: 'c0bbc1a1-0000-4000-8000-000000000006',
}

when('the collection copy claim', () => {
  let pool: Pool

  const copying = JSON.stringify({
    status: 'running',
    phase: 'copying',
    shadow_vector: 'v2',
    provider_id: ids.provider,
    started_at: new Date().toISOString(),
    total: 0,
    done: 0,
    failed: 0,
  })

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'copyclaim','copyclaim','org_copyclaim') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'copyclaim','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'copyclaim','W')
         ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'copyclaim','C',$4,'v1') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
    } finally {
      c.release()
    }
  })

  beforeEach(async () => {
    const c = await pool.connect()
    try {
      await c.query(`UPDATE layers SET reindex_state = $2::jsonb WHERE id = $1`, [
        ids.layer,
        copying,
      ])
      await c.query(`UPDATE organizations SET vector_collection = 'org_copyclaim' WHERE id = $1`, [
        ORG,
      ])
      await c.query('DELETE FROM documents WHERE org_id = $1', [ORG])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('claims once, and refuses a second claim while the lease holds', async () => {
    const first = await claimCopyable(pool, 8, 900)
    const mine = first.filter((t) => t.orgId === ORG)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.claim).toMatch(/[0-9a-f-]{36}/)
    expect(mine[0]?.startedAt).not.toBe('')

    const second = await claimCopyable(pool, 8, 900)
    expect(second.filter((t) => t.orgId === ORG)).toEqual([])
  })

  it('an expired lease is claimable again, under a new token', async () => {
    const first = (await claimCopyable(pool, 8, 900)).find((t) => t.orgId === ORG)
    expect(first).toBeDefined()

    // Zero seconds of lease: everything claimed is immediately expired.
    const second = (await claimCopyable(pool, 8, 0)).find((t) => t.orgId === ORG)
    expect(second).toBeDefined()
    expect(second?.claim).not.toBe(first?.claim)

    // The first holder's token is dead: it can neither renew nor finish.
    expect(await renewCopyClaim(pool, ORG, ids.layer, first?.claim ?? '', 'nacre_app')).toBe(false)
    expect(
      await finishCopy(pool, ORG, ids.layer, first?.claim ?? '', 'org_copyclaim_v2', 'nacre_app'),
    ).toBe(false)

    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ vector_collection: string }>(
        'SELECT vector_collection FROM organizations WHERE id = $1',
        [ORG],
      )
      // The refused finish moved nothing.
      expect(rows[0]?.vector_collection).toBe('org_copyclaim')
    } finally {
      c.release()
    }
  })

  it('the holder renews, finishes, and the pointer moves exactly then', async () => {
    const target = (await claimCopyable(pool, 8, 900)).find((t) => t.orgId === ORG)
    expect(target).toBeDefined()
    expect(await renewCopyClaim(pool, ORG, ids.layer, target?.claim ?? '', 'nacre_app')).toBe(true)

    expect(
      await finishCopy(pool, ORG, ids.layer, target?.claim ?? '', 'org_copyclaim_v2', 'nacre_app'),
    ).toBe(true)

    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ vector_collection: string; phase: string | null }>(
        `SELECT o.vector_collection, l.reindex_state ->> 'phase' AS phase
           FROM organizations o JOIN layers l ON l.org_id = o.id AND l.id = $2
          WHERE o.id = $1`,
        [ORG, ids.layer],
      )
      expect(rows[0]?.vector_collection).toBe('org_copyclaim_v2')
      expect(rows[0]?.phase).not.toBe('copying')
    } finally {
      c.release()
    }

    // Finished twice is finished once: the phase moved, so the fence refuses.
    expect(
      await finishCopy(pool, ORG, ids.layer, target?.claim ?? '', 'org_copyclaim_v3', 'nacre_app'),
    ).toBe(false)
  })

  it('repairAfterCopy requeues what moved and sends tombstones back to the sweep', async () => {
    const since = new Date(Date.now() - 60_000).toISOString()
    const c = await pool.connect()
    try {
      // Finished indexing during the copy window — its points landed in the
      // collection the pointer just abandoned.
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, content_hash, status, updated_at)
         VALUES ($1,$2,$3,'drift-indexed','inline','h1','indexed', now())`,
        [ids.indexed, ORG, ids.layer],
      )
      // Deleted and already purged during the window — its points in the new
      // collection may still say deleted: false, and vectors_purged_at was
      // keeping it out of the sweep for good.
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, content_hash, status,
                                deleted_at, vectors_purged_at, sweep_claimed_at)
         VALUES ($1,$2,$3,'drift-purged','inline','h2','indexed', now(), now(), now())`,
        [ids.purged, ORG, ids.layer],
      )
    } finally {
      c.release()
    }

    const repaired = await repairAfterCopy(pool, ORG, since, 'nacre_app')
    expect(repaired.requeued).toBe(1)
    expect(repaired.tombstoned).toEqual([ids.purged])

    const check = await pool.connect()
    try {
      const { rows } = await check.query<{
        id: string
        status: string
        vectors_purged_at: Date | null
        sweep_claimed_at: Date | null
      }>('SELECT id, status, vectors_purged_at, sweep_claimed_at FROM documents WHERE org_id = $1', [
        ORG,
      ])
      const indexed = rows.find((r) => r.id === ids.indexed)
      const purged = rows.find((r) => r.id === ids.purged)
      expect(indexed?.status).toBe('pending')
      expect(purged?.vectors_purged_at).toBeNull()
      expect(purged?.sweep_claimed_at).toBeNull()
    } finally {
      check.release()
    }
  })
})
