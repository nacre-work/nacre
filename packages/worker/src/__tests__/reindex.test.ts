import { describe, expect, it } from 'vitest'

import { reindexOnce, type ReindexPorts, type ReindexTarget } from '../reindex.js'
import { reindexProgress, fromStateJson, toStateJson, type ReindexState } from '@nacre.work/core'

/**
 * Moving a layer onto a different embedding model.
 *
 * The dangerous moments are all about ordering: a document marked reindexed
 * before its vector is written, and a switch that happens while something is
 * outstanding. Both produce a layer that reports itself migrated and cannot
 * answer for part of its own contents, and neither is visible afterwards
 * without comparing two indexes.
 */

const target = (over: Partial<ReindexTarget> = {}): ReindexTarget => ({
  orgId: 'org-1',
  collection: 'org_acme',
  layerId: 'layer-1',
  documentId: 'doc-1',
  shadowVector: 'v_new_1024',
  providerId: 'prov-1',
  chunks: [
    { pointId: 'p1', text: 'first' },
    { pointId: 'p2', text: 'second' },
  ],
  ...over,
})

interface Recorded {
  readonly added: { vectorName: string; points: number }[]
  readonly marked: string[]
  readonly finished: string[]
  readonly errors: string[]
  readonly passes: { succeeded: number; failed: number; error?: string }[]
}

const ports = (
  targets: readonly ReindexTarget[],
  over: Partial<ReindexPorts> = {},
): ReindexPorts & { recorded: Recorded } => {
  const recorded: Recorded = { added: [], marked: [], finished: [], errors: [], passes: [] }
  return {
    recorded,
    claim: async () => targets,
    embed: async (_p, texts) => texts.map(() => [0.1, 0.2]),
    addVector: async (_slug, vectorName, points) => {
      recorded.added.push({ vectorName, points: points.length })
    },
    markReindexed: async (_org, documentId) => {
      recorded.marked.push(documentId)
    },
    recordPass: async (input) => {
      recorded.passes.push({
        succeeded: input.succeeded,
        failed: input.failed,
        ...(input.error === undefined ? {} : { error: input.error }),
      })
    },
    finishIfDone: async (_org, layerId) => {
      recorded.finished.push(layerId)
      return true
    },
    onError: (t) => recorded.errors.push(t.documentId),
    ...over,
  }
}

