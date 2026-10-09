import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSecretKey, randomBytes } from 'node:crypto'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  coreAdminWrites,
  createApi,
  oauthMinter,
  postgresVerification,
  PostgresAudit,
  PostgresGrants,
  PostgresGroups,
  PostgresLayers,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresProposals,
  PostgresSkills,
  PostgresUsers,
  PostgresWorkspaces,
  writeLookup,
  type AuthContext,
} from '@nacre.work/api'
import { adminTools, createMcpServer } from '@nacre.work/mcp'
import { expireProposals } from '@nacre.work/worker'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'
import { protectedResourceMetadata } from '../../oauth.js'

/**
 * T32 — a change on the administrative MCP waits for a person. docs/mcp-admin.md.
 *
 * Every write there proposes. The change is made when the person who approved
 * the connection presses Apply — in the panel, through a tool the host does not
 * offer the model, or on the console's Proposals screen under their own session
 * — and at no other time. A planted instruction can get a change as far as a
 * screen; one nobody applied changes nothing, and is still on the record.
 *
 * Over real sockets to a real API and a real MCP server, against a real
 * PostgreSQL, with tokens minted the way the API mints them. The property is
 * that **nothing changes** until a person acts, so each case asks the database
 * whether the grant exists rather than asking a tool what it says it did.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. T32 would silently skip, and it decides whether an agent ' +
      'on the administrative surface can change anything without a person pressing Apply.',
  )
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'
const KEY = createSecretKey(Buffer.from('p'.repeat(48)))
const ISSUER = 'https://admin-proposals.test'
const AUDIENCE = 'admin-proposals'

const id = (n: number): string => `ad32e7f0-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const ADMIN = id(2)
const SECOND = id(3)
const MEMBER = id(4)
const WS = id(5)
const PROVIDER = id(6)
const LAYER = id(7)

const mint = oauthMinter({ issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 300, signing: KEY, algorithm: 'HS256' })

let pool: Pool
let api: Server
let mcp: Server
let apiBase: string
let mcpBase: string
let adminConnection: string
let adminToken: string
let secondToken: string
let ordinaryToken: string

const as = (userId: string, role: AuthContext['role']): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role,
})

/** A console session: the person, signed in, with no connection behind the token. */
const session = async (userId: string, role: AuthContext['role']): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

/**
 * A client that renders MCP Apps, as the hosts that show the change panel do:
 * it declares the UI extension, which is what the panel's two buttons are
 * offered on. One that declares nothing is not offered them at all — a case
 * below asks that too.
 */
