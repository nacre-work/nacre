#!/usr/bin/env node
/**
 * Every acl test must be reachable by one of the workflow's selectors.
 *
 * The acl-invariants job runs the suite in named groups, one step each, so a
 * leak reads as "T3 failed" rather than as one number among a hundred. The
 * selectors are literal `-t` patterns, which means a test whose describe block
 * matches none of them does not run in that job — and the job goes green,
 * because every step it *did* run passed.
 *
 * `test:acl` runs everything and would catch it, but the two jobs are separate
 * on purpose: acl-invariants is the required check, and this is the failure
 * where a required check protects nothing while reporting that it does.
 *
 * Two files had already fallen through: the coverage test, which asserts every
 * case in docs/authz.md has a test, and the rule 6 test, which guards the one
 * invariant a reader is most likely to mistake for a bug.
 */
import { spawnSync } from 'node:child_process'

import { ACL_GROUPS, UNGROUPED } from './acl-groups.mjs'

const run = spawnSync('pnpm', ['exec', 'vitest', 'list', '--project', 'acl', '--json'], {
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})

if (run.status !== 0) {
  console.error(`::error::could not list the acl tests:\n${run.stderr}`)
  process.exit(1)
}

// vitest prints the JSON array on stdout, sometimes after other output.
const start = run.stdout.indexOf('[')
let tests
try {
  tests = JSON.parse(run.stdout.slice(start))
} catch (cause) {
  console.error(`::error::could not parse the vitest listing: ${cause}`)
  process.exit(1)
}

if (!Array.isArray(tests) || tests.length === 0) {
  // An empty acl project must never be a pass, at any level.
  console.error('::error::vitest listed no acl tests at all')
  process.exit(1)
}

const selectors = [...ACL_GROUPS.map((g) => g.selector), ...UNGROUPED]
const orphans = new Map()

for (const test of tests) {
  const name = String(test.name ?? '')
  if (selectors.some((s) => name.includes(s))) continue

  const file = String(test.file ?? 'unknown').replace(`${process.cwd()}/`, '')
  if (!orphans.has(file)) orphans.set(file, [])
  orphans.get(file).push(name)
}

if (orphans.size > 0) {
  for (const [file, names] of orphans) {
    console.error(
      `::error file=${file}::${names.length} test(s) here match no acl-invariants selector, ` +
        `so they do not run in the required job. First: "${names[0]}". ` +
        'Either rename the describe block to start with an existing group, or add a group ' +
        'to scripts/acl-groups.mjs and a step to .github/workflows/acl-invariants.yml.',
    )
  }
  process.exit(1)
}

console.log(`${tests.length} acl test(s), all reachable by ${selectors.length} selector(s)`)

// And the reverse: a selector that matches nothing is a step that will report
// success having checked nothing, which acl-group.mjs catches at run time. This
// catches it before the job even starts.
const dead = selectors.filter((s) => !tests.some((t) => String(t.name ?? '').includes(s)))
if (dead.length > 0) {
  console.error(`::error::selector(s) matching no test: ${dead.map((s) => `"${s}"`).join(', ')}`)
  process.exit(1)
}
