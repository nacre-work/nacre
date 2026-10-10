import { randomUUID } from 'node:crypto'

import { QdrantClient } from '@qdrant/js-client-rest'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool } from '../db/client.js'
import { rebuildOrganizationIndex } from '../rebuild.js'
import { VectorStore } from '../vector/search.js'

/**
 * Rebuilding an organization's collection after a restore of the database, against
 * a real PostgreSQL and a real Qdrant.
 *
 * The state is the one a restore leaves when the vector store survives it,
 * measured on a running stack before this was written: a document the archive
 * holds whose points were flagged deleted after the archive was taken, and points
 * of a document added afterwards whose rows the restore removed. The first is
 * never found; the second is dropped by search hydration and takes a place in
 * `top_k` for nobody. Both are the vector store disagreeing with the database,
 * and the database is the truth.
 */

const pg = process.env.NACRE_PG_URL
const qdrant = process.env.NACRE_QDRANT_URL
if (process.env.CI && (pg === undefined || qdrant === undefined)) {
  throw new Error('NACRE_PG_URL and NACRE_QDRANT_URL are required when CI is set: a rebuild is a database question')
}
const when = pg && qdrant ? describe : describe.skip

const suffix = randomUUID().slice(0, 8)
const SLUG = `rebuild-${suffix}`
const COLLECTION = `org_rebuild_${suffix.replace(/-/g, '_')}`
const ORG = randomUUID()
const WS = randomUUID()
const PROVIDER = randomUUID()
const LAYER = randomUUID()
const LIVE = randomUUID()
const TOMBSTONED = randomUUID()
const ORPHAN = randomUUID()
const SLOT = 'v_rebuild_4'

let pool: Pool
let client: QdrantClient
let vectors: VectorStore

const point = (docId: string, deleted: boolean) => ({
  id: randomUUID(),
  vector: { [SLOT]: [1, 0, 0, 0] },
  payload: { org_id: ORG, layer_id: LAYER, doc_id: docId, chunk_id: randomUUID(), deleted },
})

const count = async (filter: Record<string, unknown>) =>
  (await client.count(COLLECTION, { filter: filter as never, exact: true })).count

const statusOf = async (id: string) =>
  (await pool.query<{ status: string }>(`SELECT status FROM documents WHERE id = $1`, [id])).rows[0]?.status

when('rebuilding an organization index from the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: pg as string, max: 4 })
    client = new QdrantClient({ url: qdrant as string })
    vectors = new VectorStore({ url: qdrant as string })

    await pool.query(
      `INSERT INTO organizations (id, slug, name, vector_collection) VALUES ($1, $2, 'Rebuild', $3)`,
      [ORG, SLUG, COLLECTION],
    )
    await pool.query(
      `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
       VALUES ($1, $2, 'rebuild', 'http://e', 'm', 4)`,
      [PROVIDER, ORG],
    )
    await pool.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1, $2, 'w', 'W')`, [WS, ORG])
    await pool.query(
      `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
       VALUES ($1, $2, $3, 'l', 'L', $4, $5)`,
      [LAYER, ORG, WS, PROVIDER, SLOT],
    )
  })

  beforeEach(async () => {
    await pool.query(`DELETE FROM documents WHERE org_id = $1`, [ORG])
    await pool.query(
      `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, content_hash, status, deleted_at)
       VALUES ($1, $3, $4, 'live', 'inline', 'h1', 'indexed', NULL),
              ($2, $3, $4, 'gone', 'inline', 'h2', 'indexed', now())`,
      [LIVE, TOMBSTONED, ORG, LAYER],
    )

    // The collection a restore leaves behind: the live document's point flagged
    // deleted, and a point for a document the database no longer has.
    await client.deleteCollection(COLLECTION).catch(() => undefined)
    await client.createCollection(COLLECTION, { vectors: { [SLOT]: { size: 4, distance: 'Cosine' } } } as never)
    await client.upsert(COLLECTION, { wait: true, points: [point(LIVE, true), point(ORPHAN, false)] })
  })

  afterAll(async () => {
    await client?.deleteCollection(COLLECTION).catch(() => undefined)
    await pool?.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
    await pool?.end()
  })

  it('refuses a collection that exists unless told to replace it', async () => {
    await expect(rebuildOrganizationIndex({ pool, vectors, slug: SLUG })).rejects.toThrow(/already exists/u)
    // Nothing was touched: the stale points are still there and nothing was requeued.
    expect(await count({ must: [{ key: 'doc_id', match: { value: ORPHAN } }] })).toBe(1)
    expect(await statusOf(LIVE)).toBe('indexed')
  })

  it('with replace, empties the stale collection and requeues every live document', async () => {
    const done = await rebuildOrganizationIndex({ pool, vectors, slug: SLUG, replace: true })
    expect(typeof done).toBe('object')
    if (typeof done === 'string') return
    expect(done.collection).toBe(COLLECTION)
    expect(done.slots).toEqual([{ name: SLOT, size: 4 }])
    expect(done.requeued).toBe(1)

    // The orphan's point and the wrongly flagged one are both gone: the worker
    // writes the live document's points afresh from its row.
    expect(await count({ must: [{ key: 'org_id', match: { value: ORG } }] })).toBe(0)
    expect(await statusOf(LIVE)).toBe('pending')
    // A tombstone is not put back into the index.
    expect(await statusOf(TOMBSTONED)).toBe('indexed')

    // The rebuilt collection carries the slot the layer searches.
    const info = await client.getCollection(COLLECTION)
    expect(Object.keys((info.config.params.vectors ?? {}) as Record<string, unknown>)).toContain(SLOT)
  })

  it('names an organization that is not there instead of throwing', async () => {
    expect(await rebuildOrganizationIndex({ pool, vectors, slug: `absent-${suffix}`, replace: true })).toMatch(
      /no organization/u,
    )
  })
})
