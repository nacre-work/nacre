#!/usr/bin/env node
/**
 * The reranker this repository ships accepts every batch this repository sends.
 *
 * `HttpReranker` posts the whole candidate set to Text Embeddings Inference's
 * `/rerank` in **one** call — `NACRE_RERANK_CANDIDATES` texts, 50 by default —
 * and TEI refuses a client batch over `--max-client-batch-size`, whose default
 * is **32**. So the combination the `full` and `airgapped` profiles ship
 * answered `413 batch size 50 > maximum allowed batch size 32` to every search
 * with more than 32 candidates, from the day reranking landed.
 *
 * Nothing failed, which is why it needed measuring rather than reading.
 * Reranking fails open by design — an unreachable reranker degrades a search to
 * fusion order with a counter and a log line — so a deployment that configured
 * a reranker got searches that still answered and were never reranked. The same
 * shape as the embedding batch that made a document over 22 KB never index, and
 * found the same way: by sending the shipped default to a real server.
 *
 * **Splitting is the wrong repair here and that is not a matter of taste.** A
 * reranker is not promised to score each text independently of the others in
 * the call, so two calls produce two sets of scores that cannot be compared —
 * a wrong *ordering*, with no symptom anywhere. `docs/config.md` states that
 * for the adapter and it is why the embeddings answer does not carry over. So
 * the server is told to accept what the product can send.
 *
 * Which makes this two numbers with nothing that knows there are two, and the
 * repair is the check rather than the edit. **Both are discovered**: the
 * ceiling comes out of `config.ts`'s own validator and the limit out of the
 * compose service's own command, so raising the configurable maximum without
 * raising the server's fails here rather than in somebody's search results.
 */

import { readFileSync } from 'node:fs'

const CONFIG = 'packages/core/config.ts'
const COMPOSE = 'docker-compose.yml'
const VARIABLE = 'NACRE_RERANK_CANDIDATES'
const FLAG = '--max-client-batch-size'

let failed = false

/**
 * The most a search can be configured to send, read from the validator rather
 * than from the default: an operator who raises the variable to its documented
 * maximum must not thereby break every search, and `min`/`max` is where this
 * repository says what a variable may be.
 */
const config = readFileSync(CONFIG, 'utf8')
const declared = new RegExp(
  `'${VARIABLE}',\\s*(\\d+),\\s*\\{[^}]*?max:\\s*(\\d+)`,
).exec(config)

if (declared === null) {
  console.error(
    `::error file=${CONFIG}::${VARIABLE} is not read here with a default and a max, so this ` +
      'check cannot tell how many texts a search may send. It is the ceiling every reranker in ' +
      'this repository has to accept — point this at wherever that ceiling is stated now.',
  )
  process.exit(1)
}

const fallback = Number(declared[1])
const ceiling = Number(declared[2])

/**
 * Every service whose command runs a reranker model. Discovered from the
 * command rather than from a service name, so a second reranker — a profile of
 * its own, a differently named one — is covered on the day it is written
 * instead of on the day somebody remembers this file.
 */
const compose = readFileSync(COMPOSE, 'utf8')
// `$(?![\s\S])` and not `\Z`, which JavaScript does not have: `\Z` is the
// letter Z, so the lazy body would have ended at the first capital Z in a
// service definition. It passed because none of them contains one.
const services = [...compose.matchAll(/^ {2}([a-z][\w-]*):\n([\s\S]*?)(?=^ {2}\S|$(?![\s\S]))/gm)]
  .map(([, name, body]) => ({ name, body }))
  .filter(({ body }) => /--model-id[^\n]*rerank|reranker/i.test(body))

if (services.length === 0) {
  console.error(
    `::error file=${COMPOSE}::no service runs a reranker model, so this check compared nothing. ` +
      'It would pass just as well with the reranker deleted from every profile.',
  )
  process.exit(1)
}

for (const { name, body } of services) {
  const flag = new RegExp(`${FLAG}"?,?\\s*"?(\\d+)`).exec(body)
  const limit = flag === null ? undefined : Number(flag[1])

  if (limit === undefined) {
    console.error(
      `::error file=${COMPOSE}::the \`${name}\` service does not pass \`${FLAG}\`, so it takes ` +
        `TEI's default of 32 — while a search sends up to ${String(ceiling)} texts in one call ` +
        `(${VARIABLE}, ${String(fallback)} by default). Every search with more than 32 ` +
        'candidates gets a 413, and reranking fails open, so what a deployment sees is searches ' +
        `that answer and are never reranked. Pass \`${FLAG} ${String(ceiling)}\` or more.`,
    )
    failed = true
    continue
  }

  if (limit < ceiling) {
    console.error(
      `::error file=${COMPOSE}::the \`${name}\` service accepts ${String(limit)} texts per call ` +
        `and a search may send ${String(ceiling)} — the documented maximum of ${VARIABLE}. An ` +
        'operator who raises it to that gets a 413 on every search, and reranking fails open, so ' +
        'the only symptom is results that stop being reranked. Raise the flag, or lower the ' +
        "variable's maximum in " + CONFIG + ' — they are one decision written in two files.',
    )
    failed = true
  }
}

if (!failed) {
  console.log(
    `${String(services.length)} reranker service(s) accept at least ${String(ceiling)} texts per ` +
      `call, which is the most ${VARIABLE} can be set to (${String(fallback)} by default)`,
  )
}
process.exit(failed ? 1 : 0)
