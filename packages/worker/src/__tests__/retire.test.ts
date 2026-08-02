import { describe, expect, it } from 'vitest'

import {
  retireOnce,
  retireVectorsOnce,
  type RetiredCollection,
  type RetiredVector,
  type RetirePorts,
  type VectorRetirePorts,
} from '../retire.js'

/**
 * Reclaiming superseded collections.
 *
 * The only irreversible operation in this repository outside a migration: a
 * deleted Qdrant collection is a deleted copy of an organization's vectors.
 * Everything here is about what stops that happening to the wrong one.
 */

function ports(
  due: RetiredCollection[],
  options: {
    live?: string[]
    dropFails?: string[]
    forgetFails?: string[]
  } = {},
) {
  const dropped: string[] = []
  const forgotten: string[] = []
  const revived: string[] = []
  const errored: string[] = []
  const order: string[] = []

  const impl: RetirePorts = {
    due: async () => due,
    isLive: async (name) => {
      order.push(`isLive:${name}`)
      return (options.live ?? []).includes(name)
    },
    drop: async (name) => {
      order.push(`drop:${name}`)
      if ((options.dropFails ?? []).includes(name)) throw new Error('qdrant said no')
      dropped.push(name)
    },
    forget: async (c) => {
      order.push(`forget:${c.name}`)
      if ((options.forgetFails ?? []).includes(c.name)) throw new Error('postgres said no')
      forgotten.push(c.name)
    },
    onDropped: (c) => void c,
    onRevived: (c) => revived.push(c.name),
    onError: (c) => errored.push(c.name),
  }

  return { impl, dropped, forgotten, revived, errored, order }
}

const one = (name: string): RetiredCollection => ({ orgId: 'o1', name })

describe('retireOnce', () => {
  it('drops a collection nothing points at, then forgets the row', async () => {
    const p = ports([one('org_acme')])
    const result = await retireOnce(p.impl, 7, 8)

    expect(result).toEqual({ dropped: 1, revived: 0, failed: 0 })
    expect(p.dropped).toEqual(['org_acme'])
    expect(p.forgotten).toEqual(['org_acme'])
  })

  it('asks the pointer before every delete, and never the other way round', async () => {
    // The order is the safety property. Checking liveness after the delete
    // would be a report rather than a guard.
    const p = ports([one('org_acme')])
    await retireOnce(p.impl, 7, 8)

    expect(p.order).toEqual(['isLive:org_acme', 'drop:org_acme', 'forget:org_acme'])
  })

  it('does not delete a collection an operator has rolled back onto', async () => {
    // D2 in the rollback runbook: the pointer goes back to the superseded
    // collection, and the row here is still sitting at its original timestamp.
    // This is the case that would otherwise destroy live data.
    const p = ports([one('org_acme')], { live: ['org_acme'] })
    const result = await retireOnce(p.impl, 7, 8)

    expect(p.dropped).toEqual([])
    expect(result).toEqual({ dropped: 0, revived: 1, failed: 0 })
    // The row goes, because it is no longer retired. Leaving it would mean
    // reconsidering a live collection for deletion on every pass, forever.
    expect(p.forgotten).toEqual(['org_acme'])
    expect(p.revived).toEqual(['org_acme'])
  })

  it('keeps the row when the drop fails, so the next pass tries again', async () => {
    const p = ports([one('org_acme')], { dropFails: ['org_acme'] })
    const result = await retireOnce(p.impl, 7, 8)

    expect(result).toEqual({ dropped: 0, revived: 0, failed: 1 })
    expect(p.forgotten).toEqual([])
    expect(p.errored).toEqual(['org_acme'])
  })

  it('carries on to the next collection when one fails', async () => {
    // One organization's vector store being unreachable must not stop the
    // others: the sweep is cross-tenant and runs hourly.
    const p = ports([one('org_a'), one('org_b'), one('org_c')], { dropFails: ['org_b'] })
    const result = await retireOnce(p.impl, 7, 8)

    expect(p.dropped).toEqual(['org_a', 'org_c'])
    expect(result).toEqual({ dropped: 2, revived: 0, failed: 1 })
  })

  it('counts a forget that failed after a successful drop as a failure', async () => {
    // The collection really is gone, so the pass did the irreversible half. The
    // row surviving is the recoverable direction: the next pass drops a
    // collection that is already absent, which `drop` tolerates.
    const p = ports([one('org_acme')], { forgetFails: ['org_acme'] })
    const result = await retireOnce(p.impl, 7, 8)

    expect(p.dropped).toEqual(['org_acme'])
    expect(result).toEqual({ dropped: 0, revived: 0, failed: 1 })
  })

  it('does nothing when nothing is due', async () => {
    const p = ports([])
    expect(await retireOnce(p.impl, 7, 8)).toEqual({ dropped: 0, revived: 0, failed: 0 })
    expect(p.order).toEqual([])
  })

  it('refuses a retention of zero days rather than treating it as no window', async () => {
    // `loadConfig` has a floor of 1, and this is the second lock on the same
    // door: a zero window deletes the collection at the moment a migration is
    // most likely to be found wrong, and "0 means disabled" is exactly the
    // reading that would make it do the opposite of disabled.
    const p = ports([one('org_acme')])
    await expect(retireOnce(p.impl, 0, 8)).rejects.toThrow('retentionDays')
    expect(p.dropped).toEqual([])
  })

  it('refuses a batch of zero rather than silently sweeping nothing', async () => {
    const p = ports([one('org_acme')])
    await expect(retireOnce(p.impl, 7, 0)).rejects.toThrow('batch')
  })
})

