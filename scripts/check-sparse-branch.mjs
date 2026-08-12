#!/usr/bin/env node
/**
 * A vector slot the collection declares must have a producer on both sides.
 *
 * This is the check for the defect it was written after, and the defect is the
 * plainest one this repository has found: `collectionConfig` declared a `bm25`
 * sparse slot, `docs/architecture.md` described search as dense plus sparse
 * fused with RRF, `buildHybridQuery` accepted a `SparseBranch` and
 * `prefilter.test.ts` passed one — and **nothing ever produced a sparse
 * vector**. Not the worker on ingest, not the search path. The slot was empty
 * on every point of every collection, every query was dense-only, and the whole
 * suite was green throughout, because every piece was individually correct.
 *
 * Nothing could have failed. A slot with no writer is not an error at ingest;
 * a branch that is never built is not an error at query time; and a test that
 * hands `buildHybridQuery` a sparse branch proves the builder works, not that
 * anybody calls it. So the guard cannot be a test of any one of them — it has
 * to be the question none of them asks: *the collection declares this slot, so
 * who fills it and who reads it?*
 *
 * Two sides, because either alone is silent. A slot written and never queried
 * is dead weight in the index. A slot queried and never written is a prefetch
 * branch that returns nothing, which fusion absorbs without a trace: results
 * still come back, they are simply the dense ones, which is exactly the state
 * this check exists to make unreachable.
 */

import { readFileSync } from 'node:fs'

const DECLARATION = 'packages/core/vector/query.ts'
const NAME = 'packages/core/text/bm25.ts'

/**
 * Where each side of the index lives.
 *
 * Named files rather than a walk: what is asserted is that *these* paths — the
 * one that writes points and the one that builds a query — reach the encoder.
 * A walk would pass on any mention anywhere, including a test, which is how a
 * check comes to assert nothing.
 */
const SIDES = [
  {
    what: 'written at ingest',
    file: 'packages/worker/src/adapters.ts',
    needs: ['SPARSE_VECTOR_NAME'],
    producer: { file: 'packages/worker/src/ingest.ts', call: 'encodeDocument(' },
  },
  {
    what: 'read on the search path',
    file: 'packages/api/src/adapters.ts',
    needs: ['SPARSE_VECTOR_NAME'],
    producer: { file: 'packages/api/src/adapters.ts', call: 'encodeQuery(' },
  },
]

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

let failed = false
const fail = (message) => {
  console.error(`✗ ${message}`)
  failed = true
}

// The name the collection is built with, taken from the source rather than
// written here: a check holding a literal against a literal it copied is a
// check that passes after somebody renames both and after somebody renames
// neither.
const nameSource = read(NAME)
if (nameSource === undefined) fail(`${NAME} is missing — the sparse slot has no name to check`)

const declared = nameSource?.match(/export const SPARSE_VECTOR_NAME = '([^']+)'/)?.[1]
if (declared === undefined) fail(`${NAME} does not export SPARSE_VECTOR_NAME as a literal`)

const config = read(DECLARATION)
if (config === undefined) fail(`${DECLARATION} is missing`)
else if (!/sparse_vectors:\s*\{\s*\[SPARSE_VECTOR_NAME\]/.test(config)) {
  fail(
    `${DECLARATION} does not build sparse_vectors from SPARSE_VECTOR_NAME. ` +
      'A literal there and a constant elsewhere are two names for one slot, ' +
      'and they disagree the first time either moves.',
  )
}

// IDF is Qdrant's half of BM25 and it is opt-in per slot. Without the modifier
// the weights written at ingest are summed raw, so a term appearing in every
// chunk of the collection counts as much as one appearing once — which is not
// BM25, does not fail, and shows up only as ranking that is quietly poor.
if (config !== undefined && !/modifier:\s*'idf'/.test(config)) {
  fail(`${DECLARATION} declares the sparse slot without \`modifier: 'idf'\` — that is a sum of term frequencies, not BM25`)
}

for (const side of SIDES) {
  const source = read(side.file)
  if (source === undefined) {
    fail(`${side.file} is missing — cannot check that the slot is ${side.what}`)
    continue
  }

  for (const needle of side.needs) {
    if (!source.includes(needle)) {
      fail(`${side.file} never names ${needle}: the ${declared ?? 'sparse'} slot is not ${side.what}`)
    }
  }

  const producer = read(side.producer.file)
  if (producer === undefined || !producer.includes(side.producer.call)) {
    fail(
      `${side.producer.file} never calls ${side.producer.call} — ` +
        `the slot is declared and ${side.what} by nothing`,
    )
  }
}

if (failed) {
  console.error('\nA declared vector slot with no producer is invisible to every test in this repository.')
  process.exit(1)
}

console.log(`sparse slot '${declared}': written at ingest, read on the search path, idf on the collection`)
