import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NacreIngest } from '@nacre.work/api'
import type { AuthContext } from '@nacre.work/api'
import { ClaimLost, ingest, PostgresDocumentStore, recordFailure, type IngestPorts } from '@nacre.work/worker'

import { createPool } from '../../db/client.js'

/**
 * I5 · a document deleted, or re-sent, while it is being indexed.
 *
 * A worker pass takes seconds to minutes — a parse, an embedding round trip —
 * and the row it is writing can change under it. The pass used to finish
 * regardless: it set the row back to `indexed` with the content it had parsed
 * and wrote points carrying `deleted: false`. So a document deleted mid-pass
 * came back into every search until the collector reached it, and a re-send
 * arriving mid-pass could be replaced by the version it was sent to replace.
 *
 * The locking is Postgres's, so Postgres is real. The index is a map of the
 * two facts the pre-filter reads per point — whose it is and whether it is
 * deleted — because what is under test is the order the two processes write
 * in, and a real Qdrant would only make that order harder to hold still.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; a delete racing an indexing pass would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'cf000000-0000-4000-8000-000000000001'
const ids = {
  alice: 'cf000000-0000-4000-8000-000000000002',
  ws: 'cf000000-0000-4000-8000-000000000003',
  layer: 'cf000000-0000-4000-8000-000000000004',
  provider: 'cf000000-0000-4000-8000-000000000005',
}
const AS_APP = 'nacre_app'
const auth: AuthContext = { orgId: ORG, principal: { type: 'user', id: ids.alice }, role: 'member' }

/** What the pre-filter reads per point: whose it is, and whether it is deleted. */
class Index {
  readonly points = new Map<string, { docId: string; deleted: boolean }>()
  async tombstone(_collection: string, documentId: string): Promise<void> {
    for (const p of this.points.values()) if (p.docId === documentId) p.deleted = true
  }
  /** Points a search would return for this document. */
  live(documentId: string): number {
    return [...this.points.values()].filter((p) => p.docId === documentId && !p.deleted).length
  }
}

let pool: Pool
let n = 0

