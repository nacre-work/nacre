import { Readable } from 'node:stream'

import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthContext } from '@nacre.work/api'
import { LEGACY_PROTOCOL_VERSIONS, PROTOCOL_VERSION, serveStdio } from '@nacre.work/mcp'
import type { Layer } from '@nacre.work/mcp'

/**
 * The local transport.
 *
 * docs/mcp.md: "local mode gets no relaxation of any kind". That sentence is
 * the only thing standing between a developer agent on a laptop and a surface
 * that quietly answers more than the HTTP one — and a second transport is
 * exactly where such a relaxation gets added by accident, because it looks like
 * a convenience rather than a permission change.
 *
 * What is checked here is that this transport reaches the same catalog and the
 * same tools, refuses a key that does not verify, and puts nothing but protocol
 * frames on stdout.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const ORG = '11111111-1111-1111-1111-111111111111'

const LAYERS: readonly Layer[] = [
  { id: 'l1', slug: 'handbook', name: 'Handbook', description: 'Onboarding', documentCount: 3 },
]

const verify = { key: SECRET, issuer: ISSUER, audience: AUDIENCE }

async function serviceKey(overrides: { issuer?: string; audience?: string } = {}): Promise<string> {
  return new SignJWT({ org: ORG, principal_type: 'service_account', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('agent-1')
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

interface Frame {
  readonly id?: number | null
  readonly result?: Record<string, unknown>
  readonly error?: { code: number; message: string }
}

let written: string[]
let stdout: typeof process.stdout.write
let calls: { name: string; auth: AuthContext }[]

const ports = () => ({
  layers: {
    forCaller: async (_auth: unknown, page: { limit: number }) => ({
      layers: LAYERS.slice(0, page.limit),
      nextCursor: null,
    }),
  },
  tools: {
    call: async (name: string, args: Record<string, unknown>, auth: AuthContext) => {
      calls.push({ name, auth })
      if (name === 'get_document') throw new Error('not found')
      return { ok: true, args }
    },
  },
})

/** The modern-era envelope, as the HTTP suite spells it. */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'stdio-surface', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

/** A modern-era frame: the method, its params, and the envelope in `_meta`. */
function modern(method: string, params: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } })
}

/** A legacy client's opening frame, whole — the schema requires all three. */
function initialize(protocolVersion: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'stdio-surface', version: '0' } },
  })
}

/** Feed lines in, collect the frames that come back out. */
async function exchange(lines: readonly string[], key: string): Promise<Frame[]> {
  await serveStdio({
    verify,
    serviceKey: key,
    input: Readable.from(lines.map((l) => `${l}\n`)),
    ...ports(),
  })
  return written.filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as Frame)
}

