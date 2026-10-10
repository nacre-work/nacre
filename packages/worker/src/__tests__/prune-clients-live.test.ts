import { randomBytes } from 'node:crypto'

import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pruneUnapprovedClients, UNAPPROVED_CLIENT_DAYS } from '../adapters.js'

/**
 * OAuth clients nobody approved are swept, and nothing else is — against a real
 * PostgreSQL, under the worker's own role.
 *
 * A database rather than a fake because the whole rule is the statement: two
 * `NOT EXISTS` over tables under FORCEd row-level security, read by a role that
 * bypasses it, and a DELETE that cascades into both. A fake would assert the
 * predicate I wrote back at me, and the failure that matters — a client somebody
 * approved disappearing, taking the connection with it — raises nothing
 * anywhere. So does the other one: a sweep that never deletes anything leaves
 * open registration bounded by nothing.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the unapproved-client sweep would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '0a444444-4444-4444-8444-444444444401'
const ADMIN = '0a444444-4444-4444-8444-4444444444a1'

let pool: Pool
const made: string[] = []

/** A registered client whose last sign of life was `daysAgo` days back. */
async function client(daysAgo: number, seen: 'created' | 'last_seen' = 'created'): Promise<string> {
  const id = `nacre_client_prune_${randomBytes(6).toString('hex')}`
  made.push(id)
  await pool.query(
    seen === 'created'
      ? `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
         VALUES ($1, 'test', ARRAY['http://127.0.0.1:1/cb'], now() - make_interval(days => $2))`
      : `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at, last_seen_at)
         VALUES ($1, 'test', ARRAY['http://127.0.0.1:1/cb'], now() - interval '400 days', now() - make_interval(days => $2))`,
    [id, daysAgo],
  )
  return id
}

async function exists(clientId: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM oauth_clients WHERE client_id = $1', [clientId])
  return rows.length === 1
}

/** Sweep until a pass removes nothing, so other files' leftovers cannot make a count flaky. */
async function sweep(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if ((await pruneUnapprovedClients(pool, 1000)) === 0) return
  }
}

when('the unapproved-client sweep, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    await pool.query(
      `INSERT INTO organizations (id, slug, name, vector_collection)
       VALUES ($1, 'pruneclients', 'pruneclients', 'org_pruneclients') ON CONFLICT DO NOTHING`,
      [ORG],
    )
    await pool.query(
      `INSERT INTO users (id, org_id, email, role)
       VALUES ($1, $2, 'pruneclients@example.test', 'org_admin') ON CONFLICT DO NOTHING`,
      [ADMIN, ORG],
    )
  })

  afterAll(async () => {
    if (pool === undefined) return
    await pool.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
    await pool.query('DELETE FROM oauth_clients WHERE client_id = ANY($1)', [made])
    await pool.end()
  })

  it('removes a client nobody approved once it has not been seen for the window', async () => {
    const stale = await client(UNAPPROVED_CLIENT_DAYS + 1)
    const lastSeenStale = await client(UNAPPROVED_CLIENT_DAYS + 1, 'last_seen')
    await sweep()
    expect(await exists(stale)).toBe(false)
    expect(await exists(lastSeenStale)).toBe(false)
  })

  it('keeps a client inside the window, by creation or by last sight', async () => {
    // The second is the case `last_seen_at` exists for: registered long ago,
    // being approved today. Created 400 days back and seen yesterday is not old.
    const fresh = await client(UNAPPROVED_CLIENT_DAYS - 1)
    const seenRecently = await client(1, 'last_seen')
    await sweep()
    expect(await exists(fresh)).toBe(true)
    expect(await exists(seenRecently)).toBe(true)
  })

  it('never removes a client somebody approved, however old', async () => {
    // A revoked consent too: the row is the record of what was approved, and
    // the Connections screen and the access log both join on the client.
    const approved = await client(400)
    const revoked = await client(400)
    for (const [id, revokedAt] of [
      [approved, null],
      [revoked, new Date()],
    ] as const) {
      await pool.query(
        `INSERT INTO oauth_consents (org_id, client_id, service_account_id, approved_by, acts_as, surface, revoked_at)
         VALUES ($1, $2, NULL, $3, 'user', 'default', $4)`,
        [ORG, id, ADMIN, revokedAt],
      )
    }
    await sweep()
    expect(await exists(approved)).toBe(true)
    expect(await exists(revoked)).toBe(true)
  })

  it('is bounded by its batch', async () => {
    const a = await client(UNAPPROVED_CLIENT_DAYS + 30)
    const b = await client(UNAPPROVED_CLIENT_DAYS + 20)
    // Oldest first, so repeated passes converge rather than revisiting a window.
    expect(await pruneUnapprovedClients(pool, 1)).toBe(1)
    await sweep()
    expect(await exists(a)).toBe(false)
    expect(await exists(b)).toBe(false)
  })
})
