import { McpToolRefusal, withOrg } from '@nacre.work/core'
import type { Pool, PoolClient } from 'pg'

import type { AccessSubject } from './access.js'
import type { AuthContext } from './auth.js'

/**
 * Names an administrator uses, resolved to the ids the ports take.
 *
 * An agent on the administrative surface says "dana@example.com" and "the
 * handbook layer", not a uuid — and so does the person reading what it
 * proposes. Every lookup is inside the caller's organization and names it in
 * its own literal, so a name in another tenant resolves to nothing rather than
 * to somebody else's row, whatever the connection's role.
 *
 * Shared by the MCP process, which proposes, and by the API, which applies from
 * the console — one answer to "who is dana@example.com" on both sides.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (value: string): boolean => UUID.test(value)

export type PrincipalKind = 'person' | 'group' | 'service_account'

export interface NamedLayer {
  readonly id: string
  readonly slug: string
  readonly workspaceId: string
}

export class AdminNames {
  constructor(
    private readonly pool: Pool,
    private readonly role: string,
  ) {}

  private inOrg<T>(auth: AuthContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return withOrg(this.pool, auth.orgId, run, { role: this.role })
  }

  /** A principal named by email, name or id, in this organization — or a refusal naming the reference. */
  async principal(
    auth: AuthContext,
    args: Readonly<Record<string, unknown>>,
    kinds: readonly PrincipalKind[] = ['person', 'group', 'service_account'],
  ): Promise<AccessSubject> {
    const given = kinds.filter((k) => typeof args[k] === 'string' && args[k] !== '')
    if (given.length !== 1) {
      throw new McpToolRefusal(`Name exactly one of ${kinds.join(', ').replace(/, ([^,]*)$/, ' or $1')}.`)
    }
    const kind = given[0] as PrincipalKind
    const ref = (args[kind] as string).trim()
    const found = await this.lookup(auth, kind, ref)
    if (found === undefined) throw new McpToolRefusal(`No ${kind.replace('_', ' ')} "${ref}" in this organization.`)
    return found
  }

  lookup(auth: AuthContext, kind: PrincipalKind, ref: string): Promise<AccessSubject | undefined> {
    return this.inOrg(auth, async (client) => {
      const byId = UUID.test(ref)
      const [table, column, type] =
        kind === 'person'
          ? (['users', 'lower(email)', 'user'] as const)
          : kind === 'group'
            ? (['groups', 'name', 'group'] as const)
            : (['service_accounts', 'name', 'service_account'] as const)
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE org_id = $1 AND ${byId ? 'id = $2::uuid' : `${column} = $2`} LIMIT 2`,
        [auth.orgId, byId ? ref : kind === 'person' ? ref.toLowerCase() : ref],
      )
      return rows.length === 1 && rows[0] !== undefined ? { type, id: rows[0].id } : undefined
    })
  }

  /** A layer by slug or id. */
  async layer(auth: AuthContext, ref: string): Promise<NamedLayer> {
    const found = await this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string; slug: string; workspace_id: string }>(
        `SELECT id, slug, workspace_id FROM layers WHERE org_id = $1 AND deleted_at IS NULL AND ${UUID.test(ref) ? 'id = $2::uuid' : 'slug = $2'}`,
        [auth.orgId, ref],
      )
      return rows[0]
    })
    if (found === undefined) throw new McpToolRefusal(`No layer "${ref}" in this organization.`)
    return { id: found.id, slug: found.slug, workspaceId: found.workspace_id }
  }

  /** A workspace by slug or id. */
  async workspace(auth: AuthContext, ref: string): Promise<{ readonly id: string; readonly slug: string }> {
    const found = await this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM workspaces WHERE org_id = $1 AND ${UUID.test(ref) ? 'id = $2::uuid' : 'slug = $2'}`,
        [auth.orgId, ref],
      )
      return rows[0]
    })
    if (found === undefined) throw new McpToolRefusal(`No workspace "${ref}" in this organization.`)
    return found
  }

  /**
   * A name beside every id: an email for a person, a name for a group or a
   * service account, a slug for a layer or a workspace. Ids the organization
   * does not have come back unnamed rather than refused — a deleted layer is
   * still in last month's log.
   */
  names(auth: AuthContext, ids: Iterable<string>): Promise<ReadonlyMap<string, string>> {
    const wanted = [...new Set([...ids].filter((id) => UUID.test(id)))]
    if (wanted.length === 0) return Promise.resolve(new Map())
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT id::text, email AS name FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, name FROM service_accounts WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, name FROM groups WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, slug FROM layers WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, slug FROM workspaces WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [auth.orgId, wanted],
      )
      return new Map(rows.map((r) => [r.id, r.name]))
    })
  }

  /** One grant with its names, or `undefined` when this organization has none by that id. */
  grant(
    auth: AuthContext,
    id: string,
  ): Promise<
    | {
        readonly principalType: string
        readonly principalId: string
        readonly scopeType: string
        readonly scopeId: string
        readonly permission: string
        readonly effect: string
      }
    | undefined
  > {
    if (!UUID.test(id)) return Promise.resolve(undefined)
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{
        principal_type: string
        principal_id: string
        scope_type: string
        scope_id: string
        permission: string
        effect: string
      }>(
        `SELECT principal_type, principal_id, scope_type, scope_id, permission, effect
           FROM grants WHERE org_id = $1 AND id = $2::uuid`,
        [auth.orgId, id],
      )
      const row = rows[0]
      return row === undefined
        ? undefined
        : {
            principalType: row.principal_type,
            principalId: row.principal_id,
            scopeType: row.scope_type,
            scopeId: row.scope_id,
            permission: row.permission,
            effect: row.effect,
          }
    })
  }

  /** Counts a person reads before deleting something that holds things. */
  counts(
    auth: AuthContext,
    of: { readonly group?: string; readonly layer?: string },
  ): Promise<{ readonly members: number; readonly grants: number; readonly documents: number }> {
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ members: string; grants: string; documents: string }>(
        `SELECT (SELECT count(*) FROM group_members WHERE org_id = $1 AND group_id = $2::uuid) AS members,
                (SELECT count(*) FROM grants WHERE org_id = $1
                   AND ((principal_type = 'group' AND principal_id = $2::uuid)
                     OR (scope_type = 'layer' AND scope_id = $3::uuid))) AS grants,
                (SELECT count(*) FROM documents WHERE org_id = $1 AND layer_id = $3::uuid AND deleted_at IS NULL) AS documents`,
        [auth.orgId, of.group ?? null, of.layer ?? null],
      )
      const row = rows[0]
      return {
        members: Number(row?.members ?? 0),
        grants: Number(row?.grants ?? 0),
        documents: Number(row?.documents ?? 0),
      }
    })
  }
}
