import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { createPool } from '@nacre.work/core'

import { NacreIngest, PostgresLayers } from '../adapters.js'
import type { AuthContext } from '../auth.js'

/**
 * Security audit 2026-11-01, LOW finding
 * api/adapters.ts:NacreIngest.writableLayer:layer-delete-race.
 *
 * `NacreIngest.queue`'s own layer check and `PostgresLayers.remove`'s layer
 * lookup each used to be a plain `SELECT`. Postgres does not serialize two
 * plain reads against each other, so an ingest could read the layer as live,
 * and a concurrent delete could finish entirely — lock its documents,
 * tombstone the index, flag every document that existed *at that moment*,
 * and set `layers.deleted_at` — before the ingest's own upsert committed.
 * The result is a document with `deleted_at IS NULL` inside a layer whose own
 * `deleted_at IS NOT NULL`: live in Postgres, invisible to `remove`'s sweep,
 * and never reclaimed by the collector, which claims on the document's own
 * tombstone.
 *
 * `writableLayer` now holds `FOR SHARE` on the layer row for the rest of its
 * transaction, and `remove` takes `FOR UPDATE` on that same row before it
 * locks a single document. `FOR SHARE` and `FOR UPDATE` conflict, so
 * whichever of the two gets there first forces the other to wait for the
 * first's *whole* transaction — not just its own query — to finish:
 *
 *  - If the ingest's `FOR SHARE` lands first, the delete's `FOR UPDATE`
 *    blocks until the ingest commits its document row, and only then runs
 *    its own document-locking `SELECT ... FOR UPDATE`, which by then sees
 *    the row the ingest just wrote. No orphan.
 *  - If the delete's `FOR UPDATE` lands first, the ingest's `FOR SHARE`
 *    blocks until the delete commits `layers.deleted_at`, and then sees it —
 *    `writableLayer`'s `WHERE deleted_at IS NULL` excludes the row, so the
 *    ingest is refused exactly as if the layer had never existed. No orphan.
 *
 * Either way the end state is the same: a layer that ends up deleted never
 * has a document that is not. That is not a probability this test has to get
 * lucky to observe — it is what the lock forces every time — so the
 * assertion below runs several trials and expects every one to hold, rather
 * than running once and hoping to catch the bad interleaving. Measured
 * red by reverting both `FOR SHARE`/`FOR UPDATE` additions in `adapters.ts`:
 * some trials then land a document with `deleted_at IS NULL` in a layer whose
 * own `deleted_at IS NOT NULL` — not every one, because the race still needs
 * the two statements to actually interleave, which is exactly why a
 * lock-based fix and not a retry is the right one.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the layer-delete race would go untested.')
}
const when = url ? describe : describe.skip

let pool: Pool
const ORG = randomUUID()
const WS = randomUUID()
const PROVIDER = randomUUID()
const USER = randomUUID()

const auth: AuthContext = { orgId: ORG, principal: { type: 'user', id: USER }, role: 'member' }

const vectors = {
  vectorsOf: async () => ({}),
  tombstoneLayer: async () => {
    /* no index in this test; remove()'s own SQL is what is under test */
  },
}

when('a layer delete racing an ingest into the same layer', () => {
  let ingest: NacreIngest
  let layers: PostgresLayers

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string, max: 8 })
    const client = await pool.connect()
    try {
      const slug = `race-${ORG.slice(0, 8)}`
      await client.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1, $2::text, $2::text, 'org_' || $2::text)`,
        [ORG, slug],
      )
      await client.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'ws','WS')`, [WS, ORG])
      await client.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,$2,'test','http://embedder.test','bge-m3',8)`,
        [PROVIDER, ORG],
      )
      // Admin on the workspace, which is what `write` on a layer inside it and
      // `remove`'s own `admin` check both resolve from.
      await client.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect, source)
         VALUES ($1,'user',$2,'workspace',$3,'admin','allow','manual')`,
        [ORG, USER, WS],
      )
    } finally {
      client.release()
    }

    ingest = new NacreIngest({ pool, tombstone: { tombstone: async () => undefined } })
    layers = new PostgresLayers(pool, vectors)
  })

  afterAll(async () => {
    const client = await pool.connect()
    try {
      await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
    } finally {
      client.release()
    }
    await pool.end()
  })

  it('never leaves a live document inside a layer it has deleted, across repeated concurrent attempts', async () => {
    const TRIALS = 20
    for (let i = 0; i < TRIALS; i++) {
      const layerId = randomUUID()
      const client = await pool.connect()
      try {
        await client.query(
          `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4::text,$4::text,$5,'v1')`,
          [layerId, ORG, WS, `race-layer-${i}`, PROVIDER],
        )
      } finally {
        client.release()
      }

      const [, removed] = await Promise.all([
        ingest.queue(auth, {
          layer: `race-layer-${i}`,
          externalId: `doc-${i}`,
          content: 'racing content',
          metadata: {},
        }),
        layers.remove(auth, layerId),
      ])

      const check = await pool.connect()
      try {
        const { rows: layerRows } = await check.query<{ deleted_at: Date | null }>(
          `SELECT deleted_at FROM layers WHERE id = $1`,
          [layerId],
        )
        const layerDeleted = layerRows[0]?.deleted_at !== null && layerRows[0]?.deleted_at !== undefined

        // `remove` always finds this layer — it was just created, nobody else
        // is racing it away — so it should succeed on every trial regardless
        // of ordering.
        expect(removed, `trial ${i}: remove() itself`).toBe(true)
        expect(layerDeleted, `trial ${i}: layers.deleted_at`).toBe(true)

        const { rows: liveDocs } = await check.query<{ id: string }>(
          `SELECT id FROM documents WHERE layer_id = $1 AND deleted_at IS NULL`,
          [layerId],
        )
        expect(liveDocs, `trial ${i}: live documents in a deleted layer`).toHaveLength(0)
      } finally {
        check.release()
      }
    }
  })
})
