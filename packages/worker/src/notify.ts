import {
  acrossOrganizations,
  NOTIFY_PER_HOUR,
  notificationMessage,
  plainName,
  ruleSentence,
  type AlertKind,
  type Mailer,
  type NotificationOrigin,
} from '@nacre.work/core'
import type { Pool, PoolClient } from 'pg'

/**
 * Alert rules and the outbox, from the side that evaluates and sends.
 * docs/mcp-admin.md, "Notifications".
 *
 * Passes across organizations under `acrossOrganizations`, and every statement
 * that reads one organization's rows names it in its own literal — this role
 * bypasses row-level security, so that literal is the only line left. The
 * statements that pick work across organizations name none, and say so by
 * being the ones that select by status and time alone.
 *
 * ## The third bound on who receives one
 *
 * The tool refuses anybody who is not an active person in the caller's
 * organization; applying refuses anybody who stopped being one since. This is
 * the third: the address is read here, at the moment of sending, from `users`
 * in the notification's own organization, active accounts only. A recipient
 * disabled after the person pressed Apply is not sent it, and nothing anywhere
 * holds an address a message could be redirected to.
 *
 * ## At most once
 *
 * A message is claimed before it is sent and is never claimed twice. A worker
 * that dies between the two leaves it `sending`, and the expiry pass marks that
 * `failed` rather than putting it back: two copies of a security notice teach
 * people that the notices are noise, and a missing one is in the access log
 * as an error somebody can see.
 */

/** Rules looked at per pass. A rule is a handful of indexed reads. */
const RULE_BATCH = 100

/**
 * How far behind now the evaluator looks. A row committed late by a long
 * transaction still carries the time that transaction started, so a window
 * ending at `now()` would step past it before it was visible.
 */
const SETTLE = "interval '15 seconds'"

/** Lines one alert lists before saying how many more there were. */
const SHOWN = 10

/** Attempts at a relay before a message is given up on. */
const SEND_ATTEMPTS = 3

interface DueRule {
  id: string
  org_id: string
  kind: AlertKind
  layer_id: string | null
  threshold: number | null
  window_minutes: number | null
  recipients: string[]
  to_org_admins: boolean
  checked_until: Date
  last_fired_at: Date | null
}

interface Finding {
  readonly subject: string
  readonly body: string
}

const plural = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`

const more = (total: number): string => (total > SHOWN ? `\n\nAnd ${String(total - SHOWN)} more.` : '')

/** Whose a skill is, in a sentence. */
const skillOf = (slug: string | null): string => (slug === null ? "the organization's skill" : `the layer ${slug}'s skill`)

/** An actor named the way a person reads one, from the tables that hold names. */
const ACTOR_NAME = `COALESCE(u.email, sa.name, a.actor_type || ' ' || a.actor_id::text)`
const ACTOR_JOIN = `LEFT JOIN users u ON a.actor_type = 'user' AND u.id = a.actor_id AND u.org_id = a.org_id
                    LEFT JOIN service_accounts sa ON a.actor_type = 'service_account' AND sa.id = a.actor_id AND sa.org_id = a.org_id`

/**
 * What one rule found since it was last looked at, or nothing.
 *
 * Every query here is the organization's and its window's. The body is written
 * from names this installation holds — slugs, addresses, an application's
 * registered name — and an application's name is the one string here somebody
 * outside the organization chose, so it goes through `plainName` first.
 */