/**
 * The other half: the slot inside the collection that survived the copy.
 *
 * A completed reindex leaves every point in the layer carrying the vector it
 * used to be searched by, which is a float per dimension per point and in
 * memory by default. Nothing removed it.
 */
function vectorPorts(due: RetiredVector[], options: { dropFails?: string[]; forgetFails?: string[] } = {}) {
  const order: string[] = []
  const dropped: string[] = []
  const forgotten: string[] = []
  const errored: string[] = []

  const impl: VectorRetirePorts = {
    due: async () => due,
    drop: async (collection, layerId, vectorName) => {
      order.push(`drop:${layerId}:${vectorName}`)
      if ((options.dropFails ?? []).includes(layerId)) throw new Error('qdrant said no')
      dropped.push(`${collection}:${layerId}:${vectorName}`)
    },
    forget: async (t) => {
      order.push(`forget:${t.layerId}`)
      if ((options.forgetFails ?? []).includes(t.layerId)) throw new Error('postgres said no')
      forgotten.push(t.layerId)
    },
    onDropped: () => {},
    onError: (t) => errored.push(t.layerId),
  }
  return { impl, order, dropped, forgotten, errored }
}

const slot = (layerId: string): RetiredVector => ({
  orgId: 'org-1',
  layerId,
  collection: 'org_acme',
  vectorName: 'v_old_4',
})

describe('retireVectorsOnce', () => {
  it('drops the slot, then forgets the key', async () => {
    const p = vectorPorts([slot('layer-1')])
    expect(await retireVectorsOnce(p.impl, 7, 8)).toEqual({ dropped: 1, failed: 0 })
    // The key is the only record that there is anything to reclaim. Forgetting
    // first and then failing to drop leaks the vectors with nothing naming
    // them; this order costs at worst a second delete of something gone.
    expect(p.order).toEqual(['drop:layer-1:v_old_4', 'forget:layer-1'])
  })

  it('keeps the key when the drop fails, so the next pass retries', async () => {
    const p = vectorPorts([slot('layer-1')], { dropFails: ['layer-1'] })
    expect(await retireVectorsOnce(p.impl, 7, 8)).toEqual({ dropped: 0, failed: 1 })
    expect(p.forgotten).toEqual([])
    expect(p.errored).toEqual(['layer-1'])
  })

  it('carries on to the next layer when one fails', async () => {
    const p = vectorPorts([slot('a'), slot('b'), slot('c')], { dropFails: ['b'] })
    expect(await retireVectorsOnce(p.impl, 7, 8)).toEqual({ dropped: 2, failed: 1 })
    expect(p.forgotten).toEqual(['a', 'c'])
  })

  it('counts a forget that failed after a successful drop as a failure', async () => {
    // The irreversible half already happened. The key surviving is the
    // recoverable direction: the next pass drops something already gone.
    const p = vectorPorts([slot('layer-1')], { forgetFails: ['layer-1'] })
    expect(await retireVectorsOnce(p.impl, 7, 8)).toEqual({ dropped: 0, failed: 1 })
    expect(p.dropped).toHaveLength(1)
  })

  it('does nothing when nothing is due', async () => {
    const p = vectorPorts([])
    expect(await retireVectorsOnce(p.impl, 7, 8)).toEqual({ dropped: 0, failed: 0 })
    expect(p.order).toEqual([])
  })

  it('refuses a retention of zero days', async () => {
    // Dropping the old slot the instant a migration completes removes the only
    // cheap rollback there is, at the moment it is most likely to be wanted.
    const p = vectorPorts([slot('layer-1')])
    await expect(retireVectorsOnce(p.impl, 0, 8)).rejects.toThrow('retentionDays')
    expect(p.dropped).toEqual([])
  })

  it('refuses a batch of zero', async () => {
    const p = vectorPorts([slot('layer-1')])
    await expect(retireVectorsOnce(p.impl, 7, 0)).rejects.toThrow('batch')
  })
})
