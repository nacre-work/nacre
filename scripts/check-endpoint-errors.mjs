#!/usr/bin/env node
/**
 * A model endpoint that refuses is reported by one function, not by three.
 *
 * Three call sites reach an endpoint an operator configured — the worker's
 * ingest embedder, the search path's query embedder, and the reranker — and
 * each threw `answered ${response.status}` and nothing else. For most statuses
 * that is enough. For **401 and 403 it is the wrong end of the problem**: none
 * of the three sends an `Authorization` header and there is nowhere to put one,
 * because `embedding_providers` deliberately has no column for a credential. So
 * an endpoint pointed straight at a hosted vendor cannot work however correct
 * the URL is, and the operator gets a bare `401`.
 *
 * That was found by somebody reading the documentation, failing to work out how
 * to use a hosted API, and asking. The paragraph they were reading said
 * "anything already speaking OpenAI's contract works by pointing
 * `embedding_providers.endpoint` straight at it" — true only of endpoints that
 * want no credential, with OpenAI itself named in the table above it.
 *
 * The message is fixed in `modelEndpointRefused`. This is the part that keeps
 * it fixed: the same property in three places with nothing that knows three is
 * how it drifts back, and the fourth call site is the one nobody reviews as
 * carefully. Same shape as `check-admin-gate.mjs`, which refuses the raw
 * comparison it replaced so the tenth handler cannot be written the old way.
 *
 * **`endpointUrl` is what marks a file as calling one.** It exists to resolve a
 * route under an operator-supplied base, so importing it *is* the statement
 * "this module calls a model server somebody configured" — a better signal than
 * a list of filenames, which would have to be kept in step by hand and is the
 * thing being replaced.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'packages'

function sources(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    if (statSync(path).isDirectory()) found.push(...sources(path))
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) found.push(path)
  }
  return found
}

/** Files that call an operator-configured model endpoint. */
const callers = sources(ROOT).filter((path) => {
  const text = readFileSync(path, 'utf8')
  // The definition and its own re-export are not call sites.
  if (path.endsWith('core/endpoint.ts') || path.endsWith('core/index.ts')) return false
  return /\bendpointUrl\s*\(/.test(text)
})

if (callers.length === 0) {
  console.error(`::error::no file under ${ROOT}/ calls endpointUrl; this check compared nothing`)
  process.exit(1)
}

let failed = false

for (const path of callers) {
  const text = readFileSync(path, 'utf8')

  // A status interpolated into a thrown message, anywhere in a file that calls
  // a model endpoint. `modelEndpointRefused` is the only thing that should be
  // turning one into words here.
  const raw = [...text.matchAll(/throw new Error\([^\n]*answered \$\{[^}]*status[^}]*\}/g)]
  for (const match of raw) {
    const line = text.slice(0, match.index).split('\n').length
    console.error(
      `::error file=${path},line=${String(line)}::${path}:${String(line)} builds its own message ` +
        'for a model endpoint that refused. Use modelEndpointRefused from @nacre.work/core — a ' +
        'bare status is the wrong answer on 401 and 403, where the cause is that this client ' +
        'sends no credential and has nowhere to hold one, and the operator needs to be told so.',
    )
    failed = true
  }

  if (!/\bmodelEndpointRefused\b/.test(text)) {
    console.error(
      `::error file=${path}::${path} calls endpointUrl and never modelEndpointRefused. Either it ` +
        'does not check the response status — which is its own defect — or it reports the ' +
        'refusal some other way. Route it through the shared helper, or move the endpointUrl ' +
        'call out if this module does not actually talk to a model server.',
    )
    failed = true
  }
}

if (!failed) {
  console.log(
    `${callers.length} model-endpoint caller(s), all reporting a refusal through ` +
      'modelEndpointRefused: ' +
      callers.join(', '),
  )
}
process.exit(failed ? 1 : 0)
