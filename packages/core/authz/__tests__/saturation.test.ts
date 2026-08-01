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

/** 20 layers, per T9. Layer 0 is the one the caller may read. */
const LAYERS = Array.from({ length: 20 }, (_, i) => `layer-${String(i).padStart(2, '0')}`)
const ALLOWED = LAYERS[0] as string
/** A second allowed layer holding exactly five documents, per T10. */
const SMALL = 'layer-small'

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
    await client.createCollection(name, collectionConfig(VECTOR, DIM) as never)
    for (const index of PAYLOAD_INDEXES) {
      await client.createPayloadIndex(name, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
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
            doc_id: `${layer}-doc-${d}`,
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
        payload: { org_id: ORG, layer_id: SMALL, doc_id: `${SMALL}-doc-${d}`, deleted: false },
      })
    }

    // A deleted document inside the allowed layer, for T7 at index level.
    points.push({
      id,
      vector: {
        [VECTOR]: [1, 1, 1, 1],
        bm25: { indices: [1, 2], values: [1, 1] },
      },
      payload: { org_id: ORG, layer_id: ALLOWED, doc_id: 'tombstoned', deleted: true },
    })

    await client.upsert(name, { wait: true, points: points as never })
  }, 120_000)

  afterAll(async () => {
    await client?.deleteCollection(collectionName(SLUG)).catch(() => {})
    await store?.close()
  })

  it('T9 · 20 layers, access to 1, top_k=10 returns exactly 10 from that layer', async () => {
    const hits = await store.search({
      orgId: ORG,
      orgSlug: SLUG,
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
        orgSlug: SLUG,
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
      orgSlug: SLUG,
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
      orgSlug: SLUG,
      plan: planFor([ALLOWED]),
      branches: branches(0.99),
      topK: 30,
    })

    expect(hits.map((h) => h.payload.doc_id)).not.toContain('tombstoned')
  })

  it('the tenant check passes on results that came through the filter', async () => {
    const hits = await store.search({
      orgId: ORG,
      orgSlug: SLUG,
      plan: planFor([ALLOWED]),
      branches: branches(0.2),
      topK: 5,
    })
    expect(() => VectorStore.assertTenant(ORG, hits)).not.toThrow()
  })

  it('an empty layer set reaches nothing rather than everything', async () => {
    // min_should: 1 with two empty `any` lists must match no point. Without it
    // a Qdrant `should` is a scoring hint and the whole collection qualifies —
    // the difference between "no access" and "all access" is this one field.
    const hits = await store.search({
      orgId: ORG,
      orgSlug: SLUG,
      plan: planFor([]),
      branches: branches(0.4),
      topK: 10,
    })

    expect(hits).toHaveLength(0)
  })
})
