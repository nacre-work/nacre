import type { Pool, PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'

const url = process.env.NACRE_PG_URL

/**
 * `embedding_providers` is the one tenant table where a NULL `org_id` is
 * legitimate — it is the installation-wide default model, readable by every
 * organization. Migration 0002 meant to allow that read and forbid the write,
 * and the write policy it added was PERMISSIVE, so it was OR'd with the read
 * policy and forbade nothing: a tenant-scoped `nacre_app` connection could
 * INSERT, UPDATE and DELETE the global row. 0019 makes the write policies
 * RESTRICTIVE. These cases assert both halves against a real database, because
 * the behaviour is Postgres policy composition and a fake would be testing the
 * fake.
 *
 * Every case runs inside one transaction that is always rolled back, seeding
 * its own org and global row through `nacre_worker` (the bootstrap path init
 * uses, and the only way a NULL-org_id row can be written now). Nothing is
 * committed, so the suite is order-independent and leaves the shared database
 * exactly as it found it — no cleanup, no foreign-key entanglement with the
 * layers other cases create.
 */
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. This case would silently skip, and ' +
      'acl-invariants would report green having checked none of the RLS it covers.',
  )
}

const when = url ? describe : describe.skip

const ORG = '33333333-3333-3333-3333-333333333333'
const GLOBAL = '00000000-0000-0000-0000-0000000000e0'

let pool: Pool

/**
 * Open a transaction, seed an organization and the global default as
 * `nacre_worker`, then hand the caller a client already switched to
 * `nacre_app` and scoped to ORG. Always rolled back.
 */
async function inTenantTx<T>(body: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    await c.query('SET LOCAL ROLE nacre_worker')
    await c.query(
      `INSERT INTO organizations (id, slug, name, vector_collection)
       VALUES ($1,'org-e','E','org_e') ON CONFLICT (id) DO NOTHING`,
      [ORG],
    )
    await c.query(
      `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
       VALUES ($1, NULL, 'default', 'http://embedder:80', 'bge-m3', 1024)
       ON CONFLICT (id) DO NOTHING`,
      [GLOBAL],
    )
    await c.query('SET LOCAL ROLE nacre_app')
    await c.query('SELECT set_config($1,$2,true)', ['app.current_org', ORG])
    return await body(c)
  } finally {
    await c.query('ROLLBACK').catch(() => undefined)
    c.release()
  }
}

when('embedding_providers · the installation default is read-only to a tenant', () => {
  beforeAll(() => {
    pool = createPool({ connectionString: url as string })
  })
  afterAll(async () => {
    await pool.end()
  })

  it('lets a tenant read the global default', async () => {
    const seen = await inTenantTx(async (c) => {
      const r = await c.query(`SELECT id FROM embedding_providers WHERE org_id IS NULL`)
      return r.rowCount ?? 0
    })
    expect(seen).toBeGreaterThanOrEqual(1)
  })

  it('refuses a tenant INSERT of a new global row', async () => {
    await expect(
      inTenantTx((c) =>
        c.query(
          `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
           VALUES (NULL, 'evil', 'http://evil:80', 'x', 8)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('matches no rows on a tenant UPDATE of the global, and leaves it unchanged', async () => {
    const { affected, endpoint } = await inTenantTx(async (c) => {
      const u = await c.query(
        `UPDATE embedding_providers SET endpoint='http://evil:80' WHERE org_id IS NULL`,
      )
      // Read the row back as the bypass role in the same transaction — the
      // tenant cannot even see whether its write landed, which is the point.
      await c.query('SET LOCAL ROLE nacre_worker')
      const r = await c.query<{ endpoint: string }>(
        `SELECT endpoint FROM embedding_providers WHERE id = $1`,
        [GLOBAL],
      )
      return { affected: u.rowCount ?? -1, endpoint: r.rows[0]?.endpoint }
    })
    expect(affected).toBe(0)
    expect(endpoint).toBe('http://embedder:80')
  })

  it('matches no rows on a tenant DELETE of the global row', async () => {
    const affected = await inTenantTx(async (c) => {
      const d = await c.query(`DELETE FROM embedding_providers WHERE org_id IS NULL`)
      return d.rowCount ?? -1
    })
    expect(affected).toBe(0)
  })

  it("still lets a tenant write its own organization's provider", async () => {
    const affected = await inTenantTx(async (c) => {
      const i = await c.query(
        `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
         VALUES ($1, 'mine', 'http://mine:80', 'm', 8)`,
        [ORG],
      )
      return i.rowCount ?? -1
    })
    expect(affected).toBe(1)
  })
})
