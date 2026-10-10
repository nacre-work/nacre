import { createHash, randomBytes } from 'node:crypto'

import {
  mcpTools,
  McpToolRefusal,
  withOrg,
  type AuditWriter,
  type McpProposal,
  type McpProposalDetail,
  type McpWriteTool,
} from '@nacre.work/core'
import type { Pool } from 'pg'

import { isUuid } from './admin-names.js'
import type { AuthContext } from './auth.js'

/**
 * Proposals: a change on the administrative MCP, waiting for a person.
 * docs/mcp-admin.md, "A change is proposed, and a person applies it".
 *
 * A write tool on `/mcp/admin` stores what it would do here and answers with
 * that. It happens when the person who approved the connection presses Apply —
 * in the panel the host renders beside the tool's result, or on the console's
 * Proposals screen under their own session — and at no other time and by no
 * other hand. Never the model's, in any client: the panel's Apply is a tool the
 * host leaves out of what the model is offered, and the console is a screen the
 * model cannot reach at all. That second door is why a client that renders no
 * panel still works, and why there is no "apply directly" setting for one.
 *
 * Three properties are this table's rather than the code's: single use (the
 * UPDATE that claims a row is the only way to apply it), expiry (the database's
 * clock, ten minutes), and a record of what nobody applied.
 */

export const PROPOSAL_TTL_MS = 10 * 60_000

/**
 * How many proposals may wait on one connection at once.
 *
 * A person reads each before applying it, so a queue longer than this is not
 * one anybody is going to read — it is an agent in a loop, or an injected
 * instruction asking for the same change over and over. Each row is kept for
 * the access log's retention, so without a bound the loop also writes a
 * skill's text into the database once per call. Refused with a sentence the
 * agent can act on: decide what is waiting first.
 */
export const OPEN_PER_CONNECTION = 25

/** Who is deciding: the connection's panel, or the person in the console. */
export type ProposalDecider =
  /** The change panel: this connection, holding the key the panel was handed. */
  | { readonly through: 'panel'; readonly consentId: string; readonly key: string }
  /** The console: the person's own session, which is its own proof. */
  | { readonly through: 'console'; readonly personId: string }

/** The panel key as stored: its SHA-256, so a database read hands over nothing that applies. */
const keyHash = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest()

export interface ProposalView {
  readonly id: string
  readonly tool: string
  readonly module: string | null
  readonly summary: string
  readonly details: readonly McpProposalDetail[]
  readonly createdAt: string
  readonly expiresAt: string
  readonly connection: { readonly id: string; readonly application: string | null }
}

interface Claimed {
  readonly tool: string
  readonly module: string | null
  readonly input: Record<string, unknown>
  readonly consentId: string
}

/** Literal, so `lint:audit-actions` can see each is recorded. */
/** What revoking a connection records for each proposal it ends. oauth-store.ts. */
export const CANCELLED_BY_REVOCATION = { action: 'proposal.cancelled' } as const

const RECORDED = {
  created: { action: 'proposal.created' },
  applied: { action: 'proposal.applied' },
  cancelled: { action: 'proposal.cancelled' },
} as const

export class PostgresProposals {
  constructor(
    private readonly pool: Pool,
    private readonly role: string,
  ) {}

  private inOrg<T>(auth: AuthContext, run: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
    return withOrg(this.pool, auth.orgId, run, { role: this.role })
  }

