import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSecretKey, randomBytes } from 'node:crypto'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  oauthMinter,
  postgresVerification,
  PostgresAudit,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  type AuthContext,
} from '@nacre.work/api'
import { adminTools, createMcpServer } from '@nacre.work/mcp'
import { evaluateAlertRules, expireNotifications, sendNotifications } from '@nacre.work/worker'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'
import type { Mailer, Message } from '../../mail.js'
import { NOTIFY_PER_HOUR } from '../../notifications.js'
import { protectedResourceMetadata } from '../../oauth.js'

/**
 * T35 — a notification reaches only active people of the caller's own
 * organization. docs/mcp-admin.md, "Notifications".
 *
 * Three bounds, and each is asked here rather than the first standing for all
 * three: the tool refuses before anything is stored — "before a message is
 * composed" — the apply refuses somebody disabled since, and the worker reads
 * the address at sending time from the notification's own organization, so a
 * stored row naming somebody elsewhere reaches nobody.
 *
 * Over a real MCP transport against a real PostgreSQL, with tokens minted the
 * way the API mints them, and the worker's own passes with a mailer that
 * records what it was handed. Every case asks the database or that record
 * rather than what a tool says it did.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. T35 would silently skip, and it decides whether an agent on the ' +
      'administrative surface can send this installation’s mail to somebody outside the organization.',
  )
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'
const KEY = createSecretKey(Buffer.from('n'.repeat(48)))
const ISSUER = 'https://notifications.test'
const AUDIENCE = 'notifications'

const id = (n: number): string => `0f35e7f0-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const OTHER = id(2)
const ADMIN = id(3)
const MEMBER = id(4)
const GONE = id(5)
const OUTSIDER = id(6)
const WS = id(7)
const PROVIDER = id(8)
const LAYER = id(9)
const SECOND_ADMIN = id(10)

const mint = oauthMinter({ issuer: ISSUER, audience: AUDIENCE, ttlSeconds: 300, signing: KEY, algorithm: 'HS256' })

let pool: Pool
let mcp: Server
let mcpBase: string
let connection: string
let token: string

const as = (userId: string, role: AuthContext['role'], orgId = ORG): AuthContext => ({
  orgId,
  principal: { type: 'user', id: userId },
  role,
})

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

const connect = async (): Promise<Client> => {
  const client = new Client(
    { name: 'notifications', version: '0' },
    { versionNegotiation: { mode: 'auto' }, capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } } },
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

const proposalOf = (result: unknown): { id: string; key: string } => {
  const meta = (result as { _meta?: Record<string, { id?: string; key?: string }> })._meta?.['nacre/proposal']
  if (typeof meta?.id !== 'string' || typeof meta.key !== 'string') throw new Error('the result carries no proposal in _meta')
  return { id: meta.id, key: meta.key }
}

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => {
  const c = await pool.connect()
  try {
    return (await c.query<T>(sql, params)).rows
  } finally {
    c.release()
  }
}

/** Everything composed for this organization: rows in the outbox and proposals waiting. */
const composed = async (): Promise<{ notifications: number; proposals: number }> => {
  const [n] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE org_id = $1`, [ORG])
  const [p] = await q<{ n: string }>(
    `SELECT count(*)::text AS n FROM admin_proposals WHERE org_id = $1 AND tool IN ('send_notification', 'create_alert_rule')`,
    [ORG],
  )
  return { notifications: Number(n?.n ?? 0), proposals: Number(p?.n ?? 0) }
}

/** A mailer that keeps what it was handed. */
const recording = (): Mailer & { sent: Message[] } => {
  const sent: Message[] = []
  return {
    sent,
    async send(message) {
      sent.push(message)
    },
  }
}

const apply = async (client: Client, result: unknown): Promise<unknown> => {
  const { id: proposal, key } = proposalOf(result)
  const applied = await client.callTool({ name: 'apply_proposal', arguments: { proposal, key } })
  return applied
}

when('adversarial · a notification reaches only active people of the caller’s organization', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      for (const org of [ORG, OTHER]) {
        await c.query('DELETE FROM notifications WHERE org_id = $1', [org])
        await c.query('DELETE FROM alert_rules WHERE org_id = $1', [org])
        await c.query('DELETE FROM admin_proposals WHERE org_id = $1', [org])
        await c.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1', [org])
        await c.query('DELETE FROM oauth_consents WHERE org_id = $1', [org])
        await c.query('DELETE FROM documents WHERE org_id = $1', [org])
      }
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES
           ($1,'notifications','Notifications','org_notifications'),
           ($2,'notifications-other','Elsewhere','org_notifications_other')
         ON CONFLICT DO NOTHING`,
        [ORG, OTHER],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role, disabled_at) VALUES
           ($1,$6,'admin@nt.test','org_admin',NULL),
           ($2,$6,'member@nt.test','member',NULL),
           ($3,$6,'gone@nt.test','member',now()),
           ($4,$7,'outsider@elsewhere.test','org_admin',NULL),
           ($5,$6,'second@nt.test','org_admin',NULL)
         ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, disabled_at = EXCLUDED.disabled_at`,
        [ADMIN, MEMBER, GONE, OUTSIDER, SECOND_ADMIN, ORG, OTHER],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'nt', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [PROVIDER],
      )
      await c.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'nt','W') ON CONFLICT DO NOTHING`, [WS, ORG])
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
    await clients.register('a notifying client', ['http://127.0.0.1:1/cb'], clientId)
    const admin = { actsAs: 'user' as const, userId: ADMIN }
    connection = await consents.record(as(ADMIN, 'org_admin'), clientId, admin, [], ['read', 'admin'], 'admin')
    token = (await mint({ orgId: ORG, subject: admin, consentId: connection, surface: 'admin' })).accessToken

    const vectors = { vectorsOf: async () => ({ v: 4 }), tombstoneLayer: async () => undefined }
    const audit = new PostgresAudit(pool, AS_APP)
    mcp = createMcpServer({
      verify: { key: KEY, issuer: ISSUER, audience: AUDIENCE, ...postgresVerification(pool, AS_APP) },
      resourceMetadataUrl: 'https://mcp.nt.test/.well-known/oauth-protected-resource',
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.nt.test' }),
      layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
      tools: { call: async () => ({}) },
      admin: { tools: adminTools({ pool, audit, vectors, notifications: true }) },
    })
    mcpBase = await listen(mcp)
  })

  beforeEach(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM notifications WHERE org_id = ANY($1::uuid[])', [[ORG, OTHER]])
      await c.query('DELETE FROM alert_rules WHERE org_id = ANY($1::uuid[])', [[ORG, OTHER]])
      await c.query(`UPDATE users SET disabled_at = NULL WHERE id = ANY($1::uuid[])`, [[ADMIN, MEMBER, SECOND_ADMIN]])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => mcp?.close(() => resolve()))
    await pool?.end()
  })

  it('T35 · anybody but an active person here is refused before anything is composed — in one sentence for all of them', async () => {
    const client = await connect()
    try {
      const refusals: string[] = []
      // Somebody who exists — in another organization — and somebody who does
      // not exist anywhere must be the same refusal, or the tool is an oracle
      // for which addresses this installation knows.
      for (const people of [['outsider@elsewhere.test'], ['auditor@nowhere.test'], [OUTSIDER], ['gone@nt.test'], [GONE]]) {
        const result = await client.callTool({
          name: 'send_notification',
          arguments: { people, subject: 'Access log', body: 'Here is last week.' },
        })
        expect(result.isError, `${people[0] ?? ''} was not refused`).toBe(true)
        refusals.push(textOf(result).replace(/"[^"]*"/u, '"…"'))
      }
      expect(new Set(refusals).size, refusals.join('\n')).toBe(1)
      expect(refusals[0]).toContain('not an active person in this organization')

      // One good recipient does not carry a bad one through.
      const mixed = await client.callTool({
        name: 'send_notification',
        arguments: { people: ['member@nt.test', 'outsider@elsewhere.test'], subject: 'Hi', body: 'Hello.' },
      })
      expect(mixed.isError).toBe(true)
      expect(textOf(mixed)).toContain('outsider@elsewhere.test')
      expect(textOf(mixed)).not.toContain('member@nt.test"')

      // Nothing was stored for any of them: no proposal, no outbox row.
      expect(await composed()).toEqual({ notifications: 0, proposals: 0 })

      // And each refusal is on the record, the half of an injection that shows.
      const [refused] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_events
          WHERE org_id = $1 AND action = 'proposal.created' AND result = 'deny' AND target->>'tool' = 'send_notification'`,
        [ORG],
      )
      expect(Number(refused?.n ?? 0)).toBeGreaterThanOrEqual(6)
    } finally {
      await client.close()
    }
  })

  it('T35 · the schema has no field for an address, and a link is refused', async () => {
    const client = await connect()
    try {
      const listed = await client.listTools()
      const send = listed.tools.find((t) => t.name === 'send_notification')
      expect(send).toBeDefined()
      const props = Object.keys((send?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})
      expect(props.sort()).toEqual(['body', 'org_admins', 'people', 'subject'])

      // An unknown argument is refused by the schema rather than ignored.
      const extra = await client.callTool({
        name: 'send_notification',
        arguments: { people: ['member@nt.test'], to: 'auditor@nowhere.test', subject: 'x', body: 'y' },
      })
      expect(extra.isError).toBe(true)

      for (const body of ['Sign in again at https://nacre-login.example/reset', 'See www.example.org today', 'go to evil.example/login']) {
        const linked = await client.callTool({
          name: 'send_notification',
          arguments: { people: ['member@nt.test'], subject: 'Your password expired', body },
        })
        expect(linked.isError, body).toBe(true)
        expect(textOf(linked)).toContain('carries no links')
      }
      expect(await composed()).toEqual({ notifications: 0, proposals: 0 })
    } finally {
      await client.close()
    }
  })

  it('T35 · applying refuses somebody disabled since it was proposed', async () => {
    const client = await connect()
    try {
      const proposed = await client.callTool({
        name: 'send_notification',
        arguments: { people: ['member@nt.test'], subject: 'Handbook moved', body: 'It is in the handbook layer now.' },
      })
      expect(proposed.isError, textOf(proposed)).toBeFalsy()
      expect((await composed()).notifications).toBe(0)

      await q(`UPDATE users SET disabled_at = now() WHERE id = $1`, [MEMBER])
      const applied = await apply(client, proposed)
      expect((applied as { isError?: boolean }).isError).toBe(true)
      expect(textOf(applied)).toContain('no longer active')
      expect((await composed()).notifications).toBe(0)
    } finally {
      await client.close()
    }
  })

  it('T35 · the worker reads addresses from the notification’s own organization, at sending time', async () => {
    const client = await connect()
    try {
      const proposed = await client.callTool({
        name: 'send_notification',
        arguments: { people: ['member@nt.test'], org_admins: true, subject: 'Handbook moved', body: 'It is in the handbook layer now.\n\nAsk if anything is missing.' },
      })
      expect(proposed.isError, textOf(proposed)).toBeFalsy()
      const applied = await apply(client, proposed)
      expect((applied as { isError?: boolean }).isError, textOf(applied)).toBeFalsy()
      const [row] = await q<{ recipients: string[]; status: string; sent_by: string; consent_id: string }>(
        `SELECT recipients, status, sent_by, consent_id FROM notifications WHERE org_id = $1`,
        [ORG],
      )
      expect(row).toMatchObject({ recipients: [MEMBER], status: 'queued', sent_by: ADMIN, consent_id: connection })

      // A second organization administrator is disabled after Apply: the
      // worker, reading at sending time, does not reach them.
      await q(`UPDATE users SET disabled_at = now() WHERE id = $1`, [SECOND_ADMIN])

      // A row nobody could have proposed, written straight into the outbox:
      // this organization's notification naming another organization's
      // administrator. The third bound is what stops it.
      await q(
        `INSERT INTO notifications (org_id, recipients, subject, body, source, sent_by, consent_id)
         VALUES ($1, $2::uuid[], 'Forged', 'Forged body.', 'agent', $3, $4)`,
        [ORG, [OUTSIDER], ADMIN, connection],
      )

      const mailer = recording()
      const out = await sendNotifications(pool, mailer, 'https://console.nt.test', 50)
      expect(out).toMatchObject({ sent: 1, dropped: 1, failed: 0 })
      const to = mailer.sent.map((m) => m.to).sort()
      expect(to).toEqual(['admin@nt.test', 'member@nt.test'])
      expect(to).not.toContain('outsider@elsewhere.test')
      expect(to).not.toContain('second@nt.test')

      const message = mailer.sent[0] as Message
      const flat = message.text.replace(/\s+/gu, ' ')
      expect(message.subject).toBe('Nacre: Handbook moved')
      expect(flat).toContain('An agent wrote this through the administrative connection of the application "a notifying client"')
      expect(flat).toContain('admin@nt.test read it and approved sending it')
      expect(message.text).toContain('https://console.nt.test/#/audit')
      // The person's paragraphs are kept as paragraphs.
      expect(message.text).toContain('It is in the handbook layer now.\n\nAsk if anything is missing.')
      // One message per address: nobody is shown who else received it.
      for (const m of mailer.sent) expect(m.text).not.toContain(m.to === 'admin@nt.test' ? 'member@nt.test' : 'second@nt.test')

      const events = await q<{ result: string; client: string | null; detail: { outcome: string; recipients?: string[] } }>(
        `SELECT result, client, detail FROM audit_events
          WHERE org_id = $1 AND action = 'notification.sent'
            AND target->>'notification' IN (SELECT id::text FROM notifications WHERE org_id = $1)
          ORDER BY id`,
        [ORG],
      )
      expect(events.map((e) => [e.result, e.detail.outcome])).toEqual([
        ['allow', 'sent'],
        ['error', 'dropped'],
      ])
      expect(events[0]?.client).toBe(`connection:${connection}`)
      expect(events[0]?.detail.recipients?.sort()).toEqual([ADMIN, MEMBER].sort())

      // Nothing is sent twice.
      expect(await sendNotifications(pool, mailer, 'https://console.nt.test', 50)).toEqual({ sent: 0, dropped: 0, failed: 0 })
      expect(mailer.sent).toHaveLength(2)
    } finally {
      await client.close()
    }
  })

  it('T35 · alert rules name their recipients the same way, and a fired rule reaches only them', async () => {
    const client = await connect()
    try {
      const outside = await client.callTool({
        name: 'create_alert_rule',
        arguments: { kind: 'documents_failed', threshold: 1, people: ['outsider@elsewhere.test'] },
      })
      expect(outside.isError).toBe(true)
      expect(textOf(outside)).toContain('not an active person in this organization')

      const proposed = await client.callTool({
        name: 'create_alert_rule',
        arguments: { kind: 'documents_failed', threshold: 2, window_minutes: 30, layer: 'handbook', people: ['member@nt.test'] },
      })
      expect(proposed.isError, textOf(proposed)).toBeFalsy()
      expect(textOf(proposed)).toContain('2 or more documents fail to index within 30 minutes in the layer handbook')
      expect((await q(`SELECT 1 FROM alert_rules WHERE org_id = $1`, [ORG])).length, 'a proposal created a rule').toBe(0)
      const applied = await apply(client, proposed)
      expect((applied as { isError?: boolean }).isError, textOf(applied)).toBeFalsy()

      // Below the threshold, nothing; at it, one message — and only once in the window.
      await q(
        `INSERT INTO documents (org_id, layer_id, external_id, title, source_type, source_ref, content_hash, status)
         VALUES ($1, $2, 'a', 'A', 'inline', 'x', 'h1', 'failed')`,
        [ORG, LAYER],
      )
      const rewind = (): Promise<unknown> =>
        q(`UPDATE alert_rules SET checked_until = now() - interval '5 minutes' WHERE org_id = $1`, [ORG])
      await rewind()
      expect((await evaluateAlertRules(pool)).fired).toBe(0)
      await q(
        `INSERT INTO documents (org_id, layer_id, external_id, title, source_type, source_ref, content_hash, status)
         VALUES ($1, $2, 'b', 'B', 'inline', 'x', 'h2', 'failed')`,
        [ORG, LAYER],
      )
      await rewind()
      expect((await evaluateAlertRules(pool)).fired).toBe(1)
      await rewind()
      expect((await evaluateAlertRules(pool)).fired, 'fired twice in one window').toBe(0)

      const mailer = recording()
      await sendNotifications(pool, mailer, 'https://console.nt.test', 50)
      expect(mailer.sent.map((m) => m.to)).toEqual(['member@nt.test'])
      expect(mailer.sent[0]?.subject).toBe('Nacre alert: 2 documents failed to index')
      expect(mailer.sent[0]?.text).toContain('- handbook: 2')
      // A document's title is somebody's content and is not in the alert.
      expect(mailer.sent[0]?.text).not.toMatch(/\bA\b.*\bB\b/u)

      // Listed, then removed through a proposal; a removed rule's queued
      // message is not sent.
      const listed = await client.callTool({ name: 'list_alert_rules', arguments: {} })
      const rules = (JSON.parse(textOf(listed)) as { rules: { id: string; notifies: string[] }[] }).rules
      expect(rules).toHaveLength(1)
      expect(rules[0]?.notifies).toEqual(['member@nt.test'])
      const removal = await client.callTool({ name: 'remove_alert_rule', arguments: { rule: rules[0]?.id } })
      expect(removal.isError, textOf(removal)).toBeFalsy()
      expect(((await apply(client, removal)) as { isError?: boolean }).isError).toBeFalsy()
      expect((await q(`SELECT 1 FROM alert_rules WHERE org_id = $1 AND removed_at IS NULL`, [ORG])).length).toBe(0)
    } finally {
      await client.close()
    }
  })

  it('each kind of rule is answered from what the database already records', async () => {
    // Straight into the tables: what is under test here is the evaluator's SQL
    // against the real schema, for the four kinds the case above does not drive.
    // The log starts empty for this case: the cases above leave refusals in it,
    // which are denials, and a denial spike is one of the things being asked.
    await q(`DELETE FROM skill_versions WHERE org_id = $1`, [ORG])
    await q(`DELETE FROM audit_events WHERE org_id = $1`, [ORG])
    for (const [kind, threshold, window] of [
      ['skill_by_agent', null, null],
      ['skill_scripts', null, null],
      ['admin_connection', null, null],
      ['denial_spike', 3, 10],
    ] as const) {
      await q(
        `INSERT INTO alert_rules (org_id, kind, threshold, window_minutes, to_org_admins, created_by, checked_until)
         VALUES ($1, $2, $3, $4, true, $5, now() - interval '10 minutes')`,
        [ORG, kind, threshold, window, ADMIN],
      )
    }
    await q(
      `INSERT INTO skill_versions (org_id, layer_id, version, files, name, description, has_scripts, principal, surface, connection_id, created_at)
       VALUES ($1, NULL, 1, '{"SKILL.md":"x","scripts/run.sh":"y"}', 'org-skill', 'd', true, $2, 'mcp-admin', $3, now() - interval '1 minute')`,
      [ORG, `user:${ADMIN}`, connection],
    )
    await q(
      `INSERT INTO audit_events (org_id, occurred_at, actor_type, actor_id, actor_label, action, surface, target, result, detail)
       VALUES ($1, now() - interval '1 minute', 'user', $2, 'user', 'oauth.consent', 'api', '{}', 'allow',
               '{"surface":"admin","client_name":"Totally Claude https://x.example/login"}')`,
      [ORG, ADMIN],
    )
    for (let i = 0; i < 3; i += 1) {
      await q(
        `INSERT INTO audit_events (org_id, occurred_at, actor_type, actor_id, actor_label, action, surface, target, result)
         VALUES ($1, now() - interval '1 minute', 'user', $2, 'user', 'get_document', 'mcp', '{"doc_id":"x"}', 'deny')`,
        [ORG, MEMBER],
      )
    }

    expect((await evaluateAlertRules(pool)).fired).toBe(4)
    const rows = await q<{ subject: string; body: string }>(
      `SELECT subject, body FROM notifications WHERE org_id = $1 AND source = 'rule'`,
      [ORG],
    )
    // Sorted here and not by the database: `ORDER BY` on text follows the
    // server's collation, which is C on one machine and en_US on CI's image.
    expect(rows.map((r) => r.subject).sort()).toEqual([
      'a skill version adds scripts',
      'an administrative connection was approved',
      'an agent wrote a skill version',
      'member@nt.test was denied repeatedly',
    ])
    const connected = rows.find((r) => r.subject.startsWith('an administrative'))?.body ?? ''
    // An application's name is the one string here somebody outside chose,
    // and it arrives broken where a mail client would make it a link.
    expect(connected).toContain('approved by admin@nt.test')
    expect(connected).not.toContain('x.example/login')
    expect(rows.find((r) => r.subject.startsWith('an agent'))?.body).toContain("the organization's skill, version 1, by admin@nt.test through the administrative MCP")

    // Looked at, the marks move and nothing fires twice.
    expect((await evaluateAlertRules(pool)).fired).toBe(0)
    await q(`DELETE FROM skill_versions WHERE org_id = $1`, [ORG])
  })

  it('T35 · an organization is held to its hourly bound, and a queued message nobody sent is recorded', async () => {
    const client = await connect()
    try {
      await q(
        `INSERT INTO notifications (org_id, recipients, subject, body, source, sent_by, consent_id, status, finished_at)
         SELECT $1, $2::uuid[], 'Earlier', 'Earlier.', 'agent', $3, $4, 'sent', now() FROM generate_series(1, $5)`,
        [ORG, [MEMBER], ADMIN, connection, NOTIFY_PER_HOUR],
      )
      const proposed = await client.callTool({
        name: 'send_notification',
        arguments: { people: ['member@nt.test'], subject: 'One more', body: 'Over the bound.' },
      })
      expect(proposed.isError, textOf(proposed)).toBeFalsy()
      const applied = await apply(client, proposed)
      expect((applied as { isError?: boolean }).isError).toBe(true)
      expect(textOf(applied)).toContain('which is the limit')

      // Another organization is not held to this one's count.
      const [other] = await q<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE org_id = $1`, [OTHER])
      expect(Number(other?.n ?? 0)).toBe(0)

      await q(`DELETE FROM notifications WHERE org_id = $1`, [ORG])
      await q(
        `INSERT INTO notifications (org_id, recipients, subject, body, source, sent_by, consent_id, created_at)
         VALUES ($1, $2::uuid[], 'Stale', 'Never sent.', 'agent', $3, $4, now() - interval '2 days')`,
        [ORG, [MEMBER], ADMIN, connection],
      )
      expect((await expireNotifications(pool, 30)).ended).toBeGreaterThanOrEqual(1)
      const [stale] = await q<{ status: string }>(`SELECT status FROM notifications WHERE org_id = $1`, [ORG])
      expect(stale?.status).toBe('dropped')
    } finally {
      await client.close()
    }
  })

  it('T35 · without a relay the tools are not offered at all', () => {
    const vectors = { vectorsOf: async () => ({ v: 4 }), tombstoneLayer: async () => undefined }
    const names = adminTools({ pool, audit: new PostgresAudit(pool, AS_APP), vectors }).catalog.map((t) => t.name)
    for (const tool of ['send_notification', 'create_alert_rule', 'remove_alert_rule', 'list_alert_rules']) {
      expect(names, tool).not.toContain(tool)
    }
    const offered = adminTools({ pool, audit: new PostgresAudit(pool, AS_APP), vectors, notifications: true }).catalog.map((t) => t.name)
    expect(offered).toContain('send_notification')
  })
})
