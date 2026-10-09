import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AuthContext } from '@nacre.work/api'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { protectedResourceMetadata } from '@nacre.work/core'

import { callToolError, callToolResult, COMPLETE, PROTOCOL_VERSION } from '../results.js'
import { createMcpServer } from '../server.js'

/**
 * Every result a 2026-07-28 client can receive carries `resultType`.
 *
 * The revision makes it a MUST, and the "absent means complete" bridge applies
 * only to a server of an earlier revision — which this one is not, since it
 * advertises 2026-07-28 first. `server/discover` carried the field and
 * `tools/call` did not, so a modern client refused every tool result as
 * malformed while `tools/list` and discovery looked healthy: an agent saw the
 * catalog and could call nothing in it.
 *
 * The field is the SDK's to stamp now, so this asks the **wire** rather than
 * a builder: raw modern-era frames over the real HTTP transport, read back
 * before any client has normalised them — the SDK's own client *strips* the
 * field after validating it, so asking the client would prove nothing about
 * the bytes. The client is then asked too, in both eras, because a client
 * that validates every result is what refused the old ones in the first
 * place, and it is the thing a 2026-07-28 agent actually runs.
 */

const KEY = 'nacre_sk_' + 'r'.repeat(32)
const auth: AuthContext = { orgId: 'o', principal: { type: 'service_account', id: 'agent' }, role: 'member' }
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'result-type', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

let server: Server
let url: URL

beforeAll(async () => {
  server = createMcpServer({
    verify: {
      key: new TextEncoder().encode('k'.repeat(32)),
      issuer: 'https://api.nacre.test',
      audience: 'nacre',
      serviceKeys: { resolve: async (key) => (key === KEY ? auth : undefined) },
    },
    resourceMetadataUrl: 'https://mcp.nacre.test/.well-known/oauth-protected-resource',
    resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.nacre.test' }),
    layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
    tools: {
      call: async (name) => {
        if (name === 'search') return [{ ok: 1 }]
        throw new Error('nope')
      },
    },
    serverVersion: '1.2.3',
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function raw(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const name = params.name
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } }),
  })
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown }
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

async function connected(era: 'modern' | 'legacy'): Promise<Client> {
  const client = new Client(
    { name: 'result-type', version: '0' },
    era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }),
  )
  return client
}

describe('resultType on every modern-era result', () => {
  it('is required because this server leads with 2026-07-28', () => {
    expect(PROTOCOL_VERSION).toBe('2026-07-28')
  })

  const cases: Array<[string, Record<string, unknown>]> = [
    ['server/discover', {}],
    ['tools/list', {}],
    ['tools/call', { name: 'search', arguments: { query: 'x' } }],
    // A failing tool is still a complete result — the failure is the tool's
    // answer, not the protocol's.
    ['tools/call', { name: 'get_document', arguments: { document_id: 'x' } }],
  ]

  for (const [method, params] of cases) {
    it(`${method} ${JSON.stringify(params)} says complete on the wire`, async () => {
      const result = await raw(method, params)
      expect(result.resultType).toBe(COMPLETE)
    })
  }

  it('the SDK client validates every result in the modern era', async () => {
    const client = await connected('modern')
    try {
      const discover = await client.discover()
      expect(discover.supportedVersions).toEqual([PROTOCOL_VERSION])
      const list = (await client.listTools()) as unknown as Record<string, unknown>
      expect((list.tools as { name: string }[]).map((t) => t.name)).toContain('search')
      expect(list.cacheScope).toBe('private')
      expect(list.ttlMs).toBe(0)
      const call = (await client.callTool({ name: 'search', arguments: { query: 'x' } })) as Record<string, unknown>
      expect(call.isError).toBe(false)
      const failed = (await client.callTool({
        name: 'get_document',
        arguments: { document_id: 'x' },
      })) as Record<string, unknown>
      expect(failed.isError).toBe(true)
      expect((failed.content as { text: string }[])[0]?.text).toBe('Not found')
    } finally {
      await client.close()
    }
  })

  it('a legacy client reaches the same tools', async () => {
    // The legacy era predates `resultType`; a client of that generation
    // validates against its own schema, which is why the SDK does not stamp
    // it there. What matters is that the catalog and the calls are the same.
    const client = await connected('legacy')
    try {
      const list = await client.listTools()
      expect(list.tools.map((t) => t.name)).toContain('search')
      const call = (await client.callTool({ name: 'search', arguments: { query: 'x' } })) as Record<string, unknown>
      expect(call.isError).toBe(false)
      expect((call.content as { text: string }[])[0]?.text).toContain('"ok": 1')
    } finally {
      await client.close()
    }
  })

  it('leaves the CallToolResult shape intact', () => {
    const result = callToolResult([1, 2])
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify([1, 2], null, 2) }])
  })
})

describe('a failed tool call', () => {
  it('is a result with isError that names nothing', () => {
    expect(callToolError()).toEqual({
      content: [{ type: 'text', text: 'Not found' }],
      isError: true,
    })
  })
})
