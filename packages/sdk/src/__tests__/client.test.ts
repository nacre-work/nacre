import { describe, expect, it, vi } from 'vitest'

import { NacreClient, NacreError, NacreTransportError } from '../index.js'

/**
 * The client.
 *
 * What is worth testing here is not that it can serialize JSON. It is the two
 * places where the permission model reaches into the client's shape: 404 means
 * "absent or invisible" and must not become an exception a caller branches on,
 * and `topK` must reach the wire uncorrected, because over-fetching and
 * trimming is exactly the post-filter invariant I2 forbids — and a client is a
 * very easy place to reintroduce one.
 */

const TOKEN = 'test-token'
const BASE = 'https://api.nacre.test'

interface Call {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

/** A fetch that answers from a script and records what it was asked. */
function stub(...answers: (Response | (() => Response))[]) {
  const calls: Call[] = []
  let i = 0

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const answer = answers[Math.min(i++, answers.length - 1)]
    // Cloned, never the original: the last answer repeats for every call past
    // the end of the script, and a Response body can only be read once.
    return typeof answer === 'function' ? answer() : (answer as Response).clone()
  }) as unknown as typeof globalThis.fetch

  return { fetchImpl, calls }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const problem = (status: number, title: string, detail = 'The requested resource does not exist or is not accessible.') =>
  json(status, {
    type: `https://nacre.work/errors/${title.toLowerCase().replace(/ /g, '-')}`,
    title,
    status,
    detail,
    instance: '/v1/x',
    request_id: 'req-1',
  })

const client = (fetchImpl: typeof globalThis.fetch, retries = 1) =>
  new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl, retries })

