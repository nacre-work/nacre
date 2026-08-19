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
import { existsSync, readdirSync } from 'node:fs'

const ENTRY_POINTS = [
  { path: 'packages/api/dist/main.js' },
  { path: 'packages/mcp/dist/main.js' },
  // The local transport is a published bin, so it is run by people rather than
  // by compose — which makes refusing an incomplete environment more important
  // here, not less. A developer gets the message; an orchestrator gets a
  // restart loop either way.
  { path: 'packages/mcp/dist/stdio-main.js' },
  { path: 'packages/worker/dist/main.js' },
  // Compose runs this to completion before the others start. It is the one that
  // must not be silently skippable: a stack that comes up against an unmigrated
  // database fails on the first query, not at boot.
  { path: 'packages/core/dist/migrate-main.js' },
  // The disaster-recovery command. `docs/upgrading.md` and the infra runbook
  // both hand it to an operator whose Qdrant is already gone, so a build that
  // stopped emitting it has to fail here rather than during the disaster. The
  // args get it past its own usage check to the configuration refusal, which
  // is the property under test.
  { path: 'packages/api/dist/rebuild-collection.js', args: ['--org', 'placeholder'] },
]

let failed = false

for (const { path: entry, args = [] } of ENTRY_POINTS) {
  if (!existsSync(entry)) {
    console.error(`::error::${entry} does not exist; docker-compose runs it`)
    failed = true
    continue
  }

  // A deliberately empty environment. PATH is kept so node can run at all.
  const run = spawnSync(process.execPath, [entry, ...args], {
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

/**
 * The build output has to carry the SQL, not only the code that reads it.
 *
 * `migrate()` is exported from `@nacre.work/core` and resolves its directory
 * relative to its own module URL, so in a build it looks in `dist/migrations/`.
 * `tsc` compiles TypeScript and copies nothing else, which made that export
 * throw ENOENT on its first call for anyone consuming the package rather than
 * the repository — and everything in this repository runs from source, so
 * nothing here would ever notice.
 */
const sqlIn = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.sql')) : [])

const source = sqlIn('packages/core/migrations')
const built = sqlIn('packages/core/dist/migrations')
const missing = source.filter((f) => !built.includes(f))

if (source.length === 0) {
  console.error('::error::no migrations under packages/core/migrations')
  failed = true
} else if (missing.length > 0) {
  console.error(
    `::error::packages/core/dist/migrations is missing ${missing.length} of ${source.length} ` +
      `migration(s): ${missing.join(', ')}. migrate() reads dist, and a published package ` +
      'without them exports a function that cannot run.',
  )
  failed = true
} else {
  console.log(`packages/core/dist/migrations: ${built.length} migration(s), all present`)
}

process.exit(failed ? 1 : 0)
