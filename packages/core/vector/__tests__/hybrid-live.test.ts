import { QdrantClient } from '@qdrant/js-client-rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AccessPlan } from '../../authz/resolve.js'
import { collectionConfig, PAYLOAD_INDEXES, vectorName } from '../query.js'
import { VectorStore } from '../search.js'
import { encodeDocument, encodeQuery, SPARSE_VECTOR_NAME } from '../../text/bm25.js'

/**
 * The hybrid query, against a real Qdrant.
 *
 * Everything else about BM25 is pinned by `text/__tests__/bm25.test.ts`, which
 * is about the encoder and asserts nothing about the database. What that file
 * cannot say is whether Qdrant accepts the slot, the modifier, a point carrying
 * a dense and a sparse vector at once, or a prefetch that mixes the two — and
 * those are facts about somebody else's process. The whole defect this replaces
 * was a set of individually-correct pieces nobody had put in front of a
 * database together.
 *
 * **Every dense vector here is identical.** So the dense branch ranks nothing:
 * an ordering that appears is BM25's, and a claim about relevance is a claim
 * about the lexical branch rather than about a stub embedder's arithmetic.
 */

const url = process.env.NACRE_QDRANT_URL

// Same rule the round-trip test states: this is the only place the sparse
// branch meets a database, so skipping it silently in CI is how the collection
// and the query drift apart again.
if (process.env.CI && url === undefined) {
  throw new Error('NACRE_QDRANT_URL is required when CI is set: the hybrid query needs a real Qdrant')
}

const COLLECTION = 'test_hybrid_live'

/**
 * The same points, in a collection whose sparse slot has no modifier.
 *
 * The only way to say whether `modifier: 'idf'` *does* anything is to run the
 * identical query against a collection without it. Asserting that a rare term
 * outscores a common one proves nothing on its own — the first attempt at this
 * case did exactly that, with two terms whose document frequency happened to be
 * equal, and reported a failure that was the test's arithmetic rather than the
 * database's.
 */
const WITHOUT_IDF = 'test_hybrid_no_idf'

const ORG = '11111111-1111-1111-1111-111111111111'
const LAYER = '22222222-2222-2222-2222-222222222222'
const CLOSED = '33333333-3333-3333-3333-333333333333'
const SLOT = vectorName('stub', 4)
const DENSE = [0.5, 0.5, 0.5, 0.5]

const point = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * A corpus built so that term frequency and IDF disagree.
 *
 * `access` is in every chunk and three times over in one of them; `sqlstate` is
 * in two. So the raw term-frequency weight of `access` is the higher of the
 * two, and only IDF reverses that — which is what makes the pair a test of the
 * modifier rather than of the encoder.
 */
const CHUNKS = [
  {
    n: 1,
    layer: LAYER,
    text: 'The migration failed with SQLSTATE 23505 while granting access to the layers table.',
  },
  {
    n: 2,
    layer: LAYER,
    text:
      'Onboarding: new engineers get repository access, and access to the handbook, ' +
      'on their first day. Access is granted by the platform team.',
  },
  { n: 3, layer: LAYER, text: 'Access requests outside onboarding go through the platform team.' },
  {
    n: 4,
    layer: LAYER,
    text: 'Пункт 4.2 договора описывает доступ подрядчика: repository access for the engagement only.',
  },
  // The same rare term, in a layer the plan excludes. If the lexical branch
  // ever reaches the index without the permission filter, this is what comes
  // back — which is why the case is here and not only in the ACL suite.
  {
    n: 5,
    layer: CLOSED,
    text: 'Salary review: SQLSTATE 23505 appears in the payroll import, and access is restricted.',
  },
]

const PLAN = { kind: 'scoped', layers: [LAYER], extraDocs: [], deniedDocs: [] } as const