describe('NacreClient', () => {
  it('sends the token and nothing that names an organization', async () => {
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    await client(fetchImpl).search('anything')

    expect(calls[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    // Invariant I1. The server refuses a request naming an organization with a
    // 403, which from inside an application reads as a bug in this library, so
    // there is no way to express one — this asserts the body stays that way.
    const body = JSON.stringify(calls[0]?.body ?? {})
    for (const key of ['org', 'org_id', 'orgId', 'organization', 'tenant']) {
      expect(body).not.toContain(key)
    }
  })

  it('passes top_k through uncorrected', async () => {
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    await client(fetchImpl).search('anything', { topK: 5 })

    // Not 5 times some factor. The filter runs inside the traversal, so five
    // permitted results come back; asking for more and trimming would be a
    // post-filter that also costs more.
    expect(calls[0]?.body).toEqual({ query: 'anything', top_k: 5 })
  })

  it('maps a hit into the SDK naming', async () => {
    const { fetchImpl } = stub(
      json(200, {
        items: [
          {
            document_id: 'doc-1',
            chunk_id: 'chunk-1',
            score: 0.8,
            text: 'layers',
            layer: 'handbook',
            title: null,
          },
        ],
      }),
    )

    expect(await client(fetchImpl).search('x')).toEqual([
      { documentId: 'doc-1', chunkId: 'chunk-1', score: 0.8, text: 'layers', layer: 'handbook', title: null },
    ])
  })

  it('a 404 on a read is undefined, not an exception', async () => {
    const { fetchImpl } = stub(problem(404, 'Not found'))

    // Absent and invisible are one answer (I4). Throwing would invite a catch
    // that treats one as retryable and the other as fatal, and there is nothing
    // here to tell them apart — by design.
    expect(await client(fetchImpl).documents.get('doc-1')).toBeUndefined()
    expect(await client(stub(problem(404, 'Not found')).fetchImpl).jobs.get('job-1')).toBeUndefined()
  })

  it('a 404 on a delete is false, not an exception', async () => {
    const { fetchImpl } = stub(problem(404, 'Not found'))
    expect(await client(fetchImpl).documents.remove('doc-1')).toBe(false)
  })

  it('every other failure is a NacreError carrying the request id', async () => {
    const { fetchImpl } = stub(problem(403, 'Forbidden', 'The organization comes from the token.'))

    await expect(client(fetchImpl).grants.issue({
      principalType: 'user',
      principalId: 'u1',
      scopeType: 'layer',
      scopeId: 'l1',
      permission: 'read',
    })).rejects.toMatchObject({
      name: 'NacreError',
      status: 403,
      // The field that joins what the caller saw to the record of what happened.
      requestId: 'req-1',
    })
  })

  it('there is no isForbidden, because the server never distinguishes', async () => {
    const error = await client(stub(problem(404, 'Not found')).fetchImpl)
      .grants.revoke('g-1')
      .then(() => undefined)
      .catch((e: unknown) => e)

    // revoke answers false rather than throwing, and the type has one
    // predicate for this case. A second one would suggest a distinction the
    // server is built never to make.
    expect(error).toBeUndefined()
    expect(Object.getOwnPropertyNames(NacreError.prototype)).not.toContain('isForbidden')
  })

  it('a body that is not a problem document is a transport error', async () => {
    const { fetchImpl } = stub(new Response('<html>502 Bad Gateway</html>', { status: 502 }))

    // A proxy or a WAF answered, not the API. There is no request id to look
    // up, and saying "the server refused" would send the reader to the wrong
    // logs.
    await expect(client(fetchImpl).layers.list()).rejects.toBeInstanceOf(NacreTransportError)
  })

  it('retries a transient failure on a safe call', async () => {
    const { fetchImpl, calls } = stub(problem(503, 'Unavailable'), json(200, { items: [] }))
    await client(fetchImpl, 2).layers.list()
    expect(calls).toHaveLength(2)
  })

  it('never retries a delete or a grant', async () => {
    const { fetchImpl, calls } = stub(problem(503, 'Unavailable'))

    // A retried delete is a second, different write, and a retried grant can
    // race a revocation. Only safe calls and ingest — which is idempotent on
    // (layer, external_id) and its content hash — are repeated.
    await expect(client(fetchImpl, 3).documents.remove('doc-1')).rejects.toThrow()
    expect(calls).toHaveLength(1)
  })

  it('retries ingest, because it is idempotent', async () => {
    const { fetchImpl, calls } = stub(
      problem(503, 'Unavailable'),
      json(202, { document_id: 'd', job_id: 'j', status: 'queued' }),
    )

    const outcome = await client(fetchImpl, 2).documents.add({
      layer: 'handbook',
      externalId: 'x',
      content: 'y',
    })

    expect(calls).toHaveLength(2)
    expect(outcome).toEqual({ documentId: 'd', jobId: 'j', unchanged: false })
  })

  it('reports an unchanged repeat rather than a queued job', async () => {
    const { fetchImpl } = stub(json(200, { document_id: 'd', job_id: 'j', status: 'indexed' }))
    const outcome = await client(fetchImpl).documents.add({ layer: 'l', externalId: 'x', content: 'y' })
    expect(outcome.unchanged).toBe(true)
  })

  it('waiting on a job resolves on failed as well as indexed', async () => {
    const { fetchImpl } = stub(
      json(200, { job_id: 'j', document_id: 'd', status: 'parsing', error: null }),
      json(200, { job_id: 'j', document_id: 'd', status: 'failed', error: 'the parser refused' }),
    )

    // Both are terminal. Throwing on failure would bury the reason the job
    // carries, which is the only place it exists.
    const job = await client(fetchImpl).jobs.wait('j', { intervalMs: 1 })
    expect(job).toMatchObject({ status: 'failed', error: 'the parser refused' })
  })

  it('waiting gives up rather than polling forever', async () => {
    const { fetchImpl } = stub(json(200, { job_id: 'j', document_id: 'd', status: 'pending', error: null }))
    await expect(
      client(fetchImpl).jobs.wait('j', { intervalMs: 5, timeoutMs: 10 }),
    ).rejects.toThrow(/still pending/)
  })

  it('a 204 is not parsed as a body', async () => {
    const { fetchImpl } = stub(new Response(null, { status: 204 }))
    expect(await client(fetchImpl).grants.revoke('g-1')).toBe(true)
  })

  it('a trailing slash on the base URL does not double up', async () => {
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    await new NacreClient({ baseUrl: `${BASE}///`, token: TOKEN, fetch: fetchImpl }).layers.list()
    expect(calls[0]?.url).toBe(`${BASE}/v1/layers`)
  })

  it('refuses to be constructed without a base URL or a token', () => {
    expect(() => new NacreClient({ baseUrl: '', token: TOKEN })).toThrow(/baseUrl/)
    expect(() => new NacreClient({ baseUrl: BASE, token: '' })).toThrow(/token/)
  })

  it('a document id is escaped rather than concatenated', async () => {
    const { fetchImpl, calls } = stub(problem(404, 'Not found'))
    await client(fetchImpl).documents.get('../../v1/grants')
    expect(calls[0]?.url).toBe(`${BASE}/v1/documents/..%2F..%2Fv1%2Fgrants`)
  })

  it('health is a boolean, not an exception', async () => {
    expect(await client(stub(json(200, { status: 'ok' })).fetchImpl).health()).toBe(true)
    expect(await client(stub(problem(503, 'Unavailable')).fetchImpl, 1).health()).toBe(false)
  })

  it('the caller’s abort is not retried', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof globalThis.fetch

    await expect(
      client(fetchImpl, 3).search('x', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(NacreTransportError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
