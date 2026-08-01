import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'

import type { AuthContext } from './auth.js'

/**
 * Service account keys.
 *
 * The one credential in the system meant to outlive a session. `init` issues a
 * token that expires in an hour, which is right for getting through the
 * quickstart and useless for an agent that runs for a week — until this
 * existed, `NACRE_SERVICE_KEY` had nothing to put in it.
 *
 * The shape is not invented here: migration 0001 gave `service_accounts` a
 * `key_hash`, a `key_prefix`, and a `revoked_at`, which is an opaque key stored
 * hashed and looked up by a non-secret prefix. This implements that.
 *
 * A key is shown once, at creation, and never again. Storing anything
 * reversible would make a database backup a set of live credentials, and the
 * whole point of `key_hash` is that a stolen dump is not one.
 */

/** Identifies the credential type on sight, in a log or a pasted variable. */
export const KEY_PREFIX = 'nacre_sk_'

/**
 * The lookup prefix: the marker plus the first 8 characters of the secret.
 *
 * Long enough that the indexed lookup returns one row in practice, short enough
 * that it is not a meaningful head start — 8 base64url characters is 48 bits,
 * against a 256-bit secret. It is stored in clear and shown in listings on
 * purpose: an operator revoking a key needs to tell two apart, and the whole
 * key is gone.
 */
export function prefixOf(key: string): string {
  return key.slice(0, KEY_PREFIX.length + 8)
}

export function hashOf(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** 32 bytes from the CSPRNG. Not a UUID — those are not secrets. */
export function generateKey(): string {
  return `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`
}

export const looksLikeServiceKey = (value: string): boolean => value.startsWith(KEY_PREFIX)

export interface ServiceKeyResolver {
  /** The caller this key belongs to, or undefined for every kind of failure. */
  resolve(key: string): Promise<AuthContext | undefined>
}

/**
 * Resolve a key against the database.
 *
 * Undefined for unknown, revoked, malformed and wrong alike — the caller turns
 * all of them into the same 401 a bad JWT gets, so which one it was cannot be
 * read off the response.
 */
export class PostgresServiceKeys implements ServiceKeyResolver {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async resolve(key: string): Promise<AuthContext | undefined> {
    if (!looksLikeServiceKey(key)) return undefined

    const client = await this.pool.connect()
    try {
      // Across organizations: the key is what says which one, so there is no
      // org to scope to yet. This is why the lookup runs here rather than
      // inside withOrg, and why every column it reads is on service_accounts
      // rather than joined from tenant data.
      const { rows } = await client.query<{
        id: string
        org_id: string
        key_hash: string
      }>(
        `SELECT id, org_id, key_hash FROM service_accounts
          WHERE key_prefix = $1 AND revoked_at IS NULL`,
        [prefixOf(key)],
      )

      const expected = Buffer.from(hashOf(key), 'utf8')
      for (const row of rows) {
        const stored = Buffer.from(row.key_hash, 'utf8')
        // Constant-time, and length-checked first because timingSafeEqual
        // throws on a mismatch rather than returning false.
        if (stored.length !== expected.length) continue
        if (!timingSafeEqual(stored, expected)) continue

        // Best-effort. A failure to record when a key was last used must not
        // fail the request it authenticated — the column is for an operator
        // pruning dead keys, not for the decision.
        void client
          .query('UPDATE service_accounts SET last_used_at = now() WHERE id = $1', [row.id])
          .catch(() => undefined)

        // 'member', always. A service account holds nothing by virtue of being
        // one; every permission it has comes from a grant, which is what
        // docs/mcp.md means by "permissions are exactly the service account's".
        return {
          orgId: row.org_id,
          principal: { type: 'service_account', id: row.id },
          role: 'member',
        }
      }

      return undefined
    } finally {
      client.release()
    }
  }
}

export interface ServiceAccount {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

export interface ServiceAccounts {
  list(auth: AuthContext): Promise<readonly ServiceAccount[]>
  /** The key is in the result and nowhere else, ever again. */
  create(auth: AuthContext, name: string): Promise<{ account: ServiceAccount; key: string }>
  /** False when it does not exist in this organization, or is already revoked. */
  revoke(auth: AuthContext, id: string): Promise<boolean>
}

export class PostgresServiceAccounts implements ServiceAccounts {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  async list(auth: AuthContext): Promise<readonly ServiceAccount[]> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          name: string
          key_prefix: string
          created_at: Date
          last_used_at: Date | null
          revoked_at: Date | null
        }>(
          `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
             FROM service_accounts WHERE org_id = $1 ORDER BY created_at`,
          [auth.orgId],
        )

        // Revoked ones are listed rather than hidden: "this key was revoked on
        // Tuesday" is the answer to the question an operator is actually
        // asking, and a key that vanishes looks like one that never existed.
        return rows.map((r) => ({
          id: r.id,
          name: r.name,
          keyPrefix: r.key_prefix,
          createdAt: r.created_at.toISOString(),
          lastUsedAt: r.last_used_at?.toISOString() ?? null,
          revokedAt: r.revoked_at?.toISOString() ?? null,
        }))
      },
      this.scope,
    )
  }

  async create(auth: AuthContext, name: string): Promise<{ account: ServiceAccount; key: string }> {
    const key = generateKey()

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO service_accounts (org_id, name, key_hash, key_prefix)
           VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
          [auth.orgId, name, hashOf(key), prefixOf(key)],
        )

        const row = rows[0]
        if (row === undefined) throw new Error('the service account insert returned no row')

        return {
          key,
          account: {
            id: row.id,
            name,
            keyPrefix: prefixOf(key),
            createdAt: row.created_at.toISOString(),
            lastUsedAt: null,
            revokedAt: null,
          },
        }
      },
      this.scope,
    )
  }

  async revoke(auth: AuthContext, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // Revoked, never deleted. The audit log refers to this id, and a row
        // that disappears turns every past event into an unresolvable
        // reference — which is the one thing an access log must not do.
        const { rowCount } = await client.query(
          `UPDATE service_accounts SET revoked_at = now()
            WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
          [auth.orgId, id],
        )
        return (rowCount ?? 0) > 0
      },
      this.scope,
    )
  }
}
