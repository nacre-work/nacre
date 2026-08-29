import { Readable } from 'node:stream'

import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AuthContext } from '@nacre.work/api'
import { LEGACY_PROTOCOL_VERSIONS, PROTOCOL_VERSION, PROTOCOL_VERSIONS, serveStdio } from '@nacre.work/mcp'
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
    const [echoed] = await exchange(
      ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'],
      await serviceKey(),
    )
    expect((echoed?.result as { protocolVersion?: string })?.protocolVersion).toBe('2025-11-25')

    // And a proposal this server cannot speak gets the newest **legacy**
    // revision back, because `initialize` is by definition a legacy client and
    // that generation cannot fall forward.
    const [offered] = await exchange(
      ['{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}'],
      await serviceKey(),
    )
    const agreed = (offered?.result as { protocolVersion?: string })?.protocolVersion
    expect(agreed).toBe(LEGACY_PROTOCOL_VERSIONS[0])
    expect(agreed).not.toBe(PROTOCOL_VERSION)
  })

  it('server/discover answers on stdio too', async () => {
    // On stdio this is also the era probe: a dual-era client sends it first,
    // and a server that answers `-32601` reads as legacy and gets served an
    // older revision than it had to be.
    const [frame] = await exchange(
      ['{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{}}'],
      await serviceKey(),
    )
    const result = frame?.result as { resultType?: string; supportedVersions?: string[] }
    expect(result?.resultType).toBe('complete')
    expect(result?.supportedVersions).toEqual([...PROTOCOL_VERSIONS])
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
      ['{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search","arguments":{}}}'],
      await serviceKey(),
    )
    const result = frame?.result as { content?: { type: string }[]; isError?: boolean }

    expect(Array.isArray(result?.content)).toBe(true)
    expect(result?.isError).toBe(false)
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

    // T8 on this transport. Telling them apart says whether a tool — and so a
    // layer — exists, and the local surface must not be the one that leaks it.
    expect(failing?.error).toEqual(unknown?.error)
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

  it('malformed input is reported without killing the session', async () => {
    const frames = await exchange(
      ['not json at all', '{"jsonrpc":"2.0","id":7,"method":"ping"}'],
      await serviceKey(),
    )

    expect(frames[0]?.error?.code).toBe(-32700)
    // The session survives: an agent that sends one bad frame should not have
    // to reconnect, and a transport that exits here looks like a crash.
    expect(frames[1]?.id).toBe(7)
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
