import { describe, expect, it } from 'vitest'

import { applyRanking, HttpReranker, rerankerFor, type Reranker } from '../rerank.js'

/**
 * Cross-encoder reranking.
 *
 * Two things are worth testing here and they are not the obvious one. The
 * ordering rule, because attaching a score to the wrong chunk is invisible in
 * any test that does not check ranking against text whose relevance is known.
 * And the transport's refusals, because a reranker that quietly answers for
 * half its inputs degrades quality without failing anything.
 */

describe('applyRanking', () => {
  const items = ['a', 'b', 'c', 'd']

  it('orders by score and keeps topK', () => {
    expect(applyRanking(items, [0.1, 0.9, 0.5, 0.2], 2)).toEqual(['b', 'c'])
  })

  it('keeps the fusion order for ties', () => {
    // A cross-encoder giving two chunks the same score is saying it cannot
    // separate them. Falling back to what the index ranked is a better answer
    // than an arbitrary one, and it makes the endpoint deterministic.
    expect(applyRanking(items, [1, 1, 1, 1], 3)).toEqual(['a', 'b', 'c'])
  })

  it('returns everything when there are fewer candidates than topK', () => {
    expect(applyRanking(items, [4, 3, 2, 1], 10)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('refuses a score list that does not match the candidates', () => {
    // Off-by-one here silently pairs each chunk with its neighbour's score.
    expect(() => applyRanking(items, [1, 2, 3], 2)).toThrow(/3 scores for 4 items/)
  })
})

/** A reranker that scores by position in a preferred list. */
const preferring = (order: readonly string[]): Reranker => ({
  rank: async (_query, texts) => texts.map((t) => -order.indexOf(t)),
})

describe('the ranking a reranker produces', () => {
  it('changes which permitted results come back, never how many', async () => {
    // The distinction the whole feature rests on. A post-filter returns fewer
    // than k because some results were not permitted; this returns exactly
    // min(k, candidates) every time, because every candidate was permitted
    // before the reranker saw it.
    const candidates = ['one', 'two', 'three', 'four', 'five']
    const reranker = preferring(['five', 'three', 'one', 'four', 'two'])

    for (const k of [1, 3, 5, 9]) {
      const scores = await reranker.rank('q', candidates)
      const ranked = applyRanking(candidates, scores, k)
      expect(ranked).toHaveLength(Math.min(k, candidates.length))
    }

    const scores = await reranker.rank('q', candidates)
    expect(applyRanking(candidates, scores, 3)).toEqual(['five', 'three', 'one'])
  })
})

describe('rerankerFor', () => {
  it('is none unless a deployment configured one', () => {
    expect(rerankerFor({ rerankerEnabled: false, rerankerEndpoint: 'http://r' })).toBeUndefined()
    // loadConfig refuses enabled-with-no-endpoint at startup, so this is the
    // belt to that braces: nothing here invents an endpoint.
    expect(rerankerFor({ rerankerEnabled: true, rerankerEndpoint: undefined })).toBeUndefined()
    expect(rerankerFor({ rerankerEnabled: true, rerankerEndpoint: 'http://r' })).toBeDefined()
  })
})

describe('the TEI transport', () => {
  const withFetch = async (
    handler: (input: unknown, init: unknown) => Promise<Response> | Response,
    run: (r: HttpReranker) => Promise<void>,
  ) => {
    const original = globalThis.fetch
    globalThis.fetch = handler as typeof fetch
    try {
      await run(new HttpReranker('http://reranker'))
    } finally {
      globalThis.fetch = original
    }
  }

  it('maps scores back by index, not by the order they arrive in', async () => {
    await withFetch(
      // TEI answers sorted by score. The index is the only thing tying a score
      // back to its input; trusting the order attaches the wrong score to the
      // wrong chunk, and every result still looks plausible.
      () =>
        new Response(
          JSON.stringify([
            { index: 2, score: 0.9 },
            { index: 0, score: 0.5 },
            { index: 1, score: 0.1 },
          ]),
          { headers: { 'content-type': 'application/json' } },
        ),
      async (r) => {
        expect(await r.rank('q', ['a', 'b', 'c'])).toEqual([0.5, 0.1, 0.9])
      },
    )
  })

  it('refuses a short answer rather than sinking the unscored', async () => {
    await withFetch(
      () => new Response(JSON.stringify([{ index: 0, score: 1 }]), { headers: { 'content-type': 'application/json' } }),
      async (r) => {
        // Leaving them at -Infinity would drop them to the bottom, which is a
        // silent quality loss rather than a visible failure.
        await expect(r.rank('q', ['a', 'b', 'c'])).rejects.toThrow(/scored 1 of 3/)
      },
    )
  })

  it('refuses an index outside the inputs', async () => {
    await withFetch(
      () => new Response(JSON.stringify([{ index: 7, score: 1 }]), { headers: { 'content-type': 'application/json' } }),
      async (r) => {
        await expect(r.rank('q', ['a'])).rejects.toThrow(/scored index 7/)
      },
    )
  })

  it('refuses a non-200 and a shape that is not a list', async () => {
    await withFetch(
      () => new Response('nope', { status: 503 }),
      async (r) => {
        await expect(r.rank('q', ['a'])).rejects.toThrow(/answered 503/)
      },
    )
    await withFetch(
      () => new Response(JSON.stringify({ scores: [1] }), { headers: { 'content-type': 'application/json' } }),
      async (r) => {
        await expect(r.rank('q', ['a'])).rejects.toThrow(/did not answer with a list/)
      },
    )
  })

  it('sends nothing at all for an empty candidate set', async () => {
    let called = 0
    await withFetch(
      () => {
        called++
        return new Response('[]')
      },
      async (r) => {
        expect(await r.rank('q', [])).toEqual([])
      },
    )
    expect(called).toBe(0)
  })
})