  /**
   * Store one. The connection and the person come from the token — the
   * administrative connection this call arrived on — and never from anything
   * the tool or the model said.
   */
  async create(
    auth: AuthContext,
    entry: { readonly tool: string; readonly module: string | null; readonly proposal: McpProposal },
  ): Promise<{ readonly id: string; readonly expiresAt: string; readonly panelKey: string }> {
    const consentId = auth.delegation?.id
    if (consentId === undefined || auth.delegation?.surface !== 'admin' || auth.principal.type !== 'user') {
      throw new Error('a proposal is made on an administrative connection, by a person')
    }
    // Handed to the panel once, in `_meta`, and kept here only as a hash.
    const panelKey = randomBytes(32).toString('base64url')
    return this.inOrg(auth, async (client) => {
      // Counted rather than locked: two calls racing past the bound leave it
      // one or two over, and the bound is about a loop, not about one more.
      const { rows: waiting } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM admin_proposals
          WHERE org_id = $1 AND consent_id = $2 AND status = 'open' AND expires_at > now()`,
        [auth.orgId, consentId],
      )
      if ((waiting[0]?.n ?? 0) >= OPEN_PER_CONNECTION) {
        throw new McpToolRefusal(
          `${String(OPEN_PER_CONNECTION)} changes are already waiting for the person on this connection. ` +
            'Ask them to apply or cancel those before proposing more.',
        )
      }
      const { rows } = await client.query<{ id: string; expires_at: string }>(
        `INSERT INTO admin_proposals (org_id, consent_id, proposed_by, tool, module, summary, details, input, expires_at, panel_key_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, now() + make_interval(secs => $9), $10)
         RETURNING id, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
        [
          auth.orgId,
          consentId,
          auth.principal.id,
          entry.tool,
          entry.module,
          entry.proposal.summary.slice(0, 1000),
          JSON.stringify(entry.proposal.details),
          JSON.stringify(entry.proposal.input),
          PROPOSAL_TTL_MS / 1000,
          keyHash(panelKey),
        ],
      )
      const row = rows[0] as { id: string; expires_at: string }
      return { id: row.id, expiresAt: row.expires_at, panelKey }
    })
  }

  /**
   * Take one for applying, or `undefined`. One answer for absent, another
   * organization's, another connection's or person's, already decided, expired,
   * and proposed through a connection revoked since — the caller learns
   * nothing about a proposal that is not theirs to apply.
   *
   * The UPDATE is the single use: two presses, two tabs, or the panel and the
   * console at once each run it, and exactly one gets a row.
   */
  async claim(auth: AuthContext, id: string, by: ProposalDecider): Promise<Claimed | undefined> {
    if (!isUuid(id) || (by.through === 'panel' && by.key === '')) return undefined
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ tool: string; module: string | null; input: Record<string, unknown>; consent_id: string }>(
        `UPDATE admin_proposals p
            SET status = 'applying', decided_at = now(), decided_through = $3
          WHERE p.org_id = $1 AND p.id = $2::uuid
            AND p.status = 'open' AND p.expires_at > now()
            AND ${by.through === 'panel' ? 'p.consent_id = $4::uuid AND p.panel_key_hash = $5' : 'p.proposed_by = $4::uuid'}
            AND EXISTS (SELECT 1 FROM oauth_consents c
                         WHERE c.org_id = p.org_id AND c.id = p.consent_id AND c.revoked_at IS NULL)
        RETURNING p.tool, p.module, p.input, p.consent_id`,
        by.through === 'panel'
          ? [auth.orgId, id, by.through, by.consentId, keyHash(by.key)]
          : [auth.orgId, id, by.through, by.personId],
      )
      const row = rows[0]
      return row === undefined ? undefined : { tool: row.tool, module: row.module, input: row.input, consentId: row.consent_id }
    })
  }

  /** Record how applying went. */
  async settle(auth: AuthContext, id: string, outcome: { readonly ok: true } | { readonly ok: false; readonly error: string }): Promise<void> {
    await this.inOrg(auth, async (client) => {
      await client.query(
        `UPDATE admin_proposals SET status = $3, error = $4
          WHERE org_id = $1 AND id = $2::uuid AND status = 'applying'`,
        [auth.orgId, id, outcome.ok ? 'applied' : 'failed', outcome.ok ? null : outcome.error.slice(0, 1000)],
      )
    })
  }

  /** Decline one. The same single answer as `claim` for anything not the caller's. */
  async cancel(auth: AuthContext, id: string, by: ProposalDecider): Promise<{ readonly tool: string; readonly module: string | null; readonly consentId: string } | undefined> {
    if (!isUuid(id) || (by.through === 'panel' && by.key === '')) return undefined
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ tool: string; module: string | null; consent_id: string }>(
        `UPDATE admin_proposals
            SET status = 'cancelled', decided_at = now(), decided_through = $3
          WHERE org_id = $1 AND id = $2::uuid AND status = 'open' AND expires_at > now()
            AND ${by.through === 'panel' ? 'consent_id = $4::uuid AND panel_key_hash = $5' : 'proposed_by = $4::uuid'}
        RETURNING tool, module, consent_id`,
        by.through === 'panel'
          ? [auth.orgId, id, by.through, by.consentId, keyHash(by.key)]
          : [auth.orgId, id, by.through, by.personId],
      )
      const row = rows[0]
      return row === undefined ? undefined : { tool: row.tool, module: row.module, consentId: row.consent_id }
    })
  }

  /** What is waiting for this person, newest first. Their own and nobody else's. */
  async pending(auth: AuthContext): Promise<readonly ProposalView[]> {
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{
        id: string
        tool: string
        module: string | null
        summary: string
        details: McpProposalDetail[]
        created_at: string
        expires_at: string
        consent_id: string
        application: string | null
      }>(
        `SELECT p.id, p.tool, p.module, p.summary, p.details,
                to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
                to_char(p.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
                p.consent_id, oc.client_name AS application
           FROM admin_proposals p
           JOIN oauth_consents c ON c.org_id = p.org_id AND c.id = p.consent_id AND c.revoked_at IS NULL
           LEFT JOIN oauth_clients oc ON oc.client_id = c.client_id
          WHERE p.org_id = $1 AND p.proposed_by = $2 AND p.status = 'open' AND p.expires_at > now()
          ORDER BY p.created_at DESC
          LIMIT 100`,
        [auth.orgId, auth.principal.id],
      )
      return rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        module: r.module,
        summary: r.summary,
        details: r.details,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        connection: { id: r.consent_id, application: r.application },
      }))
    })
  }
}

