import { NOTIFY_PER_HOUR, withOrg, type AlertKind } from '@nacre.work/core'
import type { Pool, PoolClient } from 'pg'

import { isUuid } from './admin-names.js'
import type { AuthContext } from './auth.js'

/**
 * The outbox and the alert rules, from the side that proposes and applies.
 * docs/mcp-admin.md, "Notifications".
 *
 * Nothing here sends: the worker does, reading addresses from `users` at the
 * moment it sends. This side's job is the first of the three bounds on who can
 * receive one — that every recipient it stores is an **active user of the
 * caller's organization**, resolved here, inside `withOrg`, with the
 * organization named in each statement's own literal.
 */

/** A rule as an administrator reads it back. */
export interface AlertRule {
  readonly id: string
  readonly kind: AlertKind
  readonly layerId: string | null
  readonly layerSlug: string | null
  readonly threshold: number | null
  readonly windowMinutes: number | null
  readonly recipients: readonly string[]
  readonly toOrgAdmins: boolean
  readonly createdBy: string
  readonly createdAt: string
  readonly lastFiredAt: string | null
}

export interface NewAlertRule {
  readonly kind: AlertKind
  readonly layerId: string | null
  readonly threshold: number | null
  readonly windowMinutes: number | null
  readonly recipients: readonly string[]
  readonly toOrgAdmins: boolean
}

export type Enqueued = { readonly kind: 'queued'; readonly id: string } | { readonly kind: 'limited' }

/** Active rules one organization may keep. A rule is a standing query against its log every minute. */
export const MAX_ALERT_RULES = 50

export interface NotificationStore {
  /**
   * Each reference — an address or an id — resolved to an active person in the
   * caller's organization, or listed as unknown. Unknown is everything else:
   * another organization's person, a disabled one, a service account's name,
   * an address nobody has. One answer for all of them, the way a `404` is.
   */
  people(
    auth: AuthContext,
    refs: readonly string[],
  ): Promise<{ readonly found: ReadonlyMap<string, { readonly id: string; readonly email: string }>; readonly unknown: readonly string[] }>
  /** How many active organization administrators there are: what "every org_admin" reaches today. */
  orgAdmins(auth: AuthContext): Promise<number>
  /** Into the outbox, inside the hourly bound. */
  enqueue(
    auth: AuthContext,
    notification: {
      readonly recipients: readonly string[]
      readonly toOrgAdmins: boolean
      readonly subject: string
      readonly body: string
      readonly consentId: string
    },
  ): Promise<Enqueued>
  rules(auth: AuthContext): Promise<readonly AlertRule[]>
  createRule(auth: AuthContext, rule: NewAlertRule): Promise<{ readonly kind: 'created'; readonly id: string } | { readonly kind: 'full' }>
  removeRule(auth: AuthContext, id: string): Promise<boolean>
  rule(auth: AuthContext, id: string): Promise<AlertRule | undefined>
}

interface RuleRow {
  id: string
  kind: AlertKind
  layer_id: string | null
  layer_slug: string | null
  threshold: number | null
  window_minutes: number | null
  recipients: string[]
  to_org_admins: boolean
  created_by: string
  created_at: Date
  last_fired_at: Date | null
}

const RULE_COLUMNS = `r.id, r.kind, r.layer_id, l.slug AS layer_slug, r.threshold, r.window_minutes, r.recipients,
       r.to_org_admins, r.created_by, r.created_at, r.last_fired_at`

const ruleOf = (r: RuleRow): AlertRule => ({
  id: r.id,
  kind: r.kind,
  layerId: r.layer_id,
  layerSlug: r.layer_slug,
  threshold: r.threshold,
  windowMinutes: r.window_minutes,
  recipients: r.recipients,
  toOrgAdmins: r.to_org_admins,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
  lastFiredAt: r.last_fired_at === null ? null : r.last_fired_at.toISOString(),
})

export class PostgresNotifications implements NotificationStore {
  constructor(
    private readonly pool: Pool,
    private readonly role: string,
  ) {}

  private inOrg<T>(auth: AuthContext, run: (client: PoolClient) => Promise<T>): Promise<T> {
    return withOrg(this.pool, auth.orgId, run, { role: this.role })
  }

