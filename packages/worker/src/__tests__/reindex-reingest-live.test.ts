import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { claimReindexable, finishReindexIfDone, markReindexed, PostgresDocumentStore } from '../adapters.js'

/**
 * A document re-ingested while its layer is being moved onto another model.
 *
 * Ingest writes a document's points under the layer's *live* vector name and
 * mints fresh point ids every pass, so a re-ingested document's new points
 * carry no shadow vector. If `reindexed_vector` still says the document is done,
 * the embedding pass never claims it again and the switch counts it as migrated:
 * the layer moves onto the new slot and that document matches nothing on it,
 * with no error anywhere. Found by checking the reindex rollback runbook
 * against the code, and reproduced here before it was fixed.
 *
 * Two orders, because each is a way to get it wrong. Marked and then
 * re-ingested is the plain one. The other is the race: the embedding pass
 * claimed the old points, ingest replaced them, and the pass then marks the
 * document done for vectors it wrote onto points that no longer exist.
 *
 * Against a real PostgreSQL, because every property here is an UPDATE and a
 * claim query; Qdrant is not needed to see a document the claim will never
 * return again.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; a re-ingest during a reindex would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'c0bbc1a1-0000-4000-8000-0000000000a1'
const ids = {
  ws: 'c0bbc1a1-0000-4000-8000-0000000000a2',
  layer: 'c0bbc1a1-0000-4000-8000-0000000000a3',
  provider: 'c0bbc1a1-0000-4000-8000-0000000000a4',
}
const SHADOW = 'v2'
const OLD = ['c0bbc1a1-0000-4000-8000-0000000000b1', 'c0bbc1a1-0000-4000-8000-0000000000b2']
const NEW = ['c0bbc1a1-0000-4000-8000-0000000000c1', 'c0bbc1a1-0000-4000-8000-0000000000c2']

when('a re-ingest during a reindex', () => {
  let pool: Pool
  let store: PostgresDocumentStore

  const embedding = JSON.stringify({
    status: 'running',
    phase: 'embedding',
    shadow_vector: SHADOW,
    provider_id: ids.provider,
    started_at: new Date().toISOString(),
    total: 1,
    done: 0,
    failed: 0,
  })

  const ingest = (pointIds: readonly string[], text: string) =>
    store.upsert({
      orgId: ORG,
      layerId: ids.layer,
      externalId: 'handbook',
      title: 'Handbook',
      contentHash: text,
      chunks: pointIds.map((pointId, ordinal) => ({ ordinal, text: `${text} ${String(ordinal)}`, pointId })),
      metadata: {},
    })

  const claimed = async () => (await claimReindexable(pool, 50)).filter((t) => t.layerId === ids.layer)

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    store = new PostgresDocumentStore(pool)
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'reingest','reingest','org_reingest') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'reingest','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'reingest','W')
         ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'reingest','R',$4,'v1') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
    } finally {
      c.release()
    }
  })

  beforeEach(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM documents WHERE org_id = $1', [ORG])
      await c.query(`UPDATE layers SET vector_name = 'v1', reindex_state = $2::jsonb WHERE id = $1`, [
        ids.layer,
        embedding,
      ])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('claims a re-ingested document again, and does not switch the layer without it', async () => {
    const doc = await ingest(OLD, 'first')
    expect((await claimed()).map((t) => t.documentId)).toEqual([doc.id])
    await markReindexed(pool, ORG, doc.id, SHADOW, OLD)
    expect(await claimed()).toEqual([])

    // The document changes. Its new points carry only the live vector.
    await ingest(NEW, 'second')

    const again = await claimed()
    expect(again.map((t) => t.documentId), 're-ingested document never reclaimed').toEqual([doc.id])
    expect(again[0]?.chunks.map((c) => c.pointId).sort()).toEqual([...NEW].sort())
    expect(
      await finishReindexIfDone(pool, ORG, ids.layer, SHADOW),
      'the switch counted a document whose points lack the new vector',
    ).toBe(false)
  })

  it('does not mark a document done for points a re-ingest has already replaced', async () => {
    const doc = await ingest(OLD, 'first')
    const [target] = await claimed()
    expect(target?.documentId).toBe(doc.id)

    // The pass embedded the old points; ingest replaced them before it marked.
    await ingest(NEW, 'second')
    await markReindexed(pool, ORG, doc.id, SHADOW, target?.chunks.map((c) => c.pointId) ?? [])

    expect((await claimed()).map((t) => t.documentId), 'marked done for points that are gone').toEqual([doc.id])
    expect(await finishReindexIfDone(pool, ORG, ids.layer, SHADOW)).toBe(false)
  })

  it('still marks, and switches, when nothing moved under the pass', async () => {
    const doc = await ingest(OLD, 'first')
    const [target] = await claimed()
    await markReindexed(pool, ORG, doc.id, SHADOW, target?.chunks.map((c) => c.pointId) ?? [])
    expect(await claimed()).toEqual([])
    expect(await finishReindexIfDone(pool, ORG, ids.layer, SHADOW)).toBe(true)
  })
})
