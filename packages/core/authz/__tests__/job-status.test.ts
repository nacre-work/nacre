/**
 * A writer can learn what became of what it wrote, and nothing else.
 *
 * This is a **widening of an authorization surface**, so it is asserted against
 * a real database rather than argued for in a comment.
 *
 * Rule 6 says `write` does not imply `read`, and the ingest-only service
 * account is the principal that rule exists to describe. Before this, that
 * principal could hand over a document, receive `queued`, and have no way to
 * ask what became of it: `GET /v1/documents/{id}` needs `read` and answered
 * `404`, and `GET /v1/jobs/{id}` resolved `read` too, so it answered `404` as
 * well. Every agent that ingested over MCP therefore treated `queued` as
 * success — which is exactly what a failure needs in order to be silent.
 *
 * What changed is that the job endpoint resolves `write` **as well as** `read`.
 * What did not change is rule 6: the projection is a status, a chunk count and
 * a classified reason. The document's text, title and metadata stay behind
 * `read`, and the two assertions below are the pair that says so.
 */
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresDocuments, PostgresJobs } from '@nacre.work/api'
import type { AuthContext } from '@nacre.work/api'

import { createPool } from '../../db/client.js'

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the job-status widening would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '77777777-7777-7777-7777-777777777777'
const ids = {
  writer: 'a0b57a70-0000-4000-8000-000000000001',
  reader: 'a0b57a70-0000-4000-8000-000000000002',
  stranger: 'a0b57a70-0000-4000-8000-000000000003',
  ws: 'a0b57a70-0000-4000-8000-000000000004',
  layer: 'a0b57a70-0000-4000-8000-000000000005',
  doc: 'a0b57a70-0000-4000-8000-000000000006',
  provider: 'a0b57a70-0000-4000-8000-000000000007',
}

const AS_APP = 'nacre_app'

/**
 * What the worker actually writes, verbatim, endpoint and all. A fixture that
 * tidied this up would be asserting the redaction against a string that never
 * needed redacting.
 */
const STORED_ERROR =
  'Error: the embedding endpoint at http://embedder.internal:8080/embeddings answered 413: ' +
  'Input validation error: inputs must have less than 512 tokens. Given: 620'

const auth = (userId: string): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role: 'member',
})

let pool: Pool

when('a writer can see its own ingest', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'js','J','org_js') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email)
         VALUES ($1,$4,'w@js.test'), ($2,$4,'r@js.test'), ($3,$4,'s@js.test')
         ON CONFLICT DO NOTHING`,
        [ids.writer, ids.reader, ids.stranger, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,$2,'p','http://e','m',8) ON CONFLICT DO NOTHING`,
        [ids.provider, ORG],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'ws','W')
         ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, vector_name, provider_id)
         VALUES ($1,$2,$3,'l','L','v_m',$4) ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
      // Failed, with the stored error the worker would actually write — the
      // endpoint's URL and all.
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, source_ref,
                                content_hash, status, error, chunk_count)
         VALUES ($1,$2,$3,'d','inline','x','h','failed',$4,0)
         ON CONFLICT (id) DO NOTHING`,
        [ids.doc, ORG, ids.layer, STORED_ERROR],
      )
      // One grant each, and neither is both.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow'),
                ($1,'user',$4,'layer',$3,'read','allow')
         ON CONFLICT DO NOTHING`,
        [ORG, ids.writer, ids.layer, ids.reader],
      )
      await c.query('COMMIT')
    } catch (error) {
      await c.query('ROLLBACK')
      throw error
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
      await pool?.end()
    }
  })

  const jobs = () => new PostgresJobs(pool, AS_APP)
  const documents = () => new PostgresDocuments(pool, { async setMetadata() {} }, AS_APP)

  it('the writer sees the status of the document it could write', async () => {
    const job = await jobs().read(auth(ids.writer), ids.doc)
    expect(job?.status).toBe('failed')
    expect(job?.chunkCount).toBe(0)
  })

  it('and gets a reason it can act on', async () => {
    const job = await jobs().read(auth(ids.writer), ids.doc)
    expect(job?.reason).toBe('too_long')
  })

  /** The half that keeps rule 6. */
  it('and still cannot read the document', async () => {
    const document = await documents().read(auth(ids.writer), ids.doc)
    expect(document).toBeUndefined()
  })

  it('and is never told where the installation keeps its embedder', async () => {
    const job = await jobs().read(auth(ids.writer), ids.doc)
    expect(job?.error ?? '').not.toContain('embedder.internal')
    expect(job?.error ?? '').not.toContain('8080')
  })

  it('a reader sees it too, because read reaches the document itself', async () => {
    expect((await jobs().read(auth(ids.reader), ids.doc))?.status).toBe('failed')
  })

  it('and somebody with neither grant is told nothing exists', async () => {
    expect(await jobs().read(auth(ids.stranger), ids.doc)).toBeUndefined()
  })
})
