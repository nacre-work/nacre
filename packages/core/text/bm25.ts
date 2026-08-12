/**
 * BM25 — the lexical half of the hybrid query.
 *
 * `docs/architecture.md` has described search as "dense vector plus sparse
 * BM25, fused with Reciprocal Rank Fusion" since before there was a server, the
 * collection has been created with a `bm25` sparse slot for just as long, and
 * `buildHybridQuery` has always accepted a `SparseBranch`. Nothing ever
 * produced a sparse vector — not the worker on ingest, not the search path — so
 * the slot was empty on every point and every query was dense-only. A normative
 * document disagreeing with the tree, in the shape this repository keeps
 * finding: declared, accepted, read by nothing.
 *
 * This is the missing producer, and it is one module rather than two because
 * **the document side and the query side have to agree on every token**. A
 * term that hashes to 91 at ingest and to 92 at query time does not fail, does
 * not log and does not show up in a test that checks one side: it simply never
 * matches, and the lexical branch quietly contributes nothing. The two entry
 * points below are the same tokenizer with different weights, and
 * `__tests__/bm25.test.ts` asserts the agreement directly.
 *
 * ## Why there is no stopword list and no stemmer
 *
 * **Stopwords are unnecessary here** because Qdrant applies IDF itself — the
 * sparse slot is declared `modifier: "idf"`, so a term appearing in every chunk
 * of the collection is scored near zero by arithmetic rather than by a list.
 * A list would be one more thing to keep in step, per language, and this
 * repository has enough of those.
 *
 * **A stemmer is declined on the merits, not on cost.** Stemming is
 * per-language, so it needs language detection, and applying the wrong one is
 * worse than applying none. More to the point it works against what this branch
 * is *for*: dense retrieval already handles paraphrase and synonymy, and what
 * it handles badly is exactly what must not be stemmed — error codes, contract
 * numbers, part numbers, `NACRE_*` variables, service names, surnames. The
 * division of labour is the reason to have two branches at all, and a stemmer
 * blurs the half that is pulling its weight.
 *
 * The cost is stated rather than hidden: in an inflected language, `договора`
 * and `договор` are two terms here. The dense branch is what bridges them, and
 * a query naming either still finds a chunk naming either — through the other
 * branch, at a lower rank than an exact match. That is the intended ordering.
 */

/**
 * The sparse slot's name in every collection.
 *
 * A literal in `collectionConfig`, in the writer and on the search path is
 * three copies of a string that has to agree, which is how the dense side got
 * `default` written into a column while search looked for something else and
 * the index came back empty.
 */
export const SPARSE_VECTOR_NAME = 'bm25'

export interface SparseVector {
  /** Term hashes. Unique, ascending — Qdrant requires the first, we do the second. */
  readonly indices: readonly number[]
  readonly values: readonly number[]
}

/** Term-frequency saturation. The standard value; nothing here is tuned. */
const K1 = 1.2

/** How much a chunk's length is allowed to matter. Also the standard value. */
const B = 0.75

/**
 * The length a chunk is normalised against.
 *
 * BM25 divides by the *corpus* average, which nothing here knows: Qdrant
 * computes IDF across the collection but not this, and asking Postgres for a
 * running mean would put a query on the ingest path to move a number that
 * barely moves.
 *
 * A constant is defensible here in a way it would not be for general documents,
 * and the reason is upstream: what gets encoded is never a document, it is a
 * *chunk*, and chunks are bounded — 800 characters with 120 of overlap, from
 * `DEFAULT_CHUNK_CONFIG`. Their lengths cluster tightly around one value, so
 * the length correction this constant feeds is close to a no-op whatever it is
 * set to. 120 is 800 characters at a shade under seven characters a token,
 * which is roughly English with its spaces and roughly Russian without them.
 *
 * The failure mode if a deployment chunks very differently is a mild, uniform
 * bias in favour of short chunks or long ones — a ranking that is slightly off,
 * never an answer that is wrong. If it ever needs to vary, it varies per layer,
 * beside `chunk_config`, which is where the number it depends on already lives.
 */
const AVERAGE_CHUNK_TOKENS = 120

/**
 * Runs of letters and digits, with `.`, `_`, `-` and `/` kept when they join
 * two of them.
 *
 * The connectors are the whole point. Splitting on every non-alphanumeric turns
 * `NACRE_S3_ENDPOINT` into three ordinary English-ish words, `0.14.3` into
 * three integers and `bge-m3` into a word and a token that collides with every
 * other `m3` in the corpus — and identifiers are the class of term this branch
 * exists to match. A trailing separator is not a connector: `end.` is `end`.
 */
