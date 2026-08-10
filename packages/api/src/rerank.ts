/**
 * Cross-encoder reranking.
 *
 * `docs/architecture.md` has specified this since the beginning — "a
 * cross-encoder rerank of the top 50 down to top-k. Reranking buys more quality
 * than any amount of chunking tuning and is on by default" — and the search
 * path has never called one.
 *
 * ## Why this is not the post-filter invariant I2 forbids
 *
 * It looks like it. I2 says `top_k` is passed through uncorrected and that
 * asking for more and trimming is forbidden; this asks for fifty and returns
 * ten. The difference is what the trim decides.
 *
 * The forbidden pattern trims on **permission**: fetch k results, drop the ones
 * the caller may not see, return what is left. That returns fewer than k
 * permitted results — the caller's last page silently shrinks, and how much it
 * shrinks by is a measurement of what exists but is invisible to them. It also
 * costs more, because the index ranked documents it then threw away.
 *
 * This trims on **relevance**, over a set that is already entirely permitted.
 * The ACL filter runs inside the index traversal exactly as before, so all
 * fifty candidates are ones this caller may read; reordering them and keeping
 * ten changes which permitted results are returned, never how many. The test
 * that separates the two: **can the number of results ever be smaller than the
 * number of permitted matches, up to k?** For a post-filter, yes. Here, no.
 *
 * That is the whole justification, and it is worth stating in the code rather
 * than in a commit message, because the next person to read the search path
 * will see an over-fetch and reach for the rule.
 *
 * ## Failing closed, which is the other way round from the rate limiter
 *
 * If the reranker is unreachable the search still answers, in fusion order,
 * with a metric recording that it degraded. This is not a contradiction of
 * invariant 3: reranking decides *ordering*, and every candidate in the list
 * was already permitted before the reranker saw it. Refusing the search would
 * make an optional quality component into a hard dependency of the product's
 * central operation.
 *
 * What it must never do is fail *quietly* — an operator who turned reranking on
 * is entitled to know it is not running, so degradation is a counter and a log
 * line rather than a silent fallback.
 */

import { endpointUrl, modelEndpointRefused } from '@nacre.work/core'

export interface Reranker {
  /**
   * Score each text against the query. One score per input, **in input order**.
   *
   * Returning scores rather than a sorted list is deliberate: the caller holds
   * the hits, and a reordered list of texts cannot be matched back to them
   * without an index that a wrong implementation would get to choose.
   */
  rank(query: string, texts: readonly string[]): Promise<readonly number[]>
}

/**
 * Text Embeddings Inference's `/rerank`, which is what the `full` and
 * `airgapped` Compose profiles run.
 *
 * The response is `[{index, score}, …]` sorted by score, so the index is the
 * only thing tying a score back to its input. Trusting the order instead would
 * attach the wrong score to the wrong chunk and be invisible in every test that
 * does not check ranking against known-relevant text.
 */
export class HttpReranker implements Reranker {
  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 3000,
  ) {}

  async rank(query: string, texts: readonly string[]): Promise<readonly number[]> {
    if (texts.length === 0) return []

    // A search that would otherwise have answered must not hang because a model
    // server is wedged; the caller treats a timeout as a degradation.
    const abort = AbortSignal.timeout(this.timeoutMs)

    const at = endpointUrl(this.endpoint, 'rerank')
    const response = await fetch(at, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, texts: [...texts], raw_scores: false }),
      signal: abort,
    })

    if (!response.ok) throw modelEndpointRefused('reranker', at, response.status)

    const body = (await response.json()) as unknown
    if (!Array.isArray(body)) throw new Error('the reranker did not answer with a list')

    const scores = new Array<number>(texts.length).fill(Number.NEGATIVE_INFINITY)
    let seen = 0

    for (const entry of body) {
      const { index, score } = entry as { index?: unknown; score?: unknown }
      if (typeof index !== 'number' || typeof score !== 'number') {
        throw new Error('a reranker result carried no index and score')
      }
      if (index < 0 || index >= texts.length) {
        throw new Error(`the reranker scored index ${index} for ${texts.length} inputs`)
      }
      scores[index] = score
      seen++
    }

    if (seen !== texts.length) {
      // A short answer would leave some chunks at -Infinity and sink them to the
      // bottom, which is a silent quality loss rather than a visible failure.
      throw new Error(`the reranker scored ${seen} of ${texts.length} inputs`)
    }

    return scores
  }
}

/**
 * The reranker a configuration asks for, or none.
 *
 * One factory rather than the same three lines in the API process and in the
 * MCP one. They share a search service and must not disagree about whether
 * results are reranked — two surfaces over one index answering in different
 * orders is the kind of difference nobody reports as a bug and everybody
 * notices.
 *
 * `loadConfig` already refuses the contradictory case (enabled with no
 * endpoint) at startup, so there is nothing to validate here.
 */
export function rerankerFor(config: {
  readonly rerankerEnabled: boolean
  readonly rerankerEndpoint: string | undefined
}): Reranker | undefined {
  if (!config.rerankerEnabled || config.rerankerEndpoint === undefined) return undefined
  return new HttpReranker(config.rerankerEndpoint)
}

/**
 * Reorder hits by a reranker's scores and keep the best `topK`.
 *
 * Separate from the transport so the ordering rule can be tested without a
 * model server — the rule being the part that is easy to get subtly wrong.
 *
 * The sort is stable in the sense that matters: ties keep the fusion order they
 * arrived in, because `Array.prototype.sort` is stable and the comparator
 * answers 0 for equal scores. A cross-encoder returning identical scores for
 * two chunks is saying it cannot separate them, and falling back to the index's
 * own ranking is a better answer than an arbitrary one.
 */
export function applyRanking<T>(items: readonly T[], scores: readonly number[], topK: number): T[] {
  if (scores.length !== items.length) {
    throw new Error(`the reranker returned ${scores.length} scores for ${items.length} items`)
  }
  return items
    .map((item, i) => ({ item, score: scores[i] as number }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((s) => s.item)
}
