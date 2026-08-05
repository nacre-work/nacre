import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { whileAuthenticating, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'

import type { AuthContext } from './auth.js'
import { pageOf, type Page, type PageResult } from './pagination.js'

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

    // Across organizations: the key is what says which one, so there is no org
    // to scope to yet. `whileAuthenticating` opens the one policy that permits
    // that, for the length of this transaction — without it the query raises
    // `unrecognized configuration parameter` on any connection subject to
    // row-level security, which is every connection a deployment following
    // docs/config.md will make. It worked in development because development
    // connects as a superuser, which is the configuration that document
    // forbids.
    //
    // Every column read here is on service_accounts. Joining tenant data into
    // this query is a cross-tenant read with the guard rail switched off.
    const matched = await whileAuthenticating(
      this.pool,
      async (client) => {
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
          return { id: row.id, orgId: row.org_id }
        }

        return undefined
      },
      this.role === undefined ? {} : { role: this.role },
    )

    if (matched === undefined) return undefined

    // Outside the authenticating transaction, and scoped to the organization
    // the key just identified. The policy that let the lookup happen is
    // SELECT-only on purpose — a write here would have been filtered and the
    // column would have quietly stopped moving, which is the failure mode this
    // whole migration exists to remove rather than to relocate.
    //
    // Best-effort: a failure to record when a key was last used must not fail
    // the request it authenticated. The column is for an operator pruning dead
    // keys, not for the decision.
    await withOrg(
      this.pool,
      matched.orgId,
      (client) => client.query('UPDATE service_accounts SET last_used_at = now() WHERE id = $1', [matched.id]),
      this.role === undefined ? {} : { role: this.role },
    ).catch(() => undefined)

    // 'member', always. A service account holds nothing by virtue of being one;
    // every permission it has comes from a grant, which is what docs/mcp.md
    // means by "permissions are exactly the service account's".
    return {
      orgId: matched.orgId,
      principal: { type: 'service_account', id: matched.id },
      role: 'member',
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
  /**
   * The person who created it, when one did.
   *
   * Null for every account made before the column existed and for any made by
   * `init` — inventing an owner for those, the first administrator say, would
   * be a record that reads as fact and is a guess. It is what "my agents"
   * filters on, which is the reason it exists: consent lets anyone who can
   * issue a grant stand an agent up, and without this an organization fills
   * with `laptop-agent`, `laptop-agent-2` and nobody able to say whose is
   * whose.
   */
  readonly createdBy?: string | null
}

export interface ServiceAccounts {
  list(auth: AuthContext, page?: Page): Promise<PageResult<ServiceAccount>>
  /**
   * The key is in the result and nowhere else, ever again.
   *
   * `undefined` when the name is already taken in this organization. Not an
   * exception: a duplicate name is something the caller typed, and the unique
   * constraint used to surface as a 500 — an error page for a form validation,
   * with the constraint name in the server log and nothing useful on screen.
   */
  create(auth: AuthContext, name: string): Promise<{ account: ServiceAccount; key: string } | undefined>
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

  async list(auth: AuthContext, page?: Page): Promise<PageResult<ServiceAccount>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const after = page?.after
        const seek =
          after === undefined ? '' : ' AND (created_at, id) > ($2::timestamptz, $3::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } = await client.query<{
          id: string
          name: string
          key_prefix: string
          created_at: Date
          /** Full precision, for the cursor. See `Position.createdAt`. */
          created_at_text: string
          last_used_at: Date | null
          revoked_at: Date | null
          created_by: string | null
        }>(
          `SELECT id, name, key_prefix, created_at, created_at::text AS created_at_text,
                  last_used_at, revoked_at, created_by
             FROM service_accounts WHERE org_id = $1${seek} ORDER BY created_at, id${cap}`,
          after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
        )

        // Revoked ones are listed rather than hidden: "this key was revoked on
        // Tuesday" is the answer to the question an operator is actually
        // asking, and a key that vanishes looks like one that never existed.
        const accounts = rows.map((r) => ({
          id: r.id,
          name: r.name,
          keyPrefix: r.key_prefix,
          createdAt: r.created_at.toISOString(),
          lastUsedAt: r.last_used_at?.toISOString() ?? null,
          revokedAt: r.revoked_at?.toISOString() ?? null,
          createdBy: r.created_by,
        }))

        return pageOf(accounts, page, (a, i) => ({
          // From the row, at full precision. See `Position.createdAt`.
          createdAt: (rows[i] as { created_at_text: string }).created_at_text,
          id: a.id,
        }))
      },
      this.scope,
    )
  }

  async create(
    auth: AuthContext,
    name: string,
  ): Promise<{ account: ServiceAccount; key: string } | undefined> {
    const key = generateKey()

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // DO NOTHING rather than catching a unique violation: inside the
        // transaction withOrg opens, a raised constraint error aborts
        // everything after it, so recovering would mean a savepoint. The empty
        // result says the same thing and says it without one.
        const { rows } = await client.query<{ id: string; created_at: Date; created_by: string | null }>(
          // `created_by` from the caller when the caller is a person. A
          // service account creating another leaves it null rather than naming
          // the parent: an owner is a human who can be asked about it, and a
          // chain of agents is not an answer to "whose is this".
          `INSERT INTO service_accounts (org_id, name, key_hash, key_prefix, created_by)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (org_id, name) DO NOTHING
           RETURNING id, created_at, created_by`,
          [auth.orgId, name, hashOf(key), prefixOf(key), auth.principal.type === 'user' ? auth.principal.id : null],
        )

        const row = rows[0]
        // Taken. The name is the caller's own input and this organization's
        // own namespace, so saying so discloses nothing they did not send.
        if (row === undefined) return undefined

        return {
          key,
          account: {
            id: row.id,
            name,
            keyPrefix: prefixOf(key),
            createdAt: row.created_at.toISOString(),
            lastUsedAt: null,
            revokedAt: null,
            createdBy: row.created_by,
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