describe('baseline · the MCP local transport', () => {
  beforeEach(() => {
    written = []
    calls = []
    stdout = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
  })

  afterEach(() => {
    process.stdout.write = stdout
  })

  it('a key that does not verify refuses to serve at all', async () => {
    for (const bad of [
      'not-a-token',
      await serviceKey({ issuer: 'https://not-us.test' }),
      await serviceKey({ audience: 'somebody-else' }),
    ]) {
      await expect(
        serveStdio({ verify, serviceKey: bad, input: Readable.from([]), ...ports() }),
      ).rejects.toThrow(/did not verify/)
    }
  })

  it('initialize negotiates rather than announcing', async () => {
    // This asserted `2026-07-28` for any request at all, which is what the
    // handler did: it answered the newest revision unconditionally. A client
    // proposing the newest one *it* knows was told about a revision it has
    // never heard of and gave up before reaching a tool — the same defect the
    // HTTP transport had, one step further along, because here there was not
    // even a proposal being read.
    //
    // The whole `InitializeRequest`, because the SDK holds the frame to the
    // schema and `capabilities` and `clientInfo` are required in it — the
    // hand-written dispatcher this replaced answered a bare `protocolVersion`,
    // which no client sends. A fixture written to the old code's leniency is a
    // fixture written to match the code.
    const [echoed] = await exchange([initialize('2025-11-25')], await serviceKey())
    expect((echoed?.result as { protocolVersion?: string })?.protocolVersion).toBe('2025-11-25')

    // And a proposal this server cannot speak gets the newest **legacy**
    // revision back, because `initialize` is by definition a legacy client and
    // that generation cannot fall forward.
    const [offered] = await exchange([initialize('1999-01-01')], await serviceKey())
    const agreed = (offered?.result as { protocolVersion?: string })?.protocolVersion
    expect(agreed).toBe(LEGACY_PROTOCOL_VERSIONS[0])
    expect(agreed).not.toBe(PROTOCOL_VERSION)
  })

  it('server/discover answers on stdio too', async () => {
    // On stdio this is also the era probe: a dual-era client sends it first,
    // and a server that answers `-32601` reads as legacy and gets served an
    // older revision than it had to be. The probe carries the modern
    // envelope — that is what makes it a probe: the SDK routes a frame by
    // its `_meta`, and one without it is a legacy frame, which the legacy
    // server rightly answers `-32601` for a method that revision lacks.
    const [frame] = await exchange(
      [modern('server/discover', {})],
      await serviceKey(),
    )
    const result = frame?.result as { resultType?: string; supportedVersions?: string[] }
    expect(result?.resultType).toBe('complete')
    // The modern revisions only, as over HTTP: a client asking
    // `server/discover` is modern by construction, and the legacy list is
    // what `initialize` negotiates from. The parity suite compares the two
    // transports' whole result; this pins the one value a stdio client reads.
    expect(result?.supportedVersions).toEqual([PROTOCOL_VERSION])
  })

  it('tools/list is the same catalog the HTTP surface builds', async () => {
    const [frame] = await exchange(['{"jsonrpc":"2.0","id":2,"method":"tools/list"}'], await serviceKey())
    const tools = (frame?.result as { tools?: { name: string; description: string }[] })?.tools ?? []

    expect(tools.map((t) => t.name)).toContain('search')
    // Generated from the caller's own layers, exactly as over HTTP. A local
    // transport that listed every layer would be handing an agent the names of
    // things it may not read, which is permission data.
    expect(tools.find((t) => t.name === 'search')?.description).toContain('Handbook')
  })

  it('a tool call carries the token’s organization and nothing else', async () => {
    await exchange(
      ['{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}'],
      await serviceKey(),
    )

    // Invariant I1 on a transport with no per-request headers to take it from.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.auth.orgId).toBe(ORG)
    expect(calls[0]?.auth.principal.type).toBe('service_account')
  })

  it('a successful call answers with a CallToolResult', async () => {
    const [frame] = await exchange(
      ['{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{"query":"x"}}}'],
      await serviceKey(),
    )
    const result = frame?.result as { content?: { type: string }[]; isError?: boolean }

    expect(Array.isArray(result?.content)).toBe(true)
    expect(result?.isError).toBe(false)
  })

  it('the input schema is enforced on the local transport too', async () => {
    // `query` is required. This used to reach the tool with `{}` and answer
    // `isError: false`, because nothing validated arguments on this path — a
    // relaxation of exactly the kind the header above says the local surface
    // must not have. The SDK holds every call to the tool's own schema now,
    // on both transports, and the refusal is a result rather than a JSON-RPC
    // error: the call was well-formed, the arguments were not.
    const [frame] = await exchange(
      ['{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{}}}'],
      await serviceKey(),
    )
    const result = frame?.result as { content?: { type: string; text?: string }[]; isError?: boolean }
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toContain('query')
    expect(calls).toHaveLength(0)
  })

  it('a failing tool and an unknown tool answer identically', async () => {
    const key = await serviceKey()
    const [failing] = await exchange(
      ['{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_document","arguments":{"document_id":"x"}}}'],
      key,
    )
    written = []
    const [unknown] = await exchange(
      ['{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"no_such_tool","arguments":{}}}'],
      key,
    )

    // T8 on this transport, and the same answer the HTTP suite pins. A tool
    // that fails on what is stored answers "Not found" and nothing about which
    // — a missing document and one the caller may not read are the same
    // bytes. An unknown tool is the SDK's `-32602` naming the tool the caller
    // asked for and nothing else; that is not a leak, because every caller
    // sees every tool *name* (only `search`'s description is per caller), so
    // saying a name is not in the catalog tells the caller what `tools/list`
    // already did. What must never appear in either is a layer's name.
    const result = failing?.result as { content?: { text?: string }[]; isError?: boolean }
    expect(result?.isError).toBe(true)
    expect(result?.content?.[0]?.text).toBe('Not found')
    expect(failing?.error).toBeUndefined()

    expect(unknown?.error?.code).toBe(-32602)
    expect(unknown?.error?.message).toContain('no_such_tool')
    for (const frame of [failing, unknown]) {
      expect(JSON.stringify(frame)).not.toContain('Handbook')
    }
  })

  it('a notification is not answered', async () => {
    const frames = await exchange(
      ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
      await serviceKey(),
    )
    // JSON-RPC: no id, no reply. A frame the client did not ask for desynchronises
    // everything after it, since responses are matched by position in practice.
    expect(frames).toHaveLength(0)
  })

  it('malformed input is dropped without killing the session', async () => {
    const frames = await exchange(
      ['not json at all', '{"jsonrpc":"2.0","id":7,"method":"ping"}'],
      await serviceKey(),
    )

    // Dropped, and deliberately not answered `-32700`. This asserted a parse
    // error frame first, which the hand-written transport wrote with
    // `id: null` — and MCP says a response id MUST NOT be null, so that frame
    // was itself not an MCP message, written to a stream the header above
    // promises carries nothing else. There is no id to answer on, so there is
    // nothing to write; the SDK's reader skips the line and reads on.
    expect(frames).toHaveLength(1)
    // The session survives: an agent that sends one bad frame should not have
    // to reconnect, and a transport that exits here looks like a crash.
    expect(frames[0]?.id).toBe(7)
    expect(frames[0]?.error).toBeUndefined()
  })

  it('stdout carries protocol frames and nothing else', async () => {
    await exchange(
      ['{"jsonrpc":"2.0","id":8,"method":"tools/list"}', '   ', '{"jsonrpc":"2.0","id":9,"method":"ping"}'],
      await serviceKey(),
    )

    // Every line has to parse. One stray log line in the middle of the stream
    // and the client fails on a frame nobody sent — the classic STDIO bug, and
    // invisible unless something asserts it.
    for (const line of written) {
      if (line.trim().length === 0) continue
      expect(() => JSON.parse(line) as unknown, `not a frame: ${line}`).not.toThrow()
    }
  })
})
