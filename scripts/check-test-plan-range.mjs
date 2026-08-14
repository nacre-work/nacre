#!/usr/bin/env node
/**
 * A document describing the authz suite by range does not stop short of it.
 *
 * `packages/core/authz/test-plan.ts` is the inventory, and it grew from fifteen
 * cases to twenty-five when delegated authority and the permission ceiling
 * landed. Four documents went on calling it **T1–T15**: `docs/README.md`, which
 * is the map a reader starts from; `docs/extensions.md` twice, including the
 * section telling a module author which suite to run against their resolver;
 * and `packages/core/authz/README.md`, which sits in the directory. A module
 * author who followed that sentence ran two thirds of the cases and believed
 * they had run the suite — the ten it omits are the delegation and ceiling
 * ones, which are exactly what a commercial resolver can break.
 *
 * `docs/authz.md` was right, because it names both blocks — "T1–T15 run" and
 * "T16–T25 run" — so the property here cannot be "every range reads T1–T25".
 * It is weaker and holds for both: **a file that describes the suite by range
 * mentions the plan's last case somewhere in it.** A split description reaches
 * the end; a stale one stops before it.
 *
 * This is the shape this repository keeps paying for — a property that has to
 * hold in N places with nothing that knows N — so the repair is the check
 * rather than the four edits.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const PLAN = 'packages/core/authz/test-plan.ts'

const plan = readFileSync(join(root, PLAN), 'utf8')
const ids = [...plan.matchAll(/id:\s*'T(\d+)'/g)].map((m) => Number(m[1]))
if (ids.length === 0) {
  process.stderr.write(
    `::error::${PLAN} declares no cases, so this check has nothing to hold documents against. ` +
      'Either the inventory moved or the pattern stopped matching it; a check that cannot check ' +
      'must not pass.\n',
  )
  process.exit(1)
}
const last = Math.max(...ids)

/** Every shipped `.md`, excluding dependencies and build output. */
function docs(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...docs(path))
    else if (entry.endsWith('.md')) out.push(path)
  }
  return out
}

// `T1–T15`, `T1-T15`, `T16 – T25`: an en dash or a hyphen, spaced or not.
const RANGE = /\bT(\d+)\s*[–-]\s*T(\d+)\b/g

const problems = []
let described = 0

for (const file of docs(root)) {
  const where = relative(root, file)
  const text = readFileSync(file, 'utf8')

  const ranges = [...text.matchAll(RANGE)]
  if (ranges.length === 0) continue
  described += 1

  if (!new RegExp(`\\bT${String(last)}\\b`).test(text)) {
    const seen = [...new Set(ranges.map((m) => `T${m[1]}–T${m[2]}`))].join(', ')
    problems.push(
      `${where} describes the authz suite by range (${seen}) and never reaches T${String(last)}, ` +
        `which is the last case in ${PLAN}. A reader following it runs part of the suite and ` +
        'believes they ran it.',
    )
  }
}

if (described === 0) {
  problems.push(
    'no document describes the authz suite by range, so this check asked nothing. Either the ' +
      'references moved or the pattern stopped matching them.',
  )
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} problem(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(described)} document(s) describe the authz suite, every one of them reaching T${String(last)} ` +
    `of ${String(ids.length)} case(s).\n`,
)
