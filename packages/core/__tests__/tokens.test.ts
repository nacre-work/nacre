import { describe, expect, it } from 'vitest'

import { DEFAULT_EMBED_MAX_TOKENS, estimateTokens, refusedForLength, tokenBudget } from '../index.js'

/**
 * The numbers here were measured against a real `BAAI/bge-small-en-v1.5`
 * through Text Embeddings Inference's `/tokenize`, not derived. They are the
 * reason the estimate is shaped the way it is, so they are pinned: a change to
 * the cost model that stops covering a script fails here rather than in
 * somebody's Cyrillic corpus.
 */
describe('estimateTokens', () => {
  it('charges ASCII half a token, which is above prose and identifiers', () => {
    // 600 characters of ASCII prose measured 111 tokens; identifiers measured
    // 251. Both must come out under the estimate or a chunk sized by it can be
    // refused.
    const prose = 'The permission filter runs inside the index traversal. '.repeat(11).slice(0, 600)
    expect(estimateTokens(prose)).toBe(300)
    expect(estimateTokens(prose)).toBeGreaterThan(251)
  })

  it('charges every other script its UTF-8 byte length', () => {
    // One Cyrillic character is two bytes, one CJK character three, one astral
    // emoji four. Measured worst case across scripts was 0.97 tokens per byte,
    // so bytes is the bound this side of the model.
    expect(estimateTokens('й')).toBe(2)
    expect(estimateTokens('检')).toBe(3)
    expect(estimateTokens('🔍')).toBe(4)
  })

  it('covers what a real tokenizer charged, script by script', () => {
    // chars → tokens, measured. The estimate must be at or above each.
    const measured: readonly [string, string, number][] = [
      ['russian', 'Качество поиска зависит от границ фрагмента. ', 496],
      ['korean', '검색 품질은 청크 경계에 좌우됩니다. ', 667],
      ['chinese', '检索质量取决于分块边界。', 602],
      ['arabic', 'تعتمد جودة الاسترجاع على حدود الأجزاء. ', 510],
      ['greek', 'Η ποιότητα ανάκτησης εξαρτάται από τα όρια των τμημάτων. ', 429],
    ]
    for (const [script, unit, tokens] of measured) {
      const text = unit.repeat(80).slice(0, 600)
      expect(estimateTokens(text), `${script} is under-charged`).toBeGreaterThanOrEqual(tokens)
    }
  })

  it('is empty for empty text', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('tokenBudget', () => {
  it('reserves room for what the model wraps around the input', () => {
    expect(tokenBudget(DEFAULT_EMBED_MAX_TOKENS)).toBe(508)
  })

  it('refuses a ceiling that leaves nothing to put in it', () => {
    expect(() => tokenBudget(2)).toThrow(/leaves no room/)
  })
})

describe('refusedForLength', () => {
  it('recognises what Text Embeddings Inference actually answers', () => {
    // Verbatim from a real TEI on the OpenAI-compatible route.
    expect(
      refusedForLength('Input validation error: `inputs` must have less than 512 tokens. Given: 1482'),
    ).toBe(true)
  })

  it('recognises the other wordings an endpoint uses', () => {
    expect(refusedForLength('input is too long')).toBe(true)
    expect(refusedForLength('This model has a maximum context length of 8192 tokens')).toBe(true)
  })

  /**
   * The one that matters. TEI answers **413 for both** a batch with too many
   * texts and one text with too many tokens, and the repairs are opposite:
   * send fewer texts, or send shorter ones. Re-chunking a document because the
   * batch was too large would halve the chunks and fail again, three times,
   * before reporting a length problem that never existed.
   */
  it('does not mistake a batch refusal for a length one', () => {
    expect(refusedForLength('batch size 86 > maximum allowed batch size 32')).toBe(false)
  })

  it('does not mistake a credential refusal for a length one', () => {
    expect(refusedForLength('the embedding endpoint answered 401. That means it wants a credential.')).toBe(
      false,
    )
  })
})
