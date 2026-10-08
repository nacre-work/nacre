import { existsSync, readFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AuthContext } from '@nacre.work/api'
import { protectedResourceMetadata } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { VIEWS, viewUri } from '../factory.js'
import { createMcpServer, type McpOptions } from '../server.js'

/**
 * The MCP App views, on the wire.
 *
 * A host that renders MCP Apps finds a view by the `_meta.ui.resourceUri` on
 * a tool, lists it under `resources/list` with the extension's media type,
 * reads its HTML with `resources/read` and shows it in a sandboxed iframe
 * whose CSP is what the resource's `_meta.ui.csp` says. Every one of those is
 * a question about bytes this server sends, so they are asked of the real
 * transport — with the SDK's client, and with raw frames where the client
 * normalises what is being asserted.
 *
 * What is **not** asked here is whether a host renders the result: there is no
 * host in this suite, and a stub host would agree with whatever it was written
 * to. The views' own code is type-checked against the DOM and bundled by the
 * package build, and the bundle is what `resources/read` returns.
 */

const KEY = 'nacre_sk_' + 'v'.repeat(32)
const auth: AuthContext = { orgId: 'o', principal: { type: 'service_account', id: 'agent' }, role: 'member' }
const API = 'https://api.example.test'
const ENVELOPE = (ui: boolean) => ({
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'apps', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': ui ? { extensions: { 'io.modelcontextprotocol/ui': {} } } : {},
})

const options = (apiOrigin: string | undefined): McpOptions => ({
  verify: {
    key: new TextEncoder().encode('k'.repeat(32)),
    issuer: 'https://api.nacre.test',
    audience: 'nacre',
    serviceKeys: { resolve: async (key) => (key === KEY ? auth : undefined) },
  },
  resourceMetadataUrl: 'https://mcp.nacre.test/.well-known/oauth-protected-resource',
  resourceMetadata: protectedResourceMetadata({ canonicalUrl: 'https://mcp.nacre.test' }),
  layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
  tools: { call: async () => ({ ok: true }) },
  ...(apiOrigin === undefined ? {} : { apiOrigin }),
})

let server: Server
let url: URL

beforeAll(async () => {
  server = createMcpServer(options(API))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function raw(method: string, params: Record<string, unknown>, ui: boolean): Promise<Record<string, unknown>> {
  const name = params.name ?? params.uri
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      ...(typeof name === 'string' ? { 'mcp-name': name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: ENVELOPE(ui) } }),
  })
  const body = (await res.json()) as { result?: Record<string, unknown>; error?: unknown }
  if (body.result === undefined) throw new Error(`${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

describe('the MCP App views', () => {
  it('are built', () => {
    for (const view of VIEWS) {
      const at = new URL(`../../apps/build/${view}.html`, import.meta.url)
      expect(existsSync(at), `${view}.html — run the package build`).toBe(true)
      const html = readFileSync(at, 'utf8')
      expect(html).toContain('<script>')
      // Self-contained: the host's sandbox loads no script from anywhere.
      expect(html).not.toMatch(/<script[^>]+src=/)
    }
  })

  it('are listed with the extension media type, and read back as HTML', async () => {
    const client = new Client({ name: 'apps', version: '0' }, { versionNegotiation: { mode: 'auto' } })
    await client.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }),
    )
    try {
      const listed = await client.listResources()
      expect(listed.resources.map((r) => r.uri).sort()).toEqual(VIEWS.map(viewUri).sort())
      for (const resource of listed.resources) expect(resource.mimeType).toBe('text/html;profile=mcp-app')

      const read = await client.readResource({ uri: viewUri('search') })
      const content = read.contents[0] as { mimeType?: string; text?: string }
      expect(content.mimeType).toBe('text/html;profile=mcp-app')
      expect(content.text).toContain('<!doctype html>')
    } finally {
      await client.close()
    }
  })

  it('the upload view may reach the API and the others may reach nothing', async () => {
    // Asked raw: the resource list's `_meta` is what a host reviews at
    // connection time, and the client would validate rather than echo it.
    const listed = (await raw('resources/list', {}, true)) as {
      resources: { uri: string; _meta?: { ui?: { csp?: { connectDomains?: string[] } } } }[]
    }
    const csp = (view: string) => listed.resources.find((r) => r.uri === viewUri(view as 'upload'))?._meta?.ui?.csp
    expect(csp('upload')?.connectDomains).toEqual([API])
    expect(csp('search')?.connectDomains).toEqual([])
    expect(csp('layers')?.connectDomains).toEqual([])
  })

  it('search and list_layers carry their view, under both keys', async () => {
    const listed = (await raw('tools/list', {}, true)) as {
      tools: { name: string; _meta?: Record<string, unknown> }[]
    }
    const meta = (name: string) => listed.tools.find((t) => t.name === name)?._meta
    expect((meta('search')?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(viewUri('search'))
    expect(meta('search')?.['ui/resourceUri']).toBe(viewUri('search'))
    expect((meta('list_layers')?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(viewUri('layers'))
    expect((meta('upload_file')?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(viewUri('upload'))
    expect(meta('ingest_document')).toBeUndefined()
  })

  it('offers upload_file to a client that renders apps, and not to one that said it cannot', async () => {
    const names = async (ui: boolean) =>
      ((await raw('tools/list', {}, ui)) as { tools: { name: string }[] }).tools.map((t) => t.name)
    expect(await names(true)).toContain('upload_file')
    expect(await names(false)).not.toContain('upload_file')
    // Everything else is the same catalog either way.
    expect((await names(true)).filter((n) => n !== 'upload_file')).toEqual(await names(false))

    // A legacy client says nothing per request, and the hosts rendering apps
    // today are legacy clients: unknown is offered.
    const legacy = new Client({ name: 'apps', version: '0' })
    await legacy.connect(
      new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }),
    )
    try {
      expect((await legacy.listTools()).tools.map((t) => t.name)).toContain('upload_file')
    } finally {
      await legacy.close()
    }
  })

  it('a deployment that named no API origin serves no view and offers no panel', async () => {
    const bare = createMcpServer(options(undefined))
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    const at = new URL(`http://127.0.0.1:${(bare.address() as AddressInfo).port}/mcp`)
    const client = new Client({ name: 'apps', version: '0' }, { versionNegotiation: { mode: 'auto' } })
    await client.connect(
      new StreamableHTTPClientTransport(at, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }),
    )
    try {
      expect((await client.listResources()).resources).toEqual([])
      const tools = await client.listTools()
      expect(tools.tools.map((t) => t.name)).not.toContain('upload_file')
      expect(tools.tools.find((t) => t.name === 'search')?._meta).toBeUndefined()
    } finally {
      await client.close()
      await new Promise<void>((resolve) => bare.close(() => resolve()))
    }
  })
})
