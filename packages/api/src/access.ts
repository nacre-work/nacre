import { activeResolver, withOrg, type Permission, type PrincipalType } from '@nacre.work/core'
import type { Pool } from 'pg'

import { contextFor, type PrincipalsCache } from './adapters.js'
import { administers, type AuthContext } from './auth.js'

/**
 * What somebody else can reach, computed by the resolver — for an
 * administrator asking "what does Petya see, and why".
 *
 * docs/mcp-admin.md lists it among the administrative reads, and it is the one
 * that cannot be answered by reading the grant list. A grant list says what
 * was *issued*; what a principal reaches is what the resolver makes of those
 * grants, their groups' grants, the denies beneath them and their role — and
 * an administrator adding that up by hand from a list is exactly how the wrong
 * conclusion gets drawn about who can read a contract.
 *
 * So it asks the **active resolver**, the same one search asks, with the same
 * input `contextFor` builds for a request — the subject's own effective
 * principals, their grants, the scope tree. A module that replaces the
 * resolver replaces this answer with it, which is the property: the access
 * view and the search path cannot disagree about who sees what.
 *
 * No ceiling, deliberately. The subject is a principal and not a token, and
 * what a connection of theirs may do is the connection's own ceiling on top of
 * this, which the Connections listing already says.
 */

export interface AccessSubject {
  readonly type: PrincipalType
  readonly id: string
}

/** One permission's reach, as the resolver plans it. */
export interface Reach {
  /** Every layer in the organization, by role or by grants. */
  readonly all: boolean
  /** Layers reachable in full, by id — at most `MAX_REACH_LAYERS` of them. */
  readonly layers: readonly string[]
  /** How many more layers the plan reaches than `layers` lists. */
  readonly moreLayers: number
  /** Documents reached outside those layers, by a document-scoped grant. */
  readonly extraDocuments: number
  /** Documents a deny excludes inside a reached layer. */
  readonly deniedDocuments: number
}

export interface EffectiveAccess {
  readonly subject: AccessSubject
  /** The role, for a user; `member` for anything else. */
  readonly role: AuthContext['role']
  /** The groups the subject belongs to, directly or through other groups. */
  readonly groups: readonly string[]
  readonly read: Reach
  readonly write: Reach
  readonly admin: Reach
  /**
   * The grants that decide it: every grant naming the subject or one of their
   * groups. A grant naming somebody else cannot change this answer, so it is
   * not here.
   */
  readonly grants: readonly {
    readonly principal: string
    readonly scopeType: string
    readonly scopeId: string
    readonly permission: Permission
    readonly effect: 'allow' | 'deny'
  }[]
}

/** Bounded, because a scoped plan on an installation sized in layers is unbounded. */
export const MAX_REACH_LAYERS = 200

const PERMISSIONS = ['read', 'write', 'admin'] as const

export class PostgresAccess {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
    private readonly principalsCache?: PrincipalsCache,
  ) {}

  /**
   * `undefined` when the caller does not administer the organization, or the
   * subject is not a live principal in it — one answer, invariant 4. A
   * disabled user is still answered: an administrator asking what somebody
   * who has left could reach is asking the question this exists for, and
   * their grants still stand until somebody removes them.
   */
  async effective(auth: AuthContext, subject: AccessSubject): Promise<EffectiveAccess | undefined> {
    if (!administers(auth)) return undefined

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const role = await subjectRole(client, auth.orgId, subject)
        if (role === undefined) return undefined

        const asSubject: AuthContext = { orgId: auth.orgId, principal: subject, role }
        const context = await contextFor(client, asSubject, this.principalsCache)
        const resolver = activeResolver()

        const reach = (permission: Permission): Reach => {
          const plan = resolver.resolve(context, permission)
          if (plan.kind === 'all') return { all: true, layers: [], moreLayers: 0, extraDocuments: 0, deniedDocuments: 0 }
          if (plan.kind === 'none') return { all: false, layers: [], moreLayers: 0, extraDocuments: 0, deniedDocuments: 0 }
          const sorted = [...plan.layers].sort()
          return {
            all: false,
            layers: sorted.slice(0, MAX_REACH_LAYERS),
            moreLayers: Math.max(0, sorted.length - MAX_REACH_LAYERS),
            extraDocuments: plan.extraDocs.length,
            deniedDocuments: plan.deniedDocs.length,
          }
        }

        const self = `${subject.type}:${subject.id}`
        return {
          subject,
          role,
          groups: [...context.principals]
            .filter((ref) => ref !== self && ref.startsWith('group:'))
            .map((ref) => ref.slice('group:'.length))
            .sort(),
          read: reach(PERMISSIONS[0]),
          write: reach(PERMISSIONS[1]),
          admin: reach(PERMISSIONS[2]),
          grants: context.grants
            .filter((g) => g.orgId === auth.orgId && context.principals.has(`${g.principal.type}:${g.principal.id}`))
            .map((g) => ({
              principal: `${g.principal.type}:${g.principal.id}`,
              scopeType: g.scope.type,
              scopeId: g.scope.id,
              permission: g.permission,
              effect: g.effect,
            })),
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

/**
 * The subject's role, or `undefined` when it is not a principal of this
 * organization. Every statement names the organization in its own literal, on
 * top of the row-level policy, because a deployment connecting as a superuser
 * has no policy to fall back on.
 */
async function subjectRole(
  client: import('pg').PoolClient,
  orgId: string,
  subject: AccessSubject,
): Promise<AuthContext['role'] | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(subject.id)) return undefined
  if (subject.type === 'user') {
    const { rows } = await client.query<{ role: AuthContext['role'] }>(
      `SELECT role FROM users WHERE org_id = $1 AND id = $2`,
      [orgId, subject.id],
    )
    return rows[0]?.role
  }
  if (subject.type === 'group') {
    const { rows } = await client.query(`SELECT 1 FROM groups WHERE org_id = $1 AND id = $2`, [orgId, subject.id])
    return rows.length === 0 ? undefined : 'member'
  }
  const { rows } = await client.query(
    `SELECT 1 FROM service_accounts WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [orgId, subject.id],
  )
  return rows.length === 0 ? undefined : 'member'
}
