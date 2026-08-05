import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresUsers } from '../principals.js'

/**
 * The only administrator cannot lock themselves out.
 *
 * The last-administrator guard was written for one administrator demoting
 * another; the case somebody actually asks about is doing it to yourself, and
 * it is not obviously the same code path — a check phrased as "is there another
 * administrator" and one phrased as "am I the last" differ exactly here. The
 * count excludes the row being changed (`id <> $2`), so self and other reduce to
 * one question, and this is what says so rather than the reader having to
 * derive it from an inequality.
 *
 * Both routes are covered because they are one call: `PATCH {disabled:true}`
 * and `PATCH {role:'member'}` land in `update`, and `DELETE` does too. Two entry
 * points with one check between them is how the guarded one gets walked around.
 *
 * Against a real database: the guard runs in the same transaction as the update
 * it protects, behind `FOR UPDATE`, and a fake of that is a fake of the thing
 * under test.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the lockout guard would go untested.')
}
const ORG = '9a999999-9999-4999-8999-999999999901'
let pool: Pool
let users: PostgresUsers

const when = url ? describe : describe.skip

when('the last administrator cannot lock themselves out', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    users = new PostgresUsers(pool, 'nacre_app')
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'lockoutx','lockoutx','org_lockoutx') ON CONFLICT DO NOTHING`, [ORG])
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM users WHERE org_id = $1', [ORG])
    } finally { c.release() }
  })
  afterAll(async () => { await pool?.end() })

  it('refuses self-disable, self-demote and self-delete for the only admin', async () => {
    const admin = { orgId: ORG, principal: { type: 'user' as const, id: '9a999999-9999-4999-8999-9999999999a1' }, role: 'org_admin' as const }
    const me = (await users.create(admin, 'only@example.test', 'org_admin'))!
    const asMe = { ...admin, principal: { type: 'user' as const, id: me.user.id } }

    expect(await users.update(asMe, me.user.id, { disabled: true })).toBe('last-admin')
    expect(await users.update(asMe, me.user.id, { role: 'member' })).toBe('last-admin')

    // Still an active org_admin afterwards — a refusal that half-applied would
    // be worse than one that did nothing.
    const still = (await users.list(asMe)).items.find((u) => u.id === me.user.id)
    expect(still?.role).toBe('org_admin')
    expect(still?.disabledAt).toBeNull()

    // With a second admin present it goes through, which is what proves the
    // guard is counting rather than refusing everything.
    const second = (await users.create(asMe, 'second@example.test', 'org_admin'))!
    expect(await users.update(asMe, me.user.id, { disabled: true })).toBe('updated')

    // And now the second one is the last, and is refused in turn.
    const asSecond = { ...admin, principal: { type: 'user' as const, id: second.user.id } }
    expect(await users.update(asSecond, second.user.id, { role: 'member' })).toBe('last-admin')
  })
})
