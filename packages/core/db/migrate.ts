import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Client } from 'pg'

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url))

/**
 * How long a migration may wait for a lock before giving up. See the call site.
 *
 * A migration that needs longer can say so: `SET LOCAL lock_timeout` inside the
 * file overrides this for the rest of that transaction, and it is the right
 * place for the exception because the migration is what knows it is unusual.
 *
 * `statement_timeout` is deliberately not touched. Some managed platforms set
 * one globally and a long index build will hit it — but that is the operator's
 * configuration, the failure rolls back cleanly, and quietly overriding a bound
 * somebody chose is worse than failing where they can see it.
 */
const LOCK_TIMEOUT = '10s'

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
 * Just enough of `Client` to ask what the connected role may do — so the check
 * below can be exercised without a database for its branches, having been
 * verified against a real one for its premise.
 */
export interface RoleReader {
  query<T>(sql: string): Promise<{ rows: T[] }>
}

/**
 * Refuse, before applying anything, if the connected role cannot finish.
 *
 * Every tenant table has `FORCE ROW LEVEL SECURITY`, and `FORCE` is what makes
 * the policy apply to the table's **owner** as well. Migrations run as the
 * owner and several of them read a tenant table — 0006 checks for duplicate
 * layer slugs, 0007 backfills a lease column, 0017 rewrites a role, 0018
 * dedupes group members. Each of those evaluates
 * `current_setting('app.current_org')`, which is unset during a migration, so
 * the statement fails with:
 *
 *     ERROR: unrecognized configuration parameter "app.current_org"
 *
 * That message names nothing an operator can act on. It says nothing about
 * roles, nothing about row-level security, and it arrives at migration 0006
 * rather than at the start — five migrations of schema already applied.
 *
 * It has never been seen because development connects as a superuser, and a
 * superuser bypasses row-level security entirely. It appears the moment an
 * operator follows `docs/config.md` and stops doing that, which is the same
 * shape as the two subsystems already found this way.
 *
 * So the requirement is stated once, up front, with the SQL that satisfies it.
 * The `WITH ADMIN OPTION` line is in the message even though it is not what is
 * being checked: migration 0008 runs `GRANT nacre_worker TO nacre_app` and
 * plain membership is not enough to grant a role onward. That migration's own
 * hint says to grant membership, which does not fix it — and 0008 has been
 * applied everywhere, so its text is checksummed and cannot be corrected in
 * place. Naming the whole block here is what stops an operator satisfying one
 * requirement and meeting the next one on the following run.
 *
 * Only called when there is something to apply, so re-running `migrate` on an
 * up-to-date database stays a no-op whatever role it connects as.
 */
