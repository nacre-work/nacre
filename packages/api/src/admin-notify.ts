import {
  ALERT_KINDS,
  ALERT_WINDOW,
  isAlertKind,
  McpToolRefusal,
  NOTIFY_MAX_RECIPIENTS,
  NOTIFY_PER_HOUR,
  notificationText,
  ruleSentence,
  type AlertKind,
  type AuditWriter,
  type McpReadTool,
  type McpToolCall,
  type McpWriteTool,
} from '@nacre.work/core'

import type { AdminNames } from './admin-names.js'
import { isUuid } from './admin-names.js'
import type { AuthContext } from './auth.js'
import { MAX_ALERT_RULES, type AlertRule, type NotificationStore } from './notifications.js'

/**
 * Notifications and alert rules on the administrative MCP. docs/mcp-admin.md,
 * "Notifications".
 *
 * Built only where the installation has a mail relay — a tool that queues a
 * message nothing will send is a tool that says it did something it did not —
 * and composed by both processes that hold the core's writes: the MCP process,
 * which proposes, and the API, which applies from the console.
 *
 * ## T35
 *
 * A recipient is named by address or id and resolved to an **active user of
 * the caller's organization**, or the call is refused naming what did not
 * resolve — before anything is stored, which is "refused before a message is
 * composed". The address is used to find a person and then dropped: what is
 * stored is the id, and the worker reads the address again at sending time.
 * Applying resolves the ids once more, because a person disabled in the ten
 * minutes between is somebody the organization has just decided should not be
 * reached.
 */

export interface NotifyPorts {
  readonly audit: AuditWriter
  readonly names: AdminNames
  readonly notifications: NotificationStore
}

type Args = Readonly<Record<string, unknown>>

const auth = (call: McpToolCall): AuthContext => call.auth as AuthContext

const RECIPIENT_PROPS = {
  people: {
    type: 'array',
    items: { type: 'string' },
    maxItems: NOTIFY_MAX_RECIPIENTS,
    description:
      'People in this organization, by email address or id. Nobody else can be named: there is no way to ' +
      'send to an address outside the organization.',
  },
  org_admins: { type: 'boolean', description: "Every active organization administrator, whoever they are when it is sent." },
} as const

const count = (n: number, one: string, many = `${one}s`): string => `${String(n)} ${n === 1 ? one : many}`

/** The references a call named, bounded, before anything is looked up. */
function references(args: Args): { readonly refs: readonly string[]; readonly toOrgAdmins: boolean } {
  const people = args.people
  if (people !== undefined && !Array.isArray(people)) throw new McpToolRefusal("'people' is a list of addresses or ids.")
  const refs = (people ?? []) as unknown[]
  if (refs.some((r) => typeof r !== 'string' || r.trim() === '' || r.length > 320)) {
    throw new McpToolRefusal("Each of 'people' is one person's address or id.")
  }
  if (refs.length > NOTIFY_MAX_RECIPIENTS) {
    throw new McpToolRefusal(`At most ${String(NOTIFY_MAX_RECIPIENTS)} people by name; 'org_admins' reaches every administrator.`)
  }
  if (args.org_admins !== undefined && typeof args.org_admins !== 'boolean') throw new McpToolRefusal("'org_admins' is true or false.")
  const toOrgAdmins = args.org_admins === true
  if (refs.length === 0 && !toOrgAdmins) throw new McpToolRefusal("Name the people it goes to, or set 'org_admins'.")
  return { refs: refs as string[], toOrgAdmins }
}

/**
 * Who it goes to, as ids and as the sentence a person reads — or a refusal
 * naming every reference that is not an active person here. T35.
 */
