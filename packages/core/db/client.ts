import { Pool, type PoolClient } from 'pg'

export interface DbOptions {
  readonly connectionString: string
  readonly max?: number
}

export function createPool(options: DbOptions): Pool {
  return new Pool({ connectionString: options.connectionString, max: options.max ?? 20 })
}

/**
 * Run `fn` on a connection scoped to one organization.
 *
 * `app.current_org` is what every row-level security policy reads. It is set
 * with `set_config(..., true)` — local to the transaction — so it cannot leak
 * to the next borrower of a pooled connection. A pool plus a session-level
 * setting is the classic way this goes wrong: the setting outlives the request
 * and the next tenant inherits it.
 *
 * The transaction is therefore not optional. It is the thing that scopes the
 * setting.
 *
 * This is the second line of defense, not the mechanism. Queries still name
 * `org_id` themselves, and invariant I1 is still re-checked when a response is
 * serialized. RLS exists so that one forgotten `WHERE` returns nothing instead
 * of another tenant's rows.
 */
export interface WithOrgOptions {
  /**
   * Switch to this role for the transaction, with `SET LOCAL ROLE`.
   *
   * Row-level security does not apply to a superuser at all, and applies to the
   * table owner only where the table is FORCE'd. Migrations run as the owner,
   * so a deployment that reuses that connection for the application gets
   * policies that are enabled and inert. Connecting as an unprivileged role is
   * the fix; this option exists for deployments that cannot, and for tests that
   * need to prove the policies bite.
   */
  readonly role?: string
}

/**
 * Run a lookup that resolves a credential, which cannot be scoped to an
 * organization because the credential is what says which organization it is.
 *
 * `app.authenticating` opens a second row-level security policy on
 * `service_accounts` for the length of the transaction — see migration 0008.
 * Without it the query raises `unrecognized configuration parameter` on any
 * connection that is subject to row-level security, which is every connection
 * a deployment following `docs/config.md` will make.
 *
 * **This is the one path in the system that reads across tenants, and it must
 * stay the only one.** Two things keep it narrow, and both are load-bearing:
 * the flag is `SET LOCAL`, so it cannot outlive the transaction or come back
 * on a pooled connection, and the policy it opens is `FOR SELECT`, so this
 * cannot write a row into an organization it has not identified yet.
 *
 * Read the credential and nothing else. Anything joined from tenant data here
 * is a cross-tenant read with the guard rail switched off.
 */
export async function whileAuthenticating<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  options: WithOrgOptions = {},
): Promise<T> {
  const client = await pool.connect()
  let broken: Error | undefined
  try {
    await client.query('BEGIN')
    if (options.role !== undefined) {
      if (!/^[a-z_][a-z0-9_]*$/i.test(options.role)) {
        throw new Error(`refusing to set an unrecognizable role name: ${options.role}`)
      }
      await client.query(`SET LOCAL ROLE ${options.role}`)
    }
    // `true` is the local flag: it goes away with the transaction, so a pooled
    // connection cannot hand it to the next caller.
    await client.query('SELECT set_config($1, $2, true)', ['app.authenticating', 'on'])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (cause) {
    // A rollback that itself fails means the connection is unusable — it goes
    // back to the pool inside an aborted transaction, and every later
    // borrower fails with 25P02 for a fault that happened here. Releasing
    // with an error is what makes pg discard it instead.
    broken = await client
      .query('ROLLBACK')
      .then(() => undefined)
      .catch(() => new Error('rollback failed; discarding the connection'))
    throw cause
  } finally {
    client.release(broken)
  }
}

/**
 * Run a query that legitimately spans every tenant, under the role the schema
 * gives BYPASSRLS.
 *
 * The worker's queue is the only thing that needs this: claiming the next
 * document to index means looking at all of them, which is what a queue is.
 * `0001_init.sql` has said "background worker jobs run under a separate role
 * with BYPASSRLS" since the beginning and no migration created that role until
 * 0008, so these queries ran with no organization set and raised
 * `unrecognized configuration parameter` on any connection subject to
 * row-level security — every connection a deployment following
 * `docs/config.md` makes. Indexing stopped entirely, and the Compose stack
 * never showed it because `POSTGRES_USER` connects as a superuser.
 *
 * **This turns the second line of defence off.** Every query run inside it
 * names `org_id` explicitly, because with row-level security bypassed that is
 * the only line left.
 */
export async function acrossOrganizations<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  role = 'nacre_worker',
): Promise<T> {
  const client = await pool.connect()
  let broken: Error | undefined
  try {
    await client.query('BEGIN')
    if (!/^[a-z_][a-z0-9_]*$/i.test(role)) {
      throw new Error(`refusing to set an unrecognizable role name: ${role}`)
    }
    await client.query(`SET LOCAL ROLE ${role}`)
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (cause) {
    // A rollback that itself fails means the connection is unusable — it goes
    // back to the pool inside an aborted transaction, and every later
    // borrower fails with 25P02 for a fault that happened here. Releasing
    // with an error is what makes pg discard it instead.
    broken = await client
      .query('ROLLBACK')
      .then(() => undefined)
      .catch(() => new Error('rollback failed; discarding the connection'))
    throw cause
  } finally {
    client.release(broken)
  }
}

export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: WithOrgOptions = {},
): Promise<T> {
  const client = await pool.connect()
  let broken: Error | undefined
  try {
    await client.query('BEGIN')
    if (options.role !== undefined) {
      // Not parameterizable — a role name is an identifier, not a value. The
      // caller supplies it from configuration, never from a request.
      if (!/^[a-z_][a-z0-9_]*$/i.test(options.role)) {
        throw new Error(`refusing to set an unrecognizable role name: ${options.role}`)
      }
      await client.query(`SET LOCAL ROLE ${options.role}`)
    }
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId])
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (cause) {
    // A rollback that itself fails means the connection is unusable. Releasing
    // it with an error below discards it rather than returning it to the pool
    // inside an aborted transaction — which is what a bare release() did while
    // this comment claimed otherwise: `finally { client.release() }` pools the
    // connection whatever happened, and every later borrower then fails with
    // 25P02 for a fault that happened here.
    broken = await client
      .query('ROLLBACK')
      .then(() => undefined)
      .catch(() => new Error('rollback failed; discarding the connection'))
    throw cause
  } finally {
    client.release(broken)
  }
}
