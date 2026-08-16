import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { AuthContext } from '@nacre.work/api'
import {
  createMcpServer,
  LEGACY_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSIONS,
  searchDescription,
  TOOLS_TTL_MS,
  type Layer,
} from '@nacre.work/mcp'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseFilters } from '../../metadata.js'
import { protectedResourceMetadata, PROTECTED_RESOURCE_PATH } from '../../oauth.js'

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
  'content-type': 'application/json',
}

/** The three methods that name something, and where the name lives. */
const NAMED: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
}

/**
 * The mirrored headers for a call, derived from it.
 *
 * The harness used to send a fixed `mcp-method: tools/list` whatever it was
 * calling, and an `mcp-name` on every request — which is what a client does
 * *not* do, and is why the transport requiring one everywhere went unnoticed.
 * Deriving them is the point: a header that does not describe the body is
 * exactly what the server now refuses.
 */
function mirrored(method: string, params: unknown): Record<string, string> {
  const field = NAMED[method]
  const value = field === undefined ? undefined : (params as Record<string, unknown>)?.[field]
  return {
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
    ...(typeof value === 'string' ? { 'mcp-name': value } : {}),
    'content-type': 'application/json',
  }
}

async function rpc(
  method: string,
  params: unknown,
  orgId: string,
  headers?: Record<string, string>,
): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...(headers ?? mirrored(method, params)), authorization: `Bearer ${await token(orgId)}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

/**
 * A request with a `Host` this test chooses.
 *
 * `fetch` forbids setting `Host` — undici writes it from the URL — and `Host`
 * is the entire input to the behaviour under test, so these go out over
 * `node:http` instead.
 */
async function withHost(
  port: number,
  path: string,
  host: string,
  extra: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const { request } = await import('node:http')
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { host, ...extra } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('baseline · the MCP surface', () => {
  beforeAll(async () => {
    server = createMcpServer({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE, serviceKeys },
      resourceMetadataUrl: METADATA,
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://api.example.test' }),
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

  /**
   * The handshake, sent the way a real client sends it — no 2026-07-28 headers
   * on any of the three legs.
   *
   * This is the case the suite could not see. Every other test here calls
   * `tools/list`, which is the *second* request a client makes; the first is
   * `initialize`, it carried no `MCP-Protocol-Version` because none is
   * negotiated yet, and the server refused it with -32020. So no standard
   * client had ever reached this transport, and 179 green tests said otherwise.
   */
  it('completes the handshake a real client performs, with no mirrored headers', async () => {
    const plain = { 'content-type': 'application/json' }

    const hello = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} }, ORG_A, plain)
    expect(hello.status, 'initialize with no MCP-Protocol-Version').toBe(200)
    const greeting = (await hello.json()) as {
      result: { protocolVersion: string; capabilities: Record<string, unknown>; serverInfo: { name: string } }
    }
    // Echoed, because this server speaks it. A counter-offer here would be
    // correct too but is a different case, below.
    expect(greeting.result.protocolVersion).toBe('2025-06-18')
    expect(greeting.result.capabilities).toHaveProperty('tools')
    // Nothing this server does not serve: a declared capability is a promise a
    // client will come back and call.
    expect(Object.keys(greeting.result.capabilities)).toEqual(['tools'])
    expect(greeting.result.serverInfo.name).toBe('nacre')

    // Leg two. A notification: no id, no result, and 202 with an empty body.
    const ack = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...plain, authorization: `Bearer ${await token(ORG_A)}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    expect(ack.status, 'notifications/initialized').toBe(202)
    expect(await ack.text()).toBe('')

    // Leg three, still with no mirrored headers, and it has to answer.
    const listed = await rpc('tools/list', {}, ORG_A, plain)
    expect(listed.status, 'tools/list with no mirrored headers').toBe(200)
    const tools = (await listed.json()) as { result: { tools: { name: string }[] } }
    expect(tools.result.tools.length).toBeGreaterThan(0)

    // And a tool actually runs, which is the thing the whole transport is for.
    const called = await rpc('tools/call', { name: 'search', arguments: { query: 'anything' } }, ORG_A, plain)
    expect(called.status, 'tools/call with no mirrored headers').toBe(200)
  })

  it('refuses a framing revision it cannot read, and lists the ones it can', async () => {
    // The header is not the same statement as `params.protocolVersion`. That
    // one is a proposal and gets a counter-offer; this one says which
    // revision's transport rules framed the request, and a revision we cannot
    // read means nothing below it can be trusted to mean what it looks like.
    const res = await rpc('tools/list', {}, ORG_A, {
      'mcp-protocol-version': '1999-01-01',
      'content-type': 'application/json',
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } }
    }
    expect(body.error.code).toBe(-32022)
    expect(body.error.data.requested).toBe('1999-01-01')
    // Naming what we do speak is the point: a bare refusal leaves the client
    // with nothing to retry.
    expect(body.error.data.supported).toEqual([...PROTOCOL_VERSIONS])
  })

  it('refuses a header revision that disagrees with the one in _meta', async () => {
    // The third mirrored comparison, and the one that was still missing after
    // Mcp-Method and Mcp-Name went in.
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/list',
        'content-type': 'application/json',
        authorization: `Bearer ${await token(ORG_A)}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' },
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32020)

    // Agreeing is fine, and so is a body that carries no version at all.
    const agreeing = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'mcp-protocol-version': '2026-07-28',
        'content-type': 'application/json',
        authorization: `Bearer ${await token(ORG_A)}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      }),
    })
    expect(agreeing.status).toBe(200)
  })

  it('echoes the revision every shipping client actually proposes', async () => {
    // 2025-11-25 is the newest revision the MCP SDK knows — `LATEST_PROTOCOL_VERSION`
    // in its own types — so it is what a real client puts in `initialize`. It
    // was missing from PROTOCOL_VERSIONS, so the proposal fell through to the
    // counter-offer branch and the client was handed 2026-07-28, which its
    // `SUPPORTED_PROTOCOL_VERSIONS` does not contain. Every connection died on
    // `Server's protocol version is not supported: 2026-07-28`.
    const res = await rpc(
      'initialize',
      { protocolVersion: '2025-11-25', capabilities: {} },
      ORG_A,
      { 'content-type': 'application/json' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { protocolVersion: string } }
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('counter-offers a legacy revision, never the newest one', async () => {
    const res = await rpc(
      'initialize',
      { protocolVersion: '1999-01-01', capabilities: {} },
      ORG_A,
      { 'content-type': 'application/json' },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { protocolVersion: string } }

    // A version this server cannot speak is answered with one it can, and the
    // client decides. The alternative — an error — leaves the client with
    // nothing to do.
    //
    // But the offer has to be one the *asking generation* can take. Anything
    // arriving on `initialize` is a legacy client, and the specification's own
    // compatibility matrix says legacy clients have no fall-forward mechanism:
    // they either speak what they are told or fail. So the newest legacy
    // revision, and specifically **not** PROTOCOL_VERSIONS[0] — which is what
    // this test asserted while no client could connect.
    expect(body.result.protocolVersion).toBe(LEGACY_PROTOCOL_VERSIONS[0])
    expect(body.result.protocolVersion).not.toBe(PROTOCOL_VERSION)
    expect(PROTOCOL_VERSIONS).toContain(body.result.protocolVersion)
  })

  it('server/discover advertises every revision, for anybody', async () => {
    // A MUST in 2026-07-28, and the modern era's opening move: a client that
    // sends no `initialize` learns the version list here instead.
    const res = await rpc('server/discover', {}, ORG_A, { 'content-type': 'application/json' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      result: {
        resultType: string
        supportedVersions: string[]
        capabilities: Record<string, unknown>
        cacheScope: string
        _meta: Record<string, { name: string; version: string }>
      }
    }
    expect(body.result.resultType).toBe('complete')
    expect(body.result.supportedVersions).toEqual([...PROTOCOL_VERSIONS])
    // The literal rather than the constant, deliberately. This is what goes on
    // the wire to a client, so a change to `CAPABILITIES` should stop here and
    // be looked at — a test that imported the value would agree with whatever
    // the code became, which is the fixture-written-to-match-the-code shape.
    //
    // It read `{ tools: {} }` while STDIO answered
    // `{ tools: { listChanged: false } }`, and each transport's own suite was
    // green: this file asserted this server and the other asserted that one,
    // with nothing asking whether they were the same server. `listChanged:
    // false` is the statement both make now — this server sends no
    // `notifications/tools/list_changed`, and saying so beats leaving a client
    // to infer it from an absent field.
    expect(body.result.capabilities).toEqual({ tools: { listChanged: false } })
    // Nothing in it depends on who asked — unlike tools/list, which is scoped
    // to the caller's layers and is `private` for exactly that reason.
    expect(body.result.cacheScope).toBe('public')
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']?.name).toBe('nacre')
  })

  it('a path this transport does not serve answers HTTP, not JSON-RPC', async () => {
    // The failure this replaces: a client with no token reads the
    // protected-resource document, finds no authorization server named, falls
    // back to treating this origin as one, and posts a registration request to
    // `/register`. It got a JSON-RPC envelope, tried to read it as an RFC 6749
    // error, and surfaced `HTTP 404: Invalid OAuth error response: ZodError`.
    //
    // The envelope belongs to /mcp. Everything else here arrived over plain
    // HTTP from something that is not a JSON-RPC client.
    for (const [method, path] of [
      ['GET', '/.well-known/oauth-authorization-server'],
      ['GET', '/.well-known/openid-configuration'],
      ['POST', '/register'],
      ['GET', '/nothing-here'],
    ] as const) {
      const res = await fetch(`${base}${path}`, { method })
      expect(res.status, `${method} ${path}`).toBe(404)
      const body = (await res.json()) as Record<string, unknown>
      expect(typeof body.error, `${method} ${path} error is a string`).toBe('string')
      expect(typeof body.error_description).toBe('string')
      expect(body.jsonrpc, `${method} ${path} carries no RPC envelope`).toBeUndefined()
    }
  })

  it('ignores a notification it does not know rather than refusing it', async () => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(ORG_A)}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    })
    // A notification is by definition one the receiver may ignore, and an error
    // is something the sender cannot act on — it has no id to correlate.
    expect(res.status).toBe(202)
  })

  it('accepts a request with no mirrored headers and still refuses one that lies', async () => {
    // Absent is fine: no shipping client sends these, and demanding them is
    // what made the transport unreachable.
    for (const missing of ['mcp-protocol-version', 'mcp-method', 'mcp-name']) {
      const headers: Record<string, string> = { ...mirrored('tools/list', {}) }
      delete headers[missing]
      const res = await rpc('tools/list', {}, ORG_A, headers)
      expect(res.status, `without ${missing}`).toBe(200)
    }

    // Present and disagreeing is still refused, because the comparison is the
    // entire reason the headers exist: an intermediary routes on the header
    // while this server executes the body, and two different instructions is
    // the thing to stop.
    const lying = await rpc('tools/list', {}, ORG_A, {
      ...mirrored('tools/list', {}),
      'mcp-method': 'tools/call',
    })
    expect(lying.status, 'mcp-method disagreeing with the body').toBe(400)
    const body = (await lying.json()) as { error: { code: number } }
    // -32020 HeaderMismatch, the code the specification allocates. -32600
    // read as "not a modern server" and sent a client into a fallback this
    // transport does not speak.
    expect(body.error.code).toBe(-32020)

    // `Mcp-Name` is required only on the three methods that name something.
    // Demanding it on `tools/list` refused a request no client can make any
    // other way, which is how this was found: a real client could not list
    // tools at all.
    const listed = await rpc('tools/list', {}, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
      'content-type': 'application/json',
    })
    expect(listed.status).toBe(200)

    // And on one that does name something it is **still not demanded**, because
    // no shipping client sends it — that requirement is what made this
    // transport unreachable in the first place, one method further along.
    const unnamed = await rpc('tools/call', { name: 'search', arguments: { query: 'x' } }, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'content-type': 'application/json',
    })
    expect(unnamed.status).toBe(200)

    // Sent and wrong is a different thing, and is refused: that comparison is
    // the whole protection the header buys.
    const misnamed = await rpc('tools/call', { name: 'search', arguments: { query: 'x' } }, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'delete_document',
      'content-type': 'application/json',
    })
    expect(misnamed.status).toBe(400)
    expect(((await misnamed.json()) as { error: { code: number } }).error.code).toBe(-32020)
  })

  it('refuses a header that contradicts the body', async () => {
    // The reason the headers exist: an intermediary routes on the header while
    // the server executes the body, so two halves that disagree are two
    // components acting on different instructions. The transport demanded these
    // headers and never compared them, which bought the incompatibility and
    // none of the protection.
    const wrongMethod = await rpc('tools/list', {}, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'content-type': 'application/json',
    })
    expect(wrongMethod.status).toBe(400)
    expect(((await wrongMethod.json()) as { error: { code: number } }).error.code).toBe(-32020)

    const wrongName = await rpc('tools/call', { name: 'search', arguments: { query: 'x' } }, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': 'list_layers',
      'content-type': 'application/json',
    })
    expect(wrongName.status).toBe(400)
  })

  it('accepts an Mcp-Name carried in the Base64 sentinel', async () => {
    // A name that is not header-safe travels encoded, and the server decodes
    // before comparing — otherwise every such call is a false mismatch.
    const encoded = `=?base64?${Buffer.from('search', 'utf8').toString('base64')}?=`
    const res = await rpc('tools/call', { name: 'search', arguments: { query: 'x' } }, ORG_A, {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': encoded,
      'content-type': 'application/json',
    })
    expect(res.status).not.toBe(400)
  })

  it('answers 405 on the verbs this revision removed, and 404 elsewhere', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${base}/mcp`, { method })
      // Not 404: that is one of the signals that sends a client down the
      // deprecated HTTP+SSE path, and this server does not speak it.
      expect(res.status, method).toBe(405)
      expect(res.headers.get('allow'), method).toContain('POST')
    }

    expect((await fetch(`${base}/nothing-here`)).status).toBe(404)
  })

  it('refuses a browser origin that is not allowed, and lets an agent through', async () => {
    // Validating Origin is required to stop DNS rebinding — a page in
    // somebody's browser reaching a server on their network. An agent sends
    // none, so an absent header must not be refused or this transport would
    // reject everything it exists for.
    const fromBrowser = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...mirrored('tools/list', {}), origin: 'https://evil.test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(fromBrowser.status).toBe(403)

    // No Origin, no credential: it gets as far as authentication, which is the
    // proof it was not turned away for the missing header.
    const fromAgent = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: mirrored('tools/list', {}),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(fromAgent.status).toBe(401)
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

  it('and the path it points at is served, unauthenticated', async () => {
    // The header named this path for as long as it existed and nothing served
    // it, so a client doing exactly what it was told got a 404 — the same
    // failure as a parameter read by nothing, one hop further out.
    //
    // Unauthenticated by definition: it is what a client reads *because* it has
    // no credential yet.
    const res = await fetch(`${base}${PROTECTED_RESOURCE_PATH}`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      resource: string
      bearer_methods_supported: string[]
      authorization_servers?: string[]
    }
    // The audience value every token is bound to, without a trailing slash —
    // two strings that differ by one character are two different audiences to
    // every check ever written.
    expect(body.resource).toBe('https://api.example.test')
    expect(body.bearer_methods_supported).toEqual(['header'])
    // Absent, because this fixture configures no identity provider. Pointing
    // the field at ourselves would be the same lie the 404 was, one redirect
    // further along: we issue no OAuth token.
    expect(body.authorization_servers).toBeUndefined()
  })

  /**
   * The identifier follows the request when no deployment pinned one.
   *
   * This is the second half of the failure a real client hit. Compose defaulted
   * `NACRE_MCP_CANONICAL_URL` to `http://localhost:8081`, so a client reaching
   * the stack at `http://10.8.0.1:8081/mcp` read a document naming localhost,
   * and RFC 9728 has it compare the two and refuse **before sending a token**:
   *
   *     Protected resource http://localhost:8081 does not match
   *     expected http://10.8.0.1:8081/mcp (or origin)
   *
   * A default that quietly names localhost is the failure `loadConfig` refuses
   * for every other URL in this product, and it had been introduced here by the
   * fix for the previous version of this same bug.
   */
  it('names the origin the client actually reached when nothing is pinned', async () => {
    const derived = createMcpServer({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE, serviceKeys },
      resourceMetadataUrl: METADATA,
      resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'http://localhost:8081' }),
      resourceFromRequest: (origin: string) => protectedResourceMetadata({ canonicalUrl: origin }),
      layers: { forCaller: async () => [] },
      tools: { call: async () => ({ content: [] }) },
    })
    await new Promise<void>((r) => derived.listen(0, '127.0.0.1', r))
    const port = (derived.address() as AddressInfo).port

    try {
      // Reached by IP, exactly as the operator does. `Host` carries what the
      // client put in its configuration, which is what the identifier has to
      // match.
      const res = await withHost(port, '/.well-known/oauth-protected-resource', '10.8.0.1:8081')
      const body = JSON.parse(res.body) as { resource: string }
      expect(body.resource).toBe('http://10.8.0.1:8081')
      expect(body.resource).not.toContain('localhost')

      // A proxy terminating TLS is the one case Host cannot express.
      const behindTls = await withHost(port, '/.well-known/oauth-protected-resource', 'nacre.example.com', {
        'x-forwarded-proto': 'https',
      })
      expect((JSON.parse(behindTls.body) as { resource: string }).resource).toBe('https://nacre.example.com')

      // And the 401 points at a metadata URL on the same origin, or the client
      // is sent somewhere it cannot compare either.
      const denied = await withHost(
        port,
        '/mcp',
        '10.8.0.1:8081',
        { 'content-type': 'application/json' },
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      )
      expect(denied.status).toBe(401)
      expect(String(denied.headers['www-authenticate'])).toContain(
        'http://10.8.0.1:8081/.well-known/oauth-protected-resource',
      )
    } finally {
      await new Promise<void>((r) => derived.close(() => r()))
    }
  })

  it('a pinned canonical URL wins over the request', async () => {
    // Behind a proxy that rewrites Host, the operator is the only one who knows
    // the public name — so setting NACRE_MCP_CANONICAL_URL has to be final.
    // This fixture passes no resourceFromRequest, which is what main.ts does
    // when the variable is set.
    const res = await withHost(
      (server.address() as AddressInfo).port,
      '/.well-known/oauth-protected-resource',
      'somewhere.else:9999',
    )
    expect((JSON.parse(res.body) as { resource: string }).resource).toBe('https://api.example.test')
  })

  it('initialize is answered and establishes no session', async () => {
    // This test used to assert `initialize` answers 404, on the stated grounds
    // that "the 2026-07-28 revision has no initialize". That is simply untrue —
    // `initialize` is in every revision — and the belief was load-bearing: it
    // is why the handshake was never built and why no client could connect. A
    // test can hold a bug in place as firmly as any code, and this one did.
    //
    // The property that was actually worth protecting is the second line, and
    // it still holds: the transport is stateless, so no session id comes back
    // and nothing about this request is kept. If `Mcp-Session-Id` ever appears
    // here, state has crept in and the round-robin deployment stops being safe.
    const res = await rpc('initialize', {}, ORG_A)
    expect(res.status).toBe(200)
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
