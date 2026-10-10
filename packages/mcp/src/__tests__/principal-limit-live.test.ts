import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'

import { RateLimiter, type AuthContext, type LimitPolicy } from '@nacre.work/api'
import { protectedResourceMetadata, Redis } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createMcpServer } from '../server.js'

/**
 * Every MCP request counts against the caller, on the same budget REST spends.
 *
 * Against a real Redis, for the reason `limits.test.ts` gives: the property is
 * `INCR` and `DECR` on shared keys, and a fake of those is a test of the fake.
 * Over the real transport with raw frames, because what is asked is the HTTP
 * status and the JSON-RPC error a client actually receives — and a frame that
 * is not `tools/call` must count too, since a loop over `tools/list` takes a
 * server away as well as a loop over `search` does.
 */

const url = process.env.NACRE_REDIS_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_REDIS_URL is not set and CI is; the MCP request limit would go untested.')
}
const when = url ? describe : describe.skip

const KEY = 'nacre_sk_' + 'l'.repeat(32)
const policies: Record<string, LimitPolicy> = {
  requests: { limit: 3, windowSeconds: 60 },
  search: { limit: 1, windowSeconds: 60 },
  ingest: { limit: 100, windowSeconds: 3600 },
  login: { limit: 100, windowSeconds: 900 },
  login_source: { limit: 100, windowSeconds: 900 },
  client_registration: { limit: 100, windowSeconds: 3600 },
}

let redis: Redis
let server: Server
let endpoint: string
/** Who the key resolves to — a fresh principal per case, so windows never overlap. */
let caller: AuthContext

const fresh = (): AuthContext => ({
  orgId: `0a777777-7777-4777-8777-${randomBytes(6).toString('hex')}`,
  principal: { type: 'service_account', id: randomBytes(6).toString('hex') },
  role: 'member',
})

const frame = (method: string, params: Record<string, unknown> = {}): Promise<Response> =>
  fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })

when('the MCP transport counts requests per caller', () => {
  beforeAll(async () => {
    redis = new Redis({ url: url as string })
    server = createMcpServer({
      verify: {
        key: new TextEncoder().encode('k'.repeat(32)),
        issuer: 'https://api.nacre.test',
        audience: 'nacre',
        serviceKeys: { resolve: async (key: string) => (key === KEY ? caller : undefined) },
      },
      resourceMetadataUrl: 'https://mcp.nacre.test/.well-known/oauth-protected-resource',
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.nacre.test' }),
      layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
      tools: { call: async () => [] },
      apiOrigin: 'https://api.example.test',
      limits: new RateLimiter({ redis, policies: policies as never }),
      limitPolicies: policies as never,
    } as never)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    redis?.close()
  })

  it('refuses the request past the budget, whatever the method', async () => {
    caller = fresh()
    for (let i = 0; i < 3; i++) expect((await frame('tools/list')).status).toBe(200)

    const refused = await frame('tools/list')
    expect(refused.status).toBe(429)
    expect(refused.headers.get('ratelimit-policy')).toBe('requests;q=3;w=60')
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    const body = (await refused.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32003)
    expect(body.error.message).toMatch(/^Rate limit exceeded\. Try again in \d+ seconds\.$/)

    // Another caller is not the noisy one.
    caller = fresh()
    expect((await frame('tools/list')).status).toBe(200)
  })

  it('gives the request back when the tool limit refuses', async () => {
    // search is 1 a minute, requests 3. Without the give-back the refused
    // search spends a request and the third frame below is refused.
    caller = fresh()
    expect((await frame('tools/call', { name: 'search', arguments: { query: 'x' } })).status).toBe(200)
    expect((await frame('tools/call', { name: 'search', arguments: { query: 'x' } })).status).toBe(429)
    expect((await frame('tools/list')).status).toBe(200)
    expect((await frame('tools/list')).status).toBe(200)
    expect((await frame('tools/list')).status).toBe(429)
  })
})
