import { describe, expect, it, vi } from 'vitest'

import { MetadataIndexer, METADATA_INDEX_LIMIT } from '../search.js'

/**
 * The indexes behind a metadata filter.
 *
 * What this file pins is the logic in `MetadataIndexer`. What it deliberately
 * does not pin is Qdrant's behaviour, which was established by asking a running
 * one and is recorded where the class is defined:
 *
 * - a filter on an unindexed field returns exactly the right points, by scan;
 * - creating an index is idempotent and back-fills over existing points;
 * - a `keyword` index accepts every metadata value type, indexing strings and
 *   lists of them and quietly indexing nothing for numbers and booleans, which
 *   still match.
 *
 * Those are facts about the database. Re-asserting them here would test a stub.
 * The consequence for this file is what matters: because a missing index costs
 * latency and never an answer, **nothing in this class may throw**, and that is
 * the property most of these cases are about.
 */

type Call = { field_name: string; field_schema: unknown }

function stub(options: { existing?: string[]; failCreate?: boolean; failGet?: boolean } = {}) {
  const created: Call[] = []
  const schema: Record<string, unknown> = {}
  for (const field of options.existing ?? []) schema[field] = { data_type: 'keyword' }

  let gets = 0
  const client = {
    getCollection: async () => {
      gets++
      if (options.failGet === true) throw new Error('qdrant is down')
      return { payload_schema: schema }
    },
    createPayloadIndex: async (_collection: string, call: Call) => {
      if (options.failCreate === true) throw new Error('rejected')
      created.push(call)
      return { status: 'completed' }
    },
  }

  return { client, created, gets: () => gets }
}

const indexerFor = (s: ReturnType<typeof stub>, limit?: number) =>
  new MetadataIndexer(s.client as never, limit)

describe('MetadataIndexer', () => {
  it('builds one keyword index per key, under the reserved prefix', async () => {
    const s = stub()
    await indexerFor(s).ensure('org_x', ['source', 'team'])

    expect(s.created.map((c) => c.field_name)).toEqual(['meta.source', 'meta.team'])
    // Never the bare key. `meta.deleted` is a different field from `deleted`,
    // and that separation is the whole security property of the namespace —
    // an index on the bare name would be an index on a permission field.
    expect(s.created.every((c) => c.field_schema === 'keyword')).toBe(true)
  })

  it('leaves an index that already exists alone', async () => {
    const s = stub({ existing: ['meta.source'] })
    await indexerFor(s).ensure('org_x', ['source', 'team'])

    expect(s.created.map((c) => c.field_name)).toEqual(['meta.team'])
  })

  it('ignores fields outside the namespace when counting what is indexed', async () => {
    // acl_tags, org_id and the rest are indexed too, and they are not metadata.
    // Counting them would spend the budget on fields that never came from a
    // caller, and would make a collection look full when it is not.
    const s = stub({ existing: ['acl_tags', 'org_id', 'deleted', 'meta.source'] })
    await indexerFor(s, 2).ensure('org_x', ['team'])

    expect(s.created.map((c) => c.field_name)).toEqual(['meta.team'])
  })

  it('stops at the limit, and warns once for the collection rather than per key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = stub()
      const indexer = indexerFor(s, 2)
      await indexer.ensure('org_x', ['a', 'b', 'c', 'd'])
      await indexer.ensure('org_x', ['e', 'f'])

      expect(s.created.map((c) => c.field_name)).toEqual(['meta.a', 'meta.b'])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('metadata index limit reached')
    } finally {
      warn.mockRestore()
    }
  })

  it('reads the collection once and remembers what it built', async () => {
    const s = stub()
    const indexer = indexerFor(s)

    await indexer.ensure('org_x', ['source'])
    await indexer.ensure('org_x', ['source'])
    await indexer.ensure('org_x', ['team'])

    expect(s.gets()).toBe(1)
    expect(s.created.map((c) => c.field_name)).toEqual(['meta.source', 'meta.team'])
  })

  it('keeps collections apart', async () => {
    const s = stub()
    const indexer = indexerFor(s)

    await indexer.ensure('org_a', ['source'])
    await indexer.ensure('org_b', ['source'])

    expect(s.created.map((c) => c.field_name)).toEqual(['meta.source', 'meta.source'])
    expect(s.gets()).toBe(2)
  })

  it('does nothing, and reads nothing, for a document with no metadata', async () => {
    const s = stub()
    await indexerFor(s).ensure('org_x', [])

    expect(s.created).toEqual([])
    expect(s.gets()).toBe(0)
  })

  it('does not throw when the index cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = stub({ failCreate: true })
      await expect(indexerFor(s).ensure('org_x', ['source'])).resolves.toBeUndefined()
      expect(String(warn.mock.calls[0]?.[0])).toContain('metadata index build failed')
    } finally {
      warn.mockRestore()
    }
  })

  it('does not throw when the collection cannot even be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const s = stub({ failGet: true })
      await expect(indexerFor(s).ensure('org_x', ['source'])).resolves.toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('defaults to a limit that is a number, not undefined', async () => {
    // A default of `undefined` would compare `size >= undefined` as false
    // forever, which is an unbounded index count that no test would notice.
    expect(Number.isInteger(METADATA_INDEX_LIMIT)).toBe(true)
    expect(METADATA_INDEX_LIMIT).toBeGreaterThan(0)

    const s = stub()
    const indexer = new MetadataIndexer(s.client as never)
    await indexer.ensure('org_x', Array.from({ length: METADATA_INDEX_LIMIT + 5 }, (_, i) => `k${i}`))
    expect(s.created).toHaveLength(METADATA_INDEX_LIMIT)
  })
})