async function recipients(
  ports: NotifyPorts,
  a: AuthContext,
  args: Args,
): Promise<{ readonly ids: readonly string[]; readonly emails: readonly string[]; readonly toOrgAdmins: boolean; readonly words: string }> {
  const { refs, toOrgAdmins } = references(args)
  const { found, unknown } = await ports.notifications.people(a, refs)
  if (unknown.length > 0) {
    throw new McpToolRefusal(
      `${unknown.map((r) => `"${r}"`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not an active person in this ` +
        'organization. A notification goes only to people here, named by their address — nobody outside it, ' +
        'and nobody disabled.',
    )
  }
  const people = [...new Map([...found.values()].map((p) => [p.id, p])).values()]
  const emails = people.map((p) => p.email)
  const admins = toOrgAdmins ? await ports.notifications.orgAdmins(a) : 0
  const parts = [...emails, ...(toOrgAdmins ? [`every organization administrator (${String(admins)} now)`] : [])]
  const words = parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`
  return { ids: people.map((p) => p.id), emails, toOrgAdmins, words }
}

/** Ids a stored proposal carries, still active — or the refusal saying who is not. */
async function stillActive(ports: NotifyPorts, a: AuthContext, ids: readonly string[]): Promise<void> {
  const { unknown } = await ports.notifications.people(a, ids)
  if (unknown.length > 0) {
    throw new McpToolRefusal(
      `${count(unknown.length, 'person', 'people')} it was addressed to ${unknown.length === 1 ? 'is' : 'are'} no longer active ` +
        'in this organization. Propose it again to the people who are.',
    )
  }
}

const storedIds = (input: Args, key: string): readonly string[] => {
  const value = input[key]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !isUuid(v))) {
    throw new Error(`a stored proposal is missing ${key}`)
  }
  return value as string[]
}


export function notificationTools(ports: NotifyPorts): readonly (McpReadTool | McpWriteTool)[] {
  const record = async (
    call: McpToolCall,
    action: { readonly action: string },
    result: 'allow' | 'deny',
    target: Record<string, unknown>,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    const a = auth(call)
    if (Object.keys(target).length === 0) throw new Error(`${action.action} was recorded with no target`)
    await ports.audit.write({
      orgId: a.orgId,
      actor: `${a.principal.type}:${a.principal.id}`,
      ...action,
      result,
      surface: 'mcp-admin',
      target: { ...target },
      detail: { ...detail, ...(call.proposal === undefined ? {} : { proposal: call.proposal.id, through: call.proposal.through }) },
      requestId: call.requestId,
    })
  }

  const describeRule = async (a: AuthContext, rule: AlertRule): Promise<Record<string, unknown>> => {
    const named = await ports.names.names(a, [...rule.recipients, rule.createdBy])
    return {
      id: rule.id,
      when: ruleSentence(rule),
      kind: rule.kind,
      ...(rule.layerSlug === null ? {} : { layer: rule.layerSlug }),
      ...(rule.threshold === null ? {} : { threshold: rule.threshold, window_minutes: rule.windowMinutes }),
      notifies: [
        ...rule.recipients.map((id) => named.get(id) ?? id),
        ...(rule.toOrgAdmins ? ['every organization administrator'] : []),
      ],
      created_by: named.get(rule.createdBy) ?? rule.createdBy,
      created_at: rule.createdAt,
      last_fired_at: rule.lastFiredAt,
    }
  }

  return [
    {
      kind: 'write',
      name: 'send_notification',
      title: 'Send a notification',
      description:
        'Propose an email to people in this organization — by address, or every organization administrator. ' +
        'A subject and a plain-text body, no links. It says an agent wrote it and who approved it. Only people ' +
        `in this organization can be named. At most ${String(NOTIFY_PER_HOUR)} an hour per organization.`,
      inputSchema: {
        type: 'object',
        properties: {
          ...RECIPIENT_PROPS,
          subject: { type: 'string', maxLength: 200, description: 'One line.' },
          body: { type: 'string', maxLength: 4000, description: 'Plain text; a blank line starts a paragraph. No links.' },
        },
        required: ['subject', 'body'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        // Recipients first, and refused before the text is even looked at: the
        // question T35 asks is answered before anything is composed.
        const to = await recipients(ports, a, args)
        const text = notificationText(args.subject, args.body)
        if ('refused' in text) throw new McpToolRefusal(text.refused)
        const consentId = a.delegation?.id
        if (consentId === undefined) throw new McpToolRefusal('A notification is proposed through an administrative connection.')
        return {
          summary: `Email ${to.words}: "${text.subject}".`,
          details: [
            { label: 'to', value: to.words },
            { label: 'subject', value: text.subject },
            { label: 'body', value: text.body },
            { label: 'note', value: 'The message says an agent wrote it, through which connection, and that you approved it.' },
          ],
          input: { recipients: to.ids, to_org_admins: to.toOrgAdmins, subject: text.subject, body: text.body, consent_id: consentId },
        }
      },
      async apply(call, input) {
        const a = auth(call)
        const ids = storedIds(input, 'recipients')
        const consentId = typeof input.consent_id === 'string' && isUuid(input.consent_id) ? input.consent_id : undefined
        if (consentId === undefined) throw new Error('a stored proposal is missing consent_id')
        const text = notificationText(input.subject, input.body)
        try {
          if ('refused' in text) throw new McpToolRefusal(text.refused)
          await stillActive(ports, a, ids)
        } catch (error) {
          await record(call, { action: 'send_notification' }, 'deny', { connection: consentId }, { recipients: ids.length })
          throw error
        }
        const queued = await ports.notifications.enqueue(a, {
          recipients: ids,
          toOrgAdmins: input.to_org_admins === true,
          subject: text.subject,
          body: text.body,
          consentId,
        })
        if (queued.kind === 'limited') {
          await record(call, { action: 'send_notification' }, 'deny', { connection: consentId }, { outcome: 'rate_limited' })
          throw new McpToolRefusal(
            `This organization has queued ${String(NOTIFY_PER_HOUR)} notifications in the last hour, which is the limit. ` +
              'Try again later.',
          )
        }
        await record(
          call,
          { action: 'send_notification' },
          'allow',
          { notification: queued.id, connection: consentId },
          { recipients: ids.length, to_org_admins: input.to_org_admins === true },
        )
        return { notification: queued.id, status: 'queued: the worker sends it within a minute or two' }
      },
    },
    {
      kind: 'write',
      name: 'create_alert_rule',
      title: 'Create an alert rule',
      description:
        'Propose a standing rule the worker checks every minute, emailing people in this organization when it ' +
        'fires: a skill version written by an agent (skill_by_agent), one adding scripts (skill_scripts), an ' +
        'administrative connection approved (admin_connection), one principal denied at least `threshold` ' +
        'times in `window_minutes` (denial_spike), or at least `threshold` documents failing to index in ' +
        '`window_minutes` (documents_failed). A counting rule fires at most once per window.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: Object.keys(ALERT_KINDS) },
          layer: { type: 'string', description: "A layer's slug, to watch only it — for the skill kinds and documents_failed." },
          threshold: { type: 'integer', minimum: 1, maximum: 100000, description: 'For denial_spike and documents_failed.' },
          window_minutes: {
            type: 'integer',
            minimum: ALERT_WINDOW.min,
            maximum: ALERT_WINDOW.max,
            description: `For denial_spike and documents_failed; ${String(ALERT_WINDOW.default)} by default.`,
          },
          ...RECIPIENT_PROPS,
        },
        required: ['kind'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        if (!isAlertKind(args.kind)) throw new McpToolRefusal(`'kind' is one of ${Object.keys(ALERT_KINDS).join(', ')}.`)
        const kind = args.kind
        const shape = ALERT_KINDS[kind]
        const to = await recipients(ports, a, args)

        let layer: { id: string; slug: string } | null = null
        if (typeof args.layer === 'string' && args.layer !== '') {
          if (!shape.layered) throw new McpToolRefusal(`A ${kind} rule watches the whole organization; it takes no layer.`)
          layer = await ports.names.layer(a, args.layer)
        }
        let threshold: number | null = null
        let windowMinutes: number | null = null
        if (shape.counts) {
          if (typeof args.threshold !== 'number' || !Number.isInteger(args.threshold) || args.threshold < 1 || args.threshold > 100000) {
            throw new McpToolRefusal(`A ${kind} rule needs a 'threshold': a whole number from 1.`)
          }
          threshold = args.threshold
          const w = args.window_minutes ?? ALERT_WINDOW.default
          if (typeof w !== 'number' || !Number.isInteger(w) || w < ALERT_WINDOW.min || w > ALERT_WINDOW.max) {
            throw new McpToolRefusal(`'window_minutes' is from ${String(ALERT_WINDOW.min)} to ${String(ALERT_WINDOW.max)}.`)
          }
          windowMinutes = w
        } else if (args.threshold !== undefined || args.window_minutes !== undefined) {
          throw new McpToolRefusal(`A ${kind} rule fires on each one; it takes no threshold or window.`)
        }

        const when = ruleSentence({ kind, layerSlug: layer?.slug ?? null, threshold, windowMinutes })
        return {
          summary: `Email ${to.words} whenever ${when}.`,
          details: [
            { label: 'when', value: when },
            { label: 'to', value: to.words },
            { label: 'checked', value: 'every minute, by the worker, whether or not an agent is connected' },
          ],
          input: {
            kind,
            layer_id: layer?.id ?? null,
            threshold,
            window_minutes: windowMinutes,
            recipients: to.ids,
            to_org_admins: to.toOrgAdmins,
          },
        }
      },
      async apply(call, input) {
        const a = auth(call)
        if (!isAlertKind(input.kind)) throw new Error('a stored proposal is missing kind')
        const ids = storedIds(input, 'recipients')
        const layerId = typeof input.layer_id === 'string' && isUuid(input.layer_id) ? input.layer_id : null
        try {
          await stillActive(ports, a, ids)
          if (layerId !== null) await ports.names.layer(a, layerId)
        } catch (error) {
          await record(call, { action: 'create_alert_rule' }, 'deny', { kind: input.kind })
          throw error
        }
        const created = await ports.notifications.createRule(a, {
          kind: input.kind,
          layerId,
          threshold: typeof input.threshold === 'number' ? input.threshold : null,
          windowMinutes: typeof input.window_minutes === 'number' ? input.window_minutes : null,
          recipients: ids,
          toOrgAdmins: input.to_org_admins === true,
        })
        if (created.kind === 'full') {
          await record(call, { action: 'create_alert_rule' }, 'deny', { kind: input.kind }, { outcome: 'limit' })
          throw new McpToolRefusal(`This organization keeps ${String(MAX_ALERT_RULES)} rules, which is the limit. Remove one first.`)
        }
        await record(call, { action: 'create_alert_rule' }, 'allow', { alert_rule: created.id, kind: input.kind }, {
          recipients: ids.length,
          to_org_admins: input.to_org_admins === true,
          ...(layerId === null ? {} : { layer_id: layerId }),
        })
        return { alert_rule: created.id }
      },
    },
    {
      kind: 'write',
      name: 'remove_alert_rule',
      title: 'Remove an alert rule',
      description: 'Propose removing an alert rule, by the id list_alert_rules gives. It stops firing once applied.',
      inputSchema: {
        type: 'object',
        properties: { rule: { type: 'string', description: 'The rule id, from list_alert_rules.' } },
        required: ['rule'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const id = typeof args.rule === 'string' ? args.rule.trim() : ''
        const rule = id === '' ? undefined : await ports.notifications.rule(a, id)
        if (rule === undefined) throw new McpToolRefusal(`No alert rule "${id}" in this organization.`)
        const described = await describeRule(a, rule)
        const to = (described.notifies as string[]).join(', ')
        return {
          summary: `Stop emailing ${to} whenever ${ruleSentence(rule)}.`,
          details: [
            { label: 'when', value: ruleSentence(rule) },
            { label: 'to', value: to },
          ],
          input: { rule_id: rule.id },
        }
      },
      async apply(call, input) {
        const id = typeof input.rule_id === 'string' && isUuid(input.rule_id) ? input.rule_id : undefined
        if (id === undefined) throw new Error('a stored proposal is missing rule_id')
        const removed = await ports.notifications.removeRule(auth(call), id)
        await record(call, { action: 'remove_alert_rule' }, removed ? 'allow' : 'deny', { alert_rule: id })
        if (!removed) throw new McpToolRefusal('That rule is already gone.')
        return { removed: true }
      },
    },
    {
      kind: 'read',
      name: 'list_alert_rules',
      title: 'List alert rules',
      description: 'The alert rules this organization keeps: what each watches, whom it emails, and when it last fired.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run(call) {
        const a = auth(call)
        const rules = await ports.notifications.rules(a)
        return { rules: await Promise.all(rules.map((r) => describeRule(a, r))) }
      },
    },
  ]
}
