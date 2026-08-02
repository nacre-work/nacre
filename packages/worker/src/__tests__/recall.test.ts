import { describe, expect, it } from 'vitest'

import {
  RECALL_K,
  recallOnce,
  score,
  type RecallPorts,
  type RecallTarget,
  type RecallVerdict,
  type ReferenceQuery,
} from '../recall.js'

/**
 * The gate between a finished reindex and the switch that makes it live.
 *
 * Most of what there is to test is the arithmetic and the three outcomes it has
 * to keep apart — a model that lost recall, a reference set that has gone
 * stale, and an embedder that was not reachable. The first two end the reindex
 * and the third must not.
 */

const q = (id: string, expected: string[], missing: string[] = []): ReferenceQuery => ({
  id,
  query: `find ${id}`,
  expected,
  missing,
})

describe('score', () => {
  it('is one when every expected document comes back', () => {
    const v = score([q('a', ['d1', 'd2'])], [['d1', 'd2', 'd9']], 0.8)
    expect(v.recall).toBe(1)
    expect(v.passed).toBe(true)
  })

  it('is the fraction found, per query', () => {
    const v = score([q('a', ['d1', 'd2', 'd3', 'd4'])], [['d1', 'd3']], 0.4)
    expect(v.recall).toBe(0.5)
    expect(v.scores).toEqual([{ queryId: 'a', recall: 0.5 }])
  })

  it('averages over queries and not over hits', () => {
    // The whole reason this is a mean of per-query scores: a micro-average
    // would let the ten-document query outvote the two one-document ones, which
    // is the opposite of how an operator reads the list they wrote.
    const v = score(
      [q('big', Array.from({ length: 10 }, (_, i) => `d${i}`)), q('one', ['x']), q('two', ['y'])],
      [Array.from({ length: 10 }, (_, i) => `d${i}`), [], []],
      0.5,
    )
    expect(v.recall).toBeCloseTo(1 / 3, 10)
  })

  it('counts a document once however many chunks named it', () => {
    // The retrieval port already reduces to distinct documents, and this is the
    // second lock on the same door: a duplicate would otherwise be able to push
    // a score above 1.
    const v = score([q('a', ['d1', 'd2'])], [['d1', 'd1', 'd1']], 0)
    expect(v.recall).toBe(0.5)
  })

  it('passes at exactly the floor', () => {
    // `>=`, because a floor of 0.8 typed by a person means 0.8 is acceptable.
    expect(score([q('a', ['d1', 'd2', 'd3', 'd4', 'd5'])], [['d1', 'd2', 'd3', 'd4']], 0.8).passed).toBe(
      true,
    )
  })

  it('fails just below it', () => {
    expect(score([q('a', ['d1', 'd2'])], [['d1']], 0.8).passed).toBe(false)
  })

  it('measures without blocking at a floor of zero', () => {
    // Arithmetic rather than a special case for "disabled": every recall is at
    // least 0, so the comparison passes and the number is still recorded.
    const v = score([q('a', ['d1'])], [[]], 0)
    expect(v.recall).toBe(0)
    expect(v.passed).toBe(true)
  })

  it('fails an unresolved set whatever the number says', () => {
    // The case this whole distinction exists for: a reference set naming a
    // document that is gone is a stale set, not a bad model, and scoring the
    // missing entry as a miss would report the first as the second.
    const v = score([q('a', ['d1'], ['gone.md'])], [['d1']], 0.8)
    expect(v.recall).toBe(1)
    expect(v.passed).toBe(false)
    expect(v.unresolved).toEqual(['gone.md'])
  })

  it('refuses to score a different number of results than queries', () => {
    expect(() => score([q('a', ['d1']), q('b', ['d2'])], [['d1']], 0.8)).toThrow(/scored 1/)
  })
})

function ports(
  targets: RecallTarget[],
  options: {
    retrieved?: Record<string, string[]>
    embedFails?: boolean
    shortEmbedding?: boolean
    finished?: boolean
  } = {},
) {
  const recorded: RecallVerdict[] = []
  const failed: string[] = []
  const finished: string[] = []
  const errored: string[] = []
  const order: string[] = []

  const impl: RecallPorts = {
    due: async () => targets,
    embed: async (_provider, texts) => {
      order.push('embed')
      if (options.embedFails === true) throw new Error('model server refused')
      const vectors = texts.map(() => [0.1, 0.2])
      return options.shortEmbedding === true ? vectors.slice(1) : vectors
    },
    retrieve: async (target, _vector, k) => {
      order.push(`retrieve:${k}`)
      return options.retrieved?.[target.layerId] ?? []
    },
    record: async (_t, verdict) => {
      order.push('record')
      recorded.push(verdict)
    },
    finishIfDone: async (_org, layerId) => {
      order.push('finish')
      finished.push(layerId)
      return options.finished !== false
    },
    fail: async (t, reason) => {
      order.push('fail')
      failed.push(`${t.layerId}:${reason}`)
    },
    onChecked: () => {},
    onError: (t) => errored.push(t.layerId),
  }

  return { impl, recorded, failed, finished, errored, order }
}

const target = (layerId: string, queries: ReferenceQuery[]): RecallTarget => ({
  orgId: 'o1',
  layerId,
  collection: 'org_acme',
  shadowVector: 'v_new_1024',
  providerId: 'p2',
  queries,
})

