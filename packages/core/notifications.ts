import { consoleUrl, message, type Message } from './mail.js'

/**
 * Notifications and alert rules. docs/mcp-admin.md, "Notifications".
 *
 * The bounds, the one validation both ends run, and the two messages the
 * worker sends. In the core rather than beside the API's other messages
 * because the worker sends these and cannot import the API — and
 * `packages/api/src/messages.ts` lists them with the rest, so the preview and
 * anything else reasoning about the set still sees one list.
 *
 * ## Who can receive one
 *
 * A recipient is a **user id** in the caller's own organization, active, and
 * nothing else. There is no field for an address anywhere: the tools take an
 * address only to *find a person*, the outbox stores ids, and the worker reads
 * the address from `users` at the moment of sending, scoped to the
 * notification's organization. T35 is the refusal at the first step; the
 * second and third are why the first is not the only thing standing.
 *
 * ## Why a notification carries no links
 *
 * The body is somebody's prose sent from this installation's own address, to
 * everybody in an organization if the agent asked for that — which is the
 * exact shape of a phishing message, and on a surface whose threat model is an
 * instruction planted in a document. A person applies every one, and reads it
 * first; a person also reads a message saying their password expired and
 * linking somewhere convincing. So a URL in either part is refused, with the
 * reason, and the only link in a message this installation sends is one the
 * installation built from its own configuration.
 */

/** Explicit recipients on one notification or one rule. "Every org_admin" is a flag, not a list. */
export const NOTIFY_MAX_RECIPIENTS = 20

export const NOTIFY_SUBJECT_MAX = 200
export const NOTIFY_BODY_MAX = 4000

/**
 * Notifications queued per organization in any hour, agents and rules together.
 *
 * A constant rather than a variable: it is the bound on how loud one tenant's
 * agent can be through the installation's relay, and an operator who wants a
 * louder one is asking for something nobody has argued for. Thirty is a
 * person's inbox having a bad hour, not a mailing list.
 */
export const NOTIFY_PER_HOUR = 30

/** What an alert rule can watch. Each is answered from what the database already records. */
export const ALERT_KINDS = {
  skill_by_agent: {
    counts: false,
    layered: true,
    summary: 'a skill version written by an agent',
  },
  skill_scripts: {
    counts: false,
    layered: true,
    summary: 'a skill version that adds scripts',
  },
  admin_connection: {
    counts: false,
    layered: false,
    summary: 'an administrative connection approved',
  },
  denial_spike: {
    counts: true,
    layered: false,
    summary: 'one person or service account denied at least the threshold within the window',
  },
  documents_failed: {
    counts: true,
    layered: true,
    summary: 'at least the threshold of documents failing to index within the window',
  },
} as const

export type AlertKind = keyof typeof ALERT_KINDS

export const isAlertKind = (value: unknown): value is AlertKind =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(ALERT_KINDS, value)

/** The window a counting rule takes, in minutes. */
export const ALERT_WINDOW = { min: 5, max: 1440, default: 60 } as const

/** The sentence a rule is read as, from what it stores. */
export function ruleSentence(rule: {
  readonly kind: AlertKind
  readonly layerSlug: string | null
  readonly threshold: number | null
  readonly windowMinutes: number | null
}): string {
  const where = rule.layerSlug === null ? '' : ` in the layer ${rule.layerSlug}`
  switch (rule.kind) {
    case 'skill_by_agent':
      return `an agent writes a skill version${where === '' ? '' : where.replace(' in ', ' for ')}`
    case 'skill_scripts':
      return `a skill version adds scripts${where === '' ? '' : where.replace(' in ', ' for ')}`
    case 'admin_connection':
      return 'somebody approves an administrative connection'
    case 'denial_spike':
      return `one person or service account is denied ${String(rule.threshold)} or more times within ${String(rule.windowMinutes)} minutes`
    case 'documents_failed':
      return `${String(rule.threshold)} or more documents fail to index within ${String(rule.windowMinutes)} minutes${where}`
  }
}

/**
 * A URL, or something a mail client would turn into one: a scheme, `www.`, or
 * a dotted name followed by a path. A bare `example.com` is not refused,
 * because `contract.pdf` is the same shape and over-refusing prose is how a
 * check gets worked around; with no scheme and no path it is the weakest of
 * the three, and the person reads the message before it goes.
 */
