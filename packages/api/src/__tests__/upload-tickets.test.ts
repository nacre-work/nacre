import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type IngestRequest, type UploadTicket, type UploadTicketStore } from '../index.js'

/**
 * Upload tickets: a document sent to the index by whoever holds the bytes,
 * on a capability minted by whoever holds `write`.
 *
 * These run the real handlers over a real socket against a store in a map —
 * what a Redis does with `SET … NX EX` and `GETDEL` is the live case's
 * business (`upload-tickets-live.test.ts`); what could not be tested there is
 * that the two doors agree about what a document is, that the ticket door
 * admits a browser and nothing else does, and that a spent ticket is spent.
 */

const SECRET = new TextEncoder().encode('a'.repeat(48))
const ORG = '11111111-1111-4111-8111-111111111111'
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe, 0x00, 0x01])])

/** The store, in a map, with the single-use property the real one has. */
class MapTickets implements UploadTicketStore {
  readonly tickets = new Map<string, UploadTicket>()
  down = false
  #n = 0
  async mint(ticket: UploadTicket): Promise<string> {
    if (this.down) throw new Error('redis is down')
    const id = `t${String(++this.#n).padStart(42, '0')}`
    this.tickets.set(id, ticket)
    return id
  }
  async redeem(id: string): Promise<UploadTicket | undefined> {
    if (this.down) throw new Error('redis is down')
    const ticket = this.tickets.get(id)
    this.tickets.delete(id)
    return ticket
  }
}

let server: Server
let base: string
let queued: (IngestRequest & { readonly asPrincipal: string }) | undefined
let writable = true
const audited: AuditEvent[] = []
const store = new MapTickets()

const token = async (role: 'org_admin' | 'member' = 'org_admin') =>
  new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer('i')
    .setAudience('a')
    .setExpirationTime('5m')
    .sign(SECRET)

async function mint(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/uploads`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

async function redeem(ticket: string, bytes: Buffer | string, contentType: string, query = '') {
  const res = await fetch(`${base}/v1/uploads/${ticket}${query}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof bytes === 'string' ? bytes : new Uint8Array(bytes),
  })
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as Record<string, unknown> | null }
}

