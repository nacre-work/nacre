#!/usr/bin/env node
/**
 * Every embedding request is bounded.
 *
 * An embedding endpoint does not split a batch for you — it refuses one that is
 * too large. Text Embeddings Inference, which every Compose profile here
 * starts, answers **413** above `--max-client-batch-size`, and that defaults to
 * 32. Both clients used to send a document's whole chunk list as one `input`
 * array with no bound of their own, so at 800 characters a chunk anything past
 * roughly 22 KB of text failed — permanently, because nothing retries a
 * document in `failed`.
 *
 * It was found on a running stand with twenty-six failures out of fifty, and
 * the reason it went unnoticed is worth the check on its own: the layer
 * answered searches perfectly well out of the twenty-four that had indexed. The
 * only signal was a count beside a larger count in the admin UI.
 *
 * **Two clients, with nothing making them agree** — the API's `HttpEmbedder`
 * and the worker's own inline copy — which is the shape this repository keeps
 * paying for. So the repair is not two edits: it is one helper and this, which
 * asks the question of every file rather than of the two that were wrong.
 *
 * The property: a file that posts to the `embeddings` route goes through
 * `embedInBatches`. `endpoint.ts` is where the helper lives and is exempt by
 * being the definition.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []

/** Where the helper is defined, and therefore the one file that may not call it. */
const DEFINITION = 'packages/core/endpoint.ts'

/** Every shipped `.ts` under `packages/`, excluding tests and build output. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (/^__.*__$/.test(entry) || entry === 'node_modules' || entry === 'dist') continue
      out.push(...sources(path))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
      out.push(path)
    }
  }
  return out
}

/**
 * Comments removed, quote-aware.
 *
 * This file's own subject is discussed at length in prose that names both the
 * route and the helper, and a check satisfied by a comment about the rule
 * rather than the rule is the failure mode `check-platform-admin-target.mjs`
 * already met here once.
 */
function code(text) {
  let out = ''
  let quote
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quote !== undefined) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i += 1
      } else if (c === quote) quote = undefined
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)
      i = end === -1 ? text.length : end - 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }
    out += c
  }
  return out
}

let checked = 0
for (const file of sources(join(root, 'packages'))) {
  const where = relative(root, file)
  if (where === DEFINITION) continue

  const text = code(readFileSync(file, 'utf8'))
  // The route, as it is written at every call site: `endpointUrl(base, 'embeddings')`.
  if (!/endpointUrl\([^)]*['"]embeddings['"]/.test(text)) continue
  checked += 1

  if (!/embedInBatches\s*\(/.test(text)) {
    problems.push(
      `${where} posts to the embeddings route and does not call embedInBatches. An endpoint ` +
        'refuses a batch above its own limit rather than splitting it — TEI answers 413 above 32 ' +
        'by default — and the worker marks such a document `failed`, which nothing retries.',
    )
  }
}

if (checked === 0) {
  problems.push(
    'no file was found posting to the embeddings route, so this check asked nothing. Either the ' +
      'call sites moved or the pattern stopped matching them; a check that cannot check must ' +
      'not pass.',
  )
}

// And the helper still exists to be called.
const definition = readFileSync(join(root, DEFINITION), 'utf8')
if (!/export async function embedInBatches\b/.test(definition)) {
  problems.push(`${DEFINITION} no longer exports embedInBatches, which every call site above needs.`)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} problem(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(checked)} embedding client(s), every one of them bounding what it sends.\n`,
)
