import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AuthContext } from '@nacre.work/api'
import { buildServices, type Services } from '../services.js'

/**
 * `list_layers` answers one page, against a real PostgreSQL and the real
 * resolver.
 *
 * The tool used to return **every** layer the plan reaches — no limit, no
 * order, no cursor — which on an installation at the scale layers are sold for
 * (one per patient, one per matter) is a million-row answer built inside one
 * tool result. Nothing asserted the result's shape anywhere, which is how that
 * could have stayed; these cases are the assertion, driven through the same
 * `buildServices` both transports are handed, so the claim covers HTTP and
 * STDIO at once.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; list_layers pagination is untested.')
}
const when = url ? describe : describe.skip

const ORG = '66666666-6666-4666-8666-666666660001'
const ADMIN_ID = '66666666-6666-4666-8666-6666666600a1'
const admin: AuthContext = {
  orgId: ORG,
  principal: { type: 'user', id: ADMIN_ID },
  role: 'org_admin',
}

let pool: Pool
let services: Services

when('list_layers, paged', () => {
  beforeAll(async () => {
    // `buildServices` reads the same configuration the entry points do; the
    // vector store and embedder are constructed but never reached — a layer
    // listing is a Postgres question.
    process.env.NACRE_PG_URL = url as string
    process.env.NACRE_QDRANT_URL ??= 'http://127.0.0.1:6333'
    process.env.NACRE_REDIS_URL ??= 'redis://127.0.0.1:6379'
    process.env.NACRE_PARSER_ENDPOINT ??= 'http://127.0.0.1:9998'
    process.env.NACRE_CANONICAL_URL ??= 'http://127.0.0.1:8080'
    process.env.NACRE_JWT_ISSUER ??= 'http://127.0.0.1:8080'
    process.env.NACRE_JWT_AUDIENCE ??= 'nacre'
    process.env.NACRE_JWT_SECRET ??= 's'.repeat(40)
    const { loadConfig } = await import('@nacre.work/core')
    services = buildServices(loadConfig())
    pool = services.pool

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'mcppage','mcppage','org_mcppage') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      const ws = await c.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, slug, name) VALUES ($1,'w','w')
         ON CONFLICT (org_id, slug) DO UPDATE SET name = 'w' RETURNING id`,
        [ORG],
      )
      const provider = await c.query<{ id: string }>(
        `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
         VALUES ($1,'p','http://embedder','stub',4)
         ON CONFLICT DO NOTHING RETURNING id`,
        [ORG],
      )
      const pid =
        provider.rows[0]?.id ??
        (await c.query<{ id: string }>(
          `SELECT id FROM embedding_providers WHERE org_id = $1 AND name = 'p'`,
          [ORG],
        )).rows[0]!.id
      await c.query('DELETE FROM layers WHERE org_id = $1', [ORG])
      for (const slug of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
        await c.query(
          `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3::citext,$4,$5,'v_stub_4')`,
          [ORG, ws.rows[0]!.id, slug, slug, pid],
        )
      }
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query('DELETE FROM organizations WHERE id = $1', [ORG])
      await pool.end()
    }
  })

  it('walks five layers in pages of two, each page ordered and disjoint', async () => {
    const page1 = await services.layers.forCaller(admin, { limit: 2 })
    expect(page1.layers).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.layers[1]?.id)

    const page2 = await services.layers.forCaller(admin, {
      limit: 2,
      afterId: page1.nextCursor as string,
    })
    expect(page2.layers).toHaveLength(2)
    expect(page2.nextCursor).not.toBeNull()

    const page3 = await services.layers.forCaller(admin, {
      limit: 2,
      afterId: page2.nextCursor as string,
    })
    expect(page3.layers).toHaveLength(1)
    // The last page says so, rather than handing out a cursor to an empty one.
    expect(page3.nextCursor).toBeNull()

    const ids = [...page1.layers, ...page2.layers, ...page3.layers].map((l) => l.id)
    expect(new Set(ids).size).toBe(5)
    expect([...ids].sort()).toEqual(ids)
  })

  it('the tool answers { layers, next_cursor }, and the cursor continues', async () => {
    const first = (await services.tools.call(
      'list_layers',
      { limit: 3 },
      admin,
      'req-1',
    )) as { layers: readonly { slug: string }[]; next_cursor: string | null }
    expect(first.layers).toHaveLength(3)
    expect(first.next_cursor).not.toBeNull()

    const rest = (await services.tools.call(
      'list_layers',
      { limit: 3, cursor: first.next_cursor },
      admin,
      'req-2',
    )) as { layers: readonly { slug: string }[]; next_cursor: string | null }
    expect(rest.layers).toHaveLength(2)
    expect(rest.next_cursor).toBeNull()

    const slugs = [...first.layers, ...rest.layers].map((l) => l.slug).sort()
    expect(slugs).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma'])
  })

  it('refuses a cursor this tool did not issue, rather than casting it', async () => {
    await expect(
      services.tools.call('list_layers', { cursor: 'not-a-uuid' }, admin, 'req-3'),
    ).rejects.toThrow(/cursor/)
  })

  it('clamps the limit to the bound rather than honouring an enormous one', async () => {
    const page = (await services.tools.call(
      'list_layers',
      { limit: 10_000 },
      admin,
      'req-4',
    )) as { layers: readonly unknown[] }
    // Five exist, so five come back — the clamp shows up as the absence of an
    // error, and the bound itself is pinned in the unit for the SQL's LIMIT.
    expect(page.layers).toHaveLength(5)
  })
})
