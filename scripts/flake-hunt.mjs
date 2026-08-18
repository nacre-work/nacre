#!/usr/bin/env node
/**
 * Run the suite until something falls over, and say what.
 *
 * **This exists because a flake failed the 0.19.0 release**, and no static rule
 * would have found it. `second-factor-live.test.ts` read the wall clock three
 * times across one case with a thirty-second window and a two-second body, so
 * it failed about one run in fifteen — green on the pull request, red on the
 * merge that *was* the release. Nothing published, nothing tagged.
 *
 * `check-test-clock.mjs` closes that particular mechanism. This closes the
 * class, and the difference matters: a lint can only refuse the shapes somebody
 * predicted, and the next flake will be a tie in a fused score, a row order
 * nobody pinned, or two connections racing for a lock. The only thing that
 * knows about all of those is the runner, run more than once.
 *
 * ## Why this is not on every pull request
 *
 * Ten passes of the unit suite is ten times the wall clock and ten times the
 * database, for a signal that is about the suite rather than about the change
 * in front of it. A flake is a property of `main`, so it is looked for on
 * `main`'s clock — nightly, where a find is a red scheduled run somebody reads
 * in the morning instead of a red release nobody can undo.
 *
 * ## What counts as a find
 *
 * A case that fails **sometimes**. One that fails every time is a broken test
 * and the ordinary suite already says so; one that never fails is the point.
 * So the report is per case with a count, and the exit code is about whether
 * any run disagreed with any other.
 */
import { spawnSync } from 'node:child_process'

const flag = process.argv.indexOf('--runs')
const runs = flag === -1 ? 10 : Number(process.argv[flag + 1])
if (!Number.isInteger(runs) || runs < 2) {
  console.error('::error::--runs takes an integer of at least 2; one pass cannot disagree with itself.')
  process.exit(1)
}

if (process.env.NACRE_PG_URL === undefined || process.env.NACRE_PG_URL === '') {
  // The live cases skip themselves without it, and a hunt over a suite whose
  // database-backed half did not run is a hunt that reports green having
  // looked at the deterministic part.
  console.error('::error::NACRE_PG_URL is not set. The live cases would skip, and those are where the flakes have been.')
  process.exit(1)
}

/** `× a case name 12ms` — vitest's own line for a failure. */
const FAILED = /^\s*×\s+(.*?)(?:\s+\d+ms)?\s*$/

const seen = new Map()
let broken = 0

for (let run = 1; run <= runs; run += 1) {
  const result = spawnSync('npx', ['vitest', 'run', '--project', 'unit'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const failures = output
    .split('\n')
    .map((line) => FAILED.exec(line))
    .filter((m) => m !== null)
    .map((m) => m[1].trim())

  if (result.status !== 0 && failures.length === 0) {
    // A run that died without naming a case — a crashed worker, a database that
    // went away. Counted rather than swallowed, because "the suite could not
    // run" is a different answer from "the suite passed".
    broken += 1
  }
  for (const name of new Set(failures)) seen.set(name, (seen.get(name) ?? 0) + 1)
  process.stdout.write(`run ${String(run)}/${String(runs)}: ${failures.length === 0 ? 'clean' : failures.join(' | ')}\n`)
}

if (broken > 0) {
  console.error(`::error::${String(broken)} of ${String(runs)} run(s) failed without naming a case.`)
}

if (seen.size === 0 && broken === 0) {
  console.log(`\n${String(runs)} passes, no case failed in any of them.`)
  process.exit(0)
}

console.error('')
for (const [name, count] of [...seen].sort((a, b) => b[1] - a[1])) {
  const how = count === runs ? 'every run — broken rather than flaky' : `${String(count)} of ${String(runs)} runs`
  console.error(`::error::${name} — failed ${how}`)
}
console.error(
  '\nA case that fails sometimes is a case whose claim depends on something it does not control: ' +
    'a clock read twice, a tie broken by whatever order a database happened to build, two ' +
    'connections racing. Pin the input rather than retrying the test.',
)
process.exit(1)
