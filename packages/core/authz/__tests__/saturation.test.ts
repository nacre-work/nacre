import { QdrantClient } from '@qdrant/js-client-rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { QueryablePlan } from '../filter.js'
import { collectionConfig, collectionName, PAYLOAD_INDEXES, type Branch } from '../../vector/query.js'
import { VectorStore } from '../../vector/search.js'

const url = process.env.NACRE_QDRANT_URL

/**
 * T9 and T10 — result saturation.
 *
 * These are the cases that catch a post-filter, and they are the reason the
 * pre-filter is architectural rather than a matter of taste. An implementation
 * that fetches k results and then removes the ones the caller may not see
 * passes every baseline case in this suite and fails both of these: it returns
 * "10 minus whatever got stripped" where the specification requires 10.
 *
 * They need a real index. Whether `top_k` returns k *permitted* results is a
 * property of the HNSW traversal, and no amount of inspecting the request
 * proves it — which is exactly why they stayed pending until now.
 */
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_QDRANT_URL is not set and CI is. T9 and T10 would silently skip, and ' +
      'they are the two cases that catch a post-filter — the failure this job ' +
      'exists to make impossible to ship.',
  )
}

const when = url ? describe : describe.skip

const ORG = '11111111-1111-1111-1111-111111111111'
const SLUG = 'satcheck'
const VECTOR = 'v_test_4'
const DIM = 4

/**
 * Real UUIDs, because the payload indexes say `uuid` and Qdrant enforces it —
 * a readable id like `layer-00` is rejected on upsert. Generated from a counter
 * so a failure names something reproducible.
 */
const uuid = (prefix: string, n: number): string =>
  `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`

/** 20 layers, per T9. Layer 0 is the one the caller may read. */
const LAYERS = Array.from({ length: 20 }, (_, i) => uuid('1a1e5', i))
const ALLOWED = LAYERS[0] as string
/** A second allowed layer holding exactly five documents, per T10. */
const SMALL = uuid('5ma11', 0)

const TOMBSTONED = uuid('70m85', 0)

/** The client reports every rejection as `Bad Request`; the detail is in .data. */
function explain(cause: unknown): string {
  const data = (cause as { data?: unknown } | null)?.data
  return data === undefined ? String(cause) : `${String(cause)} — ${JSON.stringify(data)}`
}

let client: QdrantClient
let store: VectorStore

const branches = (seed: number): readonly Branch[] => [
  { kind: 'dense', using: VECTOR, vector: [seed, 1 - seed, seed / 2, 1] },
  { kind: 'sparse', using: 'bm25', vector: { indices: [1, 2], values: [0.5, 0.5] } },
]

const planFor = (layers: readonly string[]): QueryablePlan => ({
  kind: 'scoped',
  layers: [...layers],
  extraDocs: [],
  deniedDocs: [],
})

