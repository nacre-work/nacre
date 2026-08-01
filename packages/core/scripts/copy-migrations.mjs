#!/usr/bin/env node
/**
 * Copy the SQL into the build output.
 *
 * `migrate()` resolves `../migrations/` relative to its own module URL, which
 * is `dist/migrations/` once compiled — and `tsc` copies `.ts`, not `.sql`. So
 * the published package exported a migrate function that threw ENOENT on the
 * first call, in a package whose `files` list said `dist` and meant it.
 *
 * Nothing caught it because every caller in this repository runs from source:
 * `pnpm migrate` goes through tsx, and the tests import the TypeScript. The
 * only consumer that would have hit it is a self-hoster, which for a
 * self-hosted product is the consumer that matters.
 */
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const from = fileURLToPath(new URL('../migrations/', import.meta.url))
const to = fileURLToPath(new URL('../dist/migrations/', import.meta.url))

const files = readdirSync(from).filter((f) => f.endsWith('.sql'))
if (files.length === 0) {
  console.error('no .sql files under packages/core/migrations; migrate() would apply nothing')
  process.exit(1)
}

mkdirSync(to, { recursive: true })
for (const file of files) copyFileSync(join(from, file), join(to, file))

console.log(`copied ${files.length} migration(s) into dist/migrations`)
