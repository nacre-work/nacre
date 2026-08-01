import { QdrantClient } from '@qdrant/js-client-rest'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NacreSearchService, type AuthContext } from '@nacre.work/api'
import { ingest, PostgresDocumentStore, QdrantVectorWriter, tagsForLayer } from '@nacre.work/worker'

import { createPool, withOrg } from '../../db/client.js'
import { collectionConfig, collectionName, PAYLOAD_INDEXES } from '../../vector/query.js'
import { VectorStore } from '../../vector/search.js'

/**
 * The round trip: a document goes in through the worker, and comes back out
 * through search — or does not, depending on the grants.
 *
 * Every other test in this suite holds one end still. The pre-filter tests
 * inspect the query without an index behind it; the saturation tests populate
 * Qdrant by hand without the pipeline in front of it; the search-path tests use
 * a stub store. Each is sharper for it, and none of them would notice if the
 * two halves disagreed about what they were writing and reading — a payload
 * field the writer spells one way and the filter another passes all of them and
 * returns nothing, or everything, in production.
 *
 * Real Postgres, real Qdrant, the real worker pipeline, the real search
 * service. The parser and the embedder are stubs because they are HTTP calls to
 * somebody else's process, and a deterministic vector makes the assertion about
 * permissions rather than about relevance.
 */

const pgUrl = process.env.NACRE_PG_URL
const qdrantUrl = process.env.NACRE_QDRANT_URL

if (process.env.CI && (!pgUrl || !qdrantUrl)) {
  throw new Error(
    'NACRE_PG_URL and NACRE_QDRANT_URL are both required when CI is set. This is ' +
      'the only test that runs the pipeline and the search path against each ' +
      'other; skipping it silently is how the two halves drift apart.',
  )
}

const when = pgUrl && qdrantUrl ? describe : describe.skip

const ORG = '55555555-5555-5555-5555-555555555555'
const SLUG = 'roundtrip'
const VECTOR = 'v_test_4'
const DIM = 4

const ids = {
  alice: '00000000-0000-0000-0000-0000000000f1',
  bob: '00000000-0000-0000-0000-0000000000f2',
  ws: '00000000-0000-0000-0000-0000000000f3',
  open: '00000000-0000-0000-0000-0000000000f4',
  shut: '00000000-0000-0000-0000-0000000000f5',
  provider: '00000000-0000-0000-0000-0000000000f6',
}

const AS_APP = { role: 'nacre_app' } as const

let pool: Pool
let client: QdrantClient
let search: NacreSearchService

/** Deterministic, so a failure is about permissions and never about ranking. */
const embedder = {
  embed: async (texts: readonly string[]) => texts.map(() => [0.1, 0.2, 0.3, 1] as readonly number[]),
}

const parser = {
  parse: async (source: { content?: string; url?: string }) => ({
    text: source.content ?? `fetched:${source.url}`,
    metadata: {},
  }),
}

const as = (user: string): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: user },
  role: 'member',
})

let counter = 0
const newId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

async function index(layerId: string, externalId: string, content: string): Promise<void> {
  const acl = await tagsForLayer(pool, ORG, layerId, 'nacre_app')
  await ingest(
    {
      orgId: ORG,
      orgSlug: SLUG,
      layerId,
      vectorName: VECTOR,
      externalId,
      content,
      aclTags: acl.tags,
      aclVersion: acl.version,
    },
    {
      parser,
      embedder,
      documents: new PostgresDocumentStore(pool, 'nacre_app'),
      vectors: new QdrantVectorWriter(client),
      newId,
    },
  )
}

