import * as http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi } from '../server.js'

/**
 * A backslash in the raw request-target used to reach `/metrics` unproxied.
 *
 * The shipped front door keeps `/metrics` off the public origin by matching
 * its own parsed URI against `location /v1/` and forwarding the client's
 * *raw* request-target unchanged. On Linux nginx a backslash is an ordinary
 * byte, not a path separator, so `/v1/..\metrics` stays inside
 * `location /v1/` there while this process's own WHATWG `URL` parsing maps
 * `\` to `/` and resolves `..`, routing straight to `/metrics` regardless of
 * what sits in front of it.
 *
 * `fetch` and most HTTP clients refuse or normalise a backslash before a
 * request ever leaves the process, so this uses `node:http` directly with a
 * manually written request-target — the one way to actually put the byte on
 * the wire the way a raw proxy would forward it.
 */

const SECRET = new TextEncoder().encode('b'.repeat(32))

let server: Server
let base: string

beforeAll(async () => {
  server = createApi({
    verify: { key: SECRET, issuer: 'https://backslash.test', audience: 'backslash' },
    documents: { read: async () => undefined },
    search: { search: async () => [] },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: { write: async () => undefined },
    metrics: { render: async () => 'nacre_documents_total{organization="dummy-org"} 3\n' },
  } as unknown as Parameters<typeof createApi>[0])
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `127.0.0.1`
  void base
})

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

/** A raw request with a hand-written request-target, bypassing any client-side URL normalisation. */
const rawGet = (requestTarget: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        method: 'GET',
        path: requestTarget,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode as number, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })

describe('a backslash in the raw request-target', () => {
  it('refuses /metrics outright, whatever path it is reached through', async () => {
    const direct = await rawGet('/metrics')
    expect(direct.status).toBe(200)
    expect(direct.body).toContain('nacre_documents_total')

    for (const attempt of ['/v1/..\\metrics', '/oauth/..\\metrics', '/.well-known/..\\metrics']) {
      const res = await rawGet(attempt)
      expect(res.status, attempt).toBe(400)
      expect(res.body, attempt).not.toContain('nacre_documents_total')
    }
  })

  it('refuses a backslash anywhere in the path, not only before "metrics"', async () => {
    const res = await rawGet('/v1\\layers')
    expect(res.status).toBe(400)
  })

  it('leaves an ordinary path with no backslash untouched', async () => {
    const res = await rawGet('/v1/../metrics')
    // No backslash at all: WHATWG parsing collapses this to /metrics too,
    // which is the existing, intended behaviour for a *forward* slash — the
    // finding is specifically about the backslash disagreement between an
    // edge and this process, not about '..' itself.
    expect(res.status).toBe(200)
  })
})
