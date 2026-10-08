import { readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { createMcpServer, serveStdio, type Layer } from '@nacre.work/mcp'
import { SignJWT } from 'jose'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { protectedResourceMetadata, PROTECTED_RESOURCE_PATH } from '../../oauth.js'

/**
 * The two transports answer the same questions the same way.
 *
 * This exists because they did not, twice, in one day, and both defects reached
 * a shipped release. `initialize` negotiated a protocol revision on Streamable
 * HTTP and *announced* one on STDIO, so a local client was handed a version it
 * could not speak and gave up before reaching a tool. `server/discover` — a MUST
 * in the current revision — was added to one and not the other. Both were fixed
 * by hand, in two places, which is the arrangement that produced them. Then
 * `ping` was answered on STDIO and 404'd on Streamable HTTP for the whole life
 * of both, while this file was green — its table guard compared a literal.
 *
 * The shape of the defect is worth naming, because it is the one this repository
 * keeps finding: **a rule applied in one place and not in its sibling.** The
 * repair that finally closed it is structural: both transports are handed the
 * same `McpServer` from one factory (`packages/mcp/src/factory.ts`), and the
 * protocol's results are the SDK's rather than either transport's. A divergence
 * now needs a second factory, which is what the last case here refuses.
 *
 * So this is not a test of `initialize`. It is a test that **the two transports
 * agree**, driven from one table, so a case added here is asked of both and a
 * method answered on one is a failure rather than an omission.
 *
 * What it deliberately does *not* assert is transport mechanics. HTTP
 * authenticates per request, carries mirrored headers and answers `405` on a
 * GET; STDIO authenticates once from `NACRE_SERVICE_KEY` and has no headers at
 * all. Those differences are the transports being different, which is allowed.
 * The dispatch result is the contract, and that is what is compared.
 */

const SECRET = new TextEncoder().encode('c'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const ORG = '33333333-3333-3333-3333-333333333333'

const LAYERS: readonly Layer[] = [
  { id: 'l1', slug: 'handbook', name: 'Handbook', description: 'Onboarding', documentCount: 3 },
]

const verify = { key: SECRET, issuer: ISSUER, audience: AUDIENCE }

const token = async (): Promise<string> =>
  new SignJWT({ org: ORG, principal_type: 'service_account', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('agent-1')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

const ports = {
  layers: {
    forCaller: async (_auth: unknown, page: { limit: number; afterId?: string }) => ({
      layers: LAYERS.slice(0, page.limit),
      nextCursor: LAYERS.length > page.limit ? (LAYERS[page.limit - 1]?.id ?? null) : null,
    }),
  },
  tools: {
    call: async (_name: string, args: Record<string, unknown>): Promise<unknown> => ({ ok: true, args }),
  },
}

/**
 * The 2026-07-28 envelope, which every modern-era request carries in
 * `params._meta`. Both transports classify a request by it: a frame with one
 * is served by the modern era, a frame without one by the legacy era.
 */
const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'parity', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

/**
 * Every method both transports answer, in both eras, and what has to match.
 *
 * `expect` reads the two results and returns the slice being compared. Returning
 * a slice rather than asserting inside keeps the failure message useful: vitest
 * prints the two objects side by side and names the method.
 */
const SHARED: readonly {
  readonly name: string
  readonly era: 'legacy' | 'modern'
  readonly method: string
  readonly params?: Record<string, unknown>
  readonly compare: (result: Record<string, unknown>) => unknown
}[] = [
  {
    name: 'initialize echoes a revision both speak',
    era: 'legacy',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '0' } },
    compare: (r) => r.protocolVersion,
  },
  {
    name: 'initialize counter-offers the same revision for one neither speaks',
    era: 'legacy',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'parity', version: '0' } },
    compare: (r) => r.protocolVersion,
  },
  {
    name: 'initialize reports the same server name',
    era: 'legacy',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '0' } },
    compare: (r) => (r.serverInfo as { name?: string } | undefined)?.name,
  },
  {
    // The specification's field for "how to use this server". It was absent
    // from both, which is the quiet half of this failure mode: two transports
    // agreeing on nothing is still agreement, so the case asserts it is
    // *present* as well as identical.
    name: 'initialize carries the same instructions',
    era: 'legacy',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '0' } },
    compare: (r) => {
      const text = r.instructions
      if (typeof text !== 'string' || text.length === 0) {
        throw new Error('initialize sent no instructions; the field is what a client hands its model')
      }
      return text
    },
  },
  {
    name: 'server/discover advertises the same versions',
    era: 'modern',
    method: 'server/discover',
    compare: (r) => r.supportedVersions,
  },
  {
    name: 'server/discover reports the same result type and cache scope',
    era: 'modern',
    method: 'server/discover',
    compare: (r) => ({ resultType: r.resultType, cacheScope: r.cacheScope }),
  },
  {
    name: 'tools/list offers the same catalog',
    era: 'modern',
    method: 'tools/list',
    // Names *and* the shape of each entry. Comparing names alone let the two
    // transports answer with different objects for the whole life of both:
    // Streamable HTTP stripped the internal `permission` field and STDIO
    // returned it, so a client on one got a member MCP's `Tool` does not
    // define. A parity case that compares a narrow enough projection is a
    // parity case that cannot fail, which is the failure this file exists
    // against — so the keys are part of the comparison.
    compare: (r) => {
      const tools = r.tools as Record<string, unknown>[]
      return {
        names: tools.map((t) => t.name as string).sort(),
        keys: [...new Set(tools.flatMap((t) => Object.keys(t)))].sort(),
      }
    },
  },
  {
    name: 'tools/list offers the same catalog to a legacy client',
    era: 'legacy',
    method: 'tools/list',
    compare: (r) => (r.tools as { name: string }[]).map((t) => t.name).sort(),
  },
  {
    // A MUST-respond for both parties in the legacy revisions, and the
    // divergence the old table guard was built against: STDIO answered `{}`
    // and Streamable HTTP fell through to its 404 arm for the whole life of
    // both — a client's keep-alive dropping the very connection it was
    // checking. 2026-07-28 removed it, so it is a legacy case.
    name: 'ping answers the same object on both',
    era: 'legacy',
    method: 'ping',
    compare: (r) => r,
  },
  {
    // The envelope, whole. Both dispatchers used to build the CallToolResult
    // by hand — two copies of `{ content, isError }` that happened to agree —
    // and each transport's own suite asserted its own copy, which is exactly
    // the arrangement this file exists against. One builder in results.ts
    // now, and this case is what notices a second one appearing.
    name: 'tools/call answers the same envelope',
    era: 'modern',
    method: 'tools/call',
    params: { name: 'list_layers', arguments: {} },
    compare: (r) => r,
  },
  {
    name: 'tools/call answers the same envelope to a legacy client',
    era: 'legacy',
    method: 'tools/call',
    params: { name: 'list_layers', arguments: {} },
    compare: (r) => r,
  },
]

