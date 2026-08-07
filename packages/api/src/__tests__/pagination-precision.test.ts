import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { createPool } from '@nacre.work/core'

import { PostgresLayers, PostgresWorkspaces } from '../adapters.js'
import { PostgresServiceAccounts } from '../service-keys.js'
import type { AuthContext } from '../auth.js'
import type { Page, Position } from '../pagination.js'

/**
 * A cursor has to advance.
 *
 * Every paged listing here built its cursor from `created_at.toISOString()`.
 * `timestamptz` holds microseconds and a JavaScript `Date` holds milliseconds,
 * so that value is truncated — and a truncated bound is *strictly less* than
 * the row it came from, which means `(created_at, id) > (bound, id)` matches
 * that row **again**.
 *
 * `GET /v1/layers?limit=1` returned the first layer eight times in a row
 * against a real database. Descending listings had the mirror image:
 * `GET /v1/audit` skipped every event between the truncated bound and the real
 * one, which on the access log is a record silently missing.
 *
 * Every test in this file needs a real Postgres, because the whole defect lives
 * in the gap between what Postgres stores and what the driver hands back — a
 * fake `now()` with millisecond precision reproduces nothing.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; cursor precision would go untested.')
}
const when = url ? describe : describe.skip

const APP_ROLE = 'nacre_app'

let pool: Pool
const ORG = randomUUID()
const WS = randomUUID()
const PROVIDER = randomUUID()
const USER = randomUUID()

const auth: AuthContext = { orgId: ORG, principal: { type: 'user', id: USER }, role: 'member' }

/** The cursor is opaque to a client; a test has to open it to page again. */
function decode(cursor: string): Position {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8')
  const at = decoded.lastIndexOf('|')
  return { createdAt: decoded.slice(0, at), id: decoded.slice(at + 1) }
}

/** Walk a listing one item at a time and report what it returned. */
async function walk(
  list: (page: Page) => Promise<{ items: readonly { id: string }[]; nextCursor: string | null }>,
  max = 10,
): Promise<string[]> {
  const seen: string[] = []
  let after: Position | undefined
  for (let i = 0; i < max; i++) {
    const page = await list({ limit: 1, after })
    seen.push(...page.items.map((x) => x.id))
    if (page.nextCursor === null) break
    after = decode(page.nextCursor)
  }
  return seen
}

when('a cursor built from a truncated timestamp', () => {
  const layerIds: string[] = []
  const workspaceIds: string[] = []
  const accountIds: string[] = []

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string, max: 4 })
    const client = await pool.connect()
    try {
      const slug = `cursor-${ORG.slice(0, 8)}`
      await client.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1, $2::text, $2::text, 'org_' || $2::text)`,
        [ORG, slug],
      )
      await client.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'ws','WS')`,
        [WS, ORG],
      )
      workspaceIds.push(WS)
      for (const n of [1, 2]) {
        const id = randomUUID()
        await client.query(
          `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,$3::text,$3::text)`,
          [id, ORG, `ws${n}`],
        )
        workspaceIds.push(id)
      }
      await client.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,$2,'test','http://embedder.test','bge-m3',8)`,
        [PROVIDER, ORG],
      )
      // Three of each, written in one statement each so their timestamps carry
      // the microseconds `now()` produces — which is the whole point.
      for (const n of [0, 1, 2]) {
        const id = randomUUID()
        await client.query(
          `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4::text,$4::text,$5,'v1')`,
          [id, ORG, WS, `layer${n}`, PROVIDER],
        )
        layerIds.push(id)

        const account = randomUUID()
        await client.query(
          `INSERT INTO service_accounts (id, org_id, name, key_prefix, key_hash)
           VALUES ($1,$2,$3::text,'nacre_sk_aaaabbbb',$4::text)`,
          [account, ORG, `agent${n}`, `hash-${n}-${'x'.repeat(40)}`],
        )
        accountIds.push(account)
      }
      // Admin on every workspace, so the listing has three pages to walk
      // rather than one row the filter happens to keep.
      for (const id of workspaceIds) {
        await client.query(
          `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect, source)
           VALUES ($1,'user',$2,'workspace',$3,'admin','allow','manual')`,
          [ORG, USER, id],
        )
      }
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    const client = await pool.connect()
    try {
      await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
    } finally {
      client.release()
    }
    await pool.end()
  })

  // The timestamps this schema writes really do carry sub-millisecond digits.
  // If this ever stops being true the tests below stop testing anything, so it
  // is asserted rather than assumed.
  //
  // Over every row in the fixture rather than over `LIMIT 1`, because `now()`
  // does occasionally land on an exact millisecond — roughly once in a thousand
  // — and one row that did made this fail while the defect it guards was
  // entirely unchanged. A flaky assertion on a required check is worse than no
  // assertion: it teaches everyone to re-run. What is actually claimed is that
  // the schema writes microseconds, so asking every row is both the honest
  // question and the stable one.
  it('is a real risk: now() writes microseconds a Date cannot hold', async () => {
    const client = await pool.connect()
    try {
      const { rows } = await client.query<{ ts: Date; text: string }>(
        `SELECT created_at AS ts, created_at::text AS text FROM layers WHERE org_id = $1`,
        [ORG],
      )
      expect(rows.length).toBeGreaterThan(1)

      const truncated = rows.filter((row) => row.text !== row.ts.toISOString())
      expect(truncated.length).toBeGreaterThan(0)

      for (const row of truncated) {
        const { rows: cmp } = await client.query<{ less: boolean }>(
          `SELECT ($1::timestamptz < $2::timestamptz) AS less`,
          [row.ts.toISOString(), row.text],
        )
        // The truncated value sorts *before* the row it came from, which is
        // what makes the row match its own cursor.
        expect((cmp[0] as { less: boolean }).less).toBe(true)
      }
    } finally {
      client.release()
    }
  })

  it('walks every layer once', async () => {
    const layers = new PostgresLayers(pool, { vectorsOf: async () => ({ v1: 8 }), tombstoneLayer: async () => undefined }, APP_ROLE)
    const seen = await walk((page) => layers.list(auth, page))
    expect(seen).toHaveLength(layerIds.length)
    expect(new Set(seen).size).toBe(layerIds.length)
    expect(new Set(seen)).toEqual(new Set(layerIds))
  })

  it('walks every workspace once', async () => {
    const workspaces = new PostgresWorkspaces(pool, APP_ROLE)
    const seen = await walk((page) => workspaces.list(auth, page))
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(seen)).toEqual(new Set(workspaceIds))
  })

  it('walks every service account once', async () => {
    const accounts = new PostgresServiceAccounts(pool, APP_ROLE)
    const admin: AuthContext = { ...auth, role: 'org_admin' }
    const seen = await walk((page) => accounts.list(admin, page))
    expect(new Set(seen).size).toBe(seen.length)
    expect(new Set(seen)).toEqual(new Set(accountIds))
  })
})
