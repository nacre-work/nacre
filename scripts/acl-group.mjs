#!/usr/bin/env node
/**
 * Run one group of the authz suite and fail if the selector matched nothing.
 *
 * `vitest -t <name>` skips what does not match and exits 0 — so a group whose
 * describe block gets renamed reports success having run zero tests. That is
 * the exact failure this project cares most about: a leak-test step that is
 * green because it checked nothing, and therefore gets believed.
 *
 * Usage: node scripts/acl-group.mjs "baseline"
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const group = process.argv[2]
if (!group) {
  console.error('usage: node scripts/acl-group.mjs <test-name-pattern>')
  process.exit(2)
}

const dir = mkdtempSync(join(tmpdir(), 'nacre-acl-'))
const report = join(dir, 'report.json')

try {
  const run = spawnSync(
    'pnpm',
    ['exec', 'vitest', 'run', '--project', 'acl', '-t', group,
     '--reporter=default', '--reporter=json', `--outputFile=${report}`],
    { stdio: 'inherit' },
  )

  let passed = 0
  let failed = 0
  try {
    const json = JSON.parse(readFileSync(report, 'utf8'))
    passed = json.numPassedTests ?? 0
    failed = json.numFailedTests ?? 0
  } catch (cause) {
    // No parseable report means we cannot tell what ran. Refuse rather than
    // assume — the assumption this code exists to prevent is "probably fine".
    console.error(`\n::error::could not read the vitest report for "${group}": ${cause}`)
    process.exit(1)
  }

  if (failed > 0 || run.status !== 0) {
    console.error(`\n::error::${group}: ${failed} failing test(s)`)
    process.exit(run.status === 0 ? 1 : run.status)
  }

  if (passed === 0) {
    console.error(
      `\n::error::"${group}" matched no tests. Vitest skips what does not match ` +
        'and exits 0, so this step would otherwise have reported success having ' +
        'checked nothing. Either the group was renamed or its tests were removed.',
    )
    process.exit(1)
  }

  console.log(`\n${group}: ${passed} test(s) passed`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