describe('reindexOnce', () => {
  it('writes the shadow vector onto the existing points and then marks', async () => {
    const p = ports([target()])
    const result = await reindexOnce(p, 10)

    expect(result).toMatchObject({ reindexed: 1, failed: 0 })
    expect(p.recorded.added).toEqual([{ vectorName: 'v_new_1024', points: 2 }])
    expect(p.recorded.marked).toEqual(['doc-1'])
  })

  it('does not mark a document whose vector write failed', async () => {
    // The ordering that matters. Marked first and failed second leaves a
    // document counted as reindexed with no vector — and since the switch
    // depends on that count, it is how vector_name moves to a model that cannot
    // answer for part of the layer.
    const p = ports([target()], {
      addVector: async () => {
        throw new Error('qdrant said no')
      },
    })

    const result = await reindexOnce(p, 10)

    expect(result).toMatchObject({ reindexed: 0, failed: 1 })
    expect(p.recorded.marked).toEqual([])
    expect(p.recorded.errors).toEqual(['doc-1'])
  })

  it('refuses a vector count that does not match the chunks', async () => {
    // A mismatch means the embedder dropped or reordered something, and writing
    // it attaches the wrong vector to the wrong text. Silent retrieval damage.
    const p = ports([target()], { embed: async () => [[0.1, 0.2]] })

    expect(await reindexOnce(p, 10)).toMatchObject({ reindexed: 0, failed: 1 })
    expect(p.recorded.added).toEqual([])
    expect(p.recorded.marked).toEqual([])
  })

  it('reports the pass where the operator polls, not only in the log', async () => {
    // The finding this exists for: the worker logged "reindexed 0 failed 2"
    // every five seconds while GET on the reindex path answered `failed: 0,
    // status: running`. The endpoint an operator is told to poll was the one
    // place the failure did not appear.
    const p = ports([target()], {
      addVector: async () => {
        throw new Error('qdrant said no')
      },
    })

    await reindexOnce(p, 10)

    expect(p.recorded.passes).toEqual([
      { succeeded: 0, failed: 1, error: 'Error: qdrant said no' },
    ])
  })

  it('records the pass before asking to finish', async () => {
    // A pass that crosses the failure bound stops the layer running, and
    // finishIfDone requires it to be running. The other order would let one
    // pass mark a reindex both failed and complete.
    const order: string[] = []
    const p = ports([target()], {
      recordPass: async () => {
        order.push('record')
      },
      finishIfDone: async () => {
        order.push('finish')
        return true
      },
    })

    await reindexOnce(p, 10)
    expect(order).toEqual(['record', 'finish'])
  })

  it('one failure does not stop the rest of the batch', async () => {
    let call = 0
    const p = ports([target({ documentId: 'a' }), target({ documentId: 'b' })], {
      addVector: async () => {
        call++
        if (call === 1) throw new Error('transient')
      },
    })

    expect(await reindexOnce(p, 10)).toMatchObject({ reindexed: 1, failed: 1 })
    expect(p.recorded.marked).toEqual(['b'])
  })

  it('asks to finish once per layer, not once per document', async () => {
    // Every document in a batch belongs to the same layer in the ordinary case.
    // Asking per document would be a query per document for the whole migration.
    const p = ports([
      target({ documentId: 'a' }),
      target({ documentId: 'b' }),
      target({ documentId: 'c' }),
    ])

    const result = await reindexOnce(p, 10)

    expect(p.recorded.finished).toEqual(['layer-1'])
    expect(result.switched).toBe(1)
  })

  it('finishes each layer separately when a batch spans two', async () => {
    const p = ports([target({ layerId: 'l1' }), target({ layerId: 'l2', documentId: 'd2' })])
    await reindexOnce(p, 10)
    expect(p.recorded.finished.sort()).toEqual(['l1', 'l2'])
  })

  it('still asks to finish when every document in the batch failed', async () => {
    // The layer may have been finished by an earlier pass and this batch may be
    // documents that keep failing. `finishIfDone` is guarded by its own
    // predicate, so asking costs one query and never switches wrongly — while
    // not asking would leave a layer whose last batch failed permanently
    // unfinished even after the failures were fixed by a later pass.
    const p = ports([target()], {
      addVector: async () => {
        throw new Error('nope')
      },
    })
    await reindexOnce(p, 10)
    expect(p.recorded.finished).toEqual(['layer-1'])
  })

  it('does nothing, and asks nothing, when there is nothing to do', async () => {
    const p = ports([])
    expect(await reindexOnce(p, 10)).toEqual({ reindexed: 0, failed: 0, switched: 0 })
    expect(p.recorded.finished).toEqual([])
  })

  it('refuses a batch of zero', async () => {
    await expect(reindexOnce(ports([]), 0)).rejects.toThrow('batch must be at least 1')
  })
})

describe('reindex progress', () => {
  const state = (over: Partial<ReindexState> = {}): ReindexState => ({
    status: 'running',
    phase: 'embedding',
    shadowVector: 'v_new_1024',
    providerId: 'prov-1',
    startedAt: '2026-08-01T00:00:00.000Z',
    total: 10,
    done: 4,
    failed: 0,
    ...over,
  })

  it('is a ratio of done to total', () => {
    expect(reindexProgress(state())).toBeCloseTo(0.4)
  })

  it('clamps rather than passing 1', () => {
    // `total` is counted once at the start and documents ingested afterwards
    // are picked up by the same pass, so `done` legitimately overshoots. A
    // gauge reading 1.4 makes an operator think the number is broken.
    expect(reindexProgress(state({ done: 14 }))).toBe(1)
  })

  it('is 1 for a complete reindex whatever the counts say', () => {
    expect(reindexProgress(state({ status: 'complete', done: 0 }))).toBe(1)
  })

  it('is 1 for an empty layer, not 0', () => {
    // A layer with nothing in it is finished. A gauge sitting at zero forever
    // for such a layer is the stuck-alert shape.
    expect(reindexProgress(state({ total: 0, done: 0 }))).toBe(1)
  })

  it('survives a round trip through the column shape', () => {
    const before = state({ finishedAt: '2026-08-02T00:00:00.000Z', error: 'x' })
    expect(fromStateJson(toStateJson(before))).toEqual(before)
  })

  it('reads nothing usable as undefined rather than as a default', () => {
    // A layer with no reindex and one whose state cannot be parsed both mean
    // "nothing to report", and the caller has no different action for either.
    expect(fromStateJson(null)).toBeUndefined()
    expect(fromStateJson({ status: 'sideways', shadow_vector: 'v' })).toBeUndefined()
    expect(fromStateJson({ status: 'running' })).toBeUndefined()
  })
})
