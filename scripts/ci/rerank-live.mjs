#!/usr/bin/env node
/**
 * `HttpReranker` against a real Text Embeddings Inference, not a stubbed fetch.
 *
 * Every case in `packages/api/src/__tests__/rerank.test.ts` replaces
 * `globalThis.fetch` and answers with a `Response` the test wrote, so what they
 * prove is that the client agrees with itself. Nothing had ever asked a real
 * TEI whether `/rerank` takes `{query, texts, raw_scores}` and answers
 * `[{index, score}]` — the fixture-written-to-match-the-code shape, on the path
 * where being wrong means a deployment's searches stop being reranked with no
 * error anywhere, because reranking fails open by design.
 *
 * Asking one turned up that it does not answer in input order and that
 * `--max-client-batch-size` defaults to 32, against a candidate set of 50. Both
 * are here.
 *
 * The server is started by the workflow with **the flag the compose file
 * passes**, read from that file rather than repeated here, so this asks the
 * arrangement the product ships rather than one written for the test.
 */

import { readFileSync } from 'node:fs'

import { HttpReranker } from '../../packages/api/dist/rerank.js'

const ENDPOINT = process.env['NACRE_RERANKER_ENDPOINT'] ?? 'http://localhost:8099'

/** The most a search can be configured to send. Read, not written down. */
const config = readFileSync('packages/core/config.ts', 'utf8')
const declared = /'NACRE_RERANK_CANDIDATES',\s*(\d+),\s*\{[^}]*?max:\s*(\d+)/.exec(config)
if (declared === null) throw new Error('NACRE_RERANK_CANDIDATES is not read with a default and a max')
const fallback = Number(declared[1])
const ceiling = Number(declared[2])

const problems = []
const check = (ok, said) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${said}`)
  if (!ok) problems.push(said)
}

/**
 * The flag took effect.
 *
 * A flag the server stopped supporting is ignored rather than refused, so the
 * container starts, `lint:rerank-batch` goes on comparing a number in a compose
 * file against a number in a config file, and both are right about a limit the
 * running server does not have.
 */
const info = await (await fetch(`${ENDPOINT}/info`)).json()
check(
  typeof info.max_client_batch_size === 'number' && info.max_client_batch_size >= ceiling,
  `the server accepts ${String(info.max_client_batch_size)} texts per call, and a search may ` +
    `send ${String(ceiling)}`,
)

const reranker = new HttpReranker(ENDPOINT, 30_000)

/**
 * The defect this exists for: the shipped candidate count, in one call.
 *
 * `HttpReranker` sends the whole set and refuses a short answer, so a 413 or a
 * truncation both arrive here as a throw rather than as a quietly worse
 * ordering.
 */
const many = Array.from({ length: fallback }, (_, i) => `chunk ${String(i)} about company matters`)
let scored
try {
  scored = await reranker.rank('what is the refund policy', many)
  check(scored.length === fallback, `the default candidate set of ${String(fallback)} is scored`)
} catch (error) {
  check(false, `the default candidate set of ${String(fallback)} is scored — ${String(error)}`)
}

/** And the documented maximum, which is what an operator may raise it to. */
const most = Array.from({ length: ceiling }, (_, i) => `chunk ${String(i)}`)
try {
  const all = await reranker.rank('refund', most)
  check(all.length === ceiling, `the documented maximum of ${String(ceiling)} is scored`)
} catch (error) {
  check(false, `the documented maximum of ${String(ceiling)} is scored — ${String(error)}`)
}

/**
 * Scores map back by index and not by arrival.
 *
 * A real TEI answers sorted by score, so the relevant text planted last comes
 * back first — which is what makes trusting the order attach the wrong score to
 * the wrong chunk. The unit case asserts this against a response it wrote; this
 * asserts it against the reordering the server actually performs.
 */
const planted = [
  'The office kitchen is cleaned on Fridays.',
  'Parking permits renew every January.',
  'Refunds are issued within 14 days of purchase, no questions asked.',
]
const scores = await reranker.rank('what is the refund policy', planted)
const best = scores.indexOf(Math.max(...scores))
check(best === 2, `the refund sentence scores highest at its own index (got ${String(best)})`)

const raw = await (
  await fetch(`${ENDPOINT}/rerank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'what is the refund policy', texts: planted, raw_scores: false }),
  })
).json()
check(
  Array.isArray(raw) && raw[0]?.index !== 0,
  `the server really does answer out of input order (first index ${String(raw[0]?.index)}), ` +
    'which is why the mapping is by index',
)

if (problems.length > 0) {
  console.error(`::error::${String(problems.length)} problem(s) against a real reranker.`)
  process.exit(1)
}
console.log(`\nHttpReranker agrees with a real ${String(info.model_id)}`)
