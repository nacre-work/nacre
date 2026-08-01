import { migrate } from './db/migrate.js'

/**
 * The migration entry point, for the container.
 *
 * `pnpm migrate` runs `scripts/migrate.ts` through tsx, which is a development
 * dependency and is not in the runtime image — so a deployment had no way to
 * apply the schema at all. Compose started the API against an empty database,
 * every request failed on a missing table, and the first thing a self-hoster
 * saw was `relation "organizations" does not exist`.
 *
 * A separate process rather than a step inside the API: several API replicas
 * starting at once would each try to migrate, and the one that loses the race
 * reports a failure that is not one. Compose runs this to completion first.
 */

async function main(): Promise<void> {
  const url = process.env.NACRE_PG_URL
  if (url === undefined || url.length === 0) {
    // Exit 2, like every other entry point refusing an incomplete environment.
    console.error('NACRE_PG_URL is not set. Configuration is validated at startup and this is startup.')
    process.exit(2)
  }

  const { applied, skipped } = await migrate(url)

  console.log(
    JSON.stringify({
      msg: 'migrations complete',
      applied: applied.length,
      skipped: skipped.length,
      names: applied,
    }),
  )
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'migration failed', error: String(error) }))
  process.exit(1)
})
