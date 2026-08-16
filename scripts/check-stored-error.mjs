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

/**
 * Two questions, because one of them was too easy to walk around.
 *
 * The first version matched a *line* carrying both `error:` and `row.error`,
 * which held the one line this repository had and missed three spellings of
 * the same thing: a formatter wrapping the pair onto two lines, any variable
 * not called `row`, and `{ ...row }` handing the column over without naming it
 * at all. It also read comments, so `error: row.error // withoutHosts is
 * applied upstream` counted as guarded.
 *
 * So comments are stripped first, the statement question accepts any
 * identifier and spans lines — and a second, coarser question stands behind
 * it: **a file that selects this column at all has to mention the redactor.**
 * That one cannot be spelled around, because the SQL is the thing that cannot
 * be renamed.
 */
const SELECTS_IT = /\bSELECT\b[\s\S]{0,400}?\berror\b[\s\S]{0,200}?\bFROM\s+documents\b/i
// `<anything>.error` in a value position, across lines, whatever the variable
// is called — plus the spread, which hands the column over without naming it.
const RETURNS_IT = /(^|[^.\w])error\s*:[\s\S]{0,120}?\b[A-Za-z_$][\w$]*\.error\b|\.\.\.\s*row\b/
const REDACTED = /withoutHosts\s*\(|classifyIngestFailure\s*\(/

/** Comments are prose. A sentence about redaction is not redaction. */
const withoutComments = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (b) => ' '.repeat(b.length))

const problems = []
let guarded = 0

for (const file of files) {
  const source = withoutComments(readFileSync(file, 'utf8'))
  if (!SELECTS_IT.test(source)) continue

  // The file reads the column. It has to name the redactor somewhere.
  if (!REDACTED.test(source)) {
    problems.push(
      `${relative(root, file)} selects \`documents.error\` and never calls \`withoutHosts\` or ` +
        '`classifyIngestFailure`. That column holds the worker\'s verbatim failure — the ' +
        "embedding endpoint's URL, the parser's, whatever a sidecar wrote — and every surface " +
        'that reads it is reachable by a delegated third party holding `read`.',
    )
    continue
  }

  // And each place it is handed to a caller has to be one of them.
  const lines = source.split('\n')
  lines.forEach((line, index) => {
    const window = lines.slice(index, index + 3).join('\n')
    if (!RETURNS_IT.test(window)) return
    if (REDACTED.test(window)) {
      guarded += 1
      return
    }
    problems.push(
      `${relative(root, file)}:${String(index + 1)} returns \`documents.error\` to a caller ` +
        'without passing it through `withoutHosts` or `classifyIngestFailure`. Redact it, or ' +
        'select it under another name and say here why that one is safe.',
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
