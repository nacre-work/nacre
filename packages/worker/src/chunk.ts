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

  while (start < normalized.length) {
    const end = boundaryBefore(normalized, start, config.size)

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