when('I5 · a document deleted or re-sent while it is being indexed', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES ($1,'claim-fence','CF','org_cf') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(`INSERT INTO users (id, org_id, email) VALUES ($1,$2,'a@cf.test') ON CONFLICT DO NOTHING`, [ids.alice, ORG])
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, $2, 'cf', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [ids.provider, ORG],
      )
      await c.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'cf','W') ON CONFLICT DO NOTHING`, [ids.ws, ORG])
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'notes','Notes',$4,'v') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'workspace',$3,'write','allow') ON CONFLICT DO NOTHING`,
        [ORG, ids.alice, ids.ws],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM organizations WHERE id = $1', [ORG])
    } finally {
      c.release()
    }
    await pool?.end()
  })

  const api = (index: Index) => new NacreIngest({ pool, tombstone: index, role: AS_APP })

  /** A document the API accepted, claimed the way the worker's claim statement claims one. */
  async function claimed(index: Index, content: string): Promise<{ id: string; externalId: string; lease: string }> {
    const externalId = `fence-${String(++n)}-${String(Date.now())}`
    const queued = (await api(index).queue(auth, { layer: 'notes', externalId, content, metadata: {} })) as { documentId: string }
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ claimed_at: string }>(
        `UPDATE documents SET status = 'parsing', claimed_at = now(), attempts = attempts + 1
          WHERE id = $1 RETURNING claimed_at::text AS claimed_at`,
        [queued.documentId],
      )
      return { id: queued.documentId, externalId, lease: (rows[0] as { claimed_at: string }).claimed_at }
    } finally {
      c.release()
    }
  }

  const pass = (index: Index, externalId: string, lease: string, content: string, gate?: Promise<void>) =>
    ingest(
      { orgId: ORG, collection: 'org_cf', layerId: ids.layer, vectorName: 'v', externalId, metadata: {}, content, claim: lease },
      {
        parser: { parse: async (s) => ({ text: s.content ?? '', metadata: {} }) },
        embedder: { embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]) },
        documents: new PostgresDocumentStore(pool),
        vectors: {
          // The upsert in flight: it lands after the gate opens, which is
          // exactly when a delete without the row lock would already have
          // flagged the points that were there before it.
          write: async (input) => {
            if (gate !== undefined) await gate
            for (const p of input.points) index.points.set(p.pointId, { docId: input.documentId, deleted: false })
            for (const [id, p] of index.points) {
              if (p.docId === input.documentId && !input.points.some((q) => q.pointId === id)) index.points.delete(id)
            }
          },
        },
        newId: () => crypto.randomUUID(),
      } satisfies IngestPorts,
    )

  const row = async (id: string) => {
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ status: string; deleted: boolean; content_hash: string; error: string | null }>(
        `SELECT status, deleted_at IS NOT NULL AS deleted, content_hash, error FROM documents WHERE id = $1`,
        [id],
      )
      return rows[0]
    } finally {
      c.release()
    }
  }

  it('a document deleted while it is indexed stays out of every search, and is not marked failed', async () => {
    const index = new Index()
    const doc = await claimed(index, 'the version that is being embedded')
    expect(await api(index).remove(auth, doc.id)).toBe(true)

    await expect(pass(index, doc.externalId, doc.lease, 'the version that is being embedded')).rejects.toBeInstanceOf(ClaimLost)
    expect(index.live(doc.id), 'a deleted document came back into search').toBe(0)
    expect((await row(doc.id))?.deleted).toBe(true)

    // The failure path is fenced the same way: a pass that lost its claim
    // writes no verdict on a row that is not its own.
    await recordFailure(pool, { orgId: ORG, documentId: doc.id, attempts: 1, claimedAt: doc.lease }, new Error('late'), 5)
    expect((await row(doc.id))?.error).toBeNull()
  })

  it('a delete that arrives while the points are being written waits for them, then flags every one', async () => {
    const index = new Index()
    const doc = await claimed(index, 'written while somebody deletes it')
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))

    const writing = pass(index, doc.externalId, doc.lease, 'written while somebody deletes it', gate)
    // Long enough for the pass to have taken the row and be inside the write.
    await new Promise((resolve) => setTimeout(resolve, 300))
    let removed = false
    const removing = api(index)
      .remove(auth, doc.id)
      .then((r) => {
        removed = r
      })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(removed, 'the delete did not wait for the pass holding the row').toBe(false)

    open()
    await writing
    await removing
    expect(removed).toBe(true)
    expect(index.points.size, 'the pass wrote no points').toBeGreaterThan(0)
    expect(index.live(doc.id), 'points written during a delete outlived it').toBe(0)
  })

  it('a re-send arriving mid-pass is not overwritten by the version it replaced', async () => {
    const index = new Index()
    const doc = await claimed(index, 'the old version')
    await api(index).queue(auth, { layer: 'notes', externalId: doc.externalId, content: 'the new version', metadata: {} })
    const requeued = await row(doc.id)
    expect(requeued?.status).toBe('pending')

    await expect(pass(index, doc.externalId, doc.lease, 'the old version')).rejects.toBeInstanceOf(ClaimLost)
    const after = await row(doc.id)
    expect(after?.status, 'the old pass marked the new version indexed').toBe('pending')
    expect(after?.content_hash).toBe(requeued?.content_hash)
    expect(index.live(doc.id), 'the old version reached the index').toBe(0)
  })

  it('the pass that still holds its claim writes as before', async () => {
    const index = new Index()
    const doc = await claimed(index, 'nothing happens to this one')
    const result = await pass(index, doc.externalId, doc.lease, 'nothing happens to this one')
    expect(result.unchanged).toBe(false)
    expect(index.live(doc.id)).toBeGreaterThan(0)
    expect((await row(doc.id))?.status).toBe('indexed')
  })
})
