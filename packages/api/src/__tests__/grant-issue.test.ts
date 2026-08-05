import { createPool, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresGrants } from '../adapters.js'
import { PostgresGroups, PostgresUsers } from '../principals.js'
import { PostgresServiceAccounts } from '../service-keys.js'

/**
 * What a grant is allowed to name.
 *
 * `issue` checked that the **scope** exists and never that the **principal**
 * does, so the other half of the same row went on accepting any uuid. The
 * comment beside the scope check spells out why that is wrong, and every word
 * of it is true of the principal: a row that permits nothing and points at
 * nothing, which an administrator meets in `GET /v1/grants` as access somebody
 * appears to have.
 *
 * It is the mistake a form makes, not one somebody has to reach for. Principal
 * type and principal id are two fields; picking `user` while pasting a service
 * account's id inserts cleanly and does nothing, forever.
 *
 * Against a real database, because the check is four SQL statements and a fake
 * of them would be a fake of the thing under test.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; grant issuance would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '77777777-7777-4777-8777-777777777701'
const OTHER = '77777777-7777-4777-8777-777777777702'
const WORKSPACE = '77777777-7777-4777-8777-7777777777aa'
const NOWHERE = '77777777-7777-4777-8777-7777777777ff'

// A real uuid: `contextFor` loads this caller's grants, and the resolver's
// query is typed. A placeholder string raises before the code under test runs.
const ADMIN_ID = '77777777-7777-4777-8777-7777777777a1'
const admin = { orgId: ORG, principal: { type: 'user' as const, id: ADMIN_ID }, role: 'org_admin' as const }

let pool: Pool
let grants: PostgresGrants
let users: PostgresUsers
let groups: PostgresGroups
let accounts: PostgresServiceAccounts

when('issuing a grant, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    grants = new PostgresGrants(pool, 'nacre_app')
    users = new PostgresUsers(pool, 'nacre_app')
    groups = new PostgresGroups(pool, 'nacre_app')
    accounts = new PostgresServiceAccounts(pool, 'nacre_app')

    const c = await pool.connect()
    try {
      for (const [id, slug] of [
        [ORG, 'grantsone'],
        [OTHER, 'grantstwo'],
      ] as const) {
        await c.query(
          `INSERT INTO organizations (id, slug, name, vector_collection)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, slug, slug, `org_${slug}`],
        )
      }
      await c.query('DELETE FROM grants WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM group_members WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM groups WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM service_accounts WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM users WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'default','Default')
         ON CONFLICT DO NOTHING`,
        [WORKSPACE, ORG],
      )
      // The caller has to exist. `service_accounts.created_by` references
      // `users(id)` since 0023, so an admin context naming an id with no row
      // behind it can no longer create one — which is the constraint working,
      // not a fixture inconvenience: in a deployment the id comes from a
      // token's subject and the row is always there.
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$2,'admin@example.test','org_admin')
         ON CONFLICT DO NOTHING`,
        [ADMIN_ID, ORG],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  const rows = async (): Promise<number> =>
    withOrg(
      pool,
      ORG,
      async (c) => {
        const { rows: found } = await c.query('SELECT 1 FROM grants WHERE org_id = $1', [ORG])
        return found.length
      },
      { role: 'nacre_app' },
    )

  it('a grant to each kind of principal that is here is issued', async () => {
    const user = (await users.create(admin, 'grantee@example.test', 'member'))!
    const group = (await groups.create(admin, 'grantees'))!
    const account = (await accounts.create(admin, 'grant-agent'))!

    for (const [type, id] of [
      ['user', user.user.id],
      ['group', group.id],
      ['service_account', account.account.id],
    ] as const) {
      const issued = await grants.issue(admin, {
        principalType: type,
        principalId: id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      })
      expect(issued, `${type} should be grantable`).toBeDefined()
    }
  })

  it('refuses a principal that is not here, rather than storing a row that does nothing', async () => {
    const before = await rows()

    const issued = await grants.issue(admin, {
      principalType: 'user',
      principalId: NOWHERE,
      scopeType: 'workspace',
      scopeId: WORKSPACE,
      permission: 'read',
    })

    expect(issued).toBeUndefined()
    // The assertion that matters: nothing was written. Returning undefined
    // while inserting would be the same defect wearing a better answer.
    expect(await rows()).toBe(before)
  })

  it('refuses the right id under the wrong principal type', async () => {
    // The exact shape a form produces: the type defaults to `user` and the id
    // was copied from the service accounts screen. It inserts cleanly and
    // resolves to nothing, because nobody is a `user` with that id.
    const account = (await accounts.create(admin, 'typo-agent'))!
    const before = await rows()

    expect(
      await grants.issue(admin, {
        principalType: 'user',
        principalId: account.account.id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      }),
    ).toBeUndefined()
    expect(await rows()).toBe(before)

    // And the same id under the type it actually is goes through.
    expect(
      await grants.issue(admin, {
        principalType: 'service_account',
        principalId: account.account.id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      }),
    ).toBeDefined()
  })

  it("refuses a principal from another organization", async () => {
    const theirs = (await users.create({ ...admin, orgId: OTHER }, 'theirs@example.test', 'member'))!
    const before = await rows()

    // Not a leak either way — the pre-filter's unconditional `must: org_id`
    // holds — but a grant naming a principal this organization cannot look up
    // makes `404` stop meaning what invariant 4 says it means.
    expect(
      await grants.issue(admin, {
        principalType: 'user',
        principalId: theirs.user.id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      }),
    ).toBeUndefined()
    expect(await rows()).toBe(before)
  })

  it('refuses a revoked service account, and keeps a disabled user', async () => {
    const account = (await accounts.create(admin, 'retired-agent'))!
    await accounts.revoke(admin, account.account.id)

    // Its key stopped working and is never reissued, so a grant to it can never
    // be exercised.
    expect(
      await grants.issue(admin, {
        principalType: 'service_account',
        principalId: account.account.id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      }),
    ).toBeUndefined()

    // A disabled user is the other way round: disabling is reversible, and the
    // grant is meant to survive it.
    const user = (await users.create(admin, 'onleave@example.test', 'member'))!
    await users.update(admin, user.user.id, { disabled: true })
    expect(
      await grants.issue(admin, {
        principalType: 'user',
        principalId: user.user.id,
        scopeType: 'workspace',
        scopeId: WORKSPACE,
        permission: 'read',
      }),
    ).toBeDefined()
  })

  it('still refuses a scope that is not here', async () => {
    // The check this one was modelled on, so it keeps its own test.
    expect(
      await grants.issue(admin, {
        principalType: 'user',
        principalId: (await users.create(admin, 'scoped@example.test', 'member'))!.user.id,
        scopeType: 'layer',
        scopeId: NOWHERE,
        permission: 'read',
      }),
    ).toBeUndefined()
  })
})
