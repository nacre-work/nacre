import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool } from '../db/client.js'
import { provisionInPostgres, provisionOrganization } from '../provision.js'
import { vectorName } from '../vector/query.js'

/**
 * Provisioning an organization.
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

when('provisionInPostgres', () => {
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
    const result = await provisionInPostgres(pool, options, PROVIDER, 'org_inittest')

    expect(result.created).toBe(true)
    expect(result.orgId).toBeTruthy()
    expect(result.userId).toBeTruthy()
    expect(result.workspaceId).toBeTruthy()
  })

  it('a second run changes nothing and says so', async () => {
    const first = await provisionInPostgres(pool, options, PROVIDER, 'org_inittest')
    const second = await provisionInPostgres(pool, options, PROVIDER, 'org_inittest')

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
    const first = await provisionInPostgres(pool, { ...options, passwordHash: STORED_FIRST }, PROVIDER, 'org_inittest')
    expect(first.passwordSet).toBe(true)

    const second = await provisionInPostgres(pool, { ...options, passwordHash: STORED_SECOND }, PROVIDER, 'org_inittest')
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

    const none = await provisionInPostgres(pool, fresh, PROVIDER, 'org_inittest')
    expect(none.passwordSet).toBe(false)

    const set = await provisionInPostgres(pool, { ...fresh, passwordHash: STORED_LATER }, PROVIDER, 'org_inittest')
    expect(set.passwordSet).toBe(true)
  })

  it('the admin is an org_admin, or nothing that follows can grant anything', async () => {
    const { orgId, userId } = await provisionInPostgres(pool, options, PROVIDER, 'org_inittest')

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
    const { orgId, workspaceId } = await provisionInPostgres(pool, options, PROVIDER, 'org_inittest')

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

when('provisionOrganization', () => {
  let pool2: Pool
  const slugs = ['provfirst', 'provsecond']

  beforeAll(async () => {
    pool2 = createPool({ connectionString: url as string })
    const c = await pool2.connect()
    try {
      for (const slug of slugs) await c.query(`DELETE FROM organizations WHERE slug = $1`, [slug])
      // Only providers nothing points at: one a layer is built on cannot be
      // removed, because those vectors were made by it.
      await c.query(
        `DELETE FROM embedding_providers p WHERE p.org_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM layers l WHERE l.provider_id = p.id)`,
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool2?.end()
  })

  /**
   * The collection's slot is named after the provider the organization got,
   * never after the one the caller asked for.
   *
   * These differ the moment an installation default already exists and the
   * configuration has moved since — a second tenant created after somebody
   * changed `NACRE_DEFAULT_EMBEDDING_MODEL`. The failure is completely silent:
   * the collection is created, the organization looks finished, and the worker
   * writes to a named vector the collection does not have, so every document
   * fails forever while the API answers `queued`.
   *
   * Checked against a real PostgreSQL and a real Qdrant before this test was
   * written, by provisioning two organizations either side of a model change.
   */
  it('names the collection slot after the provider that was resolved', async () => {
    const asked: string[] = []
    const vectors = {
      ensureCollection: async (slug: string, vector: string, size: number) => {
        asked.push(`${slug}:${vector}:${String(size)}`)
        return `org_${slug}`
      },
    }
    const slot = (r: { provider: { model: string; dimensions: number } }) =>
      vectorName(r.provider.model, r.provider.dimensions)

    // Two organizations asking for two different models. Deliberately not
    // asserted against a particular starting state: the installation default is
    // global, so a suite sharing this database cannot arrange for there to be
    // none, and a test that needed one would pass or fail on run order.
    const first = { endpoint: 'http://embedder.test', model: 'bge-m3', dimensions: 8 }
    const second = { endpoint: 'http://embedder.test', model: 'nothing-else-uses-this', dimensions: 16 }

    const a = await provisionOrganization(
      pool2,
      vectors,
      { slug: slugs[0] as string, name: 'First', email: 'a@prov.test', workspace: 'default' },
      first,
    )
    const b = await provisionOrganization(
      pool2,
      vectors,
      { slug: slugs[1] as string, name: 'Second', email: 'b@prov.test', workspace: 'default' },
      second,
    )

    // Created once and reused, which is what a NULL-`org_id` row is for. So the
    // second organization does not get the model its request named.
    expect(b.provider).toEqual(a.provider)
    expect(b.provider.model).not.toBe(second.model)

    // The invariant. Whatever was resolved, that is what the slot is called —
    // built from the *request* instead, this collection would carry a slot no
    // layer will ever write to, every document would fail in the worker
    // forever, and the API would answer `queued`. Reproduced exactly that way
    // against a real PostgreSQL and a real Qdrant before this was written.
    expect(asked[0]).toBe(`${slugs[0] as string}:${slot(a)}:${String(a.provider.dimensions)}`)
    expect(asked[1]).toBe(`${slugs[1] as string}:${slot(b)}:${String(b.provider.dimensions)}`)
    expect(asked[1]).not.toContain(vectorName(second.model, second.dimensions))
  })

  it('writes the collection it reports into organizations.vector_collection', async () => {
    // Read by every write and every search. A tenant whose row disagrees with
    // the collection that exists is a tenant whose every search fails.
    const c = await pool2.connect()
    try {
      const { rows } = await c.query<{ slug: string; vector_collection: string }>(
        `SELECT slug, vector_collection FROM organizations WHERE slug = ANY($1)`,
        [slugs],
      )
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.vector_collection).toBe(`org_${row.slug}`)
    } finally {
      c.release()
    }
  })
})
