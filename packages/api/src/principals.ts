import { generatePassword, hashPassword, withOrg } from '@nacre.work/core'
import type { Pool, PoolClient } from 'pg'

import type { AuthContext } from './auth.js'
import { pageOf, type Page, type PageResult } from './pagination.js'

/**
 * Users and groups — the principals a grant is issued to.
 *
 * `grants.principal_type` has admitted `user`, `group` and `service_account`
 * since 0001, and only the third could be created through the API. So the
 * documented way to onboard a colleague was to insert a row into `users` by
 * hand, and the documented way to give a team access was to insert into
 * `groups` and `group_members` by hand — which is the same shape of hole the
 * workspace listing had: the model offers something the product gives no route
 * to, and the route people find instead is `psql`.
 *
 * ## Why `org_admin` and not "admin on a scope"
 *
 * The same argument service accounts make. A user is a principal *in the
 * organization* rather than an object inside a workspace, so there is no scope
 * to check against — and someone holding `admin` on one layer must not be able
 * to mint a principal, any more than they can mint a key. A caller without the
 * role gets `404`, like everything else invariant 4 covers.
 *
 * ## Why a user is disabled and never deleted
 *
 * Two reasons and the second is structural. The audit log names a user id, and
 * a row that disappears turns every past event into an unresolvable reference
 * — which is the one thing an access log must not do. And `grants.created_by`
 * references `users(id)` with no cascade, so deleting an administrator who has
 * ever issued a grant raises a foreign key violation: the schema has always
 * said this, and `disabled_at` is the column it said it with.
 *
 * A group *is* deleted, because nothing points at one that way and because
 * "the team does not exist any more" is a different statement from "this person
 * has left".
 */

export interface UserView {
  readonly id: string
  readonly email: string
  readonly role: 'platform_admin' | 'org_admin' | 'member'
  readonly createdAt: string
  readonly disabledAt: string | null
  /**
   * Whether a password is set at all.
   *
   * Never the hash, and never anything derived from it. False is an SSO-only
   * account — `users.password_hash` is nullable precisely so an IdP-backed user
   * has no local credential to steal.
   */
  readonly hasPassword: boolean
}

export interface Users {
  list(auth: AuthContext, page?: Page): Promise<PageResult<UserView>>
  /**
   * The password is in the result and nowhere else, ever again.
   *
   * `undefined` when the address is already in use in this organization —
   * `UNIQUE (org_id, email)`, and a duplicate is something the caller typed
   * rather than an internal error.
   */
  create(
    auth: AuthContext,
    email: string,
    role: 'org_admin' | 'member',
  ): Promise<{ user: UserView; password: string } | undefined>
  /**
   * Change the role, the disabled state, or both.
   *
   * One call rather than a `disable` beside a `setRole`, because the guard
   * below has to see both: demoting the last administrator and disabling them
   * leave the organization in the same place, and two entry points with one
   * check between them is how the guarded one gets routed around.
   *
   * `last-admin` refuses a change that would leave the organization with no
   * active `org_admin`. Not paternalism — every endpoint that could appoint one
   * is behind the role that was just given up, so the remedy would be SQL.
   *
   * `platform-admin` refuses a change to somebody holding that role. See
   * `onTargetUser`.
   */
  update(
    auth: AuthContext,
    id: string,
    change: { role?: 'org_admin' | 'member'; disabled?: boolean },
  ): Promise<'updated' | 'last-admin' | 'platform-admin' | 'no-user'>
  /**
   * The new password, shown once.
   *
   * A result rather than `string | undefined`, because there are now two ways
   * for it to be absent and they are different answers: no such user here, and
   * a user this endpoint may not act on.
   */
  resetPassword(
    auth: AuthContext,
    id: string,
  ): Promise<{ password: string } | 'platform-admin' | 'no-user'>
}

export interface GroupView {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  /** Direct members only. A nested group counts as one, not as its members. */
  readonly memberCount: number
}

export type GroupMember =
  | { readonly type: 'user'; readonly id: string; readonly label: string }
  | { readonly type: 'group'; readonly id: string; readonly label: string }

