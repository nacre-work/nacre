import { createPool, pendingMigrations } from '../index.js'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Is this database carrying every migration this build ships?
 *
 * The question `/v1/ready` could not ask. It reported that Postgres, Qdrant,
 * Redis and the bucket answer, so a process started against a database the
 * migrator had not reached said "ready" and then failed every request — and
 * under an orchestrator that is worse than an error, because the rollout
 * believes the answer and carries on replacing working pods with broken ones.
 *
 * Against a real database, because the interesting cases are a privilege
 * (`nacre_app` had none on the ledger until migration 0022) and a table that is
 * not there — neither of which a fake has.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the readiness schema check would go untested.')
}
const when = url ? describe : describe.skip

let pool: Pool

when('the schema version, against the database', () => {
  beforeAll(() => {
    pool = createPool({ connectionString: url as string })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('a migrated database is carrying everything this build ships', async () => {
    expect(await pendingMigrations(pool)).toEqual([])
  })

  it('names what is missing when the database is behind', async () => {
    // A directory holding one migration this database has never seen. Faking
    // the *shipped* side rather than deleting a ledger row, because the
    // deletion would have to be put back and a failure between the two leaves
    // the database describing itself wrongly.
    const missing = await pendingMigrations(pool, 'packages/core/__tests__/fixtures/ahead')
    expect(missing).toEqual(['9999_not_applied_anywhere.sql'])
  })

  it('a database ahead of this build is still current', async () => {
    // The middle of a rolling upgrade: the migrator has run for the newer
    // build and the old replica is still serving. Reporting it as behind would
    // take every old pod out of rotation at the moment the schema moved, which
    // is the opposite of what a rollout needs.
    //
    // Modelled by shipping *fewer* migrations than the database has, which is
    // exactly what an old build is.
    const behindTheDatabase = await pendingMigrations(pool, 'packages/core/__tests__/fixtures/behind')
    expect(behindTheDatabase).toEqual([])
  })

  it('throws rather than answering when the ledger cannot be read', async () => {
    // No table, no privilege, no connection all land here, and the caller turns
    // every one of them into "not ready" — the same conclusion by a different
    // route, and the right one.
    await expect(
      pendingMigrations({
        query: async () => {
          throw new Error('permission denied for table schema_migrations')
        },
      }),
    ).rejects.toThrow('permission denied')
  })

  it('reads the ledger as the application role, which had no privilege before 0022', async () => {
    // The check that decides whether this ships at all. `schema_migrations` is
    // created by the migrator and therefore owned by the owning role, and
    // `nacre_app` held nothing on it — so a readiness probe written without
    // migration 0022 would have reported every correctly-split deployment as
    // not ready, which is the superuser-only defect this repository has already
    // found twice, in reverse.
    const client = await pool.connect()
    try {
      await client.query('SET ROLE nacre_app')
      expect(await pendingMigrations(client)).toEqual([])
      // And only SELECT. A process that could write the ledger could tell the
      // next migrator that a migration had already run.
      await expect(
        client.query("INSERT INTO schema_migrations (name, checksum) VALUES ('x','y')"),
      ).rejects.toThrow(/permission denied/)
    } finally {
      await client.query('RESET ROLE').catch(() => undefined)
      client.release()
    }
  })
})