const connect = async (token: string, ui = true): Promise<Client> => {
  const client = new Client(
    { name: 'admin-proposals', version: '0' },
    {
      versionNegotiation: { mode: 'auto' },
      ...(ui ? { capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } } : {}),
    },
  )
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${mcpBase}/mcp/admin`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  return client
}

const textOf = (result: unknown): string =>
  ((result as { content?: { type: string; text?: string }[] }).content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('')

/** What the panel is handed: the proposal's id, and the key its Apply presents. */
const proposalOf = (result: unknown): { id: string; key: string } => {
  const meta = (result as { _meta?: Record<string, { id?: string; key?: string }> })._meta?.['nacre/proposal']
  if (typeof meta?.id !== 'string' || typeof meta.key !== 'string') throw new Error('the result carries no proposal in _meta')
  return { id: meta.id, key: meta.key }
}

/** Whether MEMBER holds `read` on the layer — the change every case proposes. */
const granted = async (): Promise<boolean> => {
  const c = await pool.connect()
  try {
    const { rowCount } = await c.query(
      `SELECT 1 FROM grants WHERE org_id = $1 AND principal_type = 'user' AND principal_id = $2
          AND scope_type = 'layer' AND scope_id = $3 AND permission = 'read'`,
      [ORG, MEMBER, LAYER],
    )
    return (rowCount ?? 0) > 0
  } finally {
    c.release()
  }
}

const revokeAll = async (): Promise<void> => {
  const c = await pool.connect()
  try {
    await c.query(`DELETE FROM grants WHERE org_id = $1 AND principal_id = $2`, [ORG, MEMBER])
  } finally {
    c.release()
  }
}

const statusOf = async (proposal: string): Promise<string | undefined> => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query<{ status: string }>(`SELECT status FROM admin_proposals WHERE id = $1`, [proposal])
    return rows[0]?.status
  } finally {
    c.release()
  }
}

const recorded = async (action: string, proposal: string): Promise<{ result: string; surface: string; client: string | null }[]> => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query<{ result: string; surface: string; client: string | null }>(
      `SELECT result, surface, client FROM audit_events WHERE org_id = $1 AND action = $2 AND target->>'proposal' = $3`,
      [ORG, action, proposal],
    )
    return rows
  } finally {
    c.release()
  }
}

const propose = async (client: Client): Promise<{ id: string; key: string; text: string }> => {
  const result = await client.callTool({
    name: 'issue_grant',
    arguments: { person: 'member@ap.test', layer: 'handbook', permission: 'read' },
  })
  expect(result.isError, textOf(result)).toBeFalsy()
  return { ...proposalOf(result), text: textOf(result) }
}

when('adversarial · a change on the administrative MCP waits for a person', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM audit_events WHERE org_id = $1', [ORG]).catch(() => undefined)
      await c.query('DELETE FROM admin_proposals WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'admin-proposals','Admin proposals','org_admin_proposals') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES
           ($1,$4,'admin@ap.test','org_admin'),
           ($2,$4,'second@ap.test','org_admin'),
           ($3,$4,'member@ap.test','member')
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, disabled_at = NULL`,
        [ADMIN, SECOND, MEMBER, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'ap', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [PROVIDER],
      )
      await c.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'ap','W') ON CONFLICT DO NOTHING`, [WS, ORG])
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'handbook','Handbook',$4,'v') ON CONFLICT DO NOTHING`,
        [LAYER, ORG, WS, PROVIDER],
      )
    } finally {
      c.release()
    }

    const consents = new PostgresOAuthConsents(pool, AS_APP)
    const clients = new PostgresOAuthClients(pool, AS_APP)
    const clientId = `nacre_client_${randomBytes(8).toString('hex')}`
    await clients.register('a proposing client', ['http://127.0.0.1:1/cb'], clientId)
    const admin = { actsAs: 'user' as const, userId: ADMIN }
    const second = { actsAs: 'user' as const, userId: SECOND }
    adminConnection = await consents.record(as(ADMIN, 'org_admin'), clientId, admin, [], ['read', 'admin'], 'admin')
    const secondConnection = await consents.record(as(SECOND, 'org_admin'), clientId, second, [], ['read', 'admin'], 'admin')
    const ordinary = await consents.record(as(ADMIN, 'org_admin'), clientId, admin, [], undefined, 'default')
    adminToken = (await mint({ orgId: ORG, subject: admin, consentId: adminConnection, surface: 'admin' })).accessToken
    secondToken = (await mint({ orgId: ORG, subject: second, consentId: secondConnection, surface: 'admin' })).accessToken
    ordinaryToken = (await mint({ orgId: ORG, subject: admin, consentId: ordinary, surface: 'default' })).accessToken

    const vectors = { vectorsOf: async () => ({ v: 4 }), tombstoneLayer: async () => undefined }
    const audit = new PostgresAudit(pool, AS_APP)
    const verification = postgresVerification(pool, AS_APP)
    api = createApi({
      verify: { key: KEY, issuer: ISSUER, audience: AUDIENCE, ...verification },
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://ap.test' }),
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit,
      proposals: {
        store: new PostgresProposals(pool, AS_APP),
        writes: writeLookup(
          coreAdminWrites({
            pool,
            role: AS_APP,
            audit,
            grants: new PostgresGrants(pool, AS_APP),
            groups: new PostgresGroups(pool, AS_APP),
            users: new PostgresUsers(pool, AS_APP),
            workspaces: new PostgresWorkspaces(pool, AS_APP),
            layers: new PostgresLayers(pool, vectors, AS_APP),
            skills: new PostgresSkills(pool, AS_APP),
            consents,
          }),
        ),
      },
    })
    apiBase = await listen(api)

    mcp = createMcpServer({
      verify: { key: KEY, issuer: ISSUER, audience: AUDIENCE, ...verification },
      resourceMetadataUrl: 'https://mcp.ap.test/.well-known/oauth-protected-resource',
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.ap.test' }),
      layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
      tools: { call: async () => ({}) },
      admin: { tools: adminTools({ pool, audit, vectors, consoleUrl: 'https://console.ap.test/#/consent' }) },
    })
    mcpBase = await listen(mcp)
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => api?.close(() => resolve()))
    await new Promise<void>((resolve) => mcp?.close(() => resolve()))
    await pool?.end()
  })

  it('T32 · a write called and never applied changes nothing; it expires and is recorded', async () => {
    await revokeAll()
    const client = await connect(adminToken)
    try {
      const { id: proposal, key, text } = await propose(client)
      // What the model reads says what would happen and that nothing has —
      // and does not carry the id the panel applies with, nor its key.
      expect(text).toContain('member@ap.test')
      expect(text).toContain('Nothing has changed')
      expect(text).not.toContain(proposal)
      expect(text).not.toContain(key)
      expect(await granted(), 'a proposal changed something').toBe(false)
      expect(await recorded('proposal.created', proposal)).toHaveLength(1)

      // Ten minutes pass, by the database's own clock.
      const c = await pool.connect()
      try {
        await c.query(`UPDATE admin_proposals SET created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' WHERE id = $1`, [proposal])
      } finally {
        c.release()
      }
      // Applying an expired one is refused, and still nothing changes.
      const late = await client.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(late.isError).toBe(true)
      expect(await granted()).toBe(false)

      // The worker records what nobody applied.
      expect(await expireProposals(pool, 100)).toBeGreaterThanOrEqual(1)
      expect(await statusOf(proposal)).toBe('expired')
      const expired = await recorded('proposal.expired', proposal)
      expect(expired).toHaveLength(1)
      expect(expired[0]?.client).toBe(`connection:${adminConnection}`)
      // And a second pass finds nothing left to record.
      await expireProposals(pool, 100)
      expect(await recorded('proposal.expired', proposal)).toHaveLength(1)
    } finally {
      await client.close()
    }
  })

  it('applies once, from the panel, as the person — and never twice', async () => {
    await revokeAll()
    const client = await connect(adminToken)
    try {
      const { id: proposal, key } = await propose(client)
      const applied = await client.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(applied.isError, textOf(applied)).toBeFalsy()
      expect(await granted()).toBe(true)
      expect(await statusOf(proposal)).toBe('applied')
      const events = await recorded('proposal.applied', proposal)
      expect(events.map((e) => [e.result, e.surface])).toEqual([['allow', 'mcp-admin']])

      // Single use: the claim is the UPDATE that finds an open row.
      await revokeAll()
      const again = await client.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(again.isError).toBe(true)
      expect(await granted()).toBe(false)
    } finally {
      await client.close()
    }
  })

  it("another administrator's connection cannot apply it, and cancelling leaves nothing changed", async () => {
    await revokeAll()
    const mine = await connect(adminToken)
    const theirs = await connect(secondToken)
    try {
      const { id: proposal, key } = await propose(mine)
      // Even holding the key: the connection is part of the claim.
      const foreign = await theirs.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(foreign.isError).toBe(true)
      expect(await granted()).toBe(false)
      expect(await statusOf(proposal)).toBe('open')

      const cancelled = await mine.callTool({ name: 'cancel_proposal', arguments: { proposal, key } })
      expect(cancelled.isError, textOf(cancelled)).toBeFalsy()
      expect(await statusOf(proposal)).toBe('cancelled')
      expect(await recorded('proposal.cancelled', proposal)).toHaveLength(1)
      const after = await mine.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(after.isError).toBe(true)
      expect(await granted()).toBe(false)
    } finally {
      await mine.close()
      await theirs.close()
    }
  })

  it("applies from the console under the person's own session, and only theirs", async () => {
    await revokeAll()
    const client = await connect(adminToken)
    let proposal: string
    try {
      proposal = (await propose(client)).id
    } finally {
      await client.close()
    }
    const post = (token: string, path: string) =>
      fetch(`${apiBase}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    const get = (token: string) => fetch(`${apiBase}/v1/proposals`, { headers: { authorization: `Bearer ${token}` } })

    // A connected application — the ordinary one, with the person's token —
    // gets what a path that does not exist gets, or a client could apply its
    // own proposals with nobody in front of them.
    expect((await get(ordinaryToken)).status).toBe(404)
    expect((await post(ordinaryToken, `/v1/proposals/${proposal}/apply`)).status).toBe(404)
    // The administrative token is not the API's at all.
    expect((await post(adminToken, `/v1/proposals/${proposal}/apply`)).status).toBe(401)
    // Another administrator's session: not theirs.
    expect((await post(await session(SECOND, 'org_admin'), `/v1/proposals/${proposal}/apply`)).status).toBe(404)
    // A member's session: not an administrator.
    expect((await post(await session(MEMBER, 'member'), `/v1/proposals/${proposal}/apply`)).status).toBe(404)
    expect(await granted()).toBe(false)

    const own = await session(ADMIN, 'org_admin')
    const listed = (await (await get(own)).json()) as { items: { id: string; summary: string }[] }
    expect(listed.items.map((p) => p.id)).toContain(proposal)
    expect((await get(await session(SECOND, 'org_admin')).then((r) => r.json())) as { items: unknown[] }).toEqual({ items: [] })

    const applied = await post(own, `/v1/proposals/${proposal}/apply`)
    expect(applied.status).toBe(200)
    expect(await granted()).toBe(true)
    // The press that applied it — and the other administrator's attempt above,
    // which is recorded as refused rather than vanishing.
    expect((await recorded('proposal.applied', proposal)).map((e) => `${e.result}:${e.surface}`).sort()).toEqual([
      'allow:api',
      'deny:api',
    ])
    expect((await post(own, `/v1/proposals/${proposal}/apply`)).status).toBe(404)
  })

  it('a client that renders no panel is not offered the buttons — and its proposals wait on the console', async () => {
    await revokeAll()
    const client = await connect(adminToken, false)
    try {
      const listed = (await client.listTools()).tools.map((t) => t.name)
      expect(listed).toContain('issue_grant')
      expect(listed).not.toContain('apply_proposal')
      expect(listed).not.toContain('cancel_proposal')
      const { text } = await propose(client)
      expect(text).toContain('https://console.ap.test/#/proposals')
      expect(await granted()).toBe(false)
    } finally {
      await client.close()
    }
  })

  it('the buttons are declared for the app and not for the model', async () => {
    const client = await connect(adminToken)
    try {
      const tools = (await client.listTools()).tools
      for (const name of ['apply_proposal', 'cancel_proposal']) {
        const tool = tools.find((t) => t.name === name)
        expect(tool, name).toBeDefined()
        expect((tool?._meta as { ui?: { visibility?: string[] } } | undefined)?.ui?.visibility).toEqual(['app'])
      }
      // And every write opens the change panel.
      const write = tools.find((t) => t.name === 'issue_grant')
      expect((write?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui?.resourceUri).toBe('ui://nacre/change.html')
      expect(write?.annotations?.destructiveHint).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('ending the connection ends what it proposed', async () => {
    await revokeAll()
    const client = await connect(adminToken)
    let proposal: string
    try {
      proposal = (await propose(client)).id
    } finally {
      await client.close()
    }
    const consents = new PostgresOAuthConsents(pool, AS_APP)
    const own = await session(ADMIN, 'org_admin')
    // Revoked through the port, as the Connections screen does — then restored
    // for the cases after this one, by the database's owner.
    expect(await consents.revoke(as(ADMIN, 'org_admin'), adminConnection)).toBe(true)
    try {
      const listed = (await (await fetch(`${apiBase}/v1/proposals`, { headers: { authorization: `Bearer ${own}` } })).json()) as {
        items: { id: string }[]
      }
      expect(listed.items.map((p) => p.id)).not.toContain(proposal)
      const res = await fetch(`${apiBase}/v1/proposals/${proposal}/apply`, { method: 'POST', headers: { authorization: `Bearer ${own}` } })
      expect(res.status).toBe(404)
      expect(await granted()).toBe(false)
      // Ended, not merely hidden: cancelled in the revocation's own transaction
      // and recorded as such.
      expect(await statusOf(proposal)).toBe('cancelled')
      expect((await recorded('proposal.cancelled', proposal)).map((e) => e.result)).toEqual(['allow'])
    } finally {
      // Approving the same application again un-revokes the same row, which
      // is what this does — and the proposal must not come back with it.
      const c = await pool.connect()
      try {
        await c.query(`UPDATE oauth_consents SET revoked_at = NULL WHERE id = $1`, [adminConnection])
      } finally {
        c.release()
      }
    }
    const res = await fetch(`${apiBase}/v1/proposals/${proposal}/apply`, { method: 'POST', headers: { authorization: `Bearer ${own}` } })
    expect(res.status, 'a re-approved connection revived what the old one proposed').toBe(404)
    expect(await granted()).toBe(false)
  })

  it('the id the model can read applies nothing: the access log names it, and the key is the panel\'s alone', async () => {
    await revokeAll()
    const client = await connect(adminToken)
    try {
      const { id: proposal, key } = await propose(client)
      // The administrative surface reads the access log, and the log names the
      // proposal — so the id is something a model can have.
      const log = await client.callTool({ name: 'query_audit', arguments: { action: 'proposal.created' } })
      expect(textOf(log)).toContain(proposal)
      // The key is nowhere a model reads: not the log, not any audit row.
      expect(textOf(log)).not.toContain(key)
      const c = await pool.connect()
      try {
        const { rowCount } = await c.query(
          `SELECT 1 FROM audit_events WHERE org_id = $1 AND (target::text LIKE $2 OR detail::text LIKE $2)`,
          [ORG, `%${key}%`],
        )
        expect(rowCount, 'the panel key reached the access log').toBe(0)
      } finally {
        c.release()
      }

      // What a model holding the id can do with it: nothing, and it is recorded.
      for (const args of [{ proposal }, { proposal, key: '' }, { proposal, key: 'a'.repeat(43) }]) {
        const tried = await client.callTool({ name: 'apply_proposal', arguments: args })
        expect(tried.isError, JSON.stringify(args)).toBe(true)
      }
      const cancelTried = await client.callTool({ name: 'cancel_proposal', arguments: { proposal, key: 'b'.repeat(43) } })
      expect(cancelTried.isError).toBe(true)
      expect(await granted()).toBe(false)
      expect(await statusOf(proposal)).toBe('open')
      expect((await recorded('proposal.applied', proposal)).map((e) => e.result)).toContain('deny')

      // And the panel, which holds the key, still can.
      const applied = await client.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
      expect(applied.isError, textOf(applied)).toBeFalsy()
      expect(await granted()).toBe(true)
    } finally {
      await client.close()
    }
  })

  it('a write that cannot be proposed is recorded as tried', async () => {
    const client = await connect(adminToken)
    try {
      const before = await triedCount()
      const refused = await client.callTool({
        name: 'issue_grant',
        arguments: { person: 'nobody@ap.test', layer: 'handbook', permission: 'read' },
      })
      expect(refused.isError).toBe(true)
      expect(await triedCount()).toBe(before + 1)
    } finally {
      await client.close()
    }
  })

  it('the sweep ends an apply that died, and leaves one still running across the expiry', async () => {
    await revokeAll()
    const client = await connect(adminToken)
    let running: string
    let dead: string
    try {
      running = (await propose(client)).id
      dead = (await propose(client)).id
    } finally {
      await client.close()
    }
    const c = await pool.connect()
    try {
      // Both claimed and past their expiry; one a second ago, one long ago.
      await c.query(
        `UPDATE admin_proposals SET status = 'applying', created_at = now() - interval '11 minutes',
                expires_at = now() - interval '1 minute', decided_at = now() - interval '1 second', decided_through = 'panel'
          WHERE id = $1`,
        [running],
      )
      await c.query(
        `UPDATE admin_proposals SET status = 'applying', created_at = now() - interval '40 minutes',
                expires_at = now() - interval '30 minutes', decided_at = now() - interval '31 minutes', decided_through = 'panel'
          WHERE id = $1`,
        [dead],
      )
    } finally {
      c.release()
    }
    await expireProposals(pool, 100)
    expect(await statusOf(running), 'an apply in progress was marked failed').toBe('applying')
    expect(await statusOf(dead)).toBe('failed')
  })
})

/** How many refused or failed proposals this organization's log holds. */
const triedCount = async (): Promise<number> => {
  const c = await pool.connect()
  try {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE org_id = $1 AND action = 'proposal.created' AND result IN ('deny', 'error') AND target->>'tool' = 'issue_grant'`,
      [ORG],
    )
    return Number(rows[0]?.n ?? 0)
  } finally {
    c.release()
  }
}
