import { QdrantClient } from '@qdrant/js-client-rest'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { NacreSearchService, type AuthContext } from '@nacre.work/api'
import { ingest, PostgresDocumentStore, QdrantVectorWriter } from '@nacre.work/worker'

import { createPool, withOrg } from '../../db/client.js'
import { collectionConfig, collectionName, PAYLOAD_INDEXES, vectorName } from '../../vector/query.js'
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
const DIM = 4
const MODEL = 'm'
// Derived, exactly as the layer-create path derives it. Written as a literal
// here it did not match the fixture's provider at all — which nothing noticed,
// because until search resolved the model per layer nothing compared them.
const VECTOR = vectorName(MODEL, DIM)

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
  await ingest(
    {
      orgId: ORG,
      collection: collectionName(SLUG),
      metadata: {},
      layerId,
      vectorName: VECTOR,
      externalId,
      content,
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
    await client.createCollection(name, collectionConfig({ name: VECTOR, size: DIM }) as never)
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
         VALUES ($1,NULL,'rt','http://e',$3,$2) ON CONFLICT DO NOTHING`,
        [ids.provider, DIM, MODEL],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      for (const [id, slug] of [
        [ids.open, 'open'],
        [ids.shut, 'shut'],
      ] as const) {
        // slug and name are separate parameters even though the value is the
        // same: slug is citext and name is text, and Postgres refuses to deduce
        // one type for a parameter feeding both.
        await c.query(
          `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [id, ORG, ids.ws, slug, slug, ids.provider, VECTOR],
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
      embedderFor: () => embedder,
      role: 'nacre_app',
    })

    // The collection was just recreated empty, so the documents have to be
    // gone from Postgres too. Ingest is idempotent on (layer, external_id) plus
    // content_hash — rows left behind by an earlier run satisfy that key, the
    // pipeline returns `unchanged` without writing a single vector, and every
    // assertion below then fails against an empty index for a reason that has
    // nothing to do with what is under test.
    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query('DELETE FROM chunks WHERE org_id = $1', [ORG])
        await c.query('DELETE FROM documents WHERE org_id = $1', [ORG])
      },
      AS_APP,
    )

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

      // And nothing the filter does not look for. `acl_tags` and `acl_version`
      // were written here and read by no query; migration 0016 removed them,
      // and this is what keeps them from coming back — a payload field nobody
      // filters on is bytes per point per tenant, forever.
      expect(payload).not.toHaveProperty('acl_tags')
      expect(payload).not.toHaveProperty('acl_version')
    }
  })

  it('a permitted layer comes back, with text a caller can read', async () => {
    const hits = await search.search(as(ids.alice), 'repository access', 10)
    expect(hits.length).toBeGreaterThan(0)
    for (const hit of hits) {
      expect(hit.layer).toBe('open')
      // The result is the contract's shape, not the vector store's. A hit that
      // carried only identifiers and a score sent every caller back for N more
      // requests to find out what it had matched.
      expect(hit.text.length).toBeGreaterThan(0)
      expect(hit.doc_id).toMatch(/^[0-9a-f-]{36}$/i)
    }
  })

  it('the response carries no permission internals', async () => {
    const hits = await search.search(as(ids.alice), 'repository access', 10)
    expect(hits.length).toBeGreaterThan(0)

    // An acl tag is a hash over the grant set reaching a document, so shipping
    // it lets a client group documents by which permissions they share — the
    // shape of the organization's access structure, handed to anyone who can
    // search. The payload used to be the response.
    for (const hit of hits) {
      const keys = Object.keys(hit)
      for (const internal of ['payload', 'org_id', 'layer_id']) {
        expect(keys, `${internal} must not reach the client`).not.toContain(internal)
      }
    }
  })

  it('a layer the caller was never granted does not', async () => {
    const hits = await search.search(as(ids.alice), 'compensation bands', 10)

    // The query is aimed at the other document on purpose. Returning nothing
    // from `shut` is the product's entire claim; getting that result because
    // the vectors happened to rank badly would prove nothing, which is why the
    // embedder gives every chunk the same vector.
    expect(hits.every((h) => h.layer === 'open')).toBe(true)
    expect(hits.some((h) => h.layer === 'shut')).toBe(false)
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

    await new QdrantVectorWriter(client).tombstone(collectionName(SLUG), documentId)

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

  it('re-indexing replaces a document’s points rather than adding to them', async () => {
    // Found by running the stack, not by a test: after several ingests of the
    // same documents, Qdrant held two points per document and Postgres held
    // one chunk each. Every pass mints fresh point ids, so `upsert` overwrote
    // nothing — the previous pass's points stayed behind with `deleted = false`.
    //
    // They cannot leak text: hydration joins on a chunk row that is gone. What
    // they do is match the filter and take places in `top_k`, so a search for
    // ten results silently returned six, permanently, and got worse with every
    // edit. Nothing failed anywhere.
    await index(ids.open, 'revisions', 'The first revision of a document that will be edited.')

    const idOf = async (externalId: string): Promise<string> =>
      withOrg(
        pool,
        ORG,
        async (c) =>
          (
            await c.query<{ id: string }>(
              'SELECT id FROM documents WHERE org_id = $1 AND external_id = $2',
              [ORG, externalId],
            )
          ).rows[0]?.id as string,
        AS_APP,
      )

    const documentId = await idOf('revisions')
    const pointsFor = async (): Promise<string[]> =>
      (
        await client.scroll(collectionName(SLUG), {
          limit: 100,
          filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
        })
      ).points.map((p) => String(p.id))

    const first = await pointsFor()
    expect(first.length).toBeGreaterThan(0)

    // Different content, so it is a real re-index and not an idempotent repeat.
    await index(ids.open, 'revisions', 'The second revision, with entirely different words in it.')

    const second = await pointsFor()
    expect(second.length).toBeGreaterThan(0)
    // Fresh ids, which is exactly why an upsert alone left the old ones behind.
    expect(second).not.toEqual(first)
    for (const id of first) expect(second, 'a point from the previous pass survived').not.toContain(id)

    // The index and the chunk table agree on how many there are. This is the
    // assertion that would have caught it: everything else looked correct.
    const chunks = await withOrg(
      pool,
      ORG,
      async (c) =>
        (
          await c.query<{ n: string }>('SELECT count(*) AS n FROM chunks WHERE document_id = $1', [
            documentId,
          ])
        ).rows[0]?.n as string,
      AS_APP,
    )
    expect(second.length).toBe(Number(chunks))

    // And a search for the old wording finds nothing of it, because there is
    // nothing of it left rather than because it ranked badly.
    const hits = await search.search(as(ids.alice), 'first revision', 10)
    expect(hits.some((h) => h.text.includes('second revision'))).toBe(true)
    expect(hits.some((h) => h.text.includes('The first revision'))).toBe(false)
  })
})
