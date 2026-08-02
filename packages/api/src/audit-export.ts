import { badRequest, type Problem } from './errors.js'
import type { AuditQuery, AuditRecord } from './server.js'

/**
 * Reading the access log back, and the two formats an auditor actually wants.
 *
 * `docs/audit.md` has asked for "export as JSONL and CSV through `GET /v1/audit`"
 * since before there was a server, and the events have been written on every
 * access the whole time with no way to read one. For a product whose opening
 * question is *which documents did your agent read last quarter*, that is the
 * gap between having the answer and being able to give it.
 *
 * ## Why three formats rather than a `?format=` parameter
 *
 * Content negotiation, because the difference between these is representation
 * and not resource: the same events, serialized three ways. A `format` query
 * parameter would make `/v1/audit?format=csv` a different URL for the same
 * thing, which breaks caching and makes the paged JSON cursor mean something
 * subtly different depending on a sibling parameter.
 *
 * JSON is the default and the only paged one. JSONL and CSV are exports — a
 * client streaming either to a file has nowhere to put a `next_cursor`, so the
 * cursor goes in a `Link` header and the body stays a clean stream of records.
 */

export type AuditFormat = 'json' | 'ndjson' | 'csv'

/**
 * Which representation the caller asked for, or `undefined` for none we serve.
 *
 * No Accept header means JSON, which is what a curl with no arguments gets and
 * what the contract documents. A wildcard means JSON for the same reason: a
 * client with no preference should not be handed the format hardest to read.
 *
 * Deliberately not a full RFC 9110 negotiation with q-values. Three types, and
 * the first recognised one wins, in the order the client listed them — which is
 * what every real client means and is checkable by reading. A q-value parser
 * here would be more code than the endpoint.
 */
export function auditFormat(accept: string | undefined): AuditFormat | undefined {
  if (accept === undefined || accept.trim() === '') return 'json'

  for (const part of accept.split(',')) {
    const type = part.split(';')[0]?.trim().toLowerCase()
    if (type === undefined) continue
    if (type === '*/*' || type === 'application/*' || type === 'application/json') return 'json'
    if (type === 'application/x-ndjson' || type === 'application/jsonl') return 'ndjson'
    if (type === 'text/csv' || type === 'text/*') return 'csv'
  }
  return undefined
}

/** Bounds on the time range, so a malformed one is refused rather than ignored. */
export function readAuditQuery(
  params: URLSearchParams,
  instance: string,
  requestId: string,
): AuditQuery | Problem {
  const query: {
    from?: string
    to?: string
    actorId?: string
    action?: string
    result?: 'allow' | 'deny' | 'error'
  } = {}

  for (const [name, key] of [
    ['from', 'from'],
    ['to', 'to'],
  ] as const) {
    const raw = params.get(name)
    if (raw === null || raw === '') continue
    if (Number.isNaN(Date.parse(raw))) {
      return badRequest(instance, requestId, `'${name}' must be an ISO 8601 timestamp.`)
    }
    query[key] = new Date(raw).toISOString()
  }

  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    // An inverted range returns nothing, which reads as "no events happened"
    // rather than "you asked for a range that cannot contain any". On a
    // compliance query those are opposite answers.
    return badRequest(instance, requestId, "'from' must be earlier than 'to'.")
  }

  const actorId = params.get('actor_id')
  if (actorId !== null && actorId !== '') {
    if (!/^[0-9a-f-]{36}$/i.test(actorId)) {
      return badRequest(instance, requestId, "'actor_id' must be a uuid.")
    }
    query.actorId = actorId
  }

  const action = params.get('action')
  if (action !== null && action !== '') {
    // Bounded and character-restricted: it reaches a parameterized query, so
    // this is not about injection. It is about an unbounded string from a
    // request becoming a predicate on a large table.
    if (action.length > 64 || !/^[a-z0-9_.:-]+$/i.test(action)) {
      return badRequest(instance, requestId, "'action' must be a short action name.")
    }
    query.action = action
  }

  const result = params.get('result')
  if (result !== null && result !== '') {
    if (result !== 'allow' && result !== 'deny' && result !== 'error') {
      return badRequest(instance, requestId, "'result' must be allow, deny or error.")
    }
    query.result = result
  }

  return query
}

/** The wire shape, matching the schema in `docs/audit.md`. */
export function auditJson(record: AuditRecord): Record<string, unknown> {
  return {
    id: record.id,
    occurred_at: record.occurredAt,
    actor: { type: record.actorType, id: record.actorId, label: record.actorLabel },
    surface: record.surface,
    client: record.client,
    action: record.action,
    target: record.target,
    result: record.result,
    detail: record.detail,
    request_id: record.requestId,
  }
}

/** One JSON object per line, no wrapper, no trailing comma problem. */
export function toNdjson(records: readonly AuditRecord[]): string {
  return records.map((r) => JSON.stringify(auditJson(r))).join('\n') + (records.length > 0 ? '\n' : '')
}

const CSV_COLUMNS = [
  'id',
  'occurred_at',
  'actor_type',
  'actor_id',
  'actor_label',
  'surface',
  'client',
  'action',
  'result',
  'target',
  'detail',
  'request_id',
] as const

/**
 * RFC 4180, with the two escapes that actually bite.
 *
 * A field is quoted when it contains a comma, a quote, a newline — or a leading
 * character a spreadsheet treats as a formula. That last one is not in RFC 4180
 * and belongs here anyway: `actor_label` is operator-supplied text, and a value
 * beginning `=`, `+`, `-` or `@` is executed on open in Excel and Sheets. An
 * audit export is opened in a spreadsheet more often than it is parsed, and CSV
 * injection through a log viewer is a real class of bug rather than a theoretical
 * one. The cell is prefixed with a single quote, which every spreadsheet reads
 * as "text" and every CSV parser reads as part of the value — visible, and
 * inert.
 */
function csvCell(value: unknown): string {
  const raw =
    value === null || value === undefined
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function toCsv(records: readonly AuditRecord[]): string {
  const rows = [CSV_COLUMNS.join(',')]
  for (const r of records) {
    rows.push(
      [
        r.id,
        r.occurredAt,
        r.actorType,
        r.actorId,
        r.actorLabel,
        r.surface,
        r.client,
        r.action,
        r.result,
        r.target,
        r.detail,
        r.requestId,
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // CRLF, which RFC 4180 specifies and Excel is happier with.
  return rows.join('\r\n') + '\r\n'
}
