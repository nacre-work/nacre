import { QdrantClient } from '@qdrant/js-client-rest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { QueryablePlan } from '../filter.js'
import { collectionName, PAYLOAD_INDEXES, type Branch } from '../../vector/query.js'
import { VectorStore } from '../../vector/search.js'

/**
 * T12 — a layer is reindexed while search is running.
 *
 * A model change puts a layer into dual write: new points are written under a
 * second named vector while a background job backfills the existing ones, and
 * `layers.vector_name` switches over at the end. Search stays available
 * throughout, which means for a while there are two indexes over the same
 * documents.
 *
 * The property under test is that the permission filter does not care. It is
 * built from the AccessPlan and applied to whichever named vector is being
 * queried, so both indexes are bounded identically. The failure this guards
 * against is a shadow index built without the filter — indexing is where the
 * payload is written, and a backfill that forgot `acl_tags` or `deleted` would
 * produce an index that answers correctly by luck until the switch.
 */

const url = process.env.NACRE_QDRANT_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_QDRANT_URL is not set and CI is; T12 would silently skip.')
}
const when = url ? describe : describe.skip

const ORG = '77777777-7777-7777-7777-777777777777'
const SLUG = 'reindex'
const OLD_VECTOR = 'v_old_4'
const NEW_VECTOR = 'v_new_8'

const uuid = (prefix: string, n: number): string =>
  `${prefix.padEnd(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`

const OPEN = uuid('09e2', 0)
const SHUT = uuid('5407', 0)

let client: QdrantClient
let store: VectorStore

const plan = (layers: readonly string[]): QueryablePlan => ({
  kind: 'scoped',
  layers: [...layers],
  extraDocs: [],
  deniedDocs: [],
})

const branch = (using: string, size: number): Branch => ({
  kind: 'dense',
  using,
  vector: Array.from({ length: size }, (_, i) => (i % 3) / 3),
})

when('adversarial · reindexing under active search', () => {
  beforeAll(async () => {
    client = new QdrantClient({ url: url as string })
    store = new VectorStore({ url: url as string })
    const name = collectionName(SLUG)

    await client.deleteCollection(name).catch(() => {})

    // Two named vectors of different dimensions in one collection: that is what
    // makes a per-layer model migration possible without a whole-index rebuild.
    await client.createCollection(name, {
      vectors: {
        [OLD_VECTOR]: { size: 4, distance: 'Cosine' },
        [NEW_VECTOR]: { size: 8, distance: 'Cosine' },
      },
      on_disk_payload: true,
    } as never)

    for (const index of PAYLOAD_INDEXES) {
      await client.createPayloadIndex(name, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }

    const points: unknown[] = []
    let id = 1
    for (const layer of [OPEN, SHUT]) {
      for (let d = 0; d < 6; d++) {
        points.push({
          id: id++,
          // Dual write: the same point carries both vectors while the backfill
          // runs. Only one of them is being queried at any moment.
          vector: {
            [OLD_VECTOR]: [Math.random(), Math.random(), Math.random(), 1],
            [NEW_VECTOR]: Array.from({ length: 8 }, () => Math.random()),
          },
          payload: {
            org_id: ORG,
            layer_id: layer,
            doc_id: uuid('d0c', id),
            deleted: false,
          },
        })
      }
    }

    // One tombstoned point in the readable layer, present in both indexes.
    points.push({
      id,
      vector: {
        [OLD_VECTOR]: [1, 1, 1, 1],
        [NEW_VECTOR]: Array.from({ length: 8 }, () => 1),
      },
      payload: { org_id: ORG, layer_id: OPEN, doc_id: uuid('70m8', 1), deleted: true },
    })

    await client.upsert(name, { wait: true, points: points as never })
  }, 120_000)

  afterAll(async () => {
    await client?.deleteCollection(collectionName(SLUG)).catch(() => {})
    await store?.close()
  })

  it('T12 · the deny holds on the old index and on the new one', async () => {
    for (const [name, using, size] of [
      ['old', OLD_VECTOR, 4],
      ['new', NEW_VECTOR, 8],
    ] as const) {
      const hits = await store.search({
        orgId: ORG,
        orgSlug: SLUG,
        plan: plan([OPEN]),
        branches: [branch(using, size)],
        topK: 20,
      })

      expect(hits.length, `${name} index returned nothing`).toBeGreaterThan(0)
      for (const hit of hits) {
        expect(hit.payload.layer_id, `${name} index leaked a denied layer`).toBe(OPEN)
      }
    }
  })

  it('T12 · both indexes agree on which documents are visible', async () => {
    // Not just "neither leaks" — the same set. A shadow index that silently
    // dropped documents would pass the test above and lose data at the switch.
    const visible = async (using: string, size: number) => {
      const hits = await store.search({
        orgId: ORG,
        orgSlug: SLUG,
        plan: plan([OPEN]),
        branches: [branch(using, size)],
        topK: 50,
      })
      return [...new Set(hits.map((h) => String(h.payload.doc_id)))].sort()
    }

    expect(await visible(NEW_VECTOR, 8)).toEqual(await visible(OLD_VECTOR, 4))
  })

  it('T12 · a tombstone is honoured on both indexes', async () => {
    // The backfill writes the payload too, and `deleted` is part of it. An
    // index built without it answers correctly by luck until the switch.
    for (const [using, size] of [
      [OLD_VECTOR, 4],
      [NEW_VECTOR, 8],
    ] as const) {
      const hits = await store.search({
        orgId: ORG,
        orgSlug: SLUG,
        plan: plan([OPEN]),
        branches: [branch(using, size)],
        topK: 50,
      })
      expect(hits.map((h) => h.payload.doc_id)).not.toContain(uuid('70m8', 1))
    }
  })

  it('T12 · switching the vector name changes nothing about who sees what', async () => {
    // The switch is atomic on `layers.vector_name`, and a query in flight uses
    // whichever it read. Both answers must be permitted answers — that is the
    // whole safety argument for doing the switch without a maintenance window.
    const denied = await Promise.all(
      [
        [OLD_VECTOR, 4],
        [NEW_VECTOR, 8],
      ].map(async ([using, size]) => {
        const hits = await store.search({
          orgId: ORG,
          orgSlug: SLUG,
          plan: plan([SHUT]),
          branches: [branch(using as string, size as number)],
          topK: 50,
        })
        return hits.every((h) => h.payload.layer_id === SHUT)
      }),
    )

    expect(denied).toEqual([true, true])
  })
})
