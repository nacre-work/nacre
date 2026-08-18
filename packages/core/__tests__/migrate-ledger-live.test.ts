import { randomBytes } from 'node:crypto'

import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migrate } from '../db/migrate.js'
import type { Migration } from '../db/migrate.js'

/**
 * The runner against a ledger that is not the core's, on a real PostgreSQL.
 *
 * `migrate-privileges.test.ts` beside this holds the decision about roles and
 * needs no database. What is left is everything the database decides, and none
 * of it is exercised by a mock:
 *
 *   * that a second ledger is a second history — a name applied under one is
 *     not skipped under the other, which is the whole reason the option exists;
 *   * that a ledger created by an older runner, with a **nullable** checksum
 *     column and rows carrying NULL, is backfilled rather than refused;
 *   * that a modified file is still a mismatch once the backfill has run, or
 *     the tolerance would have swallowed the check it is standing next to;
 *   * that `requirePrivileges: false` actually reaches the connection, since
 *     the premise is a role that would be refused with it on.
 *
 * The nullable-checksum case is the one worth keeping. It is not hypothetical:
 * `@nacre.work/enterprise-tenancy` shipped its own runner whose ledger had
 * `checksum text` with no NOT NULL, and every database that ran it before the
 * digest was added carries rows with NULL. A generic runner that read those as
 * a mismatch would refuse every installation older than the check, on the
 * commit that was meant to remove a duplicated file.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the ledger option would go untested.')
}

const when = url ? describe : describe.skip

/** A suffix per run, so a failed run does not poison the next one. */
const suffix = randomBytes(4).toString('hex')
const LEDGER = `t_ledger_${suffix}`
const OLD = `t_old_${suffix}`
const TARGET = `t_target_${suffix}`

/**
 * Migrations that touch one table of this suite's own, so nothing here depends
 * on the core's schema being present or absent.
 */
const first: Migration = {
  name: '0001_first.sql',
  sql: `CREATE TABLE IF NOT EXISTS ${TARGET} (id int PRIMARY KEY)`,
}
const second: Migration = {
  name: '0002_second.sql',
  sql: `ALTER TABLE ${TARGET} ADD COLUMN IF NOT EXISTS note text`,
}

let client: Client

async function ledgerRows(table: string): Promise<{ name: string; checksum: string | null }[]> {
  const { rows } = await client.query<{ name: string; checksum: string | null }>(
    `SELECT name, checksum FROM ${table} ORDER BY name`,
  )
  return rows
}

beforeAll(async () => {
  if (!url) return
  client = new Client({ connectionString: url })
  await client.connect()
})

afterAll(async () => {
  if (!url) return
  for (const table of [LEDGER, OLD, TARGET]) {
    await client.query(`DROP TABLE IF EXISTS ${table}`)
  }
  // The core's ledger should never carry these names — the second case asserts
  // exactly that. It is cleaned anyway, because the run that *proves* the case
  // can fail is a run where the product is broken and did write them, and a
  // shared database left carrying two invented migration names is a later
  // failure somebody else has to diagnose. Writing this cost one such
  // diagnosis: a green suite came back red on rows a defect-restoration run of
  // mine had left behind.
  await client.query(`DELETE FROM schema_migrations WHERE name = ANY($1::text[])`, [
    [first.name, second.name],
  ])
  await client.end()
})

when('the migration ledger is a parameter', () => {
  it('refuses a name it would have to interpolate unchecked', async () => {
    await expect(
      migrate(url as string, [first], { ledgerTable: 'x"; DROP TABLE users; --' }),
    ).rejects.toThrow(/not a usable ledger table name/)
    // Before the connection, so a bad name costs nothing and cannot half-apply.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_name = $1`,
      [TARGET],
    )
    expect(rows[0]?.n).toBe('0')
  })

  it('records in the ledger it was given and not in the core’s', async () => {
    const result = await migrate(url as string, [first], {
      ledgerTable: LEDGER,
      requirePrivileges: false,
    })
    expect(result.applied).toEqual(['0001_first.sql'])

    expect((await ledgerRows(LEDGER)).map((r) => r.name)).toEqual(['0001_first.sql'])

    // The core's own ledger is untouched by a module's migration. If this ever
    // fails, a deployment's `schema_migrations` is describing a schema the core
    // did not ship, and `/v1/ready` reads that table.
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations WHERE name = $1`,
      [first.name],
    )
    expect(rows[0]?.n).toBe('0')
  })

  it('skips what that ledger already has, and applies what it does not', async () => {
    const result = await migrate(url as string, [first, second], {
      ledgerTable: LEDGER,
      requirePrivileges: false,
    })
    expect(result.skipped).toEqual(['0001_first.sql'])
    expect(result.applied).toEqual(['0002_second.sql'])
  })

  it('still refuses a file edited after it was applied', async () => {
    const edited: Migration = { name: first.name, sql: `${first.sql} -- reworded` }
    await expect(
      migrate(url as string, [edited], { ledgerTable: LEDGER, requirePrivileges: false }),
    ).rejects.toThrow(/modified after it was applied/)
  })
})

when('a ledger from an older runner', () => {
  /**
   * Exactly the shape `enterprise-tenancy` created: nullable checksum, and a
   * row recorded before the digest existed.
   */
  beforeAll(async () => {
    if (!url) return
    // `checksum text`, nullable — the column `enterprise-tenancy`'s runner
    // creates, rather than none at all. That distinction cost this file a
    // failure of its own: the first version created the table without the
    // column and then read it, which is the harness failing in the shape the
    // product does.
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${OLD} (
         name text PRIMARY KEY,
         checksum text,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    )
    await client.query(`INSERT INTO ${OLD} (name) VALUES ($1)`, [first.name])
  })

  it('is backfilled rather than refused', async () => {
    const before = await ledgerRows(OLD)
    expect(before).toEqual([{ name: first.name, checksum: null }])

    const result = await migrate(url as string, [first, second], {
      ledgerTable: OLD,
      requirePrivileges: false,
    })
    // Skipped, not re-applied: the file already ran, and re-running
    // `CREATE TABLE IF NOT EXISTS` would be harmless here and is not the point.
    expect(result.skipped).toContain(first.name)

    const after = await ledgerRows(OLD)
    expect(after.find((r) => r.name === first.name)?.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('verifies the backfilled digest on the next run', async () => {
    // The row now carries a checksum, so the guard applies to it — which is the
    // half that would be missing if the backfill simply skipped forever.
    const edited: Migration = { name: first.name, sql: `${first.sql} -- reworded` }
    await expect(
      migrate(url as string, [edited], { ledgerTable: OLD, requirePrivileges: false }),
    ).rejects.toThrow(/modified after it was applied/)
  })
})