async function find(client: PoolClient, rule: DueRule): Promise<Finding | undefined> {
  const counting = rule.window_minutes !== null && rule.threshold !== null
  if (counting && rule.last_fired_at !== null) {
    // Once per window: a spike lasting an hour is one message, not sixty.
    const since = Date.now() - (rule.window_minutes as number) * 60_000
    if (rule.last_fired_at.getTime() > since) return undefined
  }

  switch (rule.kind) {
    case 'skill_by_agent':
    case 'skill_scripts': {
      const scripts = rule.kind === 'skill_scripts'
      const { rows } = await client.query<{ slug: string | null; version: number; who: string; surface: string; total: string }>(
        `SELECT l.slug, v.version, COALESCE(u.email, sa.name, v.principal) AS who, v.surface,
                count(*) OVER ()::text AS total
           FROM skill_versions v
           LEFT JOIN layers l ON l.id = v.layer_id AND l.org_id = v.org_id
           LEFT JOIN users u ON v.principal = 'user:' || u.id::text AND u.org_id = v.org_id
           LEFT JOIN service_accounts sa ON v.principal = 'service_account:' || sa.id::text AND sa.org_id = v.org_id
           LEFT JOIN skill_versions p
                  ON p.org_id = v.org_id AND p.layer_id IS NOT DISTINCT FROM v.layer_id AND p.version = v.version - 1
          WHERE v.org_id = $1
            AND v.created_at > $2 AND v.created_at <= now() - ${SETTLE}
            AND ($3::uuid IS NULL OR v.layer_id = $3::uuid)
            AND CASE WHEN $4 THEN v.has_scripts AND NOT COALESCE(p.has_scripts, false)
                     ELSE v.surface <> 'rest' OR v.connection_id IS NOT NULL OR v.principal LIKE 'service_account:%' END
          ORDER BY v.created_at
          LIMIT ${String(SHOWN)}`,
        [rule.org_id, rule.checked_until, rule.layer_id, scripts],
      )
      if (rows.length === 0) return undefined
      const total = Number(rows[0]?.total ?? rows.length)
      const lines = rows.map(
        (r) => `- ${skillOf(r.slug)}, version ${String(r.version)}, by ${r.who}${r.surface === 'rest' ? '' : ` through ${r.surface === 'mcp-admin' ? 'the administrative MCP' : 'MCP'}`}`,
      )
      return scripts
        ? {
            subject: total === 1 ? 'a skill version adds scripts' : `${String(total)} skill versions add scripts`,
            body:
              `A skill version that adds scripts was written:\n\n${lines.join('\n')}${more(total)}\n\n` +
              "A skill's scripts run on the side of whoever uses it, with that person's approval. Read the version on the console's Skills screen.",
          }
        : {
            subject: total === 1 ? 'an agent wrote a skill version' : `agents wrote ${String(total)} skill versions`,
            body:
              `${total === 1 ? 'A skill version was' : 'Skill versions were'} written by an agent rather than in the console:\n\n` +
              `${lines.join('\n')}${more(total)}\n\n` +
              'Every later agent follows what a skill says. Read it on the console\'s Skills screen; going back to an earlier version is a restore.',
          }
    }

    case 'admin_connection': {
      const { rows } = await client.query<{ client: string | null; who: string; total: string }>(
        `SELECT a.detail->>'client_name' AS client, ${ACTOR_NAME} AS who, count(*) OVER ()::text AS total
           FROM audit_events a ${ACTOR_JOIN}
          WHERE a.org_id = $1 AND a.action = 'oauth.consent' AND a.result = 'allow'
            AND a.detail->>'surface' = 'admin'
            AND a.occurred_at > $2 AND a.occurred_at <= now() - ${SETTLE}
          ORDER BY a.occurred_at
          LIMIT ${String(SHOWN)}`,
        [rule.org_id, rule.checked_until],
      )
      if (rows.length === 0) return undefined
      const total = Number(rows[0]?.total ?? rows.length)
      const lines = rows.map((r) => `- "${plainName(r.client ?? 'an application')}", approved by ${r.who}`)
      return {
        subject: total === 1 ? 'an administrative connection was approved' : `${String(total)} administrative connections were approved`,
        body:
          `${total === 1 ? 'An application was' : 'Applications were'} given an administrative connection:\n\n${lines.join('\n')}${more(total)}\n\n` +
          'An administrative connection can propose changes to people, groups, layers and grants, each applied by the ' +
          "person who approved it. If one is unexpected, revoke it on the console's Connections screen.",
      }
    }

    case 'denial_spike': {
      const { rows } = await client.query<{ who: string; denied: string }>(
        `SELECT ${ACTOR_NAME} AS who, count(*)::text AS denied
           FROM audit_events a ${ACTOR_JOIN}
          WHERE a.org_id = $1 AND a.result = 'deny' AND a.actor_id IS NOT NULL
            AND a.occurred_at > now() - make_interval(mins => $2::int)
          GROUP BY a.actor_type, a.actor_id, u.email, sa.name
         HAVING count(*) >= $3
          ORDER BY count(*) DESC
          LIMIT ${String(SHOWN)}`,
        [rule.org_id, rule.window_minutes, rule.threshold],
      )
      if (rows.length === 0) return undefined
      const lines = rows.map((r) => `- ${r.who}: denied ${r.denied} times`)
      return {
        subject: rows.length === 1 ? `${rows[0]?.who ?? 'somebody'} was denied repeatedly` : `${String(rows.length)} principals were denied repeatedly`,
        body:
          `In the last ${plural(rule.window_minutes as number, 'minute')}, at least ${String(rule.threshold)} denials each:\n\n${lines.join('\n')}\n\n` +
          'A denial is the permission model working. Many of them from one principal is either a misconfigured client or ' +
          "somebody looking for what they cannot see — the access log says which requests.",
      }
    }

    case 'documents_failed': {
      const { rows } = await client.query<{ slug: string; failed: string }>(
        `SELECT l.slug, count(*)::text AS failed
           FROM documents d JOIN layers l ON l.id = d.layer_id AND l.org_id = d.org_id
          WHERE d.org_id = $1 AND d.status = 'failed' AND d.deleted_at IS NULL
            AND d.updated_at > now() - make_interval(mins => $2::int)
            AND ($3::uuid IS NULL OR d.layer_id = $3::uuid)
          GROUP BY l.slug
          ORDER BY count(*) DESC, l.slug`,
        [rule.org_id, rule.window_minutes, rule.layer_id],
      )
      const total = rows.reduce((sum, r) => sum + Number(r.failed), 0)
      if (total < (rule.threshold as number)) return undefined
      const lines = rows.slice(0, SHOWN).map((r) => `- ${r.slug}: ${r.failed}`)
      return {
        subject: `${plural(total, 'document')} failed to index`,
        body:
          `${plural(total, 'document')} failed to index in the last ${plural(rule.window_minutes as number, 'minute')}:\n\n` +
          `${lines.join('\n')}${rows.length > SHOWN ? `\n\nAnd ${String(rows.length - SHOWN)} more layers.` : ''}\n\n` +
          'Each failed document carries its reason. A transient failure is retried by itself; one that will not ' +
          'recover — a quota, a document too large — can be retried once the cause is fixed.',
      }
    }
  }
}

