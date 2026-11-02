import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Login, MAX_UNSCOPED_ORG_SCAN } from '../login.js'

/**
 * A no-slug login (or password reset) opens one scoped transaction per
 * organization until it has seen two matches or run out of organizations —
 * and an email the caller chooses to match no account never produces a
 * second match, so the cost of *that* request grows with how many tenants
 * the installation has. `MAX_UNSCOPED_ORG_SCAN` is what bounds it.
 *
 * Real, because the property under test is how many times `pool.connect`
 * is actually called — a count a stub would have to be told, which is
 * exactly the thing being measured here.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the organization-scan bound would go untested.')
}
const when = url ? describe : describe.skip

const SECRET = new TextEncoder().encode('s'.repeat(32))
const ISSUER = 'https://scan.test'
const AUDIENCE = 'scan'

// Comfortably more than the bound, so a scan that ignored it would still
// show up as a difference from `MAX_UNSCOPED_ORG_SCAN + 1` (the bound's own
// transactions, plus the one that reads `organizations` itself).
const EXTRA_ORGS = 10
const TOTAL_ORGS = MAX_UNSCOPED_ORG_SCAN + EXTRA_ORGS

let pool: Pool
let login: Login
let connects: number

when('the no-slug login path bounds how many organizations it scans', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })

    // Fixed slugs rather than random ones, and `ON CONFLICT (slug) DO
    // NOTHING`: this file is a live test against a shared database that
    // nothing here ever deletes rows from (the convention every other live
    // test file follows), so a fresh random slug on every run would keep
    // adding TOTAL_ORGS more organizations forever. A fixed set is created
    // once and reused.
    const values: string[] = []
    const params: string[] = []
    for (let i = 0; i < TOTAL_ORGS; i++) {
      const slug = `login-scan-fixed-${String(i)}`
      const base = params.length
      values.push(`($${String(base + 1)}, $${String(base + 2)}, $${String(base + 3)})`)
      params.push(slug, slug, `org_${slug}`)
    }
    await pool.query(
      `INSERT INTO organizations (slug, name, vector_collection) VALUES ${values.join(',')}
       ON CONFLICT (slug) DO NOTHING`,
      params,
    )

    const original = pool.connect.bind(pool) as () => ReturnType<Pool['connect']>
    pool.connect = (() => {
      connects++
      return original()
    }) as Pool['connect']

    login = new Login({
      pool,
      key: SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTokenTtl: 900,
      refreshTokenTtl: 3600,
      role: 'nacre_app',
    })
  })

  afterAll(async () => {
    // Deleted rather than left in place, unlike most of this file's
    // siblings: this test's whole point is to push the total organization
    // count *past* the bound, and unlike a handful of dummy rows, that is
    // not something the next no-slug login test here (or any other) should
    // have to share a database with. A fresh pool, never the one `connect`
    // was wrapped on above — ending a pool whose `connect` is still counting
    // is not what this cleanup is testing.
    const cleanup = createPool({ connectionString: url as string })
    try {
      await cleanup.query('DELETE FROM organizations WHERE slug LIKE $1', ['login-scan-fixed-%'])
    } finally {
      await cleanup.end()
    }
    await pool?.end()
  })

  it('opens at most MAX_UNSCOPED_ORG_SCAN scoped connections for a non-matching email', async () => {
    connects = 0
    const outcome = await login.login({ email: 'nobody-matches-anything@login-scan.test', password: 'x' })
    expect(outcome).toBeUndefined()

    // One connection reads `organizations` itself (allOrgIds), and at most
    // MAX_UNSCOPED_ORG_SCAN more — one per organization scanned — however
    // many organizations actually exist. Before this fix, a non-matching
    // email opened one connection per organization unconditionally: with
    // TOTAL_ORGS organizations beyond the bound, that would be well past
    // this number.
    expect(connects).toBeLessThanOrEqual(MAX_UNSCOPED_ORG_SCAN + 1)
    expect(connects).toBeGreaterThan(0)
  })
})
