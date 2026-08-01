import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

export interface Migration {
  readonly name: string
  readonly sql: string
}

/**
 * Migrations in filename order. Numbered prefixes are compared as numbers, so
 * `0010` sorts after `0009` rather than between `0001` and `0002`.
 */
export function loadMigrations(dir: string = MIGRATIONS_DIR): readonly Migration[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (cause) {
    // The built package resolves this to dist/migrations, which tsc does not
    // create — it compiles .ts and ignores .sql. Saying so beats an ENOENT
    // naming a path the caller has no reason to recognise.
    throw new Error(
      `no migrations directory at ${dir}. In a published build this means the ` +
        'SQL was not copied into dist; see packages/core/scripts/copy-migrations.mjs.',
      { cause },
    )
  }

  const migrations = entries.filter((f) => f.endsWith('.sql'))
  if (migrations.length === 0) {
    // Applying nothing and reporting success would leave a fresh database with
    // no tables and a ledger saying everything is up to date.
    throw new Error(`no .sql files in ${dir}; there is nothing to apply and that is not "already migrated"`)
  }

  return migrations
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b))
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }))
}

const LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`

async function checksum(sql: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface MigrateResult {
  readonly applied: readonly string[]
  readonly skipped: readonly string[]
}

/**
 * Apply every migration that has not been applied yet.
 *
 * Two properties worth stating, because both are load-bearing:
 *
 * **Each migration runs inside its own transaction**, together with the ledger
 * row that records it. A migration that fails halfway leaves the database as it
 * was — the alternative is a schema that is neither the old one nor the new one
 * and no record of which, which is the worst state to debug a permissions
 * system in.
 *
 * **Applied migrations are checksummed and re-checked.** Editing a file that
 * has already run is the mistake this catches: it works on the author's fresh
 * database and does nothing on every environment that already applied the old
 * text, so the two silently diverge. Migrations are forward-only; fixing one
 * means adding another.
 */
export async function migrate(
  connectionString: string,
  migrations: readonly Migration[] = loadMigrations(),
): Promise<MigrateResult> {
  const client = new Client({ connectionString })
  await client.connect()

  const applied: string[] = []
  const skipped: string[] = []

  try {
    await client.query(LEDGER)

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations',
    )
    const ledger = new Map(rows.map((r) => [r.name, r.checksum]))

    for (const migration of migrations) {
      const sum = await checksum(migration.sql)
      const recorded = ledger.get(migration.name)

      if (recorded !== undefined) {
        if (recorded !== sum) {
          throw new Error(
            `migration ${migration.name} was modified after it was applied ` +
              '(checksum mismatch). Migrations are forward-only: add a new one ' +
              'rather than editing this file, or the databases that already ran ' +
              'the old text will never receive the change.',
          )
        }
        skipped.push(migration.name)
        continue
      }

      await client.query('BEGIN')
      try {
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          sum,
        ])
        await client.query('COMMIT')
        applied.push(migration.name)
      } catch (cause) {
        await client.query('ROLLBACK')
        throw new Error(`migration ${migration.name} failed and was rolled back`, { cause })
      }
    }
  } finally {
    await client.end()
  }

  return { applied, skipped }
}
