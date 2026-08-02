import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi, type AuditQuery, type AuditRecord } from '../index.js'
import { auditFormat, toCsv, toNdjson } from '../audit-export.js'

/**
 * Reading the access log back.
 *
 * `docs/audit.md` has asked for this since before there was a server, and until
 * now events were written on every access with no way to read one — the gap
 * between having the answer to "which documents did your agent read last
 * quarter" and being able to give it.
 *
 * What is under test here is the boundary: who may read, what they may narrow
 * it to, what each role is shown, and the two export formats. The SQL has its
 * own tests against a real database; the reader is a stub so the rules are
 * visible rather than buried in a query plan.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const ORG = '11111111-1111-1111-1111-111111111111'
const ACTOR = '22222222-2222-2222-2222-222222222222'

/** Every query the handler passed down. */
const asked: AuditQuery[] = []

const record = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  id: '42',
  occurredAt: '2026-08-01T10:22:31.114Z',
  actorType: 'service_account',
  actorId: ACTOR,
  actorLabel: 'svc-support-bot',
  action: 'search',
  surface: 'mcp',
  client: 'claude-code/2.1',
  target: { layers: ['contracts'], returned_docs: ['d1', 'd2'] },
  result: 'allow',
  detail: { latency_ms: 128 },
  requestId: '01JQ8',
  ...over,
})

let server: Server
let base: string
const written: { action: string }[] = []

const token = async (role: string): Promise<string> =>
  new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

const get = async (
  path: string,
  role = 'org_admin',
  accept?: string,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    headers: {
      authorization: `Bearer ${await token(role)}`,
      ...(accept === undefined ? {} : { accept }),
    },
  })

