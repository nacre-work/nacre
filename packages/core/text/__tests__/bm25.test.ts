import { describe, expect, it } from 'vitest'

import { encodeDocument, encodeQuery, isEmpty, tokenize } from '../bm25.js'

/**
 * The property that matters most is not any single weight — it is that the two
 * sides of the index agree. A document encoder and a query encoder that
 * tokenize differently produce a lexical branch that never matches: no error,
 * no log, no failing test that looks at one side, and search silently reverts
 * to being dense-only. Which is the state this module was written to end.
 */
describe('the two encoders agree', () => {
  const CASES = [
    'the migration failed with SQLSTATE 23505',
    'NACRE_S3_ENDPOINT must name a scheme',
    'Договор №14/2026 подписан',
    'bge-m3 routed through cloudflare',
  ]

  for (const text of CASES) {
    it(`indexes the same terms on both sides: ${text}`, () => {
      const document = encodeDocument(text)
      const query = encodeQuery(text)

      expect(query.indices).toEqual(document.indices)
    })
  }

  it('a query term that appears in a chunk lands on a shared dimension', () => {
    const chunk = encodeDocument('Restoring from backup begins with the Postgres dump.')
    const query = encodeQuery('postgres dump')

    const shared = query.indices.filter((i) => chunk.indices.includes(i))
    expect(shared).toHaveLength(query.indices.length)
  })

  it('a query with nothing in common shares no dimension', () => {
    const chunk = encodeDocument('Restoring from backup begins with the Postgres dump.')
    const query = encodeQuery('шифрование ключей')

    expect(query.indices.some((i) => chunk.indices.includes(i))).toBe(false)
  })
})

describe('tokenizing', () => {
  it('keeps an identifier whole and also indexes its parts', () => {
    // Both, deliberately. Without the parts, `s3` misses a chunk that only ever
    // writes the full variable name; without the whole, that search scores the
    // same against every chunk mentioning S3 at all.
    expect(tokenize('NACRE_S3_ENDPOINT')).toEqual([
      'nacre_s3_endpoint',
      'nacre',
      's3',
      'endpoint',
    ])
  })

  it('keeps a version and a model name whole', () => {
    expect(tokenize('0.14.3')).toContain('0.14.3')
    expect(tokenize('bge-m3')).toContain('bge-m3')
  })

  it('does not treat a trailing separator as a connector', () => {
    expect(tokenize('It ended.')).toEqual(['it', 'ended'])
  })

  it('lowercases and normalises, so case and width do not split a term', () => {
    expect(tokenize('Postgres')).toEqual(tokenize('POSTGRES'))
    expect(tokenize('ＳＱＬ')).toEqual(tokenize('sql'))
  })

  it('indexes Cyrillic as words', () => {
    expect(tokenize('Отзыв гранта')).toEqual(['отзыв', 'гранта'])
  })

  it('splits scripts written without spaces, rather than making one huge token', () => {
    // Left whole, a Chinese chunk is a single token that matches only a query
    // containing the identical chunk — which is to say nothing at all.
    expect(tokenize('访问控制')).toEqual(['访', '问', '控', '制'])
  })

  it('finds no terms in punctuation', () => {
    expect(tokenize('— … —')).toEqual([])
  })
})

describe('weights', () => {
  it('saturates: the tenth occurrence is worth far less than the second', () => {
    const twice = weightOf(encodeDocument('grant grant'), 'grant')
    const tenTimes = weightOf(encodeDocument('grant '.repeat(10)), 'grant')

    expect(tenTimes).toBeGreaterThan(twice)
    // BM25's whole shape: more is more, but with sharply diminishing returns.
    // Linear term frequency is what lets a page repeating one word outrank the
    // page that answers the question.
    expect(tenTimes).toBeLessThan(twice * 3)
  })

  it('weighs a term less when the chunk around it is longer', () => {
    const short = weightOf(encodeDocument('revocation'), 'revocation')
    const long = weightOf(
      encodeDocument(`revocation ${'filler '.repeat(200)}`),
      'revocation',
    )

    expect(long).toBeLessThan(short)
  })

  it('gives every query term the same weight, however often it was typed', () => {
    // Repeating a word in a search box is not a claim that it matters twice as
    // much, and the corpus statistic that decides whether it matters is IDF —
    // which is Qdrant's, from the slot's modifier, not ours.
    const once = encodeQuery('backup')
    const thrice = encodeQuery('backup backup backup')

    expect(thrice).toEqual(once)
    expect(once.values).toEqual([1])
  })

  it('carries no IDF, so a chunk indexed today and one indexed next year agree', () => {
    // The document side is term frequency only. If it carried IDF, each chunk
    // would freeze its own idea of how rare a word is at the moment it was
    // written, and a growing corpus would hold a thousand disagreeing
    // snapshots of one statistic.
    const alone = encodeDocument('tombstone')
    const same = encodeDocument('tombstone')

    expect(alone).toEqual(same)
  })
})

describe('shape', () => {
  it('is ascending and free of duplicates, whatever the text', () => {
    const vector = encodeDocument('a b c a b a NACRE_S3_ENDPOINT 访问 b')

    expect([...vector.indices]).toEqual([...vector.indices].sort((x, y) => x - y))
    expect(new Set(vector.indices).size).toBe(vector.indices.length)
    expect(vector.values).toHaveLength(vector.indices.length)
  })

  it('stays inside u32, which is what Qdrant indexes are', () => {
    for (const index of encodeDocument('a b c déjà vu 访问 NACRE_S3_ENDPOINT').indices) {
      expect(Number.isInteger(index)).toBe(true)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it('reports an empty vector rather than pretending, on both sides', () => {
    expect(isEmpty(encodeDocument('— … —'))).toBe(true)
    expect(isEmpty(encodeQuery('!!!'))).toBe(true)
    expect(isEmpty(encodeQuery('backup'))).toBe(false)
  })
})

function weightOf(vector: { indices: readonly number[]; values: readonly number[] }, term: string) {
  const [index] = encodeQuery(term).indices
  const at = vector.indices.indexOf(index as number)
  if (at === -1) throw new Error(`${term} is not in the vector`)
  return vector.values[at] as number
}