/** Into the outbox under the organization's hourly bound — the same bound an agent's message meets. */
async function queue(client: PoolClient, rule: DueRule, finding: Finding): Promise<boolean> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('nacre.notify:' || $1::text, 0))`, [rule.org_id])
  const { rowCount } = await client.query(
    `INSERT INTO notifications (org_id, recipients, to_org_admins, subject, body, source, rule_id)
     SELECT $1, $2::uuid[], $3, left($4, 200), left($5, 4000), 'rule', $6
      WHERE (SELECT count(*) FROM notifications WHERE org_id = $1 AND created_at > now() - interval '1 hour') < $7`,
    [rule.org_id, rule.recipients, rule.to_org_admins, finding.subject, finding.body, rule.id, NOTIFY_PER_HOUR],
  )
  return rowCount === 1
}

/**
 * Look at every rule that is due, queue what each found, and move each one's
 * mark forward — except where the organization's hourly bound refused the
 * message, so it is found again on a later pass rather than lost.
 */
export async function evaluateAlertRules(pool: Pool): Promise<{ readonly checked: number; readonly fired: number; readonly held: number }> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<DueRule>(
      `SELECT id, org_id, kind, layer_id, threshold, window_minutes, recipients, to_org_admins, checked_until, last_fired_at
         FROM alert_rules
        WHERE removed_at IS NULL AND checked_until < now() - ${SETTLE} - interval '45 seconds'
        ORDER BY checked_until
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [RULE_BATCH],
    )
    let fired = 0
    let held = 0
    for (const rule of rows) {
      const finding = await find(client, rule)
      if (finding !== undefined && !(await queue(client, rule, finding))) {
        held += 1
        continue
      }
      if (finding !== undefined) fired += 1
      await client.query(
        `UPDATE alert_rules
            SET checked_until = now() - ${SETTLE},
                last_fired_at = CASE WHEN $3 THEN now() ELSE last_fired_at END
          WHERE org_id = $1 AND id = $2`,
        [rule.org_id, rule.id, finding !== undefined],
      )
    }
    return { checked: rows.length, fired, held }
  })
}

interface Claimed {
  id: string
  org_id: string
  subject: string
  body: string
  source: 'agent' | 'rule'
  recipients: string[]
  to_org_admins: boolean
  sent_by: string | null
  consent_id: string | null
  rule_id: string | null
  attempts: number
}

