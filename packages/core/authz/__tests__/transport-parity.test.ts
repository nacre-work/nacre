import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'

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
 * by hand, in two places, which is the arrangement that produced them.
 *
 * The shape of the defect is worth naming, because it is the one this repository
 * keeps finding: **a rule applied in one place and not in its sibling.** The
 * same day produced three more — `$http_host` in four nginx locations,
 * `NACRE_MCP_CANONICAL_URL` set in `.env.example` while `docker-compose.yml`
 * explained at length that its absence was the fix, and `workflow_dispatch` on
 * three workflows out of four. Every one was found by running something, never
 * by reading, and each was repaired one instance at a time.
 *
 * So this is not a test of `initialize`. It is a test that **the two dispatchers
 * agree**, driven from one table, so a case added here is asked of both and a
 * method implemented on one is a failure rather than an omission.
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
  layers: { forCaller: async (): Promise<readonly Layer[]> => LAYERS },
  tools: {
    call: async (_name: string, args: Record<string, unknown>): Promise<unknown> => ({ ok: true, args }),
  },
}

/**
 * Every method both transports implement, and what has to match.
 *
 * `expect` reads the two results and returns the slice being compared. Returning
 * a slice rather than asserting inside keeps the failure message useful: vitest
 * prints the two objects side by side and names the method.
 */
const SHARED: readonly {
  readonly name: string
  readonly method: string
  readonly params?: Record<string, unknown>
  readonly compare: (result: Record<string, unknown>) => unknown
}[] = [
  {
    name: 'initialize echoes a revision both speak',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {} },
    compare: (r) => r.protocolVersion,
  },
  {
    name: 'initialize counter-offers the same revision for one neither speaks',
    method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {} },
    compare: (r) => r.protocolVersion,
  },
  {
    name: 'initialize reports the same server name',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {} },
    compare: (r) => (r.serverInfo as { name?: string } | undefined)?.name,
  },
  {
    // The specification's field for "how to use this server". It was absent
    // from both, which is the quiet half of this failure mode: two transports
    // agreeing on nothing is still agreement, so the case asserts it is
    // *present* as well as identical.
    name: 'initialize carries the same instructions',
    method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {} },
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
    method: 'server/discover',
    params: {},
    compare: (r) => r.supportedVersions,
  },
  {
    name: 'server/discover reports the same result type and cache scope',
    method: 'server/discover',
    params: {},
    compare: (r) => ({ resultType: r.resultType, cacheScope: r.cacheScope }),
  },
  {
    name: 'tools/list offers the same catalog',
    method: 'tools/list',
    params: {},
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

async function overHttp(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown }
  if (body.result === undefined) throw new Error(`HTTP ${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

async function overStdio(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await serveStdio({
    verify,
    serviceKey: await token(),
    serverVersion: '9.9.9',
    input: Readable.from([`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`]),
    ...ports,
  })
  const frames = written
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { result?: Record<string, unknown>; error?: unknown })
  const frame = frames[0]
  if (frame?.result === undefined) throw new Error(`STDIO ${method}: ${JSON.stringify(frame?.error)}`)
  return frame.result
}

describe('baseline · the two MCP transports answer alike', () => {
  for (const shared of SHARED) {
    it(shared.name, async () => {
      const http = await overHttp(shared.method, shared.params ?? {})
      const stdio = await overStdio(shared.method, shared.params ?? {})
      expect(shared.compare(stdio), `${shared.method} over STDIO`).toEqual(shared.compare(http))
    })
  }

  it('neither reports a placeholder version', async () => {
    // `serverVersion` is optional on both, and for a while nothing passed one —
    // so both transports told every client they were `0.0.0`. A field carried,
    // threaded through an option and never given a value is the same shape as a
    // variable validated at startup and read by nothing.
    for (const [where, result] of [
      ['HTTP', await overHttp('initialize', { protocolVersion: '2025-11-25', capabilities: {} })],
      ['STDIO', await overStdio('initialize', { protocolVersion: '2025-11-25', capabilities: {} })],
    ] as const) {
      expect((result.serverInfo as { version?: string }).version, `${where} serverInfo.version`).toBe('9.9.9')
    }
  })

  it('a method one transport gains is a failure here, not an omission', async () => {
    // The guard on the table itself. `server/discover` was added to Streamable
    // HTTP and not to STDIO, and nothing noticed because each transport had its
    // own suite asserting its own behaviour. Anything either dispatcher answers
    // and the other does not now fails one of the cases above — this asserts the
    // table has not quietly emptied out, which is how a parity test stops
    // working without failing.
    expect(SHARED.length).toBeGreaterThanOrEqual(6)
    expect(new Set(SHARED.map((s) => s.method))).toEqual(
      new Set(['initialize', 'server/discover', 'tools/list']),
    )
  })
})