/** Where a proposal's tool is found again when it is applied. */
export type WriteLookup = (tool: string, module: string | null) => McpWriteTool | undefined

/**
 * The core's own writes and every module's, by the name and module a proposal
 * stored. A module's tool is found only under the module that registered it,
 * so a proposal cannot be applied by a different module's tool of the same
 * name — and a module unloaded since leaves nothing that can apply it.
 */
export function writeLookup(core: readonly McpWriteTool[]): WriteLookup {
  return (tool, module) => {
    if (module === null) return core.find((t) => t.name === tool)
    const found = mcpTools('admin').find((t) => t.module === module && t.tool.name === tool)?.tool
    return found?.kind === 'write' ? found : undefined
  }
}

export type DecideOutcome =
  | { readonly kind: 'applied'; readonly result: unknown }
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'failed' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'cancelled' }

export interface DecideDeps {
  readonly proposals: PostgresProposals
  readonly audit: AuditWriter
  readonly writes: WriteLookup
}

const surfaceOf = (by: ProposalDecider) => (by.through === 'panel' ? ('mcp-admin' as const) : ('api' as const))

/**
 * A press on something that was not there to press: decided already, expired,
 * another connection's, or — from the panel — without the key the panel was
 * handed. Recorded as a `deny`, since a model applying an id it read out of the
 * access log arrives exactly here.
 */
async function recordGone(
  deps: Pick<DecideDeps, 'audit'>,
  auth: AuthContext,
  action: { readonly action: string },
  id: string,
  by: ProposalDecider,
  requestId: string,
): Promise<void> {
  await deps.audit.write({
    orgId: auth.orgId,
    actor: `${auth.principal.type}:${auth.principal.id}`,
    ...action,
    result: 'deny',
    surface: surfaceOf(by),
    target: { proposal: isUuid(id) ? id : 'not a proposal id' },
    detail: { through: by.through, reason: 'not open, or not this caller\'s to decide' },
    requestId,
  })
}

/**
 * Apply one, as the person deciding. The panel and the console both come
 * here, so there is one answer to what applying means.
 *
 * `apply` runs under the decider's own authority — the administrative
 * connection, or the person's session — and re-checks whatever it needs to: a
 * role lost or a grant revoked in the minutes since the proposal is what
 * decides. A refusal from it is the person's to read and is recorded; anything
 * else is the generic failure and is logged by the caller.
 */
