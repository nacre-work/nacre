#!/usr/bin/env node
/**
 * `documents.error` never reaches a caller unredacted.
 *
 * ## What is in that column
 *
 * Whatever went wrong, verbatim, written by the worker for an operator reading
 * a log: the embedding endpoint's URL, the parser's, and whatever a sidecar put
 * in its message. Infrastructure names, on an internal network, written by
 * somebody who was not thinking about who reads them.
 *
 * ## Who reads it
 *
 * `GET /v1/documents/{id}` and the MCP tool `get_document` both resolve `read`,
 * and a delegation with a read ceiling reaches both — so the caller can be a
 * third party an operator connected, which is the caller
 * `classifyIngestFailure` was written for in the first place.
 *
 * ## The defect this exists against
 *
 * The redaction went in on `/v1/jobs` and `ingest_status` and **not** on the
 * document path, which had been handing the same class of caller the raw string
 * for as long as it had read it back. Two surfaces answering about one failure,
 * one of them careful — the most repeated defect in this repository, and the
 * rule is that finding one instance is not a licence to repair it. So: every
 * read of that column goes through `withoutHosts` or `classifyIngestFailure`,
 * and this is what asks all of them.
 *
 * ## What it cannot see
 *
 * It reads the projection where the column is selected and named, so it catches
 * the shape the two known surfaces have. A handler that selected the column
 * into a differently-named alias and returned that would be outside it. That is
 * stated rather than hidden — the check is a floor, and the reason it is worth
 * having is that the next surface will be written by copying one of these two.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const files = [
  ...sources(join(root, 'packages/api/src')),
  ...sources(join(root, 'packages/mcp/src')),
]

// A line that puts the stored column into something a caller receives. The
// column arrives as `row.error` off a `SELECT … d.error`, so that is the shape
// worth naming; `error:` on the left is the response field being built.
const RETURNS_IT = /(^|[^.\w])error\s*:\s*[^,;]*\brow\.error\b/
const REDACTED = /withoutHosts\s*\(|classifyIngestFailure\s*\(/

const problems = []
let guarded = 0

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!RETURNS_IT.test(line)) return
    if (REDACTED.test(line)) {
      guarded += 1
      return
    }
    problems.push(
      `${relative(root, file)}:${String(index + 1)} returns \`documents.error\` to a caller ` +
        'without passing it through `withoutHosts` or `classifyIngestFailure`. That column holds ' +
        "the worker's verbatim failure — the embedding endpoint's URL, the parser's, whatever a " +
        'sidecar wrote — and this projection is reachable by a delegated third party holding ' +
        '`read`. Redact it, or select it under another name and say here why that one is safe.',
    )
  })
}

if (guarded === 0 && problems.length === 0) {
  console.error(
    '::error::found no surface returning `documents.error` at all. This check exists to hold ' +
      'them; with none to read it must not report green — either the column stopped being ' +
      'exposed, in which case delete this, or the shape it matches on moved.',
  )
  process.exit(1)
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} unredacted return(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(guarded)} surface(s) return \`documents.error\`, every one of them redacted.\n`,
)