describe.skipIf(url === undefined)('the hybrid query against a real Qdrant', () => {
  const client = new QdrantClient({ url: url ?? '', checkCompatibility: false })
  const store = new VectorStore({ url: url ?? '' })

  const dense = { kind: 'dense' as const, using: SLOT, vector: DENSE }
  const lexical = (query: string) => ({
    kind: 'sparse' as const,
    using: SPARSE_VECTOR_NAME,
    vector: encodeQuery(query),
  })
  const search = (branches: Parameters<typeof store.search>[0]['branches'], topK = 5) =>
    store.search({
      orgId: ORG,
      collection: COLLECTION,
      plan: PLAN as unknown as Exclude<AccessPlan, { kind: 'none' }>,
      branches,
      topK,
    })

  const populate = async (collection: string) => {
    await client.upsert(collection, {
      wait: true,
      points: CHUNKS.map((chunk) => {
        const encoded = encodeDocument(chunk.text)
        return {
          id: point(chunk.n),
          vector: {
            [SLOT]: DENSE,
            [SPARSE_VECTOR_NAME]: {
              indices: [...encoded.indices],
              values: [...encoded.values],
            },
          },
          payload: { org_id: ORG, layer_id: chunk.layer, doc_id: `doc-${chunk.n}`, deleted: false },
        }
      }),
    })

    // A point written before the slot had a producer: dense only. Every
    // deployment upgrading into this has a collection full of them.
    await client.upsert(collection, {
      wait: true,
      points: [
        {
          id: point(99),
          vector: { [SLOT]: DENSE },
          payload: { org_id: ORG, layer_id: LAYER, doc_id: 'doc-legacy', deleted: false },
        },
      ],
    })
  }

  beforeAll(async () => {
    for (const name of [COLLECTION, WITHOUT_IDF]) {
      await client.deleteCollection(name).catch(() => undefined)
    }

    await client.createCollection(COLLECTION, collectionConfig({ name: SLOT, size: 4 }) as never)

    // Deliberately not through `collectionConfig` — this is the control, and
    // the whole of it is the one field the real builder sets. `lint:collection-config`
    // exempts `__tests__` for exactly this: a fixture asserting about a shape it
    // chose is not this system creating a collection for a deployment.
    await client.createCollection(WITHOUT_IDF, {
      vectors: { [SLOT]: { size: 4, distance: 'Cosine' } },
      sparse_vectors: { [SPARSE_VECTOR_NAME]: {} },
    } as never)

    for (const index of PAYLOAD_INDEXES) {
      await client.createPayloadIndex(COLLECTION, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }

    await populate(COLLECTION)
    await populate(WITHOUT_IDF)
  }, 60_000)

  afterAll(async () => {
    for (const name of [COLLECTION, WITHOUT_IDF]) {
      await client.deleteCollection(name).catch(() => undefined)
    }
  })

  it('declares the sparse slot with the idf modifier', async () => {
    const info = (await client.getCollection(COLLECTION)) as unknown as {
      config: { params: { sparse_vectors?: Record<string, { modifier?: string }> } }
    }

    // Without the modifier the weights written at ingest are summed raw, which
    // is not BM25 and does not fail — it ranks quietly badly.
    expect(info.config.params.sparse_vectors?.[SPARSE_VECTOR_NAME]?.modifier).toBe('idf')
  })

  it('ranks the chunk holding an identifier first', async () => {
    const hits = await search([dense, lexical('SQLSTATE 23505')], 3)

    expect(hits[0]?.payload?.doc_id).toBe('doc-1')
  })

  it('does not let the lexical branch reach a layer the plan excludes', async () => {
    const hits = await search([dense, lexical('SQLSTATE 23505')], 5)

    expect(hits.map((hit) => hit.payload?.doc_id)).not.toContain('doc-5')
  })

  it('answers a lexical-only query, and a point with no sparse vector simply does not match', async () => {
    const hits = await search([lexical('SQLSTATE 23505')])

    expect(hits[0]?.payload?.doc_id).toBe('doc-1')
    // Not an error for everybody else, which is what `docs/upgrading.md`
    // promises an operator who has not run `rebuild-collection` yet.
    expect(hits.map((hit) => hit.payload?.doc_id)).not.toContain('doc-legacy')
  })

  it('applies IDF, and the collection without the modifier is what proves it', async () => {
    const [rare, common] = await Promise.all([
      topScore(COLLECTION, 'SQLSTATE'),
      topScore(COLLECTION, 'access'),
    ])
    const [rareRaw, commonRaw] = await Promise.all([
      topScore(WITHOUT_IDF, 'SQLSTATE'),
      topScore(WITHOUT_IDF, 'access'),
    ])

    // Term frequency alone favours `access`: it is in every chunk and three
    // times in one of them. That is the control, and it has to hold or the
    // corpus is not testing what this says it is.
    expect(commonRaw).toBeGreaterThan(rareRaw)

    // With the modifier, rarity reverses it. Same points, same encoder, same
    // query — the only difference is the one field on the slot.
    expect(rare).toBeGreaterThan(common)
  })

  it('matches Cyrillic', async () => {
    const hits = await search([lexical('договора подрядчика')], 2)

    expect(hits[0]?.payload?.doc_id).toBe('doc-4')
  })

  /** A bare sparse query, unfused, so the number that comes back is BM25's. */
  async function topScore(collection: string, query: string): Promise<number> {
    const encoded = encodeQuery(query)
    const result = (await client.query(collection, {
      query: { indices: [...encoded.indices], values: [...encoded.values] },
      using: SPARSE_VECTOR_NAME,
      limit: 1,
      filter: { must: [{ key: 'layer_id', match: { value: LAYER } }] },
    } as never)) as unknown as { points: { score: number }[] }
    return result.points[0]?.score ?? 0
  }
})
