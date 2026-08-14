import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresUsers } from '../principals.js'

/**
 * A `platform_admin` is not administered from inside an organization.
 *
 * `POST /v1/users` and `PATCH /v1/users/{id}` have always refused to *set* that
 * role, because this surface is scoped to one organization and the role spans
 * all of them — so issuing one here would be an escalation out of the scope
 * doing the issuing. Neither looked at the role it was *replacing*, and the
 * argument applies with the same force in that direction: an `org_admin` could
 * demote a platform administrator who happened to live in their organization,
 * disable them, delete them, or reset their password.
 *
 * **The reset is the one that is not a demotion.** It returns the plaintext, so
 * it is a takeover of the account that administers the installation, performed
 * from an endpoint scoped to one tenant by somebody who administers only that
 * tenant. That is why the assertion here is on `password_hash` being untouched
 * rather than only on the answer: a guard that refuses after writing the row
 * has already handed over the account.
 *
 * Against a real database, on `nacre_app`, because the guard is a read in the
 * same transaction as the write it protects and a fake of that is a fake of the
 * thing under test.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; this guard would go untested.')
}

const ORG = '9a999999-9999-4999-8999-999999999902'
const CALLER = '9a999999-9999-4999-8999-9999999999b1'
let pool: Pool
let users: PostgresUsers
/** The one the surface may not touch, and an ordinary user beside it. */
let target: string
let ordinary: string

const when = url ? describe : describe.skip

const admin = {
  orgId: ORG,
  principal: { type: 'user' as const, id: CALLER },
  role: 'org_admin' as const,
}

async function stored(id: string): Promise<{ role: string; hash: string | null; disabled: Date | null }> {
  const c = await pool.connect()
  try {
    const { rows } = await c.query<{ role: string; password_hash: string | null; disabled_at: Date | null }>(
      'SELECT role, password_hash, disabled_at FROM users WHERE id = $1',
      [id],
    )
    const row = rows[0] as { role: string; password_hash: string | null; disabled_at: Date | null }
    return { role: row.role, hash: row.password_hash, disabled: row.disabled_at }
  } finally {
    c.release()
  }
}

when('a platform_admin cannot be administered from inside an organization', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    users = new PostgresUsers(pool, 'nacre_app')
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'ptargetx','ptargetx','org_ptargetx') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM users WHERE org_id = $1', [ORG])

      // Inserted rather than created through the port, because the port cannot
      // make one — which is the whole reason this role is dangerous to leave
      // reachable from here. A real installation gets it from a command run by
      // whoever holds the database credentials.
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'root@example.test','platform_admin','scrypt$original-hash-standing-in-for-a-real-one')
         RETURNING id`,
        [ORG],
      )
      target = (rows[0] as { id: string }).id
    } finally {
      c.release()
    }

    // A second administrator, so nothing below can be confused with the
    // last-administrator refusal — that guard answers on a different path and
    // for a different reason.
    await users.create(admin, 'other@example.test', 'org_admin')
    ordinary = (await users.create(admin, 'ordinary@example.test', 'member'))!.user.id
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('refuses to demote one, and the row is unchanged', async () => {
    expect(await users.update(admin, target, { role: 'member' })).toBe('platform-admin')
    expect((await stored(target)).role).toBe('platform_admin')
  })

  it('refuses to disable or delete one, which are the same call', async () => {
    expect(await users.update(admin, target, { disabled: true })).toBe('platform-admin')
    expect((await stored(target)).disabled).toBeNull()
  })

  /**
   * The important one. The answer being a refusal is not the property — the
   * property is that the stored hash is the one it was, so nobody holds a
   * password for this account that they did not have before the request.
   */
  it('refuses a password reset without writing a hash', async () => {
    const before = await stored(target)
    expect(await users.resetPassword(admin, target)).toBe('platform-admin')
    expect((await stored(target)).hash).toBe(before.hash)
    expect(before.hash).toBe('scrypt$original-hash-standing-in-for-a-real-one')
  })

  /**
   * A guard that refuses everything is not a guard. Every path still works on
   * somebody this surface does administer, and the reset still returns a
   * password on that path — which is what says the refusal is about the target
   * and not about the code having stopped functioning.
   */
  it('still administers everybody else', async () => {
    expect(await users.update(admin, ordinary, { role: 'org_admin' })).toBe('updated')
    expect((await stored(ordinary)).role).toBe('org_admin')

    const reset = await users.resetPassword(admin, ordinary)
    expect(typeof reset === 'object' && reset.password.length > 0).toBe(true)

    expect(await users.update(admin, ordinary, { disabled: true })).toBe('updated')
    expect((await stored(ordinary)).disabled).not.toBeNull()
  })

  it('still answers no-user for an id that is not here, and never platform-admin', async () => {
    const absent = '9a999999-9999-4999-8999-9999999999ff'
    expect(await users.update(admin, absent, { role: 'member' })).toBe('no-user')
    expect(await users.resetPassword(admin, absent)).toBe('no-user')
    // A malformed id took an early return before the guard existed; it still
    // has to, and it has to be the same answer as an absent one.
    expect(await users.resetPassword(admin, 'not-a-uuid')).toBe('no-user')
  })
})
