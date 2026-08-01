/**
 * CLI entry point for migrations: `pnpm migrate`.
 *
 * Lives in scripts/ rather than in the package so the published library does
 * not carry a process-exiting entry point.
 */
import { migrate } from '../packages/core/db/migrate.js'

const url = process.env.NACRE_PG_URL
if (!url) {
  console.error('NACRE_PG_URL is not set. Configuration is validated at startup and this is startup.')
  process.exit(2)
}

const { applied, skipped } = await migrate(url)

if (applied.length === 0) {
  console.log(`nothing to apply; ${skipped.length} migration(s) already recorded`)
} else {
  for (const name of applied) console.log(`applied ${name}`)
  console.log(`\n${applied.length} applied, ${skipped.length} already recorded`)
}
