/**
 * Chunking.
 *
 * The defaults come from `layers.chunk_config`: 800 characters with 120 of
 * overlap, split recursively on the largest separator that fits. Reranking buys
 * more retrieval quality than any amount of tuning here, so this aims to be
 * predictable rather than clever — a chunker whose output shifts with an
 * unrelated change makes every reindex look like a content change.
 */

export interface ChunkConfig {
  readonly size: number
  readonly overlap: number
  readonly strategy: 'recursive'
}

export const DEFAULT_CHUNK_CONFIG: ChunkConfig = { size: 800, overlap: 120, strategy: 'recursive' }

export interface Chunk {
  readonly ordinal: number
  readonly text: string
}

/** Largest structural boundary first: paragraphs, then lines, then sentences, then words. */
const SEPARATORS = ['\n\n', '\n', '. ', ' ']

function splitOnce(text: string, limit: number): [string, string] {
  if (text.length <= limit) return [text, '']

  for (const separator of SEPARATORS) {
    // Look for the last boundary inside the limit, so a chunk ends where the
    // text does rather than mid-word.
    const cut = text.lastIndexOf(separator, limit)
    if (cut > 0) return [text.slice(0, cut + separator.length).trimEnd(), text.slice(cut + separator.length)]
  }

  // No boundary at all — one very long token. Cut it rather than emit a chunk
  // larger than the limit, because the embedding endpoint has its own ceiling
  // and finding out there is worse.
  return [text.slice(0, limit), text.slice(limit)]
}

export function chunk(text: string, config: ChunkConfig = DEFAULT_CHUNK_CONFIG): readonly Chunk[] {
  if (config.overlap >= config.size) {
    // Overlap at or above size means every chunk re-reads everything the
    // previous one covered, and the loop never advances.
    throw new Error(`chunk overlap (${config.overlap}) must be smaller than size (${config.size})`)
  }

  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (normalized.length === 0) return []

  const chunks: Chunk[] = []
  let rest = normalized
  let carry = ''
  let ordinal = 0

  while (rest.length > 0) {
    const [head, tail] = splitOnce(carry + rest, config.size)
    const body = head.trim()
    if (body.length > 0) chunks.push({ ordinal: ordinal++, text: body })

    if (tail.length === 0) break

    // The overlap is taken from what was just emitted, so a sentence spanning a
    // boundary is searchable from both sides.
    carry = head.slice(Math.max(0, head.length - config.overlap))
    rest = tail
  }

  return chunks
}
