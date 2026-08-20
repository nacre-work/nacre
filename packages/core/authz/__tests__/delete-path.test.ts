import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NacreIngest } from '@nacre.work/api'
import type { AuthContext } from '@nacre.work/api'

import { createPool } from '../../db/client.js'

/**
 * The delete path.
 *
 * Invariant I5 says a deleted document is never returned, *including before
 * garbage collection*. Nothing about that is held by the Postgres tombstone:
 * the pre-filter tests `deleted = false` on the payload, so a delete that
 * writes only the row leaves the document in every answer until the collector
 * reaches it — minutes later, on a schedule with no deadline.
 *
 * So what is under test here is an ordering, not a state. The index is marked
 * first and the row second, because the two failure directions are not
 * symmetric: index-first fails with the document already invisible and the
 * caller holding an error to retry on, and row-first fails with the document
 * permanently visible and nothing left that would ever look at it again.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the delete path would go untested.')
}
const when = url ? describe : describe.skip

/**
 * Its own id space, not another suffix in the shared `00000000-…-0000000000xx`
 * range. Ids are primary keys across every organization, so a fixture that
 * reuses one silently edits another file's rows — which is how a document this
 * file deletes turns into a gauge assertion failing three packages away.
 */
const ORG = '66666666-6666-6666-6666-666666666666'
const ids = {
  alice: 'de1e7e00-0000-4000-8000-000000000001',
  carol: 'de1e7e00-0000-4000-8000-000000000002',
  ws: 'de1e7e00-0000-4000-8000-000000000003',
  layer: 'de1e7e00-0000-4000-8000-000000000004',
  doc: 'de1e7e00-0000-4000-8000-000000000005',
  denied: 'de1e7e00-0000-4000-8000-000000000006',
  provider: 'de1e7e00-0000-4000-8000-000000000007',
}

const AS_APP = 'nacre_app'

const auth = (userId: string, orgId: string = ORG): AuthContext => ({
  orgId,
  principal: { type: 'user', id: userId },
  role: 'member',
})

/** Records what it was asked to tombstone, and can be told to fail. */
class RecordingIndex {
  readonly seen: { collection: string; documentId: string }[] = []
  fail = false
  async tombstone(collection: string, documentId: string): Promise<void> {
    if (this.fail) throw new Error('qdrant is unreachable')
    this.seen.push({ collection, documentId })
  }
}

let pool: Pool

