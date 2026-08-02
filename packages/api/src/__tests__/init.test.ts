import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { initialize, parseArgs } from '../init.js'

/**
 * Creating the first organization.
 *
 * Idempotency is the property under test and the one that regresses without
 * anyone noticing, because a second run of something non-idempotent usually
 * still exits zero — it just leaves two organizations, or two providers, and
 * the failure surfaces days later as a search that returns nothing.
 *
 * A half-finished first install is the normal case rather than the unlucky one:
 * the collection created and the process killed before the workspace, a
 * connection dropped mid-run, an operator who is not sure whether it worked and
 * runs it again. All of those have to converge.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the init path would go untested.')
}
const when = url ? describe : describe.skip

const PROVIDER = { endpoint: 'http://embedder.test', model: 'bge-m3', dimensions: 8 }
const options = {
  slug: 'inittest',
  name: 'Init Test',
  email: 'admin@inittest.test',
  workspace: 'default',
}

// Stand-ins for a stored scrypt record. Sixteen characters at least — the
// schema refuses a shorter one, which is a floor against a column that got a
// truncated value rather than a hash.
const STORED_FIRST = 'scrypt$n=16384$first-run-hash'
const STORED_SECOND = 'scrypt$n=16384$second-run-hash'
const STORED_LATER = 'scrypt$n=16384$later-run-hash'

let pool: Pool

describe('parseArgs', () => {
  it('requires an organization and an email', () => {
    expect(parseArgs([])).toMatch(/usage/)
    expect(parseArgs(['--org', 'acme'])).toMatch(/usage/)
    expect(parseArgs(['--email', 'a@b.test'])).toMatch(/usage/)
  })

  it('defaults the display name and the workspace', () => {
    const parsed = parseArgs(['--org', 'acme', '--email', 'a@b.test'])
    expect(parsed).toMatchObject({ slug: 'acme', name: 'acme', workspace: 'default' })
  })

  it('refuses a slug that would not survive being a collection name', () => {
    // The slug becomes the Qdrant collection, so this is not a matter of taste.
    // A slug with a slash or a quote in it reaches a URL path and a JSON body.
    for (const bad of ['Acme', 'a', 'has space', 'has/slash', '-leading', 'trailing-', 'x'.repeat(41)]) {
      expect(parseArgs(['--org', bad, '--email', 'a@b.test']), bad).toMatch(/--org must be/)
    }
    for (const good of ['ac', 'acme', 'acme-corp', 'a1-b2', 'x'.repeat(40)]) {
      expect(parseArgs(['--org', good, '--email', 'a@b.test']), good).toMatchObject({ slug: good })
    }
  })

  it('refuses an address that is not one, and an odd argument list', () => {
    expect(parseArgs(['--org', 'acme', '--email', 'nobody'])).toMatch(/does not look like/)
    expect(parseArgs(['--org'])).toMatch(/usage/)
    expect(parseArgs(['acme', 'a@b.test'])).toMatch(/usage/)
  })
})

when('initialize', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    // Start from nothing, so "created" means created.
    const c = await pool.connect()
    try {
      await c.query(`DELETE FROM organizations WHERE slug = $1`, [options.slug])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('creates the organization, the admin, a provider and a workspace', async () => {
    const result = await initialize(pool, options, PROVIDER, 'org_inittest')

    expect(result.created).toBe(true)
    expect(result.orgId).toBeTruthy()
    expect(result.userId).toBeTruthy()
    expect(result.workspaceId).toBeTruthy()
  })

  it('a second run changes nothing and says so', async () => {
    const first = await initialize(pool, options, PROVIDER, 'org_inittest')
    const second = await initialize(pool, options, PROVIDER, 'org_inittest')

    expect(second.created).toBe(false)
    expect(second.orgId).toBe(first.orgId)
    expect(second.userId).toBe(first.userId)
    expect(second.workspaceId).toBe(first.workspaceId)

    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM organizations WHERE slug = $1`,
        [options.slug],
      )
      expect(rows[0]?.n).toBe('1')
    } finally {
      c.release()
    }
  })

  it('says whether it set the password, and a second run says it did not', async () => {
    // The caller has a plaintext in hand on every run and only sometimes owns
    // it. Printing one the database did not accept is the most damaging thing
    // this command can say: an operator writes it down, discards the one that
    // works, and finds out an hour later when the token expires.
    const first = await initialize(pool, { ...options, passwordHash: STORED_FIRST }, PROVIDER, 'org_inittest')
    expect(first.passwordSet).toBe(true)

    const second = await initialize(pool, { ...options, passwordHash: STORED_SECOND }, PROVIDER, 'org_inittest')
    expect(second.passwordSet).toBe(false)

    // And the stored hash is still the first one. The report and the row have
    // to agree — a truthful `false` over a password that was quietly reset
    // would be the same bug wearing the other mask.
    const c = await pool.connect()
    try {
      await c.query('SELECT set_config($1, $2, false)', ['app.current_org', second.orgId])
      const { rows } = await c.query<{ password_hash: string }>(
        `SELECT password_hash FROM users WHERE id = $1`,
        [second.userId],
      )
      expect(rows[0]?.password_hash).toBe(STORED_FIRST)
    } finally {
      c.release()
    }
  })

  it('sets a password on an administrator who had none, rather than never', async () => {
    // The other half of the same COALESCE. An organization created before
    // passwords existed, or by a run that passed none, must still be able to
    // get one — otherwise "it is not printed again" becomes "there is no way
    // to have one".
    // Its own address, because the tests above share one row and this needs an
    // administrator who has never had a password rather than one who has.
    const fresh = { ...options, email: 'nopassword@inittest.test' }

    const none = await initialize(pool, fresh, PROVIDER, 'org_inittest')
    expect(none.passwordSet).toBe(false)

    const set = await initialize(pool, { ...fresh, passwordHash: STORED_LATER }, PROVIDER, 'org_inittest')
    expect(set.passwordSet).toBe(true)
  })

  it('the admin is an org_admin, or nothing that follows can grant anything', async () => {
    const { orgId, userId } = await initialize(pool, options, PROVIDER, 'org_inittest')

    const c = await pool.connect()
    try {
      await c.query('SELECT set_config($1, $2, false)', ['app.current_org', orgId])
      const { rows } = await c.query<{ role: string }>(`SELECT role FROM users WHERE id = $1`, [userId])
      // A member here would leave the installation with no way to issue the
      // first grant — every scope check would deny, and the only route back
      // would be SQL by hand, which is the thing this command exists to remove.
      expect(rows[0]?.role).toBe('org_admin')
    } finally {
      c.release()
    }
  })

  it('the workspace it reports is real and belongs to the organization', async () => {
    const { orgId, workspaceId } = await initialize(pool, options, PROVIDER, 'org_inittest')

    const c = await pool.connect()
    try {
      await c.query('SELECT set_config($1, $2, false)', ['app.current_org', orgId])
      const { rows } = await c.query<{ org_id: string }>(
        `SELECT org_id FROM workspaces WHERE id = $1`,
        [workspaceId],
      )
      // It is printed for the operator to paste into the next command. A
      // workspace id that does not resolve makes the whole page fail at step
      // one, with a 404 that reads as a permission problem.
      expect(rows[0]?.org_id).toBe(orgId)
    } finally {
      c.release()
    }
  })
})
