import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { AuthContext } from '@nacre.work/api'
import { createMcpServer, searchDescription, TOOLS_TTL_MS, type Layer } from '@nacre.work/mcp'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseFilters } from '../../metadata.js'

/**
 * The MCP surface.
 *
 * Two properties carry the leak risk here and neither is visible from the tool
 * implementations: the catalog is built per caller, so a shared cache would
 * hand one tenant's layer names to another, and a tool failure must not say
 * which layer or document it failed on.
 */

const SECRET = new TextEncoder().encode('b'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const METADATA = 'https://api.nacre.test/.well-known/oauth-protected-resource'

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

const LAYERS: Record<string, Layer[]> = {
  [ORG_A]: [
    { id: 'l1', slug: 'contracts', name: 'Contracts', description: 'Signed agreements', documentCount: 812 },
  ],
  [ORG_B]: [
    { id: 'l2', slug: 'payroll', name: 'Payroll', description: 'Salary bands and reviews', documentCount: 44 },
  ],
}

/** The shape of a tools/list result, so tests read fields without casting each time. */
interface ToolsListResult {
  readonly result: {
    readonly tools: readonly { readonly name: string; readonly description: string }[]
    readonly ttlMs: number
    readonly cacheScope: string
  }
}

let server: Server
let base: string

const token = (orgId: string) =>
  new SignJWT({ org: orgId, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

/**
 * A service account key resolver, standing in for the Postgres one.
 *
 * Present because this transport is the agent transport and an agent presents a
 * `nacre_sk_` key. It was absent from the Streamable HTTP wiring for as long as
 * that wiring existed — every agent key 401'd here while the same key worked
 * over STDIO and REST — and nothing failed, because the surface tests built
 * their own options and never asked for one.
 */
const AGENT_KEY = 'nacre_sk_' + 'a'.repeat(32)
const serviceKeys = {
  resolve: async (key: string): Promise<AuthContext | undefined> =>
    key === AGENT_KEY
      ? { orgId: ORG_A, principal: { type: 'service_account', id: 'agent-1' }, role: 'member' }
      : undefined,
}

const MCP_HEADERS = {
  'mcp-protocol-version': '2026-07-28',
  'mcp-method': 'tools/list',
  'mcp-name': 'nacre',
  'content-type': 'application/json',
}

async function rpc(
  method: string,
  params: unknown,
  orgId: string,
  headers: Record<string, string> = MCP_HEADERS,
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, authorization: `Bearer ${await token(orgId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

describe('baseline · the MCP surface', () => {
  beforeAll(async () => {
    server = createMcpServer({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE, serviceKeys },
      resourceMetadataUrl: METADATA,
      layers: { forCaller: async (auth: AuthContext) => LAYERS[auth.orgId] ?? [] },
      tools: {
        call: async (name, args) => {
          if (name === 'search') {
            // The real runner validates filters here. What is under test is the
            // transport's mapping of the two kinds of failure, so the stub
            // raises the same two kinds.
            parseFilters((args as { filters?: unknown } | undefined)?.filters)
            return { items: [] }
          }
          // Everything else pretends the object is not there, which is what a
          // real refusal looks like from outside.
          throw new Error('nope')
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('the catalog is built per caller, not shared', async () => {
    const a = (await (await rpc('tools/list', {}, ORG_A)).json()) as ToolsListResult
    const b = (await (await rpc('tools/list', {}, ORG_B)).json()) as ToolsListResult

    const describe = (r: ToolsListResult) =>
      r.result.tools.find((t) => t.name === 'search')?.description ?? ''

    expect(describe(a)).toContain('Contracts')
    expect(describe(b)).toContain('Payroll')
    // The names are the leak: one tenant must not learn the other's layers.
    expect(describe(a)).not.toContain('Payroll')
    expect(describe(b)).not.toContain('Contracts')
  })

  it('a service account key authenticates on this transport', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${AGENT_KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })

    // 200, not 401. An agent holding a working key over REST and STDIO getting
    // 401 here is indistinguishable from a revoked key, which is where the
    // debugging goes and where it does not end.
    expect(res.status).toBe(200)
    const body = (await res.json()) as ToolsListResult
    expect(body.result.tools.map((t) => t.name)).toContain('search')
  })

  it('an unknown service account key is refused like every other bad token', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer nacre_sk_${'z'.repeat(32)}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(res.status).toBe(401)
  })

  it('tools/list is cached per user, for the same reason', async () => {
    const body = (await (await rpc('tools/list', {}, ORG_A)).json()) as ToolsListResult
    // If this ever becomes 'global', the test above starts failing in
    // production and passing here.
    expect(body.result.cacheScope).toBe('user')
    expect(body.result.ttlMs).toBe(TOOLS_TTL_MS)
  })

  it('a caller with no layers is told so, and told nothing else', () => {
    const empty = searchDescription([])
    expect(empty).toContain('No layers are available to you')
    for (const layer of [...LAYERS[ORG_A]!, ...LAYERS[ORG_B]!]) {
      expect(empty).not.toContain(layer.name)
    }
  })

  it('the generated description names the layers and their sizes', () => {
    const text = searchDescription(LAYERS[ORG_A] as Layer[])
    expect(text).toContain('Contracts — Signed agreements (812 docs)')
  })

  it('T2 · params naming an organization are refused', async () => {
    const res = await rpc('tools/call', { name: 'search', arguments: { query: 'x', org_id: ORG_B } }, ORG_A)
    expect(res.status).toBe(403)
  })

  it('T2 · a nested org_id in params is caught too', async () => {
    const res = await rpc(
      'tools/call',
      { name: 'search', arguments: { query: 'x', filters: { meta: { org_id: ORG_B } } } },
      ORG_A,
    )
    expect(res.status).toBe(403)
  })

  it('a malformed filter is named, and only a malformed filter', async () => {
    // Everything else a tool can fail on answers one "not found", because a
    // tool error that names a layer tells the caller the layer exists. A
    // validation error is the one thing that names only what the caller
    // already sent — and answering "not found" to a typo leaves an agent
    // retrying the same call forever, since the one thing it cannot learn from
    // that answer is that its arguments were wrong.
    const bad = await rpc(
      'tools/call',
      { name: 'search', arguments: { query: 'x', filters: { 'Bad.Key': 'v' } } },
      ORG_A,
    )
    expect(bad.status).toBe(400)
    const body = (await bad.json()) as { error: { code: number; message: string } }
    expect(body.error.code).toBe(-32602)
    expect(body.error.message).toContain('Bad.Key')

    // An unknown tool is still indistinguishable from one the caller may not
    // reach. If this ever starts naming things, the carve-out above grew.
    const unknown = await rpc('tools/call', { name: 'nope', arguments: {} }, ORG_A)
    expect(unknown.status).toBe(404)
    const other = (await unknown.json()) as { error: { code: number; message: string } }
    expect(other.error.code).toBe(-32601)
    expect(other.error.message).toBe('Not found')
  })

  it('a successful call answers with a CallToolResult, not the bare value', async () => {
    const res = await rpc('tools/call', { name: 'search', arguments: { query: 'x' } }, ORG_A)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      result?: { content?: { type: string; text: string }[]; isError?: boolean }
    }

    // The protocol requires `content` to be a list of content blocks, and a
    // client that follows it rejects anything else. This server answered with
    // the raw result array — every request in this file passed, and no
    // compliant client could read a single result from any of them. The claim
    // that agents reach this over MCP is exactly the shape of this object.
    expect(Array.isArray(body.result?.content), JSON.stringify(body)).toBe(true)
    expect(body.result?.content?.[0]?.type).toBe('text')
    expect(body.result?.isError).toBe(false)
    // The payload survives the envelope rather than being described by it.
    expect(() => JSON.parse(body.result?.content?.[0]?.text ?? '')).not.toThrow()
  })

  it('T8 · a failing tool and an unknown tool answer identically', async () => {
    const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} }, ORG_A)
    const failing = await rpc('tools/call', { name: 'get_document', arguments: { document_id: 'x' } }, ORG_A)

    expect(unknown.status).toBe(failing.status)
    expect(await unknown.json()).toEqual(await failing.json())
  })

  it('no tool schema accepts an organization', async () => {
    const body = (await (await rpc('tools/list', {}, ORG_A)).json()) as ToolsListResult
    const serialized = JSON.stringify(body.result.tools)
    for (const forbidden of ['org_id', 'orgId', 'organization', 'tenant']) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('the required transport headers are required', async () => {
    for (const missing of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
      const headers: Record<string, string> = { ...MCP_HEADERS }
      delete headers[missing]
      const res = await rpc('tools/list', {}, ORG_A, headers)
      expect(res.status, `without ${missing}`).toBe(400)
    }
  })

  it('a 401 points the client at the protected-resource metadata', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
    // RFC 9728. Without this the client has nowhere to start.
    expect(res.headers.get('www-authenticate')).toContain(METADATA)
  })

  it('there is no session to establish', async () => {
    // The 2026-07-28 revision has no initialize and no Mcp-Session-Id. If this
    // ever succeeds, state has crept into the transport and the round-robin
    // deployment stops being safe.
    const res = await rpc('initialize', {}, ORG_A)
    expect(res.status).toBe(404)
    expect(res.headers.get('mcp-session-id')).toBeNull()
  })

  it('write tools are declared write, and read tools read', async () => {
    const { catalog } = await import('@nacre.work/mcp')
    const tools = catalog(LAYERS[ORG_A] as Layer[])
    const permission = (name: string) => tools.find((t) => t.name === name)?.permission

    expect(permission('search')).toBe('read')
    expect(permission('list_layers')).toBe('read')
    expect(permission('get_document')).toBe('read')
    // write does not imply read: an ingest-only service account must not be
    // able to search what it uploaded.
    expect(permission('ingest_document')).toBe('write')
    expect(permission('delete_document')).toBe('write')
  })
})
