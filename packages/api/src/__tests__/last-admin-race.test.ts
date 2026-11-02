import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresUsers } from '../principals.js'

/**
 * Security audit 2026-11-01, LOW finding
 * api/principals.ts:PostgresUsers.update:last-admin-count-write-skew.
 *
 * The last-administrator guard locks only the *target* row `FOR UPDATE`
 * (`onTargetUser`) and then counts the organization's other active
 * `org_admin`s with a plain `SELECT` at the database's default READ
 * COMMITTED. The invariant — at least one active `org_admin` — spans every
 * row in the organization, so locking one row per transaction cannot
 * serialize two writers who each target a *different* administrator: two
 * concurrent demotions of two different people each lock a different row,
 * neither waits, and each counts the other administrator as still active
 * because the other transaction has not committed yet. Both pass the guard
 * and both commit, leaving zero. The sibling file, `last-admin-self.test.ts`,
 * covers the case the comment there actually proves — one administrator
 * acting on one row, sequentially — and says nothing about two.
 *
 * `onTargetUser` now takes a transaction-scoped advisory lock keyed on the
 * organization before it reads anything, so the second of two concurrent
 * changes to this organization's users waits for the first to commit and
 * then sees its result rather than a stale count.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the last-admin race would go untested.')
}
// Two organizations, one per test: each test races its own pair down to the
// boundary, and a leftover active admin from an earlier test in a shared
// organization would silently raise the count the next race depends on.
//
// A different prefix from the sibling last-admin files on purpose —
// `9a999999…9902` collides with `platform-admin-target.test.ts`'s own fixture
// org and caller id, and vitest runs test files concurrently against the
// same database by default, so that collision showed up as this file's own
// race failing nondeterministically for a reason that had nothing to do with
// the lock under test.
const ORG_DEMOTE = '9a777777-7777-4777-8777-777777770001'
const ORG_DISABLE = '9a777777-7777-4777-8777-777777770002'
let pool: Pool
let users: PostgresUsers

const when = url ? describe : describe.skip

const adminOf = (orgId: string) => ({
  orgId,
  principal: { type: 'user' as const, id: '9a777777-7777-4777-8777-7777777700b1' },
  role: 'org_admin' as const,
})

async function seedOrg(orgId: string, slug: string): Promise<void> {
  const c = await pool.connect()
  try {
    // By slug first, and not only by id: a run of this file under an
    // earlier revision of its own fixture ids left a row at the *old* id
    // with this same slug, so `ON CONFLICT DO NOTHING` on the id silently
    // skipped the insert for the new one and every later statement failed
    // its `org_id` foreign key. Deleting by slug makes this idempotent
    // against whichever id a previous run of this exact fixture used.
    await c.query('DELETE FROM organizations WHERE slug = $1::text AND id <> $2', [slug, orgId])
    await c.query(
      `INSERT INTO organizations (id, slug, name, vector_collection)
       VALUES ($1,$2::text,$2::text,'org_' || $2::text) ON CONFLICT DO NOTHING`,
      [orgId, slug],
    )
    await c.query('DELETE FROM grants WHERE org_id = $1', [orgId])
    await c.query('DELETE FROM users WHERE org_id = $1', [orgId])
  } finally {
    c.release()
  }
}

when('the last-administrator guard against two concurrent writers', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    users = new PostgresUsers(pool, 'nacre_app')
    await seedOrg(ORG_DEMOTE, 'adminrace-demote')
    await seedOrg(ORG_DISABLE, 'adminrace-disable')
  })
  afterAll(async () => {
    await pool?.end()
  })

  it('two administrators demoting each other at once leave exactly one active, never zero', async () => {
    const admin = adminOf(ORG_DEMOTE)
    const seed = (await users.create(admin, 'bootstrap@example.test', 'org_admin'))!
    const asBootstrap = { ...admin, principal: { type: 'user' as const, id: seed.user.id } }
    const a = (await users.create(asBootstrap, 'race-a@example.test', 'org_admin'))!.user.id
    const b = (await users.create(asBootstrap, 'race-b@example.test', 'org_admin'))!.user.id
    // The bootstrap account only exists to create A and B; with three active
    // administrators disabling it goes through, leaving the organization
    // with exactly the two the audit's own reproduction raced.
    expect(await users.update(asBootstrap, seed.user.id, { disabled: true })).toBe('updated')

    const asA = { ...admin, principal: { type: 'user' as const, id: a } }
    const asB = { ...admin, principal: { type: 'user' as const, id: b } }

    // Fired together rather than sequentially, so Postgres's own lock queue —
    // not this test's timing — decides which one lands first.
    const [resultA, resultB] = await Promise.all([
      users.update(asA, b, { role: 'member' }),
      users.update(asB, a, { role: 'member' }),
    ])

    // Exactly one of the two demotions goes through; the other is refused as
    // the last administrator, whichever order Postgres serialized them in.
    const outcomes = [resultA, resultB].sort()
    expect(outcomes).toEqual(['last-admin', 'updated'])

    const active = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM users WHERE org_id = $1 AND role = 'org_admin' AND disabled_at IS NULL`,
      [ORG_DEMOTE],
    )
    expect(Number(active.rows[0]?.n)).toBe(1)
  })

  it('one administrator disabling the other and themself at once leaves exactly one active', async () => {
    const admin = adminOf(ORG_DISABLE)
    const seed = (await users.create(admin, 'bootstrap2@example.test', 'org_admin'))!
    const asBootstrap = { ...admin, principal: { type: 'user' as const, id: seed.user.id } }
    const a = (await users.create(asBootstrap, 'race2-a@example.test', 'org_admin'))!.user.id
    const b = (await users.create(asBootstrap, 'race2-b@example.test', 'org_admin'))!.user.id
    expect(await users.update(asBootstrap, seed.user.id, { disabled: true })).toBe('updated')

    const asA = { ...admin, principal: { type: 'user' as const, id: a } }

    const [disableOther, disableSelf] = await Promise.all([
      users.update(asA, b, { disabled: true }),
      users.update(asA, a, { disabled: true }),
    ])

    const outcomes = [disableOther, disableSelf].sort()
    expect(outcomes).toEqual(['last-admin', 'updated'])

    const active = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM users
        WHERE org_id = $1 AND id IN ($2, $3) AND role = 'org_admin' AND disabled_at IS NULL`,
      [ORG_DISABLE, a, b],
    )
    expect(Number(active.rows[0]?.n)).toBe(1)
  })
})