when('saturation · top_k returns k permitted results', () => {
  beforeAll(async () => {
    client = new QdrantClient({ url: url as string })
    store = new VectorStore({ url: url as string })

    const name = collectionName(SLUG)
    await client.deleteCollection(name).catch(() => {
      // Absent is the expected state on a fresh runner.
    })
    try {
      await client.createCollection(name, collectionConfig({ name: VECTOR, size: DIM }) as never)
    } catch (cause) {
      throw new Error(`createCollection rejected: ${explain(cause)}`, { cause })
    }

    for (const index of PAYLOAD_INDEXES) {
      try {
        await client.createPayloadIndex(name, {
          field_name: index.field_name,
          field_schema: index.field_schema as never,
          wait: true,
        })
      } catch (cause) {
        throw new Error(`payload index ${index.field_name} rejected: ${explain(cause)}`, { cause })
      }
    }

    const points: unknown[] = []
    let id = 1

    // 30 documents in each of the 20 layers. The allowed layer holds more than
    // top_k, so a correct implementation can fill the page from it alone.
    for (const layer of LAYERS) {
      for (let d = 0; d < 30; d++) {
        points.push({
          id: id++,
          vector: {
            [VECTOR]: [Math.random(), Math.random(), Math.random(), 1],
            bm25: { indices: [1, 2], values: [Math.random(), Math.random()] },
          },
          payload: {
            org_id: ORG,
            layer_id: layer,
            doc_id: uuid('d0c', d + 1000 * LAYERS.indexOf(layer)),
            deleted: false,
          },
        })
      }
    }

    // Exactly five, for T10.
    for (let d = 0; d < 5; d++) {
      points.push({
        id: id++,
        vector: {
          [VECTOR]: [Math.random(), Math.random(), Math.random(), 1],
          bm25: { indices: [1, 2], values: [Math.random(), Math.random()] },
        },
        payload: { org_id: ORG, layer_id: SMALL, doc_id: uuid('5d0c', d), deleted: false },
      })
    }

    // A deleted document inside the allowed layer, for T7 at index level.
    points.push({
      id,
      vector: {
        [VECTOR]: [1, 1, 1, 1],
        bm25: { indices: [1, 2], values: [1, 1] },
      },
      payload: { org_id: ORG, layer_id: ALLOWED, doc_id: TOMBSTONED, deleted: true },
    })

    try {
      await client.upsert(name, { wait: true, points: points as never })
    } catch (cause) {
      throw new Error(`upsert rejected: ${explain(cause)}`, { cause })
    }
  }, 120_000)

  afterAll(async () => {
    await client?.deleteCollection(collectionName(SLUG)).catch(() => {})
    await store?.close()
  })

  it('T9 · 20 layers, access to 1, top_k=10 returns exactly 10 from that layer', async () => {
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: planFor([ALLOWED]),
      branches: branches(0.3),
      topK: 10,
    })

    // Not "10 minus whatever got stripped".
    expect(hits).toHaveLength(10)
    for (const hit of hits) {
      expect(hit.payload.layer_id).toBe(ALLOWED)
    }
  })

  it('T9 · the count holds as top_k grows', async () => {
    for (const topK of [1, 5, 25]) {
      const hits = await store.search({
        orgId: ORG,
        collection: collectionName(SLUG),
        plan: planFor([ALLOWED]),
        branches: branches(0.7),
        topK,
      })
      expect(hits, `top_k=${topK}`).toHaveLength(topK)
      for (const hit of hits) expect(hit.payload.layer_id).toBe(ALLOWED)
    }
  })

  it('T10 · a 5-document layer with top_k=10 returns 5, with no topping up', async () => {
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: planFor([SMALL]),
      branches: branches(0.5),
      topK: 10,
    })

    expect(hits).toHaveLength(5)
    for (const hit of hits) {
      expect(hit.payload.layer_id).toBe(SMALL)
    }
  })

  it('T7 · a tombstoned document is never returned, before garbage collection', async () => {
    // The point is still in the index; only `deleted` is set. This is the window
    // that depending on GC timing would leave open.
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: planFor([ALLOWED]),
      branches: branches(0.99),
      topK: 30,
    })

    expect(hits.map((h) => h.payload.doc_id)).not.toContain(TOMBSTONED)
  })

  it('the tenant check passes on results that came through the filter', async () => {
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: planFor([ALLOWED]),
      branches: branches(0.2),
      topK: 5,
    })
    expect(() => VectorStore.assertTenant(ORG, hits)).not.toThrow()
  })

  it('a plan reaching one document returns that document and nothing else', async () => {
    const target = uuid('d0c', 3)
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: { kind: 'scoped', layers: [], extraDocs: [target], deniedDocs: [] },
      branches: branches(0.4),
      topK: 10,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]?.payload.doc_id).toBe(target)
  })

  it('a denied document is excluded from inside an allowed layer', async () => {
    const denied = uuid('d0c', 1)
    const hits = await store.search({
      orgId: ORG,
      collection: collectionName(SLUG),
      plan: { kind: 'scoped', layers: [ALLOWED], extraDocs: [], deniedDocs: [denied] },
      branches: branches(0.6),
      topK: 30,
    })

    expect(hits.length).toBeGreaterThan(0)
    expect(hits.map((h) => h.payload.doc_id)).not.toContain(denied)
  })
})
