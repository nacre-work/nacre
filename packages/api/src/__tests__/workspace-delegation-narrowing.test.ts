import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'

import { createPool } from '@nacre.work/core'

import { PostgresLayers, PostgresWorkspaces } from '../adapters.js'
import type { AuthContext } from '../auth.js'

/**
 * Security audit 2026-11-01, LOW finding
 * api/adapters.ts:PostgresWorkspaces.list:delegation-narrowing-not-applied.
 *
 * `PostgresLayers.list` intersects the read plan with the delegation's
 * narrowing before it queries (T40, docs/authz.md): a connection narrowed to
 * layer L lists L and nothing else, whatever other layers its person reaches.
 * `PostgresWorkspaces.list` never consulted the narrowing at all — it listed
 * every workspace the *person* could reach, with that workspace's real slug,
 * name and `layer_count`, and for an `org_admin` person, `read`/`write`/`admin`
 * on workspaces holding no narrowed layer whatsoever. That is "something from
 * M" exactly as T40 forbids on the layer catalog, one endpoint over, and for
 * an org_admin it additionally claimed authority — write and admin — a
 * narrowed token can never exercise (T42 refuses the writes; this was only
 * ever a misstatement in the read).
 *
 * The fix applies the same narrowing `PostgresLayers.list` does: a narrowed
 * token reaches a workspace only through a layer that is both inside the
 * narrowing and reached by the plan — the workspace-grant branch, which is
 * for a workspace with no layers at all, is skipped outright, since a
 * narrowing only ever names layers and can never admit a workspace through
 * it. `layer_count` is clipped to the narrowed layers, and the reported
 * permissions are `['read']` alone: a narrowing cannot confer `write` or
 * `admin` on a workspace scope, which is checked directly against the role
 * and a workspace grant rather than through any layer.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the workspace narrowing fix would go untested.')
}
const when = url ? describe : describe.skip

let pool: Pool
const ORG = randomUUID()
const WS_HANDBOOK = randomUUID()
const WS_SECRET = randomUUID()
const PROVIDER = randomUUID()
const USER = randomUUID()
const LAYER_HB = randomUUID()
const LAYER_DEAL = randomUUID()

const vectors = { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined }

when('the workspace catalog, narrowed by a delegation', () => {
  let layers: PostgresLayers
  let workspaces: PostgresWorkspaces

  beforeAll(async () => {
    pool = createPool({ connectionString: url as string, max: 4 })
    const client = await pool.connect()
    try {
      const slug = `wsnarrow-${ORG.slice(0, 8)}`
      await client.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1, $2::text, $2::text, 'org_' || $2::text)`,
        [ORG, slug],
      )
      await client.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'handbook','Handbook')`, [
        WS_HANDBOOK,
        ORG,
      ])
      await client.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'secret-merger','Secret merger')`,
        [WS_SECRET, ORG],
      )
      await client.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,$2,'test','http://embedder.test','bge-m3',8)`,
        [PROVIDER, ORG],
      )
      await client.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'hb','Handbook docs',$4,'v1')`,
        [LAYER_HB, ORG, WS_HANDBOOK, PROVIDER],
      )
      await client.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'deal','Secret deal',$4,'v1')`,
        [LAYER_DEAL, ORG, WS_SECRET, PROVIDER],
      )
      // An org_admin by grant on both layers, matching the audit's own
      // reproduction (an org_admin person has no ceiling and is told
      // read/write/admin on every workspace it administers by role — the
      // worst case for the misstatement this fix closes).
      await client.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect, source)
         VALUES ($1,'user',$2,'layer',$3,'read','allow','manual'),
                ($1,'user',$2,'layer',$4,'read','allow','manual')`,
        [ORG, USER, LAYER_HB, LAYER_DEAL],
      )
    } finally {
      client.release()
    }
    layers = new PostgresLayers(pool, vectors)
    workspaces = new PostgresWorkspaces(pool)
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

  const member: AuthContext = { orgId: ORG, principal: { type: 'user', id: USER }, role: 'member' }
  const orgAdmin: AuthContext = { orgId: ORG, principal: { type: 'user', id: USER }, role: 'org_admin' }

  it('lists both workspaces, unnarrowed, for the member and the org_admin alike', async () => {
    for (const auth of [member, orgAdmin]) {
      const result = await workspaces.list(auth)
      expect(result.items.map((w) => w.slug).sort()).toEqual(['handbook', 'secret-merger'])
      const handbook = result.items.find((w) => w.slug === 'handbook')
      expect(handbook?.layerCount).toBe(1)
    }
  })

  it('T40, applied to the workspace catalog: a narrowing to one layer lists only its workspace', async () => {
    for (const base of [member, orgAdmin]) {
      const narrowed: AuthContext = { ...base, delegation: { id: randomUUID(), layers: [{ id: LAYER_HB }] } }

      const layerList = await layers.list(narrowed)
      expect(layerList.items.map((l) => l.id)).toEqual([LAYER_HB])

      const wsList = await workspaces.list(narrowed)
      expect(wsList.items.map((w) => w.slug)).toEqual(['handbook'])
      expect(wsList.items[0]?.layerCount).toBe(1)

      // Never write or admin on a workspace scope, however much the role
      // itself would otherwise answer — a narrowing names layers and has
      // nothing to say about a workspace's own scope.
      expect(wsList.items[0]?.permissions).toEqual(['read'])
    }
  })

  it('a `{write}` ceiling with no layer narrowing still reports read alone on the workspace', async () => {
    // Mirrors the layer catalog's own case for an unnarrowed ceiling: rule 6
    // means `{write}` reads nothing, so every layer disappears from the
    // narrowed plan and the workspace it lives in disappears with it.
    const narrowed: AuthContext = {
      ...orgAdmin,
      delegation: { id: randomUUID(), layers: [{ id: LAYER_HB, permissions: ['write'] }] },
    }
    const wsList = await workspaces.list(narrowed)
    expect(wsList.items).toEqual([])
  })
})
