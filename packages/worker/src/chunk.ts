/**
 * Chunking.
 *
 * The defaults come from `layers.chunk_config`: 800 characters with 120 of
 * overlap, split recursively on the largest separator that fits. Reranking buys
 * more retrieval quality than any amount of tuning here, so this aims to be
 * predictable rather than clever — a chunker whose output shifts with an
 * unrelated change makes every reindex look like a content change.
 *
 * One property holds above all the tuning: **every chunk is a contiguous
 * substring of the document.** It is why this works on offsets rather than by
 * carrying a tail forward and gluing it to the next slice — that version
 * dropped the separator when it trimmed, so the last word of one chunk ran
 * into the first word of the next and produced tokens that were in no
 * document. `practiceNew`, `ory`. They embed, they index, and they are
 * searchable; nothing downstream can tell them from real text.
 */

import { DEFAULT_EMBED_MAX_TOKENS, tokenBudget } from '@nacre.work/core'

export interface ChunkConfig {
  readonly size: number
  readonly overlap: number
  readonly strategy: 'recursive'
  /**
   * What the embedder will accept, in tokens. Absent means unbounded, which is
   * only right for a caller that has already checked — `DEFAULT_CHUNK_CONFIG`
   * carries the real one.
   *
   * `size` is the retrieval knob and this is the ceiling; they are two
   * different questions and a chunk ends at whichever comes first. 800
   * characters of English is 149 tokens and 800 of Korean is 1094, so a
   * character budget alone cannot express "small enough to embed".
   */
  readonly maxTokens?: number
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  size: 800,
  overlap: 120,
  strategy: 'recursive',
  maxTokens: DEFAULT_EMBED_MAX_TOKENS,
}

export interface Chunk {
  readonly ordinal: number
  readonly text: string
}

/** Largest structural boundary first: paragraphs, then lines, then sentences, then words. */
const SEPARATORS = ['\n\n', '\n', '. ', ' ']

/**
 * How many characters from `start` fit inside the token budget.
 *
 * Walks forward accumulating the per-character cost rather than estimating the
 * whole slice and bisecting: one pass, and it stops as soon as the budget is
 * spent. Returns at least one character, because a loop that can return zero
 * does not advance — a single astral character costing more than the whole
 * budget is a document that cannot be chunked, and cutting it out on its own
 * is better than not terminating.
 */
function charactersWithinBudget(text: string, start: number, budget: number): number {
  let cost = 0
  let at = start
  while (at < text.length) {
    const code = text.codePointAt(at) as number
    const width = code > 0xffff ? 2 : 1
    const spend = code < 0x80 ? 0.5 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    if (cost + spend > budget && at > start) break
    cost += spend
    at += width
  }
  return Math.max(at - start, 1)
}

/**
 * Where the chunk beginning at `start` ends: just past the last separator that
 * fits inside `size`, or at `start + size` when the text holds no boundary at
 * all — one very long token, cut rather than handed to an embedding endpoint
 * that has its own ceiling.
 */
function boundaryBefore(text: string, start: number, size: number): number {
  const limit = start + size
  if (limit >= text.length) return text.length

  for (const separator of SEPARATORS) {
    // -separator.length so the whole separator lands inside the limit, and
    // `> start` so a boundary at the very beginning cannot produce an empty
    // chunk and no forward progress.
    const cut = text.lastIndexOf(separator, limit - separator.length)
    if (cut > start) return cut + separator.length
  }

  return limit
}

/**
 * Where the next chunk begins, so a sentence spanning a boundary is searchable
 * from both sides.
 *
 * Snapped forward to a word boundary. A raw `end - overlap` offset lands in the
 * middle of a word as often as not, and the resulting chunk opens with that
 * word's tail — the `ory` of `history` — which is a token the document does not
 * contain. When the window holds no boundary to snap to, the answer is no
 * overlap rather than a fabricated one.
 */
function overlapStart(text: string, start: number, end: number, overlap: number): number {
  // A chunk no longer than the overlap would be repeated whole by the next one,
  // which is not an overlap; it is the same chunk twice and a loop that barely
  // advances.
  if (overlap <= 0 || end - start <= overlap) return end

  const from = end - overlap
  const boundary = text.slice(from, end).search(/\s/)
  return boundary === -1 ? end : from + boundary + 1
}

export function chunk(text: string, config: ChunkConfig = DEFAULT_CHUNK_CONFIG): readonly Chunk[] {
  if (config.overlap >= config.size) {
    // Overlap at or above size means every chunk re-reads everything the
    // previous one covered, and the loop never advances.
    throw new Error(`chunk overlap (${config.overlap}) must be smaller than size (${config.size})`)
  }
  if (config.size <= 0) {
    throw new Error(`chunk size (${config.size}) must be positive`)
  }

  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return []

  const chunks: Chunk[] = []
  let start = 0
  let ordinal = 0

  const budget = config.maxTokens === undefined ? undefined : tokenBudget(config.maxTokens)

  while (start < normalized.length) {
    // The narrower of the two bounds, recomputed per chunk because the answer
    // depends on the text: 800 characters of English costs 149 tokens and 800
    // of Korean costs 1094, so a document that mixes scripts gets long chunks
    // where it is cheap and short ones where it is not.
    const size =
      budget === undefined
        ? config.size
        : Math.min(config.size, charactersWithinBudget(normalized, start, budget))

    const end = boundaryBefore(normalized, start, size)

    // trim, not slice-and-glue: the separator stays in the source string, so
    // what is dropped here is only whitespace at the two ends of a substring.
    const body = normalized.slice(start, end).trim()
    if (body.length > 0) chunks.push({ ordinal: ordinal++, text: body })

    if (end >= normalized.length) break

    const next = overlapStart(normalized, start, end, config.overlap)
    // The loop advances or it stops. Every branch above already guarantees it,
    // and this is here so that stays true of branches added later.
    start = next > start ? next : end
  }

  return chunks
}