/** Who it goes to, now — active people of its own organization — and where it came from. */
async function address(
  client: PoolClient,
  n: Claimed,
): Promise<{ readonly people: readonly { id: string; email: string }[]; readonly origin: NotificationOrigin | undefined }> {
  const { rows: people } = await client.query<{ id: string; email: string }>(
    `SELECT id, email FROM users
      WHERE org_id = $1 AND disabled_at IS NULL
        AND (id = ANY($2::uuid[]) OR ($3 AND role = 'org_admin'))
      ORDER BY email`,
    [n.org_id, n.recipients, n.to_org_admins],
  )
  if (n.source === 'agent') {
    const { rows } = await client.query<{ applied_by: string; application: string }>(
      `SELECT u.email AS applied_by, c.client_name AS application
         FROM users u, oauth_consents oc JOIN oauth_clients c ON c.client_id = oc.client_id
        WHERE u.org_id = $1 AND u.id = $2 AND oc.org_id = $1 AND oc.id = $3`,
      [n.org_id, n.sent_by, n.consent_id],
    )
    const r = rows[0]
    return { people, origin: r === undefined ? undefined : { source: 'agent', appliedBy: r.applied_by, application: plainName(r.application) } }
  }
  const { rows } = await client.query<{
    kind: AlertKind
    slug: string | null
    threshold: number | null
    window_minutes: number | null
    rule_by: string | null
  }>(
    `SELECT r.kind, l.slug, r.threshold, r.window_minutes, u.email AS rule_by
       FROM alert_rules r
       LEFT JOIN layers l ON l.id = r.layer_id AND l.org_id = r.org_id
       LEFT JOIN users u ON u.id = r.created_by AND u.org_id = r.org_id
      WHERE r.org_id = $1 AND r.id = $2 AND r.removed_at IS NULL`,
    [n.org_id, n.rule_id],
  )
  const r = rows[0]
  return {
    people,
    origin:
      r === undefined
        ? undefined
        : {
            source: 'rule',
            when: ruleSentence({ kind: r.kind, layerSlug: r.slug, threshold: r.threshold, windowMinutes: r.window_minutes }),
            ruleBy: r.rule_by,
          },
  }
}

type Outcome =
  | { readonly status: 'sent'; readonly to: readonly string[]; readonly failed: number; readonly error?: string }
  | { readonly status: 'dropped'; readonly error: string }
  | { readonly status: 'retry'; readonly error: string }
  | { readonly status: 'failed'; readonly error: string }

/** The row's end, and the access log's line about it, in one transaction. */
async function finish(pool: Pool, n: Claimed, outcome: Outcome): Promise<void> {
  await acrossOrganizations(pool, async (client) => {
    if (outcome.status === 'retry') {
      await client.query(
        `UPDATE notifications
            SET status = 'queued', claimed_at = NULL, error = left($3, 500),
                not_before = now() + make_interval(mins => power(2, attempts)::int)
          WHERE org_id = $1 AND id = $2`,
        [n.org_id, n.id, outcome.error],
      )
      return
    }
    await client.query(
      `UPDATE notifications
          SET status = $3, finished_at = now(), delivered = $4, error = left($5, 500)
        WHERE org_id = $1 AND id = $2`,
      [n.org_id, n.id, outcome.status, outcome.status === 'sent' ? outcome.to.length : 0, 'error' in outcome ? (outcome.error ?? null) : null],
    )
    // `notification.sent` whatever became of it, with the result saying which:
    // a message that did not go is the one somebody needs to find.
    await client.query(
      `INSERT INTO audit_events (org_id, actor_type, actor_id, actor_label, action, surface, client, target, result, detail)
       VALUES ($1, 'system', NULL, 'system', $2, 'system', $3, $4, $5, $6)`,
      [
        n.org_id,
        SENT.action,
        n.consent_id === null ? null : `connection:${n.consent_id}`,
        JSON.stringify({ notification: n.id, ...(n.rule_id === null ? {} : { alert_rule: n.rule_id }) }),
        outcome.status === 'sent' ? 'allow' : 'error',
        JSON.stringify({
          source: n.source,
          outcome: outcome.status,
          ...(outcome.status === 'sent' ? { recipients: outcome.to, delivered: outcome.to.length, ...(outcome.failed > 0 ? { undelivered: outcome.failed } : {}) } : {}),
          ...(n.sent_by === null ? {} : { applied_by: `user:${n.sent_by}` }),
          ...('error' in outcome && outcome.error !== undefined ? { error: outcome.error.slice(0, 200) } : {}),
        }),
      ],
    )
  })
}

/** Literal, so `lint:audit-actions` can see it is recorded. */
const SENT = { action: 'notification.sent' } as const

/**
 * Send what is queued and due, one message per address so no recipient sees
 * another's, and record each in the access log.
 *
 * Nothing is held open across a relay's round trip: the claim commits, the
 * messages go, and the outcome is a second short transaction.
 */
