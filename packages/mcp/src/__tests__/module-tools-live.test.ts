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

import { adminTools } from '../admin-services.js'
import { AdminResult } from '../admin-tools.js'

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
    const proposal = ((proposed as AdminResult).meta['nacre/proposal'] as { id: string }).id

    // A refusal from propose is the caller's to read, and stores nothing.
    await expect(tools.call('issue_deny', { on: 'nothing' }, auth, 'r2')).rejects.toThrow('Nothing to deny.')

    const result = await tools.call('apply_proposal', { proposal }, auth, 'r3')
    expect(result).toEqual({ applied: true, result: { denied: 'contracts' } })
    expect(applied).toEqual([{ input: { on: 'contracts' }, proposal: 'panel' }])
    await expect(tools.call('apply_proposal', { proposal }, auth, 'r4')).rejects.toThrow(/no longer open/)
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
    const proposal = ((await before.call('tag_layer', {}, auth, 'r1')) as AdminResult).meta['nacre/proposal'] as { id: string }

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
    await expect(after.call('apply_proposal', { proposal: proposal.id }, auth, 'r2')).rejects.toThrow(/no longer offered/)
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
