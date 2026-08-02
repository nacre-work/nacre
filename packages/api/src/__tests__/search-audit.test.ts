import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createHash } from 'node:crypto'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent } from '../index.js'

/**
 * What a search leaves in the journal.
 *
 * `docs/audit.md` promised a `query_hash` and offered `NACRE_AUDIT_QUERY_TEXT`
 * for deployments that want the text as well. Neither was written: the event
 * carried a count, so the hash the document calls "enough to investigate an
 * incident" did not exist and the flag was read by nothing.
 *
 * These run the real handler over a real socket, because the thing that was
 * wrong was not the helper — it was that nothing called it.
 */

const SECRET = new TextEncoder().encode('a'.repeat(48))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const ORG = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const QUERY = 'what did legal decide about the merger'

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`

function build(auditQueryText: boolean) {
  const audited: AuditEvent[] = []
  const server = createApi({
    verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
    documents: { read: async () => undefined },
    search: {
      search: async () => [
        { chunk_id: '33333333-3333-4333-8333-333333333333', doc_id: DOC, layer: 'contracts', title: 't', score: 0.5, text: 'x' },
      ],
    },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: { write: async (event) => void audited.push(event) },
    ...(auditQueryText ? { auditQueryText: true } : {}),
  })
  return { server, audited }
}

const token = async () =>
  new SignJWT({ org: ORG, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

async function searchOn(server: Server): Promise<void> {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const res = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, top_k: 5 }),
  })
  expect(res.status).toBe(200)
}

describe('the journal entry for a search', () => {
  const off = build(false)
  const on = build(true)

  beforeAll(async () => {
    for (const s of [off.server, on.server]) {
      await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    }
  })

  afterAll(async () => {
    for (const s of [off.server, on.server]) {
      await new Promise<void>((resolve) => s.close(() => resolve()))
    }
  })

  it('carries the query hash by default, and not the query', async () => {
    await searchOn(off.server)
    const event = off.audited.find((e) => e.action === 'search')

    expect(event?.detail).toMatchObject({ query_hash: sha256(QUERY) })
    // Absent, not empty. `query: ''` in a journal reads as "they searched for
    // nothing", which is a different claim from "we did not record it".
    expect(event?.detail).not.toHaveProperty('query')
  })

  it('carries the query too where the deployment asked for it', async () => {
    await searchOn(on.server)
    const event = on.audited.find((e) => e.action === 'search')

    expect(event?.detail).toMatchObject({ query_hash: sha256(QUERY), query: QUERY })
  })

  it('records the same hash either way', async () => {
    // An installation that turns the flag on must still be able to compare its
    // new records against its old ones.
    const a = off.audited.find((e) => e.action === 'search')?.detail as Record<string, unknown>
    const b = on.audited.find((e) => e.action === 'search')?.detail as Record<string, unknown>
    expect(a.query_hash).toBe(b.query_hash)
  })

  it('records the latency it already measured for the histogram', async () => {
    const event = off.audited.find((e) => e.action === 'search')
    const latency = (event?.detail as Record<string, unknown>).latency_ms
    expect(typeof latency).toBe('number')
    expect(latency as number).toBeGreaterThanOrEqual(0)
  })

  it('still names the documents it returned', async () => {
    // The rest of the event has to survive the addition — this is the field
    // "show me which documents your agent read last quarter" is answered from.
    const event = off.audited.find((e) => e.action === 'search')
    expect(event?.target).toMatchObject({ returned_docs: [DOC], layers: ['contracts'] })
  })
})