when('pipeline round trip · the worker and the search path agree', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: pgUrl as string })
    client = new QdrantClient({ url: qdrantUrl as string })

    const name = collectionName(SLUG)
    await client.deleteCollection(name).catch(() => {})
    await client.createCollection(name, collectionConfig(VECTOR, DIM) as never)
    for (const ix of PAYLOAD_INDEXES) {
      await client.createPayloadIndex(name, {
        field_name: ix.field_name,
        field_schema: ix.field_schema as never,
        wait: true,
      })
    }

    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,$2,'Round trip',$3) ON CONFLICT DO NOTHING`,
        [ORG, SLUG, collectionName(SLUG)],
      )
      for (const [id, email] of [
        [ids.alice, 'alice@rt.test'],
        [ids.bob, 'bob@rt.test'],
      ] as const) {
        await c.query(`INSERT INTO users (id, org_id, email) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [
          id,
          ORG,
          email,
        ])
      }
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'rt','http://e','m',$2) ON CONFLICT DO NOTHING`,
        [ids.provider, DIM],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      for (const [id, slug] of [
        [ids.open, 'open'],
        [ids.shut, 'shut'],
      ] as const) {
        await c.query(
          `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [id, ORG, ids.ws, slug, ids.provider, VECTOR],
        )
      }
      // Alice reads `open` and nothing else. Bob is granted nothing at all.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'read','allow') ON CONFLICT DO NOTHING`,
        [ORG, ids.alice, ids.open],
      )
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }

    search = new NacreSearchService({
      pool,
      vectors: new VectorStore({ url: qdrantUrl as string }),
      embedder,
      orgSlug: async () => SLUG,
      vectorName: VECTOR,
      role: 'nacre_app',
    })

    await index(ids.open, 'handbook', 'New engineers get repository access on their first day.')
    await index(ids.shut, 'salaries', 'Compensation bands for the engineering ladder.')
  })

  afterAll(async () => {
    await client?.deleteCollection(collectionName(SLUG)).catch(() => {})
    await pool?.end()
  })

  it('the document reaches the index with the fields the filter looks for', async () => {
    const { points } = await client.scroll(collectionName(SLUG), { limit: 100, with_payload: true })

    expect(points.length).toBeGreaterThan(0)
    for (const p of points) {
      const payload = p.payload as Record<string, unknown>
      // The writer and the filter have to agree on every one of these. A field
      // spelled differently on the two sides matches nothing and returns
      // nothing — which reads as "no results" and not as a bug.
      expect(payload.org_id).toBe(ORG)
      expect(payload.deleted).toBe(false)
      expect(typeof payload.layer_id).toBe('string')
      expect(typeof payload.doc_id).toBe('string')
      expect(Array.isArray(payload.acl_tags)).toBe(true)
    }
  })

  it('a permitted layer comes back', async () => {
    const hits = await search.search(as(ids.alice), 'repository access', 10)
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(hit.payload.layer_id).toBe(ids.open)
    }
  })

  it('a layer the caller was never granted does not', async () => {
    const hits = await search.search(as(ids.alice), 'compensation bands', 10)

    // The query is aimed at the other document on purpose. Returning nothing
    // from `shut` is the product's entire claim; getting that result because
    // the vectors happened to rank badly would prove nothing, which is why the
    // embedder gives every chunk the same vector.
    expect(hits.every((h) => h.payload.layer_id === ids.open)).toBe(true)
    expect(hits.some((h) => h.payload.layer_id === ids.shut)).toBe(false)
  })

  it('a caller with no grants at all gets nothing', async () => {
    expect(await search.search(as(ids.bob), 'repository access', 10)).toEqual([])
  })

  it('a deleted document stops coming back before it is purged', async () => {
    const before = await search.search(as(ids.alice), 'repository access', 10)
    expect(before.length).toBeGreaterThan(0)

    const documentId = await withOrg(
      pool,
      ORG,
      async (c) =>
        (
          await c.query<{ id: string }>(
            `SELECT id FROM documents WHERE org_id = $1 AND external_id = 'handbook'`,
            [ORG],
          )
        ).rows[0]?.id as string,
      AS_APP,
    )

    await new QdrantVectorWriter(client).tombstone(SLUG, documentId)

    // Invariant I5. The points are still there — garbage collection has not
    // run — and the only thing keeping them out of this answer is the
    // `deleted = false` clause the filter carries.
    expect(await search.search(as(ids.alice), 'repository access', 10)).toEqual([])

    const { points } = await client.scroll(collectionName(SLUG), {
      limit: 100,
      with_payload: true,
      filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
    })
    expect(points.length, 'the points must still exist, or this proved nothing').toBeGreaterThan(0)
  })
})