const TOKEN = /[\p{L}\p{N}]+(?:[._\-/][\p{L}\p{N}]+)*/gu

/**
 * Scripts written without spaces between words.
 *
 * Left whole, a Chinese or Japanese chunk is one enormous token that matches
 * only a query containing the identical chunk — which is to say, nothing. Split
 * per character it behaves like a unigram index: coarse, and vastly better than
 * silence. Hangul is deliberately absent, because Korean is written with
 * spaces and `TOKEN` already handles it.
 */
const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u

/**
 * FNV-1a, 32-bit, because Qdrant's sparse indices are `u32`.
 *
 * A collision makes two unrelated terms share a dimension, which costs a little
 * relevance on one query and can never cost a permission: the ACL filter is a
 * separate structure applied inside the traversal, and nothing about which
 * points are *considered* is decided here. At a vocabulary of a hundred
 * thousand distinct terms the expected number of collisions is around one.
 */
function hash(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i += 1) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Text to terms, identically on both sides of the index.
 *
 * A compound token is emitted *and* broken up: `nacre_s3_endpoint` yields
 * itself plus `nacre`, `s3` and `endpoint`. Without the parts, somebody
 * searching `s3` misses a chunk that only ever writes the full variable name;
 * without the whole, that search ranks equally against every chunk mentioning
 * S3 at all. Both, and the exact match wins on having matched twice.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []

  for (const [token] of text.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    if (IDEOGRAPHIC.test(token)) {
      for (const character of token) tokens.push(character)
      continue
    }

    tokens.push(token)

    if (token.length > 1 && /[._\-/]/.test(token)) {
      for (const part of token.split(/[._\-/]/)) {
        if (part.length > 0) tokens.push(part)
      }
    }
  }

  return tokens
}

function counts(tokens: readonly string[]): Map<number, number> {
  const frequencies = new Map<number, number>()
  for (const token of tokens) {
    const index = hash(token)
    frequencies.set(index, (frequencies.get(index) ?? 0) + 1)
  }
  return frequencies
}

function assemble(pairs: Iterable<readonly [number, number]>): SparseVector {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0])
  return {
    indices: sorted.map(([index]) => index),
    values: sorted.map(([, value]) => value),
  }
}

/**
 * One chunk's sparse vector: the term-frequency half of BM25.
 *
 * Deliberately *half*. The IDF half is Qdrant's, computed across the collection
 * from the slot's `modifier: "idf"` — which is the only place it can be
 * computed correctly, because it depends on every other point and those are
 * still being written. Storing an IDF here would freeze each chunk's idea of
 * how rare a word is at the moment it was indexed, and a corpus that grows
 * would carry a thousand disagreeing snapshots of the same statistic.
 *
 * An empty result is a real answer — a chunk of punctuation has no terms — and
 * the writer omits the slot rather than sending it, because a sparse vector
 * with no dimensions matches nothing and is not worth the bytes.
 */
export function encodeDocument(text: string): SparseVector {
  const tokens = tokenize(text)
  if (tokens.length === 0) return { indices: [], values: [] }

  const length = tokens.length
  const normalisation = K1 * (1 - B + (B * length) / AVERAGE_CHUNK_TOKENS)

  return assemble(
    [...counts(tokens)].map(([index, frequency]) => [
      index,
      (frequency * (K1 + 1)) / (frequency + normalisation),
    ]),
  )
}

/**
 * A query's sparse vector: presence, at weight one.
 *
 * Not the same weighting as a document, and that asymmetry is BM25 rather than
 * an oversight. The score is a sum over shared terms of `idf × document
 * weight × query weight`; saturating a query term by how often the person
 * happened to repeat it says nothing about the corpus, and repeating a word in
 * a search box is not a claim that it matters twice as much.
 */
export function encodeQuery(text: string): SparseVector {
  const tokens = tokenize(text)
  if (tokens.length === 0) return { indices: [], values: [] }

  return assemble([...new Set(tokens.map(hash))].map((index) => [index, 1] as const))
}

/** Whether there is anything to ask the lexical branch. */
export function isEmpty(vector: SparseVector): boolean {
  return vector.indices.length === 0
}
