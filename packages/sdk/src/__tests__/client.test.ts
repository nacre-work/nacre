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

describe('sign-in', () => {
  it('exchanges a password for a pair of tokens', async () => {
    const { fetchImpl, calls } = stub(
      json(200, {
        access_token: 'eyJ…',
        token_type: 'Bearer',
        expires_in: 900,
        refresh_token: 'r1',
      }),
    )
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const tokens = await nacre.auth.login({ email: 'a@b.test', password: 'p' })

    expect(tokens).toEqual({
      accessToken: 'eyJ…',
      tokenType: 'Bearer',
      expiresIn: 900,
      refreshToken: 'r1',
    })
    expect(calls[0]?.url).toBe(`${BASE}/v1/auth/login`)
  })

  it('sends organization as a lookup key when one is given, and never otherwise', async () => {
    // It is a disambiguator for the address, not a claim: what goes into the
    // issued token is the organization on the row that authenticated. Sending
    // an empty or defaulted one would be inventing a claim the caller did not
    // make.
    const { fetchImpl, calls } = stub(json(200, { access_token: 'a', refresh_token: 'r' }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    await nacre.auth.login({ email: 'a@b.test', password: 'p' })
    expect(calls[0]?.body).not.toHaveProperty('organization')

    await nacre.auth.login({ email: 'a@b.test', password: 'p', organization: 'acme' })
    expect(calls[1]?.body).toMatchObject({ organization: 'acme' })
  })

  it('answers undefined for a refusal rather than throwing', async () => {
    // The server gives one 401 with one message for an unknown address, a wrong
    // password, a wrong organization, a disabled account and an account with no
    // password — in the same time. Turning that into distinguishable outcomes
    // here would invent information it deliberately withheld.
    const { fetchImpl } = stub(problem(401, 'Unauthorized', 'The credentials are not valid.'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.auth.login({ email: 'a@b.test', password: 'no' })).toBeUndefined()
    expect(await nacre.auth.refresh('spent')).toBeUndefined()
  })

  it('still throws for a refusal that is not about the credentials', async () => {
    // 503 with Retry-After is sign-in shed under load: nothing was decided
    // about the credentials presented, so answering `undefined` would tell the
    // caller they were wrong about something that was never checked.
    const { fetchImpl } = stub(problem(503, 'Service Unavailable', 'Try again shortly.'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, retries: 1, fetch: fetchImpl })

    await expect(nacre.auth.login({ email: 'a@b.test', password: 'p' })).rejects.toBeInstanceOf(
      NacreError,
    )
  })

  it('does not swap the client credential on a successful login', async () => {
    // "Which identity is this object" must not depend on call history. An
    // application holding one client for a background job and one for a request
    // would otherwise eventually get the wrong one.
    const { fetchImpl, calls } = stub(json(200, { access_token: 'new-token', refresh_token: 'r' }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    await nacre.auth.login({ email: 'a@b.test', password: 'p' })
    await nacre.search('anything')

    expect(calls[1]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })
})

describe('reindex', () => {
  const RUNNING = {
    layer_id: 'l1',
    status: 'running',
    phase: 'embedding',
    current_vector: 'v_old_768',
    shadow_vector: 'v_new_1024',
    provider_id: 'p2',
    started_at: '2026-08-02T10:00:00Z',
    finished_at: null,
    total: 40,
    done: 12,
    failed: 0,
    progress: 0.3,
    error: null,
    check: null,
  }

  it('starts one and reads the state back', async () => {
    const { fetchImpl, calls } = stub(json(202, RUNNING))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const status = await nacre.layers.reindex('l1', 'p2')

    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.url).toBe(`${BASE}/v1/layers/l1/reindex`)
    expect(calls[0]?.body).toEqual({ provider_id: 'p2' })
    expect(status).toMatchObject({ shadowVector: 'v_new_1024', progress: 0.3, check: null })
  })

  it('reads a null check as null, not as absent', async () => {
    // A layer with no reference query set has no gate, permanently. `undefined`
    // would read as "not scored yet", which is a different claim and the one a
    // caller would poll on forever.
    const { fetchImpl } = stub(json(200, RUNNING))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect((await nacre.layers.reindexStatus('l1'))?.check).toBeNull()
  })

  it('decodes a failed recall check, scores and all', async () => {
    const { fetchImpl } = stub(
      json(200, {
        ...RUNNING,
        status: 'failed',
        error: 'recall 0.500 is below the floor of 0.8',
        check: {
          recall: 0.5,
          floor: 0.8,
          passed: false,
          queries: 2,
          scores: [
            { query_id: 'q1', recall: 1 },
            { query_id: 'q2', recall: 0 },
          ],
        },
      }),
    )
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const check = (await nacre.layers.reindexStatus('l1'))?.check
    expect(check).toMatchObject({ recall: 0.5, floor: 0.8, passed: false, queries: 2 })
    expect(check?.scores).toEqual([
      { queryId: 'q1', recall: 1 },
      { queryId: 'q2', recall: 0 },
    ])
    expect(check?.unresolved).toBeUndefined()
  })

  it('carries the unresolved list, which is a different failure from a low score', async () => {
    const { fetchImpl } = stub(
      json(200, {
        ...RUNNING,
        check: { recall: 1, floor: 0.8, passed: false, queries: 1, scores: [], unresolved: ['gone.md'] },
      }),
    )
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const check = (await nacre.layers.reindexStatus('l1'))?.check
    // Recall is 1 and it still did not pass. A caller branching on the number
    // alone would report a stale reference set as a healthy migration.
    expect(check?.recall).toBe(1)
    expect(check?.passed).toBe(false)
    expect(check?.unresolved).toEqual(['gone.md'])
  })

  it('answers undefined for a layer with no reindex, like every other get', async () => {
    const { fetchImpl } = stub(problem(404, 'Not found'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.layers.reindexStatus('nope')).toBeUndefined()
  })

  it('throws a 409 rather than hiding it, because it is not a permission answer', async () => {
    // The caller has already proved they may administer the layer by the time
    // this can happen, so folding it into `undefined` would lose the one thing
    // they need to know: a migration is already running.
    const { fetchImpl } = stub(problem(409, 'Conflict', 'A reindex is already running.'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    await expect(nacre.layers.reindex('l1', 'p2')).rejects.toMatchObject({ status: 409 })
  })
})

describe('reference queries', () => {
  it('replaces the set whole', async () => {
    const { fetchImpl, calls } = stub(
      json(200, { items: [{ id: 'q1', query: 'notice period', expected: ['a.md'] }] }),
    )
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const set = await nacre.layers.setReferenceQueries('l1', [
      { query: 'notice period', expected: ['a.md'] },
    ])

    expect(calls[0]?.method).toBe('PUT')
    expect(calls[0]?.body).toEqual({ queries: [{ query: 'notice period', expected: ['a.md'] }] })
    expect(set).toEqual([{ id: 'q1', query: 'notice period', expected: ['a.md'] }])
  })

  it('sends an empty set as an empty array, which is how a gate is removed', async () => {
    // Not omitted, and not skipped as a no-op: `{queries: []}` is the request
    // that clears one, and anything else leaves the gate in place.
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.layers.setReferenceQueries('l1', [])).toEqual([])
    expect(calls[0]?.body).toEqual({ queries: [] })
  })

  it('answers undefined for a layer the token may not administer', async () => {
    const { fetchImpl } = stub(problem(404, 'Not found'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.layers.referenceQueries('l1')).toBeUndefined()
    expect(await nacre.layers.setReferenceQueries('l1', [])).toBeUndefined()
  })
})

describe('the access log', () => {
  const RECORD = {
    id: '42',
    occurred_at: '2026-08-02T10:00:00Z',
    actor: { type: 'user', id: 'u1', label: 'alice@example.test' },
    surface: 'rest',
    client: '10.0.0.1',
    action: 'search',
    target: { layer_id: 'l1' },
    result: 'allow',
    detail: { query_hash: 'sha256:abc' },
    request_id: 'req-9',
  }

  it('reads a page and decodes the nested actor', async () => {
    const { fetchImpl } = stub(json(200, { items: [RECORD], next_cursor: 'c2' }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    const page = await nacre.audit.read()

    expect(page.nextCursor).toBe('c2')
    expect(page.items[0]).toMatchObject({
      id: '42',
      actor: { type: 'user', id: 'u1', label: 'alice@example.test' },
      action: 'search',
      result: 'allow',
      requestId: 'req-9',
    })
  })

  it('omits nextCursor on the last page rather than carrying null', async () => {
    // A caller loops `while (page.nextCursor)`. A null that survives decoding
    // as a string would make that loop request the same page forever.
    const { fetchImpl } = stub(json(200, { items: [RECORD], next_cursor: null }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.audit.read()).not.toHaveProperty('nextCursor')
  })

  it('passes filters as query parameters, in snake case', async () => {
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    await nacre.audit.read({
      from: '2026-08-01T00:00:00Z',
      actorId: 'u1',
      action: 'search',
      result: 'deny',
      limit: 50,
      cursor: 'c1',
    })

    const url = new URL(calls[0]?.url as string)
    expect(url.pathname).toBe('/v1/audit')
    expect(url.searchParams.get('actor_id')).toBe('u1')
    expect(url.searchParams.get('result')).toBe('deny')
    expect(url.searchParams.get('limit')).toBe('50')
  })

  it('sends no query string at all when nothing is filtered', async () => {
    const { fetchImpl, calls } = stub(json(200, { items: [] }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    await nacre.audit.read()
    expect(calls[0]?.url).toBe(`${BASE}/v1/audit`)
  })
})

describe('layers.update', () => {
  it('sends only what changed', async () => {
    const { fetchImpl, calls } = stub(new Response(null, { status: 204 }))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.layers.update('l1', { name: 'Contracts' })).toBe(true)
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.body).toEqual({ name: 'Contracts' })
  })

  it('answers false for a layer the token may not administer', async () => {
    const { fetchImpl } = stub(problem(404, 'Not found'))
    const nacre = new NacreClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl })

    expect(await nacre.layers.update('l1', { name: 'x' })).toBe(false)
  })
})

describe('automatic token refresh', () => {
  const tokens = (access: string, refresh: string) =>
    json(200, { access_token: access, token_type: 'Bearer', expires_in: 900, refresh_token: refresh })

  it('renews once on a 401 and replays with the new access token', async () => {
    const { fetchImpl, calls } = stub(
      problem(401, 'Unauthorized', 'The access token is expired.'),
      tokens('access-2', 'refresh-2'),
      json(200, { items: [{ id: 'w1', slug: 's', name: 'W', layer_count: 0 }] }),
    )
    const rotated: unknown[] = []
    const nacre = new NacreClient({
      baseUrl: BASE,
      token: 'access-1',
      fetch: fetchImpl,
      refreshToken: 'refresh-1',
      onTokens: (t) => rotated.push(t),
    })

    const result = await nacre.workspaces.list()
    expect(result).toHaveLength(1)

    expect(calls.map((c) => c.url)).toEqual([
      `${BASE}/v1/workspaces`,
      `${BASE}/v1/auth/refresh`,
      `${BASE}/v1/workspaces`,
    ])
    // the exchange presented the token the client was constructed with
    expect(calls[1]?.body).toEqual({ refresh_token: 'refresh-1' })
    // the replay carried the freshly issued access token, not the expired one
    expect(calls[0]?.headers.authorization).toBe('Bearer access-1')
    expect(calls[2]?.headers.authorization).toBe('Bearer access-2')
    // the application is handed the new pair to persist
    expect(rotated).toEqual([
      { accessToken: 'access-2', tokenType: 'Bearer', expiresIn: 900, refreshToken: 'refresh-2' },
    ])
  })

  it('shares one renewal across concurrent 401s, never presenting a spent token twice', async () => {
    // Replaying a spent refresh token revokes the whole family, so a burst that
    // all 401 at once must produce exactly one exchange.
    let refreshCalls = 0
    let renewed = false
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.endsWith('/v1/auth/refresh')) {
        refreshCalls++
        renewed = true
        return tokens('access-2', 'refresh-2')
      }
      return renewed ? json(200, { items: [] }) : problem(401, 'Unauthorized')
    }) as unknown as typeof globalThis.fetch

    const nacre = new NacreClient({ baseUrl: BASE, token: 'access-1', fetch: fetchImpl, refreshToken: 'refresh-1' })

    const results = await Promise.all([nacre.workspaces.list(), nacre.layers.list(), nacre.grants.list()])
    results.forEach((r) => expect(Array.isArray(r)).toBe(true))
    expect(refreshCalls).toBe(1)
  })

  it('leaves a 401 untouched when no refresh token is configured (a service-account key)', async () => {
    const { fetchImpl, calls } = stub(problem(401, 'Unauthorized'))
    const nacre = new NacreClient({ baseUrl: BASE, token: 'nacre_sk_x', fetch: fetchImpl })

    await expect(nacre.workspaces.list()).rejects.toMatchObject({ status: 401 })
    expect(calls).toHaveLength(1)
  })

  it('surfaces the 401 and drops the token when the refresh is itself refused', async () => {
    const { fetchImpl, calls } = stub(problem(401, 'Unauthorized'), problem(401, 'Unauthorized'))
    const nacre = new NacreClient({ baseUrl: BASE, token: 'access-1', fetch: fetchImpl, refreshToken: 'spent' })

    await expect(nacre.workspaces.list()).rejects.toMatchObject({ status: 401 })
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/workspaces`, `${BASE}/v1/auth/refresh`])

    // the spent token is gone, so a later 401 does not present it a second time
    await expect(nacre.workspaces.list()).rejects.toMatchObject({ status: 401 })
    expect(calls.filter((c) => c.url.endsWith('/v1/auth/refresh'))).toHaveLength(1)
  })
})