export async function sendNotifications(
  pool: Pool,
  mailer: Mailer,
  consoleBase: string,
  limit: number,
): Promise<{ readonly sent: number; readonly dropped: number; readonly failed: number }> {
  const claimed = await acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<Claimed>(
      `UPDATE notifications n
          SET status = 'sending', claimed_at = now(), attempts = n.attempts + 1
         FROM (SELECT id FROM notifications
                WHERE status = 'queued' AND not_before <= now()
                ORDER BY not_before
                LIMIT $1
                FOR UPDATE SKIP LOCKED) due
        WHERE n.id = due.id
        RETURNING n.id, n.org_id, n.subject, n.body, n.source, n.recipients, n.to_org_admins,
                  n.sent_by, n.consent_id, n.rule_id, n.attempts`,
      [limit],
    )
    const out: { n: Claimed; people: readonly { id: string; email: string }[]; origin: NotificationOrigin | undefined }[] = []
    for (const n of rows) out.push({ n, ...(await address(client, n)) })
    return out
  })

  let sent = 0
  let dropped = 0
  let failed = 0
  for (const { n, people, origin } of claimed) {
    if (origin === undefined) {
      dropped += 1
      await finish(pool, n, { status: 'dropped', error: n.source === 'rule' ? 'the rule was removed' : 'the connection or the person who applied it is gone' })
      continue
    }
    if (people.length === 0) {
      dropped += 1
      await finish(pool, n, { status: 'dropped', error: 'nobody it was addressed to is an active person in the organization any more' })
      continue
    }
    const to: string[] = []
    let lastError = ''
    for (const person of people) {
      try {
        await mailer.send(notificationMessage(person.email, consoleBase, n, origin))
        to.push(person.id)
      } catch (error) {
        lastError = String(error).slice(0, 200)
      }
    }
    if (to.length > 0) {
      sent += 1
      // Partly delivered is sent: going round again would give the ones who
      // have it a second copy. The shortfall is in the record.
      await finish(pool, n, { status: 'sent', to, failed: people.length - to.length, ...(lastError === '' ? {} : { error: lastError }) })
    } else if (n.attempts < SEND_ATTEMPTS) {
      await finish(pool, n, { status: 'retry', error: lastError })
    } else {
      failed += 1
      await finish(pool, n, { status: 'failed', error: lastError })
    }
  }
  return { sent, dropped, failed }
}

/**
 * The outbox's loose ends: a message nobody could send within a day, one a
 * dead worker left half-sent, and finished rows past their retention window.
 *
 * Runs whether or not this worker has a relay — it is the pass that says, in
 * the access log, that a queued message never went, which matters most exactly
 * when there is nothing to send it.
 */
export async function expireNotifications(pool: Pool, retentionDays: number): Promise<{ readonly ended: number; readonly pruned: number }> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{ ended: string }>(
      `WITH due AS (
         SELECT id FROM notifications
          WHERE (status = 'queued' AND created_at < now() - interval '1 day')
             OR (status = 'sending' AND claimed_at < now() - interval '15 minutes')
          LIMIT 200
          FOR UPDATE SKIP LOCKED
       ), ended AS (
         UPDATE notifications n
            SET status = CASE WHEN n.status = 'queued' THEN 'dropped' ELSE 'failed' END,
                finished_at = now(),
                delivered = 0,
                error = CASE WHEN n.status = 'queued' THEN 'not sent within a day'
                             ELSE 'interrupted while sending; not sent again, so nobody gets it twice' END
           FROM due WHERE n.id = due.id
         RETURNING n.org_id, n.id, n.rule_id, n.consent_id, n.sent_by, n.source, n.status, n.error
       ), recorded AS (
         INSERT INTO audit_events (org_id, actor_type, actor_id, actor_label, action, surface, client, target, result, detail)
         SELECT org_id, 'system', NULL, 'system', $1, 'system',
                CASE WHEN consent_id IS NULL THEN NULL ELSE 'connection:' || consent_id END,
                jsonb_strip_nulls(jsonb_build_object('notification', id, 'alert_rule', rule_id)),
                'error',
                jsonb_strip_nulls(jsonb_build_object('source', source, 'outcome', status, 'error', error,
                                                     'applied_by', CASE WHEN sent_by IS NULL THEN NULL ELSE 'user:' || sent_by END))
           FROM ended
         RETURNING 1
       )
       SELECT count(*)::text AS ended FROM recorded`,
      [SENT.action],
    )
    const { rowCount } = await client.query(
      `DELETE FROM notifications
        WHERE id IN (SELECT id FROM notifications
                      WHERE finished_at < now() - make_interval(days => $1::int)
                      LIMIT 2000)`,
      [retentionDays],
    )
    return { ended: Number(rows[0]?.ended ?? 0), pruned: rowCount ?? 0 }
  })
}
