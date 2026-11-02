import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { createPool } from '@nacre.work/core'

import { PostgresDocuments, PostgresLayers } from '../adapters.js'
import type { AuthContext } from '../auth.js'

/**
 * Security audit 2026-11-01, LOW finding
 * api/adapters.ts:layer-document-count-includes-denied-documents.
 *
 * `GET /v1/layers`' `document_count` and `failed_count` counted every live
 * document in the layer, with no reference to `plan.deniedDocs` — so a
 * caller holding `read` on a layer but denied one specific document in it
 * was told that document exists, and whether it failed to index, from an
 * aggregate. `PostgresDocuments.read` already subtracts the same set for a
 * single document (invariant 4: a denied document and one that does not
 * exist answer the same way), so the counts disagreed with the one surface
 * that is supposed to make a denied document invisible.
 *
 * The core itself can never create a document-scoped deny — `POST
 * /v1/grants` refuses one by name — so this is latent in an open-core-only
 * installation and real the moment a module that issues deny rules (such as
 * `acl-advanced`) is loaded. The deny row below is inserted directly, the
 * way such a module would issue one, which is also how the audit itself
 * reproduced it.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the denied-document count leak would go untested.')
}
const when = url ? describe : describe.skip

let pool: Pool
const ORG = randomUUID()
const WS = randomUUID()
const LAYER = randomUUID()
const PROVIDER = randomUUID()
const USER = randomUUID()
const DOC_VISIBLE = randomUUID()
const DOC_DENIED = randomUUID()

when('a layer catalog beside a document-scoped deny', () => {
  let layers: PostgresLayers
  let documents: PostgresDocuments

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string, max: 4 })
    const client = await pool.connect()
    try {
      const slug = `denycount-${ORG.slice(0, 8)}`
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
      await client.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'L','L',$4,'v1')`,
        [LAYER, ORG, WS, PROVIDER],
      )
      // Two live documents: one visible, one failed and about to be denied.
      await client.query(
        `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, title, content_hash, metadata, status)
         VALUES ($1,$2,$3,'visible','inline','Visible','sha256:a','{}','indexed')`,
        [DOC_VISIBLE, ORG, LAYER],
      )
      await client.query(
        `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, title, content_hash, metadata, status)
         VALUES ($1,$2,$3,'denied','inline','Denied','sha256:b','{}','failed')`,
        [DOC_DENIED, ORG, LAYER],
      )
      // Read on the layer, plus a document-scoped deny on one document in
      // it — exactly the shape a module issuing document-level denies would
      // write, and the core's own CHECK constraint already admits.
      await client.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect, source)
         VALUES ($1,'user',$2,'layer',$3,'read','allow','manual'),
                ($1,'user',$2,'document',$4,'read','deny','manual')`,
        [ORG, USER, LAYER, DOC_DENIED],
      )
    } finally {
      client.release()
    }
    layers = new PostgresLayers(pool, { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined })
    documents = new PostgresDocuments(pool, { setMetadata: async () => undefined })
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

  const member: AuthContext = { orgId: ORG, principal: { type: 'user', id: USER }, role: 'member' }

  it('404s a document-level deny the way every single-document read already does', async () => {
    expect(await documents.read(member, DOC_DENIED)).toBeUndefined()
    const visible = await documents.read(member, DOC_VISIBLE)
    expect(visible?.document_id).toBe(DOC_VISIBLE)
  })

  it('excludes a denied document from the layer catalog\'s document_count and failed_count', async () => {
    const { items } = await layers.list(member)
    const layer = items.find((l) => l.id === LAYER)
    expect(layer).toBeDefined()
    // One visible, indexed document; the denied, failed one is invisible to
    // both counts, exactly as it is to a direct read.
    expect(layer?.documentCount).toBe(1)
    expect(layer?.failedCount).toBe(0)
  })
})