describe('upload tickets', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: {
        queue: async (auth, request) => {
          queued = { ...request, asPrincipal: `${auth.principal.type}:${auth.principal.id}` }
          return { documentId: 'd1', jobId: 'j1', unchanged: false }
        },
        writable: async () => writable,
        remove: async () => false,
      },
      uploads: store,
      uploadBaseUrl: 'https://api.example.test',
      objectStorage: true,
      audit: { write: async (event) => void audited.push(event) },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    queued = undefined
    writable = true
    store.down = false
    store.tickets.clear()
    audited.length = 0
  })

  it('mints a descriptor on write, and the document arrives as the minter', async () => {
    const minted = await mint({ layer: 'contracts', external_id: 'q3.md', title: 'Q3', metadata: { team: 'finance' } })
    expect(minted.status).toBe(201)
    const d = minted.body as {
      ticket: string
      url: string
      method: string
      expires_at: string
      max_size: number
      accepts: string[]
      curl: string
    }
    // The descriptor is the SEP-2631 shape plus the two things a model hands
    // a person: the ticket itself and the request as a line.
    expect(d.url).toBe(`https://api.example.test/v1/uploads/${d.ticket}`)
    expect(d.method).toBe('POST')
    expect(d.accepts).toContain('application/pdf')
    expect(d.curl).toContain(d.url)
    expect(d.curl).toContain('--data-binary @FILE')
    expect(Date.parse(d.expires_at) - Date.now()).toBeGreaterThan(4 * 60 * 1000)
    expect(minted.headers.get('cache-control')).toBe('no-store')

    const sent = await redeem(d.ticket, '# Q3\n', 'text/markdown')
    expect(sent.status).toBe(202)
    expect(sent.body).toMatchObject({ document_id: 'd1', job_id: 'j1', status: 'queued' })
    // As the caller who minted it, with everything the ticket fixed.
    expect(queued).toMatchObject({
      layer: 'contracts',
      externalId: 'q3.md',
      title: 'Q3',
      content: '# Q3\n',
      metadata: { team: 'finance' },
      asPrincipal: 'user:alice',
    })
    // The same journal entry a multipart or JSON ingest leaves.
    expect(audited.map((e) => [e.action, e.result])).toEqual([['ingest', 'allow']])
  })

  it('a ticket is spent by its first use, whatever the outcome', async () => {
    const { ticket } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    expect((await redeem(ticket, 'one', 'text/plain')).status).toBe(202)
    // The second redeem is a stranger's answer.
    expect((await redeem(ticket, 'two', 'text/plain')).status).toBe(404)

    // And a refused upload spends it too: a ticket that survived its own
    // refusal would be a capability outliving the check that used it.
    const { ticket: other } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    expect((await redeem(other, PDF, 'text/plain')).status).toBe(400)
    expect((await redeem(other, 'fine', 'text/plain')).status).toBe(404)
  })

  it('an unknown, malformed or expired ticket is one 404', async () => {
    const unknown = await redeem('t'.padEnd(43, '0'), 'x', 'text/plain')
    const malformed = await redeem('not-a-ticket', 'x', 'text/plain')
    expect(unknown.status).toBe(404)
    expect(malformed.status).toBe(404)
    expect(unknown.body?.detail).toEqual(malformed.body?.detail)
    expect(queued).toBeUndefined()
  })

  it('needs write on the layer, and a layer the caller may not write to is absent', async () => {
    writable = false
    const res = await mint({ layer: 'payroll' })
    expect(res.status).toBe(404)
    expect(audited.map((e) => [e.action, e.result])).toEqual([['ingest', 'deny']])
    expect(store.tickets.size).toBe(0)
  })

  it('refuses to mint without a layer, and refuses bad tags at minting', async () => {
    expect((await mint({})).status).toBe(400)
    expect((await mint({ layer: 'contracts', metadata: { 'Bad.Key': 1 } })).status).toBe(400)
    expect(store.tickets.size).toBe(0)
  })

  it('fails closed when the store does not answer', async () => {
    store.down = true
    expect((await mint({ layer: 'contracts' })).status).toBe(503)
    expect((await redeem('t'.padEnd(43, '0'), 'x', 'text/plain')).status).toBe(503)
  })

  it('gives the bytes the same admission a multipart file part gets', async () => {
    const { ticket: pdf } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    const binary = await redeem(pdf, PDF, 'application/pdf', '?filename=contract.pdf')
    expect(binary.status).toBe(202)
    expect(queued).toMatchObject({ externalId: 'contract.pdf', contentType: 'application/pdf' })
    expect(Buffer.from(queued?.bytes ?? []).equals(PDF)).toBe(true)

    // The signature without the declaration, and the declaration without the
    // signature — each refused naming the other, as the form is.
    const { ticket: a } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    const undeclared = await redeem(a, PDF, 'application/octet-stream')
    expect(undeclared.status).toBe(400)
    expect(undeclared.body?.detail).toContain('PDF')
    const { ticket: b } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    const unsigned = await redeem(b, 'not a pdf', 'application/pdf')
    expect(unsigned.status).toBe(400)

    // An empty body is a mistake, not an empty document.
    const { ticket: c } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    expect((await redeem(c, '', 'text/plain')).status).toBe(400)
  })

  it('a document with no name gets the filename, then a generated id', async () => {
    const { ticket } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    await redeem(ticket, 'x', 'text/plain')
    expect(queued?.externalId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('admits every origin on the ticket door and nowhere else', async () => {
    // A browser's preflight from an origin no deployment can list — an MCP
    // App's sandboxed iframe — is answered, with `*` and the one header a
    // file upload needs.
    const preflight = await fetch(`${base}/v1/uploads/${'t'.padEnd(43, '0')}`, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
    expect((preflight.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('content-type')
    // Never credentials: there is no cookie and no Authorization on this door.
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull()

    const { ticket } = (await mint({ layer: 'contracts' })).body as { ticket: string }
    const sent = await fetch(`${base}/v1/uploads/${ticket}`, {
      method: 'POST',
      headers: { origin: 'https://host.example', 'content-type': 'text/plain' },
      body: 'from a page',
    })
    expect(sent.status).toBe(202)
    expect(sent.headers.get('access-control-allow-origin')).toBe('*')

    // The minting endpoint is the ordinary API: no allowed origins here, so a
    // browser gets nothing and the preflight is refused.
    const mintPreflight = await fetch(`${base}/v1/uploads`, {
      method: 'OPTIONS',
      headers: { origin: 'https://host.example', 'access-control-request-method': 'POST' },
    })
    expect(mintPreflight.status).toBe(404)
    expect(mintPreflight.headers.get('access-control-allow-origin')).toBeNull()
    const minted = await mint({ layer: 'contracts' }, { origin: 'https://host.example' })
    expect(minted.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('is absent, as a surface, when the deployment has no store', async () => {
    const bare = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
    })
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
    try {
      const minted = await fetch(`${at}/v1/uploads`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
        body: JSON.stringify({ layer: 'contracts' }),
      })
      expect(minted.status).toBe(404)
      const sent = await fetch(`${at}/v1/uploads/${'t'.padEnd(43, '0')}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      })
      expect(sent.status).toBe(404)
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()))
    }
  })
})