describe('GET /v1/audit', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (e) => {
          written.push({ action: e.action })
        },
      },
      jobs: { read: async () => undefined },
      auditReader: {
        read: async (_auth, query) => {
          asked.push(query)
          return { items: [record()], nextCursor: 'bmV4dA' }
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('a member gets 404, not 403', async () => {
    // The contract published this answer before the endpoint existed, and the
    // reason is invariant 4: 403 is reserved for an operation forbidden on an
    // object the caller can already see. Whether an organization keeps an audit
    // log is not something a member is told.
    const response = await get('/v1/audit', 'member')
    expect(response.status).toBe(404)
    const body = (await response.json()) as { title: string; detail: string }
    expect(body.title).not.toContain('Forbidden')
  })

  it('an org_admin reads the whole log for its organization', async () => {
    asked.length = 0
    const response = await get('/v1/audit')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { items: unknown[]; next_cursor: string }
    expect(body.items).toHaveLength(1)
    expect(body.next_cursor).toBe('bmV4dA')
    // Not narrowed: this role sees document access, which is the question the
    // whole feature exists to answer.
    expect(asked[0]?.administrativeOnly).toBe(false)
  })

  it('a platform_admin is not shown document access', async () => {
    // Rule 2, applied to the journal. A platform administrator who can read
    // every tenant's document-access log has exactly the access the permission
    // model spends its whole effort denying — obtained through the record that
    // exists to prove they did not have it.
    asked.length = 0
    const response = await get('/v1/audit', 'platform_admin')

    expect(response.status).toBe(200)
    expect(asked[0]?.administrativeOnly).toBe(true)
  })

  it('the caller cannot widen their own view', async () => {
    // `administrative_only` is not a request parameter. If it were, a
    // platform_admin would lift the restriction by omitting it — which is the
    // shape this bug would take.
    asked.length = 0
    await get('/v1/audit?administrative_only=false', 'platform_admin')
    expect(asked[0]?.administrativeOnly).toBe(true)
  })

  it('passes the filters down rather than accepting and ignoring them', async () => {
    asked.length = 0
    await get(
      '/v1/audit?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z' +
        `&actor_id=${ACTOR}&action=search&result=deny`,
    )

    expect(asked[0]).toMatchObject({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
      actorId: ACTOR,
      action: 'search',
      result: 'deny',
    })
  })

  it('refuses a malformed filter instead of dropping it', async () => {
    for (const q of [
      'from=yesterday',
      'to=not-a-date',
      'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      'actor_id=nope',
      'result=maybe',
      `action=${'x'.repeat(65)}`,
    ]) {
      expect((await get(`/v1/audit?${q}`)).status, q).toBe(400)
    }
  })

  it('records that the log was read', async () => {
    // The one action where leaving this out is self-serving: an administrator
    // who can read who-read-what without that read appearing is a hole in the
    // guarantee the endpoint exists to provide.
    written.length = 0
    await get('/v1/audit')
    expect(written.map((w) => w.action)).toContain('audit.read')
  })

  it('serves JSONL and CSV, and puts the cursor in a Link header', async () => {
    const ndjson = await get('/v1/audit', 'org_admin', 'application/x-ndjson')
    expect(ndjson.headers.get('content-type')).toBe('application/x-ndjson')
    // An export streams to a file, which has nowhere to put a next_cursor.
    expect(ndjson.headers.get('link')).toContain('rel="next"')
    const lines = (await ndjson.text()).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({ action: 'search' })

    const csv = await get('/v1/audit', 'org_admin', 'text/csv')
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect((await csv.text()).split('\r\n')[0]).toContain('occurred_at')
  })

  it('refuses a format it does not serve', async () => {
    expect((await get('/v1/audit', 'org_admin', 'application/xml')).status).toBe(406)
  })

  it('is GET only', async () => {
    const response = await fetch(`${base}/v1/audit`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${await token('org_admin')}` },
    })
    // 404 and not 405: the append-only guarantee is not something to advertise
    // a method for and then refuse.
    expect(response.status).toBe(404)
  })
})

describe('audit export formats', () => {
  it('negotiates the three types it serves', () => {
    expect(auditFormat(undefined)).toBe('json')
    expect(auditFormat('*/*')).toBe('json')
    expect(auditFormat('application/json')).toBe('json')
    expect(auditFormat('application/x-ndjson')).toBe('ndjson')
    expect(auditFormat('text/csv')).toBe('csv')
    // First recognised type wins, in the order the client listed them.
    expect(auditFormat('application/xml, text/csv')).toBe('csv')
    expect(auditFormat('application/pdf')).toBeUndefined()
  })

  it('quotes a CSV field that would otherwise break the row', () => {
    const csv = toCsv([record({ actorLabel: 'a,b', client: 'says "hi"' })])
    expect(csv).toContain('"a,b"')
    expect(csv).toContain('"says ""hi"""')
  })

  it('defuses a spreadsheet formula in an operator-supplied field', () => {
    // `actor_label` is text somebody chose. A value beginning `=`, `+`, `-` or
    // `@` is executed on open in Excel and Sheets, and an audit export is
    // opened in a spreadsheet far more often than it is parsed. The leading
    // quote is inert to a CSV parser and reads as text to a spreadsheet.
    const csv = toCsv([record({ actorLabel: '=cmd|/c calc' })])
    expect(csv).toContain("'=cmd|/c calc")
    expect(csv).not.toMatch(/,=cmd/)
  })

  it('writes one JSON object per line and nothing around them', () => {
    const out = toNdjson([record({ id: '1' }), record({ id: '2' })])
    const lines = out.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => l.startsWith('{'))).toBe(true)
    // No array wrapper: a consumer reads it a line at a time without buffering
    // a retention window into memory.
    expect(out.startsWith('[')).toBe(false)
  })

  it('produces an empty body rather than a stray newline for no records', () => {
    expect(toNdjson([])).toBe('')
    // CSV still carries its header: a file with no header is not a CSV, and a
    // consumer that maps columns by name needs it to exist even when empty.
    expect(toCsv([])).toBe(
      'id,occurred_at,actor_type,actor_id,actor_label,surface,client,action,result,target,detail,request_id\r\n',
    )
  })
})
