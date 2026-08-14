import { createPool, generatePassword, verifyPassword, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { looksLikeEmail, PostgresGroups, PostgresUsers } from '../principals.js'

/**
 * Users and groups, against the database.
 *
 * Everything worth checking here is something a fake cannot have: the
 * last-administrator count, which is a query in the same transaction as the
 * update it guards; the grants a deleted group takes with it, which no
 * foreign key removes; and `groups_version`, which is a trigger and is the
 * whole reason a revocation is not served from cache.
 *
 * Run as `nacre_app`, deliberately. Two subsystems in this repository only ever
 * worked because development connects as a superuser — service account keys and
 * the worker's queue — and both were found the moment an operator followed
 * `docs/config.md`. A test that connects as the owner proves nothing about the
 * role the application actually uses.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the principal paths would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '99999999-9999-4999-8999-999999999901'
const OTHER = '99999999-9999-4999-8999-999999999902'

// A real uuid with a real row behind it. `service_accounts.created_by`
// references `users(id)` since 0023, so a placeholder principal is no longer
// something the database will accept — which is the constraint doing its job:
// in a deployment this id is a token's subject and the row always exists.
const ADMIN_ID = '99999999-9999-4999-8999-9999999990a1'
const admin = { orgId: ORG, principal: { type: 'user' as const, id: ADMIN_ID }, role: 'org_admin' as const }

let pool: Pool
let users: PostgresUsers
let groups: PostgresGroups

async function groupsVersion(orgId: string): Promise<number> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query<{ groups_version: string }>(
      'SELECT groups_version FROM organizations WHERE id = $1',
      [orgId],
    )
    return Number(rows[0]?.groups_version ?? '0')
  } finally {
    c.release()
  }
}

describe('shapes', () => {
  it('a generated password is six words and a number, from the CSPRNG', () => {
    const password = generatePassword()
    expect(password.split('-')).toHaveLength(7)
    // Not a bound on entropy — that is the word list's — but on repetition. A
    // generator returning the same value twice would pass every other check
    // here and hand two people one credential.
    expect(new Set(Array.from({ length: 500 }, () => generatePassword())).size).toBe(500)
  })

  it('an address is checked only enough to refuse what cannot be one', () => {
    expect(looksLikeEmail('dana@example.test')).toBe(true)
    expect(looksLikeEmail('dana+tag@sub.example.co.uk')).toBe(true)
    // A uuid or a name typed into the wrong field, which is what this catches.
    expect(looksLikeEmail('99999999-9999-4999-8999-999999999901')).toBe(false)
    expect(looksLikeEmail('Dana')).toBe(false)
    expect(looksLikeEmail('dana@example')).toBe(false)
    expect(looksLikeEmail('two words@example.test')).toBe(false)
  })
})

when('users and groups, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    users = new PostgresUsers(pool, 'nacre_app')
    groups = new PostgresGroups(pool, 'nacre_app')

    const c = await pool.connect()
    try {
      for (const [id, slug] of [
        [ORG, 'principalsone'],
        [OTHER, 'principalstwo'],
      ] as const) {
        await c.query(
          `INSERT INTO organizations (id, slug, name, vector_collection)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, slug, slug, `org_${slug}`],
        )
      }
      // Order matters: grants and memberships reference the rows below them.
      await c.query('DELETE FROM grants WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM group_members WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM groups WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM users WHERE org_id IN ($1,$2)', [ORG, OTHER])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('a created user can be verified against the password it printed, once', async () => {
    const created = (await users.create(admin, 'dana@example.test', 'member'))!
    expect(created.user.hasPassword).toBe(true)

    const stored = await withOrg(
      pool,
      ORG,
      async (c) => {
        const { rows } = await c.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE org_id = $1 AND id = $2',
          [ORG, created.user.id],
        )
        return rows[0]?.password_hash
      },
      { role: 'nacre_app' },
    )

    expect(stored).toBeDefined()
    // The hash verifies and the plaintext is nowhere. Getting this backwards
    // would be invisible from the API: a user created with a hash of the wrong
    // thing looks identical until somebody tries to sign in.
    expect(await verifyPassword(created.password, stored as string)).toBeTruthy()
    expect(stored).not.toContain(created.password)
    expect(JSON.stringify(created.user)).not.toContain(created.password)
  })

  it('a duplicate address is undefined rather than a raised constraint', async () => {
    await users.create(admin, 'dup@example.test', 'member')
    // Not an exception, because a raised constraint inside `withOrg`'s
    // transaction aborts everything after it — recovering would need a
    // savepoint, and the empty result says the same thing without one.
    expect(await users.create(admin, 'dup@example.test', 'member')).toBeUndefined()
  })

  it('resetting a password replaces it, and the old one stops verifying', async () => {
    const created = (await users.create(admin, 'reset@example.test', 'member'))!
    const next = await users.resetPassword(admin, created.user.id)
    // A result rather than `string | undefined`, because absence now has two
    // meanings — no such user here, and a user this surface may not act on.
    expect(next).not.toBe('no-user')
    expect(next).not.toBe('platform-admin')
    const password = (next as { password: string }).password
    expect(password).not.toBe(created.password)

    const stored = await withOrg(
      pool,
      ORG,
      async (c) => {
        const { rows } = await c.query<{ password_hash: string }>(
          'SELECT password_hash FROM users WHERE org_id = $1 AND id = $2',
          [ORG, created.user.id],
        )
        return rows[0]?.password_hash as string
      },
      { role: 'nacre_app' },
    )

    expect(await verifyPassword(password, stored)).toBeTruthy()
    expect(await verifyPassword(created.password, stored)).toBeFalsy()
  })

  it('the last active org_admin can neither be demoted nor disabled', async () => {
    const first = (await users.create(admin, 'root1@example.test', 'org_admin'))!

    // The only one. Both spellings of giving the role up are refused, and they
    // go through one call so that neither can be used to walk around the other.
    expect(await users.update(admin, first.user.id, { role: 'member' })).toBe('last-admin')
    expect(await users.update(admin, first.user.id, { disabled: true })).toBe('last-admin')

    // A second one, and the first is now free to go.
    const second = (await users.create(admin, 'root2@example.test', 'org_admin'))!
    expect(await users.update(admin, first.user.id, { disabled: true })).toBe('updated')

    // And the second is now the last, so the guard follows it rather than
    // being a fact about a particular row.
    expect(await users.update(admin, second.user.id, { role: 'member' })).toBe('last-admin')
  })

  it('a disabled user keeps the instant they were disabled across an unrelated change', async () => {
    const created = (await users.create(admin, 'stamp@example.test', 'member'))!
    expect(await users.update(admin, created.user.id, { disabled: true })).toBe('updated')

    const listed = () =>
      users.list(admin).then((p) => p.items.find((u) => u.id === created.user.id))
    const first = await listed()
    expect(first?.disabledAt).not.toBeNull()

    expect(await users.update(admin, created.user.id, { role: 'org_admin' })).toBe('updated')
    const second = await listed()
    // "Disabled since Tuesday" is the answer an operator wants; re-stamping it
    // on every PATCH would quietly move it.
    expect(second?.disabledAt).toBe(first?.disabledAt)
    expect(second?.role).toBe('org_admin')

    // And re-enabling clears it rather than leaving a row that says both.
    expect(await users.update(admin, created.user.id, { disabled: false })).toBe('updated')
    expect((await listed())?.disabledAt).toBeNull()
  })

  it('a user in another organization is not there at all', async () => {
    const created = (await users.create(admin, 'mine@example.test', 'member'))!
    const asOther = { ...admin, orgId: OTHER }

    expect(await users.update(asOther, created.user.id, { disabled: true })).toBe('no-user')
    // `no-user` and not `platform-admin`: the guard reads a row the other
    // organization cannot see at all, so it never gets as far as a role.
    expect(await users.resetPassword(asOther, created.user.id)).toBe('no-user')
    expect((await users.list(asOther)).items).toHaveLength(0)
  })

  it('membership moves groups_version, which is what makes the cache safe', async () => {
    const group = (await groups.create(admin, 'legal'))!
    const user = (await users.create(admin, 'member@example.test', 'member'))!

    const before = await groupsVersion(ORG)
    expect(await groups.addMember(admin, group.id, { type: 'user', id: user.user.id })).toBe('added')
    const afterAdd = await groupsVersion(ORG)

    // The whole argument for caching a permission input here is structural
    // rather than temporal: the key carries this number, so a membership change
    // composes a different key and the old entry is never asked for again.
    expect(afterAdd).toBeGreaterThan(before)

    // 0018 is what makes this reachable. Before it, NULLS DISTINCT meant the
    // constraint matched nothing and every re-sync doubled the membership.
    expect(await groups.addMember(admin, group.id, { type: 'user', id: user.user.id })).toBe('already')
    const members = await groups.members(admin, group.id)
    expect(members?.items).toHaveLength(1)
    expect(members?.items[0]).toMatchObject({ type: 'user', id: user.user.id, label: 'member@example.test' })

    expect(await groups.removeMember(admin, group.id, { type: 'user', id: user.user.id })).toBe(true)
    expect(await groupsVersion(ORG)).toBeGreaterThan(afterAdd)
  })

  it('a nested group is one member, not its members', async () => {
    const outer = (await groups.create(admin, 'everyone'))!
    const inner = (await groups.create(admin, 'engineering'))!
    const user = (await users.create(admin, 'nested@example.test', 'member'))!

    await groups.addMember(admin, inner.id, { type: 'user', id: user.user.id })
    expect(await groups.addMember(admin, outer.id, { type: 'group', id: inner.id })).toBe('added')

    const listed = await groups.members(admin, outer.id)
    expect(listed?.items).toHaveLength(1)
    // The label is the group's name rather than an email, and flattening here
    // would answer a different question from the one the row holds — the
    // transitive closure is the resolver's and is computed per request.
    expect(listed?.items[0]).toMatchObject({ type: 'group', id: inner.id, label: 'engineering' })
  })

  it('an edge to a principal in another organization is refused', async () => {
    const group = (await groups.create(admin, 'crosstenant'))!
    const theirs = (await users.create({ ...admin, orgId: OTHER }, 'theirs@example.test', 'member'))!

    // The composite foreign key from 0002 is what makes this impossible; this
    // is what makes it a 404 rather than a 500. Both matter — a raised
    // constraint inside the transaction aborts everything after it.
    expect(await groups.addMember(admin, group.id, { type: 'user', id: theirs.user.id })).toBe('no-member')
  })

  it('deleting a group takes its grants and its edges with it', async () => {
    const group = (await groups.create(admin, 'temporary'))!
    const user = (await users.create(admin, 'temp@example.test', 'member'))!
    await groups.addMember(admin, group.id, { type: 'user', id: user.user.id })

    await withOrg(
      pool,
      ORG,
      (c) =>
        c.query(
          `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission)
           VALUES ($1,'group',$2,'workspace',$3,'read')`,
          [ORG, group.id, '99999999-9999-4999-8999-9999999999aa'],
        ),
      { role: 'nacre_app' },
    )

    expect(await groups.remove(admin, group.id)).toBe(true)

    const left = await withOrg(
      pool,
      ORG,
      async (c) => {
        const grants = await c.query(
          `SELECT 1 FROM grants WHERE org_id = $1 AND principal_type = 'group' AND principal_id = $2`,
          [ORG, group.id],
        )
        const edges = await c.query('SELECT 1 FROM group_members WHERE org_id = $1 AND group_id = $2', [
          ORG,
          group.id,
        ])
        return { grants: grants.rows.length, edges: edges.rows.length }
      },
      { role: 'nacre_app' },
    )

    // Nothing removes the grants for us: `principal_id` addresses three tables,
    // so it is a bare uuid with no foreign key. A row left behind is one
    // `GET /v1/grants` lists and nobody can resolve.
    expect(left).toEqual({ grants: 0, edges: 0 })

    // And the user is still there. Deleting a group is not a way to remove
    // people from the organization.
    expect((await users.list(admin)).items.some((u) => u.id === user.user.id)).toBe(true)
  })

  it('a listing walks to its end rather than repeating its first page', async () => {
    // The bug this repository has already had twice: `timestamptz` holds
    // microseconds and a JavaScript `Date` holds milliseconds, so a truncated
    // bound is strictly less than the row it came from and the seek matches it
    // again. Only walking a collection to its end catches a cursor that does
    // not move, and asking for one page does not.
    for (let i = 0; i < 5; i += 1) await groups.create(admin, `page-${String(i)}`)

    const seen = new Set<string>()
    let cursor: string | undefined
    for (let guard = 0; guard < 50; guard += 1) {
      const page: { items: readonly { id: string }[]; nextCursor: string | null } =
        await groups.list(admin, {
          limit: 1,
          after:
            cursor === undefined
              ? undefined
              : {
                  createdAt: Buffer.from(cursor, 'base64url').toString('utf8').split('|')[0] as string,
                  id: Buffer.from(cursor, 'base64url').toString('utf8').split('|')[1] as string,
                },
        })
      for (const g of page.items) {
        expect(seen.has(g.id)).toBe(false)
        seen.add(g.id)
      }
      if (page.nextCursor === null) break
      cursor = page.nextCursor
    }

    expect(seen.size).toBeGreaterThanOrEqual(5)
  })
})