export interface Groups {
  list(auth: AuthContext, page?: Page): Promise<PageResult<GroupView>>
  /** `undefined` when the name is already in use in this organization. */
  create(auth: AuthContext, name: string): Promise<GroupView | undefined>
  /** False when there is no such group here. */
  remove(auth: AuthContext, id: string): Promise<boolean>
  /** `undefined` when there is no such group here — distinct from an empty one. */
  members(
    auth: AuthContext,
    groupId: string,
    page?: Page,
  ): Promise<PageResult<GroupMember> | undefined>
  /**
   * `no-group` and `no-member` are separate because the caller is an
   * `org_admin` who can list both collections, so neither answer tells them
   * anything they could not already read.
   */
  addMember(
    auth: AuthContext,
    groupId: string,
    member: { type: 'user' | 'group'; id: string },
  ): Promise<'added' | 'already' | 'no-group' | 'no-member'>
  /** False when that edge is not there. */
  removeMember(
    auth: AuthContext,
    groupId: string,
    member: { type: 'user' | 'group'; id: string },
  ): Promise<boolean>
}

const UUID = /^[0-9a-f-]{36}$/i

/**
 * An email address, checked only enough to refuse what cannot be one.
 *
 * Deliberately not RFC 5322. A stricter test rejects addresses that work, and
 * the column is `citext` with a uniqueness constraint — what matters here is
 * that the value is a single token with an `@` and a dot after it, so a name or
 * a uuid typed into the wrong field is refused where the operator can see it
 * rather than becoming a user nobody can sign in as.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

export class PostgresUsers implements Users {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  async list(auth: AuthContext, page?: Page): Promise<PageResult<UserView>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const after = page?.after
        const seek = after === undefined ? '' : ' AND (created_at, id) > ($2::timestamptz, $3::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } = await client.query<{
          id: string
          email: string
          role: 'platform_admin' | 'org_admin' | 'member'
          created_at: Date
          /** Full precision, for the cursor. See `Position.createdAt`. */
          created_at_text: string
          disabled_at: Date | null
          has_password: boolean
        }>(
          `SELECT id, email, role, created_at, created_at::text AS created_at_text,
                  disabled_at, (password_hash IS NOT NULL) AS has_password
             FROM users WHERE org_id = $1${seek} ORDER BY created_at, id${cap}`,
          after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
        )

        // Disabled ones are listed rather than hidden, on the same grounds as a
        // revoked key: "this account was disabled on Tuesday" is the answer to
        // the question being asked, and a row that vanishes looks like one that
        // never existed.
        const users = rows.map((r) => ({
          id: r.id,
          email: r.email,
          role: r.role,
          createdAt: r.created_at.toISOString(),
          disabledAt: r.disabled_at?.toISOString() ?? null,
          hasPassword: r.has_password,
        }))

        return pageOf(users, page, (u, i) => ({
          createdAt: (rows[i] as { created_at_text: string }).created_at_text,
          id: u.id,
        }))
      },
      this.scope,
    )
  }

  async create(
    auth: AuthContext,
    email: string,
    role: 'org_admin' | 'member',
  ): Promise<{ user: UserView; password: string } | undefined> {
    const password = generatePassword()
    // Outside the transaction on purpose: scrypt at OWASP's minimum takes long
    // enough that holding a database connection across it is a connection spent
    // on arithmetic. `login.ts` makes the same call under a concurrency cap for
    // the same reason.
    const passwordHash = await hashPassword(password)

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // DO NOTHING rather than catching a unique violation: inside the
        // transaction `withOrg` opens, a raised constraint error aborts
        // everything after it, so recovering would need a savepoint. The empty
        // result says the same thing without one.
        const { rows } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO users (org_id, email, role, password_hash)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (org_id, email) DO NOTHING
           RETURNING id, created_at`,
          [auth.orgId, email, role, passwordHash],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        return {
          password,
          user: {
            id: row.id,
            email,
            role,
            createdAt: row.created_at.toISOString(),
            disabledAt: null,
            hasPassword: true,
          },
        }
      },
      this.scope,
    )
  }

  /**
   * Every write to somebody else's row goes through here, and it is the only
   * place that decides whether the row may be written at all.
   *
   * **A `platform_admin` is not administered from inside an organization.**
   * `POST /v1/users` and `PATCH /v1/users/{id}` have always refused to *set*
   * that role, on the argument that this surface is scoped to one organization
   * and the role spans all of them — so issuing one here would be an escalation
   * out of the scope doing the issuing. Neither looked at the role it was
   * *replacing*, and the same argument applies with the same force in that
   * direction: an `org_admin` could demote a platform administrator who happens
   * to live in their organization, disable them, or — worst — reset their
   * password and read the plaintext out of the response, which is not a
   * demotion but a takeover of the account that administers the installation.
   * All three from an endpoint scoped to one tenant.
   *
   * Nobody reaching this code is a platform administrator themselves:
   * `administers(auth)` is `org_admin` and nothing else, so there is no
   * peer-administration case to carve out. The refusal is about what the
   * endpoint is scoped to rather than about who is calling, which is why it has
   * no branch on the caller.
   *
   * A guard and not three guards. Demote, disable, delete and reset-password
   * are four spellings of "act on this person", and four checks with nothing
   * knowing there are four is the shape this repository keeps being bitten by.
   * `check-platform-admin-target.mjs` is what knows.
   *
   * `FOR UPDATE` for the same reason the last-administrator count needs it: the
   * decision and the write have to see one state, or a promotion landing
   * between them is a guard that read a role nobody has any more.
   */
  private async onTargetUser<T>(
    auth: AuthContext,
    id: string,
    fn: (
      client: PoolClient,
      current: { role: string; disabledAt: Date | null },
    ) => Promise<T>,
  ): Promise<T | 'platform-admin' | 'no-user'> {
    if (!UUID.test(id)) return 'no-user'

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ role: string; disabled_at: Date | null }>(
          'SELECT role, disabled_at FROM users WHERE org_id = $1 AND id = $2 FOR UPDATE',
          [auth.orgId, id],
        )
        const current = rows[0]
        if (current === undefined) return 'no-user'
        if (current.role === 'platform_admin') return 'platform-admin'

        return fn(client, { role: current.role, disabledAt: current.disabled_at })
      },
      this.scope,
    )
  }

  async update(
    auth: AuthContext,
    id: string,
    change: { role?: 'org_admin' | 'member'; disabled?: boolean },
  ): Promise<'updated' | 'last-admin' | 'platform-admin' | 'no-user'> {
    return this.onTargetUser(
      auth,
      id,
      async (client, current): Promise<'updated' | 'last-admin' | 'no-user'> => {
        const role = change.role ?? current.role
        const disabled = change.disabled ?? current.disabledAt !== null
        const wasActiveAdmin = current.role === 'org_admin' && current.disabledAt === null
        const staysActiveAdmin = role === 'org_admin' && !disabled

        // Counted in the same transaction, and only when this change would
        // actually give one up. `FOR UPDATE` on the row above plus this count
        // is what stops two administrators demoting each other concurrently and
        // both reading a count of two.
        if (wasActiveAdmin && !staysActiveAdmin) {
          const { rows: others } = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM users
              WHERE org_id = $1 AND id <> $2 AND role = 'org_admin' AND disabled_at IS NULL`,
            [auth.orgId, id],
          )
          if (Number(others[0]?.n ?? '0') === 0) return 'last-admin'
        }

        // `disabled_at` keeps the instant it was set rather than being rewritten
        // on every unrelated PATCH: "disabled since Tuesday" is the answer an
        // operator is looking for, and re-stamping it on a role change would
        // quietly move it.
        const { rowCount } = await client.query(
          `UPDATE users
              SET role = $3,
                  disabled_at = CASE
                    WHEN $4::boolean THEN COALESCE(disabled_at, now())
                    ELSE NULL
                  END
            WHERE org_id = $1 AND id = $2`,
          [auth.orgId, id, role, disabled],
        )
        return (rowCount ?? 0) > 0 ? 'updated' : 'no-user'
      },
    )
  }

  async resetPassword(
    auth: AuthContext,
    id: string,
  ): Promise<{ password: string } | 'platform-admin' | 'no-user'> {
    const password = generatePassword()
    // Before the transaction on purpose: scrypt at OWASP's minimum takes long
    // enough that holding a connection across it is a connection spent on
    // arithmetic. It costs a hash on a request that turns out to be refused,
    // which is the right way round — the alternative is the guard reading a
    // role while the row is not locked.
    const passwordHash = await hashPassword(password)

    return this.onTargetUser(auth, id, async (client): Promise<{ password: string } | 'no-user'> => {
      // A disabled account is deliberately still resettable: re-enabling and
      // resetting are two decisions, and refusing here would make the second
      // depend on the first in a way nothing asked for.
      const { rowCount } = await client.query(
        'UPDATE users SET password_hash = $3 WHERE org_id = $1 AND id = $2',
        [auth.orgId, id, passwordHash],
      )
      return (rowCount ?? 0) > 0 ? { password } : 'no-user'
    })
  }
}