export async function applyProposal(
  deps: DecideDeps,
  auth: AuthContext,
  id: string,
  by: ProposalDecider,
  requestId: string,
): Promise<DecideOutcome> {
  const claimed = await deps.proposals.claim(auth, id, by)
  if (claimed === undefined) {
    await recordGone(deps, auth, RECORDED.applied, id, by, requestId)
    return { kind: 'gone' }
  }

  const record = (result: 'allow' | 'deny' | 'error', detail: Record<string, unknown>) =>
    deps.audit.write({
      orgId: auth.orgId,
      actor: `${auth.principal.type}:${auth.principal.id}`,
      ...RECORDED.applied,
      result,
      surface: surfaceOf(by),
      client: `connection:${claimed.consentId}`,
      target: { proposal: id, tool: claimed.tool, ...(claimed.module === null ? {} : { module: claimed.module }) },
      detail: { through: by.through, ...detail },
      requestId,
    })

  const tool = deps.writes(claimed.tool, claimed.module)
  if (tool === undefined) {
    const reason = `${claimed.tool} is no longer offered here, so this proposal cannot be applied.`
    await deps.proposals.settle(auth, id, { ok: false, error: reason })
    await record('deny', { reason })
    return { kind: 'refused', reason }
  }

  try {
    const result = await tool.apply({ auth, requestId, proposal: { id, through: by.through } }, claimed.input)
    await deps.proposals.settle(auth, id, { ok: true })
    await record('allow', {})
    return { kind: 'applied', result }
  } catch (error) {
    if (error instanceof McpToolRefusal) {
      await deps.proposals.settle(auth, id, { ok: false, error: error.message })
      await record('deny', { reason: error.message })
      return { kind: 'refused', reason: error.message }
    }
    await deps.proposals.settle(auth, id, { ok: false, error: 'internal' })
    await record('error', {})
    throw error
  }
}

/** Decline one. Recorded, because a proposal nobody wanted is part of the story. */
export async function cancelProposal(
  deps: Pick<DecideDeps, 'proposals' | 'audit'>,
  auth: AuthContext,
  id: string,
  by: ProposalDecider,
  requestId: string,
): Promise<DecideOutcome> {
  const cancelled = await deps.proposals.cancel(auth, id, by)
  if (cancelled === undefined) {
    await recordGone(deps, auth, RECORDED.cancelled, id, by, requestId)
    return { kind: 'gone' }
  }
  await deps.audit.write({
    orgId: auth.orgId,
    actor: `${auth.principal.type}:${auth.principal.id}`,
    ...RECORDED.cancelled,
    result: 'allow',
    surface: surfaceOf(by),
    client: `connection:${cancelled.consentId}`,
    target: { proposal: id, tool: cancelled.tool, ...(cancelled.module === null ? {} : { module: cancelled.module }) },
    detail: { through: by.through },
    requestId,
  })
  return { kind: 'cancelled' }
}

/** Store one and record that an agent asked for it. */
/**
 * A write that could not be proposed — a name that matched nothing, a value the
 * tool will not take, or a failure. Recorded as `proposal.created` with `deny`
 * or `error`, because the stream of what an agent *tried* is the part of the
 * log an injection shows up in, and a model probing names leaves nothing
 * otherwise.
 */
export async function recordRefusedProposal(
  deps: Pick<DecideDeps, 'audit'>,
  auth: AuthContext,
  entry: { readonly tool: string; readonly module: string | null },
  reason: string | undefined,
  requestId: string,
): Promise<void> {
  await deps.audit.write({
    orgId: auth.orgId,
    actor: `${auth.principal.type}:${auth.principal.id}`,
    ...RECORDED.created,
    result: reason === undefined ? 'error' : 'deny',
    surface: 'mcp-admin',
    target: { tool: entry.tool, ...(entry.module === null ? {} : { module: entry.module }) },
    detail: reason === undefined ? {} : { reason: reason.slice(0, 300) },
    requestId,
  })
}

export async function recordProposal(
  deps: Pick<DecideDeps, 'proposals' | 'audit'>,
  auth: AuthContext,
  entry: { readonly tool: string; readonly module: string | null; readonly proposal: McpProposal },
  requestId: string,
): Promise<{ readonly id: string; readonly expiresAt: string; readonly panelKey: string }> {
  const stored = await deps.proposals.create(auth, entry)
  await deps.audit.write({
    orgId: auth.orgId,
    actor: `${auth.principal.type}:${auth.principal.id}`,
    ...RECORDED.created,
    result: 'allow',
    surface: 'mcp-admin',
    target: { proposal: stored.id, tool: entry.tool, ...(entry.module === null ? {} : { module: entry.module }) },
    // The sentence and the facts, which are what a person reads — never the
    // input, which may carry a skill's text.
    detail: { summary: entry.proposal.summary, expires_at: stored.expiresAt },
    requestId,
  })
  return stored
}
