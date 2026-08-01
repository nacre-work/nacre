#!/usr/bin/env node
/**
 * Every service entry point must refuse to start on an incomplete
 * configuration, and say why.
 *
 * The failure this guards against is a process that starts anyway and fails
 * the first request needing the missing value: it looks healthy to an
 * orchestrator, gets traffic, and reports the problem as an error rate. It also
 * catches the duller mistake of pointing the container at a file that exports
 * a library and exits zero without doing anything — which is what
 * docker-compose ran until the entry points existed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ENTRY_POINTS = [
  'packages/api/dist/main.js',
  'packages/mcp/dist/main.js',
  'packages/worker/dist/main.js',
]

let failed = false

for (const entry of ENTRY_POINTS) {
  if (!existsSync(entry)) {
    console.error(`::error::${entry} does not exist; docker-compose runs it`)
    failed = true
    continue
  }

  // A deliberately empty environment. PATH is kept so node can run at all.
  const run = spawnSync(process.execPath, [entry], {
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 30_000,
  })

  if (run.status !== 2) {
    console.error(
      `::error::${entry} exited ${run.status} with no configuration; expected 2. ` +
        'A service that starts without its configuration looks healthy and is not.',
    )
    failed = true
    continue
  }

  if (!/is not set/.test(run.stderr ?? '')) {
    console.error(`::error::${entry} refused to start but did not say which variables are missing`)
    failed = true
    continue
  }

  console.log(`${entry}: refuses an empty environment, exit 2`)
}

process.exit(failed ? 1 : 0)