export class PostgresGroups implements Groups {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  async list(auth: AuthContext, page?: Page): Promise<PageResult<GroupView>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const after = page?.after
        const seek =
          after === undefined ? '' : ' AND (g.created_at, g.id) > ($2::timestamptz, $3::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } = await client.query<{
          id: string
          name: string
          created_at: Date
          created_at_text: string
          member_count: string
        }>(
          `SELECT g.id, g.name, g.created_at, g.created_at::text AS created_at_text,
                  (SELECT count(*) FROM group_members m
                    WHERE m.org_id = g.org_id AND m.group_id = g.id) AS member_count
             FROM groups g WHERE g.org_id = $1${seek} ORDER BY g.created_at, g.id${cap}`,
          after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
        )

        const groups = rows.map((r) => ({
          id: r.id,
          name: r.name,
          createdAt: r.created_at.toISOString(),
          // count() is bigint, which pg hands over as a string rather than
          // silently losing precision. Parsed here rather than left to JSON,
          // where it would have serialized as a quoted number.
          memberCount: Number(r.member_count),
        }))

        return pageOf(groups, page, (g, i) => ({
          createdAt: (rows[i] as { created_at_text: string }).created_at_text,
          id: g.id,
        }))
      },
      this.scope,
    )
  }

  async create(auth: AuthContext, name: string): Promise<GroupView | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string; created_at: Date }>(
          `INSERT INTO groups (org_id, name) VALUES ($1,$2)
           ON CONFLICT (org_id, name) DO NOTHING
           RETURNING id, created_at`,
          [auth.orgId, name],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        return { id: row.id, name, createdAt: row.created_at.toISOString(), memberCount: 0 }
      },
      this.scope,
    )
  }

  async remove(auth: AuthContext, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // Grants naming the group go first, and in the same transaction. There
        // is no foreign key from `grants` to `groups` — `principal_id` is a
        // bare uuid because it addresses three different tables — so nothing
        // would clean them up, and a grant to a principal that no longer exists
        // is a row `GET /v1/grants` lists and nobody can resolve.
        //
        // No permission answer changes either way: `effectivePrincipals` walks
        // membership from the caller, and a deleted group has no members to
        // walk from.
        await client.query(
          `DELETE FROM grants WHERE org_id = $1 AND principal_type = 'group' AND principal_id = $2`,
          [auth.orgId, id],
        )

        // `group_members` cascades on both endpoints, so the edges into and out
        // of this group go with it. 0003's row trigger fires on those deletes
        // and on this one, so `groups_version` moves and every cached principal
        // set is composed from a different key on the next request.
        const { rowCount } = await client.query('DELETE FROM groups WHERE org_id = $1 AND id = $2', [
          auth.orgId,
          id,
        ])
        return (rowCount ?? 0) > 0
      },
      this.scope,
    )
  }

  async members(
    auth: AuthContext,
    groupId: string,
    page?: Page,
  ): Promise<PageResult<GroupMember> | undefined> {
    if (!UUID.test(groupId)) return undefined

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // Asked first, so an empty group and a group that is not here are
        // different answers. They are allowed to be: the caller is an
        // `org_admin` who can list every group in the organization, so this
        // tells them nothing `GET /v1/groups` would not.
        const { rows: present } = await client.query(
          'SELECT 1 FROM groups WHERE org_id = $1 AND id = $2',
          [auth.orgId, groupId],
        )
        if (present.length === 0) return undefined

        const after = page?.after
        // The tie-breaker is whichever member column is set: the CHECK from
        // 0001 guarantees exactly one is, so the coalesce is total rather than
        // a default.
        const seek =
          after === undefined
            ? ''
            : ' AND (m.created_at, COALESCE(m.member_user, m.member_group)) > ($3::timestamptz, $4::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } = await client.query<{
          member_user: string | null
          member_group: string | null
          label: string
          created_at_text: string
        }>(
          `SELECT m.member_user, m.member_group,
                  COALESCE(u.email, g.name) AS label,
                  m.created_at::text AS created_at_text
             FROM group_members m
             LEFT JOIN users  u ON u.id = m.member_user  AND u.org_id = m.org_id
             LEFT JOIN groups g ON g.id = m.member_group AND g.org_id = m.org_id
            WHERE m.org_id = $1 AND m.group_id = $2${seek}
            ORDER BY m.created_at, COALESCE(m.member_user, m.member_group)${cap}`,
          after === undefined
            ? [auth.orgId, groupId]
            : [auth.orgId, groupId, after.createdAt, after.id],
        )

        const members: GroupMember[] = rows.map((r) =>
          r.member_user !== null
            ? { type: 'user' as const, id: r.member_user, label: r.label }
            : { type: 'group' as const, id: r.member_group as string, label: r.label },
        )

        return pageOf(members, page, (m, i) => ({
          createdAt: (rows[i] as { created_at_text: string }).created_at_text,
          id: m.id,
        }))
      },
      this.scope,
    )
  }

  async addMember(
    auth: AuthContext,
    groupId: string,
    member: { type: 'user' | 'group'; id: string },
  ): Promise<'added' | 'already' | 'no-group' | 'no-member'> {
    if (!UUID.test(groupId)) return 'no-group'
    if (!UUID.test(member.id)) return 'no-member'

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows: group } = await client.query(
          'SELECT 1 FROM groups WHERE org_id = $1 AND id = $2',
          [auth.orgId, groupId],
        )
        if (group.length === 0) return 'no-group'

        const { rows: exists } = await client.query(
          member.type === 'user'
            ? 'SELECT 1 FROM users WHERE org_id = $1 AND id = $2'
            : 'SELECT 1 FROM groups WHERE org_id = $1 AND id = $2',
          [auth.orgId, member.id],
        )
        // Checked here as well as by the composite foreign key from 0002. The
        // constraint is what makes a cross-tenant edge impossible; this is what
        // makes a typo a `404` instead of a `500`, and the two are not
        // substitutes — a raised constraint inside `withOrg`'s transaction
        // aborts everything after it.
        if (exists.length === 0) return 'no-member'

        // A cycle is not refused. `group_members`' own comment says cycles are
        // the resolver's problem to terminate on rather than the schema's to
        // prevent, and `effectivePrincipals` walks into a `Set` — so a group
        // that contains itself resolves to the same principal set it already
        // had. Refusing here would be a second, weaker implementation of a rule
        // T14 already pins, and it would only catch the direct case anyway.
        const { rowCount } = await client.query(
          member.type === 'user'
            ? `INSERT INTO group_members (org_id, group_id, member_user) VALUES ($1,$2,$3)
               ON CONFLICT DO NOTHING`
            : `INSERT INTO group_members (org_id, group_id, member_group) VALUES ($1,$2,$3)
               ON CONFLICT DO NOTHING`,
          [auth.orgId, groupId, member.id],
        )

        // `already` rather than an error. 0018 is what makes this reachable at
        // all — before it, `NULLS DISTINCT` meant the constraint matched
        // nothing and `ON CONFLICT DO NOTHING` was a no-op that inserted a
        // duplicate every time a directory sync ran.
        return (rowCount ?? 0) > 0 ? 'added' : 'already'
      },
      this.scope,
    )
  }

  async removeMember(
    auth: AuthContext,
    groupId: string,
    member: { type: 'user' | 'group'; id: string },
  ): Promise<boolean> {
    if (!UUID.test(groupId) || !UUID.test(member.id)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rowCount } = await client.query(
          member.type === 'user'
            ? 'DELETE FROM group_members WHERE org_id = $1 AND group_id = $2 AND member_user = $3'
            : 'DELETE FROM group_members WHERE org_id = $1 AND group_id = $2 AND member_group = $3',
          [auth.orgId, groupId, member.id],
        )
        return (rowCount ?? 0) > 0
      },
      this.scope,
    )
  }
}
