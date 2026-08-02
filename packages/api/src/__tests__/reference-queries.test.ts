import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type ReferenceQuery } from '../index.js'

/**
 * The query set behind the reindex recall gate.
 *
 * The scoring is tested in the worker, against ports. What could not be tested
 * there is the surface: that the bounds are refusals rather than truncations,
 * that a set is replaced whole, and that a layer the caller cannot administer
 * is indistinguishable from one that is not there.
 */

const SECRET = new TextEncoder().encode('a'.repeat(48))
const ORG = '11111111-1111-4111-8111-111111111111'
const LAYER = '22222222-2222-4222-8222-222222222222'

let server: Server
let base: string
let stored: ReferenceQuery[] = []
let administrable = true
const audited: AuditEvent[] = []

const token = async () =>
  new SignJWT({ org: ORG, principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer('i')
    .setAudience('a')
    .setExpirationTime('5m')
    .sign(SECRET)

async function call(method: 'GET' | 'PUT' | 'DELETE', body?: unknown, path = LAYER) {
  const res = await fetch(`${base}/v1/layers/${path}/reference-queries`, {
    method,
    headers: {
      authorization: `Bearer ${await token()}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as
      | { items?: ReferenceQuery[]; detail?: string }
      | null,
  }
}

describe('reference queries', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => ({ documentId: 'd', jobId: 'j', unchanged: false }), remove: async () => false },
      audit: { write: async (event) => void audited.push(event) },
      referenceQueries: {
        list: async () => (administrable ? stored : undefined),
        replace: async (_auth, _layerId, queries) => {
          if (!administrable) return undefined
          stored = queries.map((q, i) => ({
            id: `q${i}`,
            query: q.query,
            expected: [...q.expected],
          }))
          return stored
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    stored = []
    administrable = true
    audited.length = 0
  })

  it('replaces the set whole and reads it back in order', async () => {
    // A reference set is one statement about what search must keep doing. A
    // partial edit is how half of one ends up describing a layer nobody has
    // looked at since.
    const put = await call('PUT', {
      queries: [
        { query: 'notice period', expected: ['contracts/acme.md'] },
        { query: 'payment terms', expected: ['contracts/acme.md', 'contracts/globex.md'] },
      ],
    })

    expect(put.status).toBe(200)
    expect(put.body?.items?.map((q) => q.query)).toEqual(['notice period', 'payment terms'])

    const got = await call('GET')
    expect(got.status).toBe(200)
    expect(got.body?.items?.[1]?.expected).toEqual(['contracts/acme.md', 'contracts/globex.md'])
  })

  it('accepts an empty set, which is how a gate is removed', async () => {
    // Refusing it would leave no way back from having written one.
    await call('PUT', { queries: [{ query: 'x', expected: ['a.md'] }] })
    const cleared = await call('PUT', { queries: [] })

    expect(cleared.status).toBe(200)
    expect(cleared.body?.items).toEqual([])
  })

  it('records the replacement in the journal, by count and never by text', async () => {
    await call('PUT', { queries: [{ query: 'the salary of every director', expected: ['a.md'] }] })

    const event = audited.find((e) => e.action === 'reference_queries.replace')
    expect(event?.result).toBe('allow')
    expect(event?.detail).toMatchObject({ queries: 1 })
    expect(JSON.stringify(event)).not.toContain('salary')
  })

  it('refuses more expected documents than the check retrieves', async () => {
    // Not a size limit — it is RECALL_K. A query naming eleven documents could
    // never score 1.0, so its floor would be unreachable and would read as a
    // regression in the model rather than as a mistake in the set.
    const res = await call('PUT', {
      queries: [{ query: 'x', expected: Array.from({ length: 11 }, (_, i) => `d${i}.md`) }],
    })

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/at most 10 documents/)
    expect(res.body?.detail).toMatch(/never score 1\.0/)
  })

  it('refuses a set larger than the cap rather than storing the first fifty', async () => {
    const res = await call('PUT', {
      queries: Array.from({ length: 51 }, (_, i) => ({ query: `q${i}`, expected: ['a.md'] })),
    })

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/at most 50 queries/)
    expect(stored).toEqual([])
  })

  it('refuses a query with no expected documents', async () => {
    // A query expecting nothing scores nothing, and averaging it in would drag
    // a healthy set below its floor for a line that says nothing.
    const res = await call('PUT', { queries: [{ query: 'x', expected: [] }] })
    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/non-empty/)
  })

  it('refuses an empty or over-long query string', async () => {
    expect((await call('PUT', { queries: [{ query: '   ', expected: ['a.md'] }] })).status).toBe(400)
    expect(
      (await call('PUT', { queries: [{ query: 'x'.repeat(1025), expected: ['a.md'] }] })).status,
    ).toBe(400)
  })

  it('names which entry is wrong', async () => {
    const res = await call('PUT', {
      queries: [{ query: 'fine', expected: ['a.md'] }, { query: 'fine too', expected: [7] }],
    })
    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/queries\[1\]/)
  })

  it('deduplicates a repeated expected id rather than refusing it', async () => {
    // An obvious typo with an obvious reading. Leaving it in would divide the
    // score by a denominator the caller did not mean.
    const res = await call('PUT', {
      queries: [{ query: 'x', expected: ['a.md', 'a.md', 'b.md'] }],
    })
    expect(res.status).toBe(200)
    expect(res.body?.items?.[0]?.expected).toEqual(['a.md', 'b.md'])
  })

  it('refuses a body that is not an object with a queries array', async () => {
    expect((await call('PUT', { queries: 'all of them' })).status).toBe(400)
    expect((await call('PUT', [])).status).toBe(400)
  })

  it('404s a layer the caller may not administer, on both verbs', async () => {
    // The usual rule: no permission and no such layer are one answer, and the
    // wording is the same too.
    administrable = false

    const got = await call('GET')
    const put = await call('PUT', { queries: [] })

    expect(got.status).toBe(404)
    expect(put.status).toBe(404)
    expect(got.body?.detail).toBe(put.body?.detail)
  })

  it('audits a refused replacement as a denial', async () => {
    administrable = false
    await call('PUT', { queries: [{ query: 'x', expected: ['a.md'] }] })

    expect(audited.find((e) => e.action === 'reference_queries.replace')?.result).toBe('deny')
  })

  it('404s a method it does not serve', async () => {
    expect((await call('DELETE')).status).toBe(404)
  })
})

describe('reference queries, on a surface without them', () => {
  let bare: Server
  let bareBase: string

  beforeAll(async () => {
    bare = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => ({ documentId: 'd', jobId: 'j', unchanged: false }), remove: async () => false },
      audit: { write: async () => {} },
    })
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    bareBase = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => bare.close(() => resolve()))
  })

  it('answers 404, like any capability a surface lacks', async () => {
    const res = await fetch(`${bareBase}/v1/layers/${LAYER}/reference-queries`, {
      headers: { authorization: `Bearer ${await token()}` },
    })
    expect(res.status).toBe(404)
  })
})