when('I5 · the delete path', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'dp','D','org_dp') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$3,'a@dp.test'), ($2,$3,'c@dp.test')
         ON CONFLICT DO NOTHING`,
        [ids.alice, ids.carol, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'dp', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'dp','W')
         ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'notes','Notes',$4,'v') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
      // Alice may write the whole workspace. Carol may write it too, but one
      // document inside it is denied to her — the case where checking `layers`
      // alone would let the write through.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'workspace',$4,'write','allow'),
                ($1,'user',$3,'workspace',$4,'write','allow')
         ON CONFLICT DO NOTHING`,
        [ORG, ids.alice, ids.carol, ids.ws],
      )
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** A fresh, live document. Each test deletes its own, so order is free. */
  async function document(id: string): Promise<string> {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, source_type, content_hash)
         VALUES ($1,$2,$3,'inline','h')
         ON CONFLICT (id) DO UPDATE SET deleted_at = NULL`,
        [id, ORG, ids.layer],
      )
      return id
    } finally {
      c.release()
    }
  }

  /** Remove a case's own row, so a run does not assert on the last run's. */
  async function wipe(externalId: string): Promise<void> {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM documents WHERE org_id = $1 AND layer_id = $2 AND external_id = $3', [
        ORG,
        ids.layer,
        externalId,
      ])
    } finally {
      c.release()
    }
  }

  async function deletedAt(id: string): Promise<Date | null> {
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM documents WHERE id = $1',
        [id],
      )
      return rows[0]?.deleted_at ?? null
    } finally {
      c.release()
    }
  }

  const collectionOf = async () => {
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ vector_collection: string }>(
        'SELECT vector_collection FROM organizations WHERE id = $1',
        [ORG],
      )
      return rows[0]?.vector_collection
    } finally {
      c.release()
    }
  }

  const ingest = (index: RecordingIndex) =>
    new NacreIngest({
      pool,
      tombstone: index,
      role: AS_APP,
    })

  it('marks the points deleted, not only the row', async () => {
    const id = await document(ids.doc)
    const index = new RecordingIndex()

    expect(await ingest(index).remove(auth(ids.alice), id)).toBe(true)

    // The row alone changes nothing a query looks at. This assertion is the
    // whole finding: it failed before the index write existed, while the
    // endpoint answered 204 and search kept returning the document.
    // The collection is whatever `organizations.vector_collection` holds —
    // read rather than assumed, because a reindex moves it and deriving it from
    // the slug here would repeat the bug this column exists to prevent. The
    // shared fixture organization means the literal name is not this file's to
    // know either.
    expect(index.seen).toEqual([{ collection: await collectionOf(), documentId: id }])
    expect(await deletedAt(id)).not.toBeNull()
  })

  it('an index that refuses leaves the document undeleted, so the retry is real', async () => {
    const id = await document('de1e7e00-0000-4000-8000-000000000008')
    const index = new RecordingIndex()
    index.fail = true

    await expect(ingest(index).remove(auth(ids.alice), id)).rejects.toThrow(/qdrant/)

    // Not a partial success. Had the row been written first, this failure would
    // have left a document that is gone from the API, present in the index, and
    // queued for nothing but a purge — unrecoverable without an operator.
    expect(await deletedAt(id)).toBeNull()
  })

  it('a caller with no write grant never reaches the index', async () => {
    const id = await document('de1e7e00-0000-4000-8000-000000000009')
    const index = new RecordingIndex()

    // No grants at all for this principal.
    expect(await ingest(index).remove(auth(ids.denied), id)).toBe(false)

    // Refused before the port, not after: a check that tombstoned first and
    // resolved second would let any caller take a document out of search.
    expect(index.seen).toEqual([])
    expect(await deletedAt(id)).toBeNull()
  })

  it('an organization that is not there refuses rather than deleting half', async () => {
    const id = await document('de1e7e00-0000-4000-8000-00000000000a')
    const index = new RecordingIndex()
    const absent = '99999999-9999-4999-8999-999999999999'

    expect(await ingest(index).remove(auth(ids.alice, absent), id)).toBe(false)

    // No organization row, so no `vector_collection` and no index write to
    // make. Writing the Postgres row anyway would report a delete that only
    // ever happened on one side, and the document would stay in every answer.
    expect(index.seen).toEqual([])
    expect(await deletedAt(id)).toBeNull()
  })

  it('a document that is already deleted is refused, and not tombstoned twice', async () => {
    const id = await document('de1e7e00-0000-4000-8000-00000000000b')
    const index = new RecordingIndex()

    expect(await ingest(index).remove(auth(ids.alice), id)).toBe(true)
    expect(await ingest(index).remove(auth(ids.alice), id)).toBe(false)

    // Same answer as a document that never existed — I4 does not stop applying
    // because the caller is allowed to write.
    expect(index.seen).toHaveLength(1)
  })

  it('another organization deletes nothing here', async () => {
    const id = await document('de1e7e00-0000-4000-8000-00000000000c')
    const index = new RecordingIndex()
    const other = '77777777-7777-7777-7777-777777777777'

    expect(await ingest(index).remove(auth(ids.alice, other), id)).toBe(false)

    expect(index.seen).toEqual([])
    expect(await deletedAt(id)).toBeNull()
  })

  it('re-ingesting identical content after a delete requeues, never "unchanged"', async () => {
    // The requeue predicate compared the hash, the metadata and `failed` — and
    // a tombstoned row re-sent with the *identical* content matched none of
    // them, so resurrection (`deleted_at = NULL`) went back to `indexed`
    // untouched while the points kept the tombstone's `deleted: true`. A live,
    // `indexed` document no search could ever return, with `unchanged: true`
    // in the response: invariant 5's mirror image. The index's copy is what
    // the tombstone made of it whatever the bytes say, so a resurrection
    // always requeues — and the collector's columns reset with it, or the
    // *next* delete of a once-purged document never reaches the sweep.
    const index = new RecordingIndex()
    const request = {
      layer: 'notes',
      externalId: 'resurrect-1',
      content: 'the same bytes before and after the delete',
      metadata: {},
    }
    // From a clean slate: this database outlives runs, and a row left by a
    // previous pass is a case asserting on the last run's answer.
    await wipe('resurrect-1')

    const first = (await ingest(index).queue(auth(ids.alice), request)) as { documentId: string }
    expect(first.documentId).toBeDefined()

    const c = await pool.connect()
    try {
      // The worker finished, and an earlier life was purged once.
      await c.query(
        `UPDATE documents SET status = 'indexed', vectors_purged_at = now() WHERE id = $1`,
        [first.documentId],
      )
    } finally {
      c.release()
    }
    expect(await ingest(index).remove(auth(ids.alice), first.documentId)).toBe(true)

    const second = (await ingest(index).queue(auth(ids.alice), request)) as {
      documentId: string
      unchanged: boolean
    }
    expect(second.documentId).toBe(first.documentId)
    expect(second.unchanged).toBe(false)

    const check = await pool.connect()
    try {
      const { rows } = await check.query<{
        status: string
        deleted_at: Date | null
        vectors_purged_at: Date | null
        sweep_claimed_at: Date | null
      }>(
        'SELECT status, deleted_at, vectors_purged_at, sweep_claimed_at FROM documents WHERE id = $1',
        [first.documentId],
      )
      expect(rows[0]?.status).toBe('pending')
      expect(rows[0]?.deleted_at).toBeNull()
      expect(rows[0]?.vectors_purged_at).toBeNull()
      expect(rows[0]?.sweep_claimed_at).toBeNull()
    } finally {
      check.release()
    }
  })

  it('a document re-sent as a different source kind is dispatched as the new kind', async () => {
    // `source_type` was written once at INSERT and never again, while
    // `source_ref` moved on every content change — so a document first
    // ingested by URL and re-sent inline kept 'url' against a ref that was
    // now the whole document text, and the worker asked the parser to fetch
    // the text as a URL, failing forever. The type moves with the ref, under
    // the same condition, because the two describe one value.
    const index = new RecordingIndex()
    await wipe('source-kind-1')
    const asUrl = (await ingest(index).queue(auth(ids.alice), {
      layer: 'notes',
      externalId: 'source-kind-1',
      url: 'https://example.test/source-kind',
      metadata: {},
    })) as { documentId: string }

    const asInline = (await ingest(index).queue(auth(ids.alice), {
      layer: 'notes',
      externalId: 'source-kind-1',
      content: 'now it is the text itself',
      metadata: {},
    })) as { documentId: string }
    expect(asInline.documentId).toBe(asUrl.documentId)

    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ source_type: string; source_ref: string }>(
        'SELECT source_type, source_ref FROM documents WHERE id = $1',
        [asUrl.documentId],
      )
      expect(rows[0]?.source_type).toBe('inline')
      expect(rows[0]?.source_ref).toBe('now it is the text itself')
    } finally {
      c.release()
    }
  })
})
