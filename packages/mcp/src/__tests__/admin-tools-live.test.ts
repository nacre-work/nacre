import { PostgresAudit, type AuthContext } from '@nacre.work/api'
import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { adminTools } from '../admin-services.js'
import type { ToolRunner } from '../factory.js'

/**
 * The administrative tools against a real PostgreSQL.
 *
 * What is under test is SQL a mock would agree with whatever it was written
 * to: the resolver's answer for somebody else, a grant listing narrowed in the
 * statement, and the access log's summaries — which expand a search's
 * `returned_docs` and `layers` arrays through a lateral subquery, so "who read
 * this document" counts the searches that returned it and not only the
 * fetches. Each of those was a way to be wrong with every unit green.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the administrative tools are untested.')
}
const when = url ? describe : describe.skip

const id = (n: number): string => `ad7001e0-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const ADMIN = id(2)
const READER = id(3)
const TEAM = id(4)
const WS = id(5)
const PROVIDER = id(6)
const HANDBOOK = id(7)
const CONTRACTS = id(8)
const DOC = id(9)
const SECRET_DOC = id(10)

const admin: AuthContext = {
  orgId: ORG,
  principal: { type: 'user', id: ADMIN },
  role: 'org_admin',
  delegation: { id: id(11), surface: 'admin', permissions: ['read', 'admin'] },
}

let pool: Pool
let tools: ToolRunner

const call = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  (await tools.call(name, args, admin, `req-${name}`)) as Record<string, unknown>

when('the administrative tools, against a real database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    tools = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app') })

    const c = await pool.connect()
    try {
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      // This connection is the database's owner, which the application role's
      // revoked DELETE does not bind. Without it the counts below double on a
      // second run against the same database — the suite asserting on rows a
      // previous run left, which is a case whose answer depends on history.
      await c.query('DELETE FROM audit_events WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'admin-tools','Admin tools','org_admin_tools') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$3,'admin@at.test','org_admin'), ($2,$3,'reader@at.test','member')
         ON CONFLICT DO NOTHING`,
        [ADMIN, READER, ORG],
      )
      await c.query(`INSERT INTO groups (id, org_id, name) VALUES ($1,$2,'readers') ON CONFLICT DO NOTHING`, [TEAM, ORG])
      await c.query(
        `INSERT INTO group_members (org_id, group_id, member_user) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [ORG, TEAM, READER],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'at', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [PROVIDER],
      )
      await c.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'at','W') ON CONFLICT DO NOTHING`, [WS, ORG])
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$3,$4,'handbook','Handbook',$5,'v'), ($2,$3,$4,'contracts','Contracts',$5,'v')
         ON CONFLICT DO NOTHING`,
        [HANDBOOK, CONTRACTS, ORG, WS, PROVIDER],
      )
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, title, status, source_type, source_ref, content_hash) VALUES
           ($1,$3,$4,'Leave policy','indexed','inline','a','h1'),
           ($2,$3,$4,'Salaries','failed','inline','b','h2')
         ON CONFLICT DO NOTHING`,
        [DOC, SECRET_DOC, ORG, HANDBOOK],
      )
      // The group reads the handbook; a deny takes one document back out of
      // it for the reader; nobody but the administrator reaches contracts.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect) VALUES
           ($1,'group',$2,'layer',$3,'read','allow'),
           ($1,'user',$4,'document',$5,'read','deny')`,
        [ORG, TEAM, HANDBOOK, READER, SECRET_DOC],
      )
      // A fetch of the document, and a search that returned it among others.
      await c.query(
        `INSERT INTO audit_events (org_id, actor_type, actor_id, actor_label, action, surface, target, result, detail, request_id)
         VALUES
           ($1,'user',$2,$3,'get_document','api',jsonb_build_object('document_id',$4::text),'allow','{}','r1'),
           ($1,'user',$2,$3,'search','mcp',jsonb_build_object('returned_docs',jsonb_build_array($4::text,'x'),'layers',jsonb_build_array('handbook')),'allow','{}','r2'),
           ($1,'user',$2,$3,'get_document','api',jsonb_build_object('document_id',$5::text),'deny','{}','r3')`,
        [ORG, READER, `user:${READER}`, DOC, SECRET_DOC],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('effective_access answers by the resolver: a group grant, a deny beneath it, and the grants that decide it', async () => {
    const result = await call('effective_access', { person: 'Reader@AT.test' })
    expect(result.principal).toMatchObject({ id: READER, name: 'reader@at.test', role: 'member' })
    expect(result.read).toMatchObject({ every_layer: false, layers: ['handbook'], documents_denied_inside_them: 1 })
    expect(result.write).toMatchObject({ every_layer: false, layers: [] })
    expect(result.groups).toEqual([{ id: TEAM, name: 'readers' }])
    const deciding = result.deciding_grants as { through: string; effect: string; scope: { name: string | null } }[]
    expect(deciding.map((g) => `${g.through} ${g.effect}`).sort()).toEqual(['directly deny', 'group readers allow'])

    // An administrator reaches everything by role, and the answer says so.
    const self = await call('effective_access', { person: 'admin@at.test' })
    expect(self.read).toEqual({ every_layer: true })
    expect(self.note).toContain('by role')
  })

  it('refuses a principal that is not in the organization, naming the reference rather than answering empty', async () => {
    await expect(call('effective_access', { person: 'nobody@at.test' })).rejects.toThrow(/No person "nobody@at.test"/)
    await expect(call('effective_access', { person: 'reader@at.test', group: 'readers' })).rejects.toThrow(/exactly one/)
  })

  it('list_grants narrows to a scope and to a principal in the statement', async () => {
    const onHandbook = (await call('list_grants', { layer: 'handbook' })).grants as { principal: { name: string } }[]
    expect(onHandbook.map((g) => g.principal.name)).toEqual(['readers'])
    const forReader = (await call('list_grants', { person: 'reader@at.test' })).grants as { effect: string }[]
    expect(forReader.map((g) => g.effect)).toEqual(['deny'])
  })

  it('list_layers carries failures and the model', async () => {
    const layers = (await call('list_layers')).layers as { slug: string; documents: number; failed: number; model: string }[]
    expect(layers.find((l) => l.slug === 'handbook')).toMatchObject({ documents: 2, failed: 1, model: 'm' })
  })

  it('the access log finds a document in a search that returned it, not only in a fetch', async () => {
    const rows = (await call('query_audit', { document: DOC })).events as { action: string }[]
    expect(rows.map((r) => r.action).sort()).toEqual(['get_document', 'search'])

    const byDocument = (await call('summarize_audit', { by: 'document', actor: 'reader@at.test' })).groups as {
      key: string
      events: number
      denied: number
    }[]
    expect(byDocument.find((g) => g.key === DOC)).toMatchObject({ events: 2, denied: 0 })
    expect(byDocument.find((g) => g.key === SECRET_DOC)).toMatchObject({ events: 1, denied: 1 })

    // A layer recorded by slug in a search's array is the layer's bucket.
    const byLayer = (await call('summarize_audit', { by: 'layer', actor: 'reader@at.test' })).groups as { key: string }[]
    expect(byLayer.map((g) => g.key)).toContain('handbook')

    const byActor = (await call('summarize_audit', { by: 'actor', action: 'get_document' })).groups as {
      name: string | null
      events: number
    }[]
    expect(byActor).toContainEqual(expect.objectContaining({ name: 'reader@at.test', events: 2 }))
  })

  it('refuses a window it would not bound', async () => {
    await expect(
      call('summarize_audit', { by: 'day', from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow(/at most 366 days/)
    await expect(call('summarize_audit', { by: 'everything' })).rejects.toThrow(/'by' is one of/)
  })
})
