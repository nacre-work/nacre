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

export async function withOrg<T>(
  pool: Pool,
  orgId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: WithOrgOptions = {},
): Promise<T> {
  const client = await pool.connect()
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
    await client.query('ROLLBACK').catch(() => {
      // A rollback that itself fails means the connection is unusable. Releasing
      // it with an error below discards it rather than returning it to the pool
      // with an open transaction and someone else's org setting on it.
    })
    throw cause
  } finally {
    client.release()
  }
}