const LINKISH = /\b(?:https?|ftp|mailto|javascript|data|file):|\bwww\.[a-z0-9-]+\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\//iu

/**
 * A subject and a body, or the sentence saying why not.
 *
 * Both ends ask it: the tool when it proposes, so the person is never shown
 * something that would be refused, and the apply, because a stored proposal is
 * not trusted for having been checked ten minutes ago.
 */
export function notificationText(
  subject: unknown,
  body: unknown,
): { readonly subject: string; readonly body: string } | { readonly refused: string } {
  if (typeof subject !== 'string' || subject.trim() === '') return { refused: "'subject' is required." }
  if (typeof body !== 'string' || body.trim() === '') return { refused: "'body' is required." }
  const s = subject.trim()
  // Line endings normalised before the length and character checks, so a body
  // written on Windows is not refused for the carriage returns in it.
  const b = body.replace(/\r\n?/gu, '\n').trim()
  if (s.length > NOTIFY_SUBJECT_MAX) return { refused: `The subject is at most ${String(NOTIFY_SUBJECT_MAX)} characters.` }
  if (b.length > NOTIFY_BODY_MAX) return { refused: `The body is at most ${String(NOTIFY_BODY_MAX)} characters.` }
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/u.test(s)) return { refused: 'The subject is one line of plain text.' }
  // eslint-disable-next-line no-control-regex -- the same, with newline and tab allowed
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(b)) return { refused: 'The body is plain text: no control characters.' }
  if (LINKISH.test(s) || LINKISH.test(b)) {
    return {
      refused:
        'A notification carries no links. It is sent from this installation\'s own address, so a link in it is ' +
        'one people have every reason to trust — name the layer, document or screen instead.',
    }
  }
  return { subject: s, body: b }
}

/**
 * A name somebody outside the organization chose — an application's registered
 * name — made safe to put in a message's text: one line, bounded, and broken
 * where a mail client would otherwise turn it into a link. The rule above, for
 * the one string in an alert that this installation did not write.
 */
export function plainName(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is being removed
  const line = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 80)
  return LINKISH.test(line) ? line.replace(/([.:/@])/gu, '$1 ').replace(/\s+/gu, ' ').trim() : line
}

/** What a stored notification says about where it came from, for the message's last line. */
export type NotificationOrigin =
  | {
      readonly source: 'agent'
      /** The person who applied it. */
      readonly appliedBy: string
      /** The application the administrative connection was approved for. */
      readonly application: string
    }
  | {
      readonly source: 'rule'
      /** What the rule watches, as `ruleSentence` says it. */
      readonly when: string
      /** Who created the rule, by address, or null where they are gone. */
      readonly ruleBy: string | null
    }

/**
 * A notification, in the brand, to one address.
 *
 * The body is the stored text, a paragraph per blank-line-separated block. The
 * last line says where it came from — an agent, through which application, and
 * who applied it; or which rule — because a message from this installation's
 * address that an agent wrote has to say so, or it borrows trust it was not
 * given. The one link is to the access log, built from configuration.
 */
export function notificationMessage(
  to: string,
  consoleBase: string,
  stored: { readonly subject: string; readonly body: string },
  origin: NotificationOrigin,
): Message {
  const paragraphs = stored.body
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((text) => ({ kind: 'say' as const, text }))
  const provenance =
    origin.source === 'agent'
      ? `An agent wrote this through the administrative connection of the application "${origin.application}", and ${origin.appliedBy} ` +
        'read it and approved sending it. Nobody outside your organization can be sent one.'
      : `An alert rule your organization keeps sent this: it emails whenever ${origin.when}` +
        `${origin.ruleBy === null ? '' : `, and ${origin.ruleBy} set it up`}. An administrator can remove it.`
  // Prefixed both ways, so the subject line alone says this is the
  // installation speaking and which kind of message it is.
  return message(to, `${origin.source === 'rule' ? 'Nacre alert' : 'Nacre'}: ${stored.subject}`, [
    ...paragraphs,
    { kind: 'link', url: consoleUrl(consoleBase, '#/audit'), label: 'Open the access log' },
    { kind: 'caution', text: provenance },
  ])
}