let server: Server
let base: string
let written: string[]
let stdout: typeof process.stdout.write

beforeAll(async () => {
  server = createMcpServer({
    verify: { ...verify, serviceKeys: { resolve: async () => undefined } },
    ...ports,
    serverVersion: '9.9.9',
    resourceMetadataUrl: `https://mcp.nacre.test${PROTECTED_RESOURCE_PATH}`,
    resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.nacre.test' }),
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

beforeEach(() => {
  written = []
  stdout = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stdout.write
})

afterEach(() => {
  process.stdout.write = stdout
})

/** The frame as a client of that era sends it, and the headers HTTP mirrors beside it. */
function framed(
  era: 'legacy' | 'modern',
  method: string,
  params: Record<string, unknown>,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  if (era === 'legacy') return { body: { jsonrpc: '2.0', id: 1, method, params }, headers: {} }
  const name = params.name
  return {
    body: { jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE } },
    headers: {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
  }
}

/**
 * The result with the SDK's per-transport stamp removed.
 *
 * `_meta["io.modelcontextprotocol/serverInfo"]` is written onto every
 * modern-era result by the SDK, and it is the same object on both — so it is
 * compared like everything else and stripped nowhere. Listed here so the next
 * person looking for an exemption knows there still is none.
 */
const whole = (r: Record<string, unknown>): Record<string, unknown> => r

async function overHttp(
  era: 'legacy' | 'modern',
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { body, headers } = framed(era, method, params)
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}`, ...headers },
    body: JSON.stringify(body),
  })
  const answer = (await res.json()) as { result?: Record<string, unknown>; error?: unknown }
  if (answer.result === undefined) throw new Error(`HTTP ${method}: ${JSON.stringify(answer.error)}`)
  return whole(answer.result)
}

async function overStdio(
  era: 'legacy' | 'modern',
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { body } = framed(era, method, params)
  await serveStdio({
    verify,
    serviceKey: await token(),
    serverVersion: '9.9.9',
    input: Readable.from([`${JSON.stringify(body)}\n`]),
    ...ports,
  })
  const frames = written
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { result?: Record<string, unknown>; error?: unknown })
  const frame = frames[0]
  if (frame?.result === undefined) throw new Error(`STDIO ${method}: ${JSON.stringify(frame?.error)}`)
  return whole(frame.result)
}

describe('baseline · the two MCP transports answer alike', () => {
  for (const shared of SHARED) {
    it(`${shared.name} (${shared.era})`, async () => {
      const http = await overHttp(shared.era, shared.method, shared.params ?? {})
      const stdio = await overStdio(shared.era, shared.method, shared.params ?? {})
      expect(shared.compare(stdio), `${shared.method} over STDIO`).toEqual(shared.compare(http))
    })
  }

  /**
   * The whole result, for every method and era in the table.
   *
   * The cases above each compare a *slice*, which is what makes their failures
   * readable — and it is also how two divergences sat here unseen while this
   * file was green. `capabilities` was compared by no case at all, so
   * Streamable HTTP answered `{ tools: {} }` and STDIO
   * `{ tools: { listChanged: false } }`: one server telling two clients two
   * different things about what it supports. And `tools/list` was projected to
   * `r.tools`, so the *wrapper* around it went unasked — HTTP carried `ttlMs`
   * and `cacheScope` and STDIO carried neither.
   *
   * A projection narrow enough is a comparison that cannot fail. So the
   * projections stay for their messages and this asks the question they
   * cannot: **everything, deep, with nothing left out.**
   *
   * A field that must genuinely differ between transports belongs in an
   * exemption here with its reason written beside it. There is none today —
   * these results are the protocol's, and the transport is not one of their
   * inputs.
   */
  for (const { era, method, params } of SHARED) {
    it(`${method} answers with the same object, field for field (${era})`, async () => {
      expect(await overStdio(era, method, params ?? {}), `${method} over STDIO`).toEqual(
        await overHttp(era, method, params ?? {}),
      )
    })
  }

  it('neither reports a placeholder version', async () => {
    // `serverVersion` is optional on both, and for a while nothing passed one —
    // so both transports told every client they were `0.0.0`. A field carried,
    // threaded through an option and never given a value is the same shape as a
    // variable validated at startup and read by nothing.
    const hello = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'parity', version: '0' } }
    for (const [where, result] of [
      ['HTTP', await overHttp('legacy', 'initialize', hello)],
      ['STDIO', await overStdio('legacy', 'initialize', hello)],
    ] as const) {
      expect((result.serverInfo as { version?: string }).version, `${where} serverInfo.version`).toBe('9.9.9')
    }
  })

  it('both transports are built from the one factory, and nothing else registers a tool', () => {
    // The guard on the structure itself. The table above can only ask what
    // somebody wrote into it; what makes a divergence impossible rather than
    // merely untested is that there is one `McpServer` builder and both entry
    // points call it. Its first version read the two dispatch switches' case
    // arms, which was right for two hand-written dispatchers and reads
    // nothing now that there are none — so it asks the thing that replaced
    // them: `buildServer` is imported by both transports, and `registerTool`
    // appears in the factory and nowhere else under `packages/mcp/src`.
    const source = (relative: string): string =>
      readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    const http = source('../../../mcp/src/server.ts')
    const stdio = source('../../../mcp/src/stdio.ts')
    const factory = source('../../../mcp/src/factory.ts')

    expect(http, 'HTTP builds its server from the factory').toMatch(/import \{[^}]*\bbuildServer\b[^}]*\} from '\.\/factory\.js'/)
    expect(stdio, 'STDIO builds its server from the factory').toMatch(/import \{[^}]*\bbuildServer\b[^}]*\} from '\.\/factory\.js'/)
    expect(factory, 'the factory registers the tools').toContain('registerTool(')
    for (const [name, text] of [
      ['server.ts', http],
      ['stdio.ts', stdio],
    ] as const) {
      expect(text, `${name} registers no tool of its own`).not.toContain('registerTool(')
      expect(text, `${name} sets no request handler of its own`).not.toContain('setRequestHandler(')
      expect(text, `${name} builds no McpServer of its own`).not.toMatch(/new McpServer\(/)
    }
    expect(SHARED.length).toBeGreaterThanOrEqual(10)
  })
})
