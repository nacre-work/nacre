import { randomBytes } from 'node:crypto'

import { PostgresAudit, PostgresOAuthClients, PostgresOAuthConsents, type AuthContext } from '@nacre.work/api'
import {
  createPool,
  McpToolRefusal,
  registerMcpTools,
  resetExtensionsForTests,
  withLoadingModuleForTests,
  type McpToolCall,
} from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport } from '@modelcontextprotocol/server'

import { buildAdminServer } from '../admin.js'
import { adminTools } from '../admin-services.js'
import { AdminResult, PANEL_META } from '../admin-tools.js'

/**
 * A module's tools on the administrative MCP, against a real PostgreSQL.
 * docs/extensions.md, `registerMcpTools`.
 *
 * What the point promises a module cannot get around: its write is proposed
 * and stored exactly as a core one is, and its `apply` runs only when the panel
 * applies — never on the call that proposed it. And a name the core already
 * uses stops the process rather than shadowing a tool somebody believes they
 * called.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; a module write could skip the person with nothing noticing.')
}
const when = url ? describe : describe.skip

const id = (n: number): string => `0d01e7f0-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const ADMIN = id(2)
const vectors = { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined }

let pool: Pool
let auth: AuthContext

when('module tools on the administrative MCP', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM admin_proposals WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES ($1,'module-tools','M','org_module_tools') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$2,'admin@mt.test','org_admin')
         ON CONFLICT (id) DO UPDATE SET role = 'org_admin', disabled_at = NULL`,
        [ADMIN, ORG],
      )
    } finally {
      c.release()
    }
    const person: AuthContext = { orgId: ORG, principal: { type: 'user', id: ADMIN }, role: 'org_admin' }
    const clientId = `nacre_client_${randomBytes(8).toString('hex')}`
    await new PostgresOAuthClients(pool, 'nacre_app').register('module tools', ['http://127.0.0.1:1/cb'], clientId)
    const consent = await new PostgresOAuthConsents(pool, 'nacre_app').record(
      person,
      clientId,
      { actsAs: 'user', userId: ADMIN },
      [],
      ['read', 'admin'],
      'admin',
    )
    auth = { ...person, delegation: { id: consent, surface: 'admin', permissions: ['read', 'admin'] } } as AuthContext
  })

  afterEach(() => resetExtensionsForTests())
  afterAll(async () => {
    await pool?.end()
  })

  it("proposes a module's write and applies it only when the panel does", async () => {
    const applied: unknown[] = []
    const proposedWith: McpToolCall[] = []
    withLoadingModuleForTests('acl-advanced', () =>
      registerMcpTools('admin', {
        kind: 'write',
        name: 'issue_deny',
        title: 'Deny',
        description: 'Propose a deny.',
        inputSchema: { type: 'object', properties: { on: { type: 'string' } } },
        async propose(call, args) {
          proposedWith.push(call)
          if (args.on === 'nothing') throw new McpToolRefusal('Nothing to deny.')
          return { summary: `Deny ${String(args.on)}.`, details: [{ label: 'on', value: String(args.on) }], input: { on: args.on } }
        },
        async apply(call, input) {
          applied.push({ input, proposal: call.proposal?.through })
          return { denied: input.on }
        },
      }),
    )
    const tools = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })
    expect(tools.catalog.find((t) => t.name === 'issue_deny')?.kind).toBe('write')

    const proposed = await tools.call('issue_deny', { on: 'contracts' }, auth, 'r1')
    expect(proposed).toBeInstanceOf(AdminResult)
    expect(applied, 'apply ran on the call that proposed').toEqual([])
    expect(proposedWith[0]?.auth.orgId).toBe(ORG)
    const { id: proposal, key } = (proposed as AdminResult).meta['nacre/proposal'] as { id: string; key: string }

    // A refusal from propose is the caller's to read, and stores nothing.
    await expect(tools.call('issue_deny', { on: 'nothing' }, auth, 'r2')).rejects.toThrow('Nothing to deny.')

    const result = await tools.call('apply_proposal', { proposal, key }, auth, 'r3')
    expect(result).toEqual({ applied: true, result: { denied: 'contracts' } })
    expect(applied).toEqual([{ input: { on: 'contracts' }, proposal: 'panel' }])
    await expect(tools.call('apply_proposal', { proposal, key }, auth, 'r4')).rejects.toThrow(/no longer open/)
    expect(applied).toHaveLength(1)
  })

  it('a proposal names the module that made it, so another module of the same name cannot apply it', async () => {
    withLoadingModuleForTests('first', () =>
      registerMcpTools('admin', {
        kind: 'write',
        name: 'tag_layer',
        title: 'Tag',
        description: 'Tag.',
        inputSchema: { type: 'object' },
        propose: async () => ({ summary: 'Tag it.', details: [], input: {} }),
        apply: async () => ({ by: 'first' }),
      }),
    )
    const before = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })
    const proposal = ((await before.call('tag_layer', {}, auth, 'r1')) as AdminResult).meta['nacre/proposal'] as { id: string; key: string }

    // The module is gone and another registers the same name.
    resetExtensionsForTests()
    withLoadingModuleForTests('second', () =>
      registerMcpTools('admin', {
        kind: 'write',
        name: 'tag_layer',
        title: 'Tag',
        description: 'Tag.',
        inputSchema: { type: 'object' },
        propose: async () => ({ summary: 'Tag it.', details: [], input: {} }),
        apply: async () => ({ by: 'second' }),
      }),
    )
    const after = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })
    await expect(after.call('apply_proposal', { proposal: proposal.id, key: proposal.key }, auth, 'r2')).rejects.toThrow(/no longer offered/)
  })

  it("a module's read opens a core panel, and what the panel may offer is only a write on this surface", async () => {
    withLoadingModuleForTests('acl-advanced', () =>
      registerMcpTools('admin', {
        kind: 'read',
        name: 'list_document_grants',
        title: 'Document grants',
        description: 'Grants on documents.',
        inputSchema: { type: 'object', properties: { layer: { type: 'string' } } },
        run: async (_call, args) => ({ layer: args.layer, grants: [] }),
        panel: {
          view: 'grants',
          offers: (args) => [
            { tool: 'issue_grant', label: 'Give access', document: 'none', fixed: { layer: String(args.layer) } },
            // Each of these is dropped by the core, and each for its own reason.
            { tool: 'apply_proposal', label: 'Apply', document: 'none', fixed: {} },
            { tool: 'list_grants', label: 'A read', document: 'none', fixed: {} },
            { tool: 'no_such_tool', label: 'Nothing', document: 'none', fixed: {} },
            { tool: 'revoke_grant', label: '  ', document: 'none', fixed: {} },
            { tool: 'revoke_grant', label: 'Odd', document: 'sometimes' as never, fixed: {} },
            { tool: 'revoke_grant', label: 'Not text', document: 'none', fixed: { grant: 7 as never } },
          ],
        },
      }),
    )
    const tools = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })
    expect(tools.catalog.find((t) => t.name === 'list_document_grants')?.panel).toBe('grants')

    const answered = await tools.call('list_document_grants', { layer: 'handbook' }, auth, 'r1')
    expect(answered).toBeInstanceOf(AdminResult)
    expect((answered as AdminResult).result).toEqual({ layer: 'handbook', grants: [] })
    expect((answered as AdminResult).meta[PANEL_META]).toEqual({
      tool: 'list_document_grants',
      offers: [{ tool: 'issue_grant', label: 'Give access', document: 'none', fixed: { layer: 'handbook' } }],
    })

    // On the wire: the read names the grants panel, and the panel is listed
    // with no network of its own.
    const server = buildAdminServer({ auth, requestId: () => 'r', tools, ui: true })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    await server.connect(serverSide)
    const client = new Client({ name: 'panels', version: '0' })
    await client.connect(clientSide)
    try {
      const listed = (await client.listTools()).tools
      for (const name of ['list_document_grants', 'list_grants']) {
        const tool = listed.find((t) => t.name === name)
        expect((tool?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri, name).toBe('ui://nacre/grants.html')
      }
      const resource = (await client.listResources()).resources.find((r) => r.uri === 'ui://nacre/grants.html')
      expect((resource?._meta as { ui?: { csp?: { connectDomains?: string[] } } } | undefined)?.ui?.csp?.connectDomains).toEqual([])
      const wire = await client.callTool({ name: 'list_document_grants', arguments: { layer: 'handbook' } })
      expect((wire._meta as Record<string, unknown> | undefined)?.[PANEL_META]).toMatchObject({ tool: 'list_document_grants' })
    } finally {
      await client.close()
    }
  })

  it('a module whose offers throw still answers its read, with nothing to offer', async () => {
    withLoadingModuleForTests('broken', () =>
      registerMcpTools('admin', {
        kind: 'read',
        name: 'list_broken',
        title: 'Broken',
        description: 'Throws building offers.',
        inputSchema: { type: 'object' },
        run: async () => ({ grants: [] }),
        panel: {
          view: 'grants',
          offers: () => {
            throw new Error('no')
          },
        },
      }),
    )
    const tools = adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })
    const answered = (await tools.call('list_broken', {}, auth, 'r1')) as AdminResult
    expect(answered.meta[PANEL_META]).toEqual({ tool: 'list_broken', offers: [] })
  })

  it('a module tool named like a core one stops the process, naming the module', () => {
    withLoadingModuleForTests('shadow', () =>
      registerMcpTools('admin', {
        kind: 'read',
        name: 'list_grants',
        title: 'Grants',
        description: 'Not the core’s.',
        inputSchema: { type: 'object' },
        run: async () => ({}),
      }),
    )
    expect(() => adminTools({ pool, audit: new PostgresAudit(pool, 'nacre_app'), vectors })).toThrow(/list_grants .*the core and by shadow/)
  })
})
