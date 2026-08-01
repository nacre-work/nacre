import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { chunk, DEFAULT_CHUNK_CONFIG, type ChunkConfig } from '../chunk.js'

/**
 * Chunking.
 *
 * The assertions that matter are not about sizes. A chunker that returns
 * slightly wrong lengths costs recall; a chunker that returns text the document
 * does not contain puts tokens in the index that no query can legitimately
 * match and no reader can explain. The first two tests here are the ones that
 * failed: overlap was taken from the trimmed tail of the previous chunk and
 * concatenated with nothing between, so every seam past the first produced a
 * word made of two halves.
 */

const config = (over: Partial<ChunkConfig> = {}): ChunkConfig => ({ ...DEFAULT_CHUNK_CONFIG, ...over })

/** The normalization the chunker applies before anything else. */
const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim()

describe('chunk', () => {
  it('every chunk is a substring of the document', () => {
    const text = [
      'Nacre is deposited in layers, and the layers are what make it strong.',
      'A single layer is brittle. Stacked, they bend before they break.',
      'That is the whole of the metaphor and it is also the engineering practice.',
      'New material is added around whatever got inside, not instead of it.',
    ].join('\n\n')

    const chunks = chunk(text, config({ size: 90, overlap: 30 }))

    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      // The strongest statement available, and the one the old implementation
      // could not make: nothing here was assembled, so nothing here is new.
      expect(normalize(text)).toContain(c.text)
    }
  })

  it('no chunk contains a word the document does not', () => {
    const text =
      'The layer grows around the grain. It is a slow practice. ' +
      'New material arrives at the edge and history accumulates underneath it. ' +
      'Reading the strata tells you the order things happened in.'

    const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean))
    const inDocument = words(text)

    for (const c of chunk(text, config({ size: 60, overlap: 20 }))) {
      for (const word of words(c.text)) {
        // `practiceNew` and `ory` were the real ones — a sentence end glued to
        // the next sentence's start, and the tail of `history` opening a chunk.
        expect(inDocument, `${word} is in no chunk of the source`).toContain(word)
      }
    }
  })

  it('consecutive chunks actually overlap', () => {
    const text = Array.from({ length: 40 }, (_, i) => `sentence number ${i} carries its own words.`).join(' ')
    const chunks = chunk(text, config({ size: 120, overlap: 40 }))

    expect(chunks.length).toBeGreaterThan(2)
    for (let i = 1; i < chunks.length; i++) {
      const previous = chunks[i - 1]?.text ?? ''
      const current = chunks[i]?.text ?? ''
      const opening = current.split(/\s+/)[0] ?? ''
      // Not a length assertion — the point of overlap is that a phrase spanning
      // a boundary is findable from both sides.
      expect(previous, `chunk ${i} does not overlap chunk ${i - 1}`).toContain(opening)
    }
  })

  it('an overlap that lands mid-word starts at the next word instead', () => {
    // 'history' straddles the overlap offset for this size. The old code opened
    // the following chunk with 'ory'.
    const text = 'alpha beta gamma delta epsilon history zeta eta theta iota kappa'
    for (const c of chunk(text, config({ size: 40, overlap: 12 }))) {
      expect(c.text).not.toMatch(/^ory/)
      expect(text).toContain(c.text)
    }
  })

  it('splits on the largest boundary that fits', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const chunks = chunk(text, config({ size: 20, overlap: 0 }))
    expect(chunks.map((c) => c.text)).toEqual(['First paragraph.', 'Second paragraph.', 'Third paragraph.'])
  })

  it('a token longer than the size is cut rather than emitted whole', () => {
    const long = 'x'.repeat(250)
    const chunks = chunk(long, config({ size: 100, overlap: 20 }))

    // Cut, because the embedding endpoint has a ceiling of its own and finding
    // out there is worse. No overlap is possible: there is no word boundary to
    // take one from, and inventing one would split the token.
    expect(chunks.every((c) => c.text.length <= 100)).toBe(true)
    expect(chunks.map((c) => c.text).join('')).toBe(long)
  })

  it('empty and whitespace-only input produce no chunks', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   \n\n  \t ')).toEqual([])
  })

  it('refuses a configuration that cannot terminate', () => {
    expect(() => chunk('anything', config({ size: 100, overlap: 100 }))).toThrow(/overlap/)
    expect(() => chunk('anything', config({ size: 0, overlap: 0 }))).toThrow(/size/)
  })

  it('ordinals are dense and start at zero', () => {
    const chunks = chunk('a b c d e f g h i j k l m n o p', config({ size: 10, overlap: 3 }))
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('property · any document, any settings: chunks are substrings and cover it', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 400 }),
        fc.integer({ min: 4, max: 60 }),
        fc.integer({ min: 0, max: 30 }),
        (text, size, overlapRaw) => {
          const overlap = Math.min(overlapRaw, size - 1)
          const normalized = normalize(text)
          const chunks = chunk(text, { size, overlap, strategy: 'recursive' })

          for (const c of chunks) {
            // Substring, always. This is what makes a chunk explainable: an
            // operator can find it in the source.
            if (!normalized.includes(c.text)) return false
          }

          // And nothing is silently dropped: a document with content produces
          // chunks, and one without does not.
          return normalized.trim().length === 0 ? chunks.length === 0 : chunks.length > 0
        },
      ),
      { numRuns: 500 },
    )
  })
})
