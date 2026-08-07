import { describe, expect, it } from 'vitest'

import { collectionConfig } from '../vector/query.js'
import { vectorStoreOptions } from '../vector/search.js'

/**
 * The shape a collection is created with, and the wiring that carries it there.
 *
 * `lint:collection-config` asserts that every `createCollection` goes through
 * `collectionConfig`. That is the "N places" half. This is the other half:
 * what the one place emits, and whether a deployment's numbers survive the trip
 * from `loadConfig` to the constructor.
 *
 * The seam matters because the failure is silent. Qdrant accepts a collection
 * with one shard on a three-node cluster and answers every query correctly —
 * it just never uses the other two nodes, and the repair is copying every point
 * into a new collection.
 */
describe('collectionConfig', () => {
  it('omits both fields when a deployment asks for neither', () => {
    const config = collectionConfig({ name: 'v_m_8', size: 8 })
    // Absent rather than `1`. A collection created by this build has to be
    // what one created by the last build was unless somebody asked otherwise —
    // an explicit `shard_number: 1` is a different document to compare against
    // and a different thing to explain in a diff.
    expect(config).not.toHaveProperty('shard_number')
    expect(config).not.toHaveProperty('replication_factor')
  })

  it('carries both when a cluster asks for them', () => {
    const config = collectionConfig({ name: 'v_m_8', size: 8 }, { shards: 3, replicationFactor: 2 })
    expect(config).toMatchObject({ shard_number: 3, replication_factor: 2 })
  })

  it('carries one without the other', () => {
    // Replication above 1 on a single shard is a real configuration — three
    // copies of one shard is how a small cluster survives a node — so neither
    // number implies the other.
    expect(collectionConfig({ name: 'v_m_8', size: 8 }, { replicationFactor: 3 })).toMatchObject({
      replication_factor: 3,
    })
    expect(collectionConfig({ name: 'v_m_8', size: 8 }, { replicationFactor: 3 })).not.toHaveProperty(
      'shard_number',
    )
  })

  it('gives a copy the same shape as a first collection', () => {
    // The reindex copy is the site that spelled this object out inline, and it
    // is the one that passes a map rather than a single name and size. Both
    // forms reaching the same layout is the property that was untrue.
    const first = collectionConfig({ name: 'v_m_8', size: 8 }, { shards: 3, replicationFactor: 2 })
    const copy = collectionConfig(
      { v_m_8: { size: 8, distance: 'Cosine' }, v_n_4: { size: 4, distance: 'Cosine' } },
      { shards: 3, replicationFactor: 2 },
    )
    const layout = (config: Record<string, unknown>) => {
      const rest = { ...config }
      delete rest['vectors']
      return rest
    }
    expect(layout(copy)).toStrictEqual(layout(first))
    expect(Object.keys(copy.vectors)).toStrictEqual(['v_m_8', 'v_n_4'])
    expect(Object.keys(first.vectors)).toStrictEqual(['v_m_8'])
  })
})

describe('vectorStoreOptions', () => {
  const base = {
    qdrantUrl: 'http://qdrant:6333',
    qdrantApiKey: undefined,
    qdrantShards: 1,
    qdrantReplicationFactor: 1,
  }

  it('carries the shape from configuration to the store', () => {
    // Five call sites assembled these options by hand and none of them knew
    // about a shape, which is exactly how a new field reaches one process and
    // not the other four. They ask this function now.
    expect(vectorStoreOptions({ ...base, qdrantShards: 3, qdrantReplicationFactor: 2 })).toStrictEqual({
      url: 'http://qdrant:6333',
      shape: { shards: 3, replicationFactor: 2 },
    })
  })

  it('omits the key rather than passing an undefined one', () => {
    // `exactOptionalPropertyTypes` is on, and an absent API key is not the
    // same value as a present undefined one to the Qdrant client.
    expect(vectorStoreOptions(base)).not.toHaveProperty('apiKey')
    expect(vectorStoreOptions({ ...base, qdrantApiKey: 'k' })).toMatchObject({ apiKey: 'k' })
  })
})