  people(
    auth: AuthContext,
    refs: readonly string[],
  ): Promise<{ found: ReadonlyMap<string, { id: string; email: string }>; unknown: readonly string[] }> {
    return this.inOrg(auth, async (client) => {
      const wanted = [...new Set(refs.map((r) => r.trim()).filter((r) => r !== ''))]
      const ids = wanted.filter(isUuid)
      const emails = wanted.filter((r) => !isUuid(r)).map((r) => r.toLowerCase())
      // Both shapes in one statement, and the organization in its own literal:
      // RLS is the second line here, not the mechanism.
      const { rows } = await client.query<{ id: string; email: string }>(
        `SELECT id, email FROM users
          WHERE org_id = $1 AND disabled_at IS NULL
            AND (id = ANY($2::uuid[]) OR lower(email) = ANY($3::text[]))`,
        [auth.orgId, ids, emails],
      )
      const found = new Map<string, { id: string; email: string }>()
      const unknown: string[] = []
      for (const ref of wanted) {
        const hit = rows.filter((r) => (isUuid(ref) ? r.id === ref.toLowerCase() : r.email.toLowerCase() === ref.toLowerCase()))
        // An address two accounts share would be two people; refused as unknown
        // rather than guessed between. `users` is unique on it, so this is the
        // shape the code has rather than one the data can produce today.
        if (hit.length === 1 && hit[0] !== undefined) found.set(ref, hit[0])
        else unknown.push(ref)
      }
      return { found, unknown }
    })
  }

  orgAdmins(auth: AuthContext): Promise<number> {
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND role = 'org_admin' AND disabled_at IS NULL`,
        [auth.orgId],
      )
      return rows[0]?.n ?? 0
    })
  }

  enqueue(
    auth: AuthContext,
    n: { recipients: readonly string[]; toOrgAdmins: boolean; subject: string; body: string; consentId: string },
  ): Promise<Enqueued> {
    return this.inOrg(auth, async (client) => {
      // One organization's count at a time, so two applies in the same second
      // cannot both read twenty-nine. The lock is the transaction's and goes
      // with it.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('nacre.notify:' || $1::text, 0))`, [auth.orgId])
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO notifications (org_id, recipients, to_org_admins, subject, body, source, sent_by, consent_id)
         SELECT $1, $2::uuid[], $3, $4, $5, 'agent', $6, $7
          WHERE (SELECT count(*) FROM notifications
                  WHERE org_id = $1 AND created_at > now() - interval '1 hour') < $8
         RETURNING id`,
        [auth.orgId, n.recipients, n.toOrgAdmins, n.subject, n.body, auth.principal.id, n.consentId, NOTIFY_PER_HOUR],
      )
      const id = rows[0]?.id
      return id === undefined ? { kind: 'limited' as const } : { kind: 'queued' as const, id }
    })
  }

  rules(auth: AuthContext): Promise<readonly AlertRule[]> {
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<RuleRow>(
        `SELECT ${RULE_COLUMNS}
           FROM alert_rules r LEFT JOIN layers l ON l.id = r.layer_id AND l.org_id = r.org_id
          WHERE r.org_id = $1 AND r.removed_at IS NULL
          ORDER BY r.created_at, r.id`,
        [auth.orgId],
      )
      return rows.map(ruleOf)
    })
  }

  rule(auth: AuthContext, id: string): Promise<AlertRule | undefined> {
    if (!isUuid(id)) return Promise.resolve(undefined)
    return this.inOrg(auth, async (client) => {
      const { rows } = await client.query<RuleRow>(
        `SELECT ${RULE_COLUMNS}
           FROM alert_rules r LEFT JOIN layers l ON l.id = r.layer_id AND l.org_id = r.org_id
          WHERE r.org_id = $1 AND r.id = $2::uuid AND r.removed_at IS NULL`,
        [auth.orgId, id],
      )
      return rows[0] === undefined ? undefined : ruleOf(rows[0])
    })
  }

  createRule(auth: AuthContext, rule: NewAlertRule): Promise<{ kind: 'created'; id: string } | { kind: 'full' }> {
    return this.inOrg(auth, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('nacre.alert-rules:' || $1::text, 0))`, [auth.orgId])
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO alert_rules (org_id, kind, layer_id, threshold, window_minutes, recipients, to_org_admins, created_by)
         SELECT $1, $2, $3, $4, $5, $6::uuid[], $7, $8
          WHERE (SELECT count(*) FROM alert_rules WHERE org_id = $1 AND removed_at IS NULL) < $9
         RETURNING id`,
        [
          auth.orgId,
          rule.kind,
          rule.layerId,
          rule.threshold,
          rule.windowMinutes,
          rule.recipients,
          rule.toOrgAdmins,
          auth.principal.id,
          MAX_ALERT_RULES,
        ],
      )
      const id = rows[0]?.id
      return id === undefined ? { kind: 'full' as const } : { kind: 'created' as const, id }
    })
  }

  removeRule(auth: AuthContext, id: string): Promise<boolean> {
    if (!isUuid(id)) return Promise.resolve(false)
    return this.inOrg(auth, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE alert_rules SET removed_at = now() WHERE org_id = $1 AND id = $2::uuid AND removed_at IS NULL`,
        [auth.orgId, id],
      )
      return rowCount === 1
    })
  }
}