export async function requireMigrationPrivileges(client: RoleReader): Promise<void> {
  const { rows } = await client.query<{ superuser: boolean; bypassrls: boolean }>(
    'SELECT rolsuper AS superuser, rolbypassrls AS bypassrls FROM pg_roles WHERE rolname = current_user',
  )

  const role = rows[0]
  if (role === undefined || role.superuser || role.bypassrls) return

  throw new Error(
    'the role running migrations can neither bypass row-level security nor is a ' +
      'superuser, and several migrations read tenant tables. Every one of those ' +
      'tables has FORCE ROW LEVEL SECURITY, which applies the policy to the owner ' +
      'too, and the policy reads app.current_org — unset during a migration. The ' +
      'migration would fail partway through with "unrecognized configuration ' +
      'parameter \\"app.current_org\\"", which names none of this.\n\n' +
      'Run this once as a superuser:\n\n' +
      '  ALTER ROLE <the role in NACRE_PG_URL> BYPASSRLS;\n' +
      '  CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;  -- if it does not exist\n' +
      '  GRANT nacre_worker TO <the role in NACRE_PG_URL> WITH ADMIN OPTION;\n\n' +
      'WITH ADMIN OPTION is required and plain membership is not: migration 0008 ' +
      'grants nacre_worker onward to nacre_app, and only a member holding ADMIN ' +
      'may do that.\n\n' +
      'This role is the one that owns the tables and runs migrations. It is not ' +
      'the role the application connects as — that one must not bypass row-level ' +
      'security and must not be able to create tables.',
  )
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

    // Only when there is work to do. A re-run against an up-to-date database
    // applies nothing, so the privileges it would need are not needed.
    if (migrations.some((m) => !ledger.has(m.name))) {
      await requireMigrationPrivileges(client)
    }

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
        // Bounded waiting, set inside the transaction so it reverts on its own.
        //
        // `ALTER TABLE` takes ACCESS EXCLUSIVE, which conflicts with everything
        // including a plain SELECT. With no timeout the sequence on a busy
        // database is: the ALTER waits behind one long-running query, and every
        // statement arriving afterwards queues behind the ALTER — because a
        // lock request is not overtaken by weaker ones. One slow reporting
        // query therefore stops the entire application for as long as it runs,
        // and the migration that appeared to be "just adding a column" is what
        // the outage gets blamed on.
        //
        // `lock_timeout`, not `statement_timeout`: the two failures are not
        // alike. Waiting for a lock is a scheduling problem and retrying in a
        // quieter minute fixes it, so failing fast is free. Doing the work is
        // not — a backfill or an index build on a large table legitimately
        // takes longer than any bound worth setting, and killing it halfway
        // achieves nothing except a rollback. So the wait is capped and the
        // work is not.
        //
        // Ten seconds because it is far longer than any lock this schema takes
        // when the queue is empty, and far shorter than a deploy timeout — the
        // migration fails with `55P03 lock_not_available`, which names the
        // problem, instead of hanging until someone kills it and has to guess.
        await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`)
        await client.query(migration.sql)
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          migration.name,
          sum,
        ])
        await client.query('COMMIT')
        applied.push(migration.name)
      } catch (cause) {
        await client.query('ROLLBACK')

        // 55P03 is `lock_not_available`, and it is worth naming: it is the one
        // failure here that says nothing about the migration. The SQL is fine,
        // something else was holding the table, and the fix is to look at
        // pg_stat_activity rather than at the file.
        if ((cause as { code?: string }).code === '55P03') {
          throw new Error(
            `migration ${migration.name} gave up waiting for a lock after ${LOCK_TIMEOUT} ` +
              'and was rolled back. Something else is holding the table — a long query, an ' +
              'idle-in-transaction session, another migration — so this is not a problem with ' +
              'the migration itself and re-running it once the holder is gone will work. ' +
              'The wait is capped deliberately: an ALTER queued behind one slow query blocks ' +
              'every statement that arrives after it, which takes the application down.',
            { cause },
          )
        }

        throw new Error(`migration ${migration.name} failed and was rolled back`, { cause })
      }
    }
  } finally {
    await client.end()
  }

  return { applied, skipped }
}

/**
 * Whatever can run one query, which is a `Pool`, a `PoolClient` or a test's
 * double. Deliberately not the `pg` types: this is the readiness path, and
 * nothing about it needs a connection of its own.
 */
export interface LedgerReader {
  query(text: string): Promise<{ rows: { name: string }[] }>
}

/**
 * Does this database carry every migration this build ships?
 *
 * `/v1/ready` used to report that Postgres, Qdrant, Redis and the bucket
 * answer, and say nothing about whether the schema matches the code. A process
 * started against a database the migrator has not reached reports ready and
 * then fails every request — and under an orchestrator that is worse than an
 * error, because the rollout believes the answer and carries on replacing
 * working pods with broken ones.
 *
 * **A database that is ahead is current.** Extra rows mean the migrator has run
 * for a newer build, which is exactly the middle of a rolling upgrade: the old
 * pod is still serving and must stay ready, or a normal upgrade would take
 * every old replica out of rotation at the moment the schema moved. Only what
 * this build ships and the database lacks makes it behind.
 *
 * Returns the missing names rather than a boolean, because a readiness body
 * that says "false" and a log line that says which migration is missing are two
 * different jobs and only one of them is the operator's answer.
 *
 * Throws where the ledger cannot be read at all — no table, no privilege, no
 * connection. The caller turns that into "not ready", which is the same
 * conclusion by a different route and the right one: a database whose ledger is
 * unreadable is not one this process should be serving against.
 */
export async function pendingMigrations(
  client: LedgerReader,
  dir: string = MIGRATIONS_DIR,
): Promise<readonly string[]> {
  const shipped = loadMigrations(dir).map((m) => m.name)
  const { rows } = await client.query('SELECT name FROM schema_migrations')
  const applied = new Set(rows.map((r) => r.name))
  return shipped.filter((name) => !applied.has(name))
}