describe('recallOnce', () => {
  it('records the verdict and switches the layer when it passes', async () => {
    const p = ports([target('l1', [q('a', ['d1'])])], { retrieved: { l1: ['d1'] } })
    expect(await recallOnce(p.impl, 0.8, 4)).toEqual({
      passed: 1,
      failed: 0,
      errored: 0,
      switched: 1,
    })
    expect(p.finished).toEqual(['l1'])
  })

  it('writes the verdict before acting on it', async () => {
    // A failed migration whose numbers were never written is one an operator
    // can only re-run to understand.
    const p = ports([target('l1', [q('a', ['d1'])])], { retrieved: { l1: [] } })
    await recallOnce(p.impl, 0.8, 4)
    expect(p.order).toEqual(['embed', 'retrieve:10', 'record', 'fail'])
  })

  it('ends the reindex and does not switch when recall is short', async () => {
    const p = ports([target('l1', [q('a', ['d1', 'd2'])])], { retrieved: { l1: ['d1'] } })
    const result = await recallOnce(p.impl, 0.8, 4)

    expect(result).toEqual({ passed: 0, failed: 1, errored: 0, switched: 0 })
    expect(p.finished).toEqual([])
    expect(p.failed[0]).toMatch(/recall 0\.500 is below the floor/)
  })

  it('names the stale entries rather than reporting a low score', async () => {
    const p = ports([target('l1', [q('a', ['d1'], ['old-contract.md'])])], {
      retrieved: { l1: ['d1'] },
    })
    await recallOnce(p.impl, 0.8, 4)

    expect(p.failed[0]).toMatch(/do not exist: old-contract\.md/)
  })

  it('retrieves at RECALL_K and no deeper', async () => {
    // The cap is the same number the API refuses a longer `expected` against. A
    // query naming more documents than the check retrieves could never score
    // 1.0, and its floor would read as a regression in the model.
    const p = ports([target('l1', [q('a', ['d1'])])], { retrieved: { l1: ['d1'] } })
    await recallOnce(p.impl, 0.8, 4)
    expect(p.order).toContain(`retrieve:${RECALL_K}`)
  })

  it('does not end the reindex when the embedder is unreachable', async () => {
    // An embedder that is down says nothing about the new model's recall, and
    // ending the migration on it would turn a restart into a re-run of the
    // whole corpus. No verdict, so the next pass tries again.
    const p = ports([target('l1', [q('a', ['d1'])])], { embedFails: true })
    const result = await recallOnce(p.impl, 0.8, 4)

    expect(result).toEqual({ passed: 0, failed: 0, errored: 1, switched: 0 })
    expect(p.recorded).toEqual([])
    expect(p.failed).toEqual([])
    expect(p.finished).toEqual([])
  })

  it('refuses a short embedding rather than scoring against shifted queries', async () => {
    // Silently dropping one would shift every subsequent query onto the wrong
    // expectations and produce a plausible, meaningless number.
    const p = ports([target('l1', [q('a', ['d1']), q('b', ['d2'])])], { shortEmbedding: true })
    expect(await recallOnce(p.impl, 0.8, 4)).toMatchObject({ errored: 1 })
    expect(p.recorded).toEqual([])
  })

  it('carries on to the next layer when one errors', async () => {
    const p = ports([target('l1', [q('a', ['d1'])]), target('l2', [q('b', ['d2'])])], {
      retrieved: { l2: ['d2'] },
    })
    const result = await recallOnce(p.impl, 0.8, 4)
    expect(result).toEqual({ passed: 1, failed: 1, errored: 0, switched: 1 })
    expect(p.finished).toEqual(['l2'])
  })

  it('treats a layer with no reference queries as an error, never as a zero', async () => {
    // `due` excludes these. Scoring an empty set averages to zero, which would
    // fail every migration in the deployment — so reaching here has to be loud
    // rather than arithmetically quiet.
    const p = ports([target('l1', [])])
    expect(await recallOnce(p.impl, 0.8, 4)).toEqual({
      passed: 0,
      failed: 0,
      errored: 1,
      switched: 0,
    })
    expect(p.failed).toEqual([])
  })

  it('counts a passing check whose switch was refused as passed but not switched', async () => {
    // `finishIfDone` re-evaluates everything, so a document ingested between
    // the check and the switch legitimately blocks it. The gate passed; the
    // layer is not done.
    const p = ports([target('l1', [q('a', ['d1'])])], {
      retrieved: { l1: ['d1'] },
      finished: false,
    })
    expect(await recallOnce(p.impl, 0.8, 4)).toEqual({
      passed: 1,
      failed: 0,
      errored: 0,
      switched: 0,
    })
  })

  it('does nothing when nothing is due', async () => {
    const p = ports([])
    expect(await recallOnce(p.impl, 0.8, 4)).toEqual({
      passed: 0,
      failed: 0,
      errored: 0,
      switched: 0,
    })
    expect(p.order).toEqual([])
  })

  it('refuses a floor outside [0, 1]', async () => {
    // 80 rather than 0.8 is the mistake this catches, and it would otherwise
    // fail every migration silently: no recall is ever above 80.
    const p = ports([target('l1', [q('a', ['d1'])])])
    await expect(recallOnce(p.impl, 80, 4)).rejects.toThrow('floor')
    await expect(recallOnce(p.impl, -1, 4)).rejects.toThrow('floor')
  })

  it('refuses a batch of zero', async () => {
    const p = ports([target('l1', [q('a', ['d1'])])])
    await expect(recallOnce(p.impl, 0.8, 0)).rejects.toThrow('batch')
  })
})
