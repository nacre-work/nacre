import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { AuthContext, CeilingValue } from '@nacre.work/api'
import { protectedResourceMetadata } from '@nacre.work/core'
import { afterEach, describe, expect, it } from 'vitest'

import { createMcpServer } from '../server.js'
import { catalog } from '../tools.js'

/**
 * The catalog a delegated connection is offered, against its ceiling.
 *
 * A person who approves a read-only connection has approved a search client.
 * Until 0.29.2 that client was listed `delete_document`, `ingest_document` and
 * `update_skill` anyway, and refused each on every call — so the catalog said
 * the client may do what the person said it may not, and the public stand's
 * own page described a "not offered" marker that the server never produced.
 *
 * Asked over the real transport with the SDK's client, because the claim is
 * about what `tools/list` answers and not about a helper: a filter applied in a
 * function the dispatcher does not call would pass a test of the function.
 *
 * Two directions, because each is a way to be wrong. A tool the ceiling admits
 * must still be listed — hiding `search` from a read-only client is a broken
 * client — and a principal with no ceiling at all, a service account or a
 * person's own token, is listed everything: their reach moves with grants
 * between calls, and a catalog listed once per session must not freeze it.
 */

const KEY = 'nacre_sk_' + 'c'.repeat(32)
const API = 'https://api.example.test'

let server: Server | undefined

afterEach(async () => {
  if (server !== undefined) await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = undefined
})

async function listed(auth: AuthContext): Promise<string[]> {
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
    tools: { call: async () => ({ ok: true }) },
    apiOrigin: API,
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`)
  const client = new Client({ name: 'ceiling', version: '0' }, { versionNegotiation: { mode: 'auto' } })
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}` } } }))
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort()
  } finally {
    await client.close()
  }
}

const person = (
  permissions?: readonly CeilingValue[],
  layers?: readonly { id: string; permissions?: readonly CeilingValue[] }[],
): AuthContext => ({
  orgId: 'o',
  principal: { type: 'user', id: 'u' },
  role: 'member',
  delegation: {
    id: 'connection',
    ...(permissions === undefined ? {} : { permissions }),
    ...(layers === undefined ? {} : { layers }),
  },
})

// `upload_file` is left out of every expectation: this client declares no
// MCP Apps extension, so the panel tool is dropped for a reason of its own,
// which `apps.test.ts` asks.
const needing = (...permissions: string[]): string[] =>
  catalog([])
    .filter((t) => permissions.includes(t.permission) && t.name !== 'upload_file')
    .map((t) => t.name)
    .sort()

describe('a delegated connection is offered the tools its ceiling admits', () => {
  it('lists a read-only connection the read tools and nothing that writes', async () => {
    const names = await listed(person(['read']))
    expect(names).toEqual(needing('read'))
    for (const refused of ['delete_document', 'ingest_document', 'request_upload', 'update_skill']) {
      expect(names, `a read-only connection is offered ${refused}`).not.toContain(refused)
    }
  })

  it('lists a write-only connection the write tools and not search, because write does not imply read', async () => {
    const names = await listed(person(['write']))
    expect(names).toEqual(needing('write'))
    expect(names).not.toContain('search')
  })

  it('offers update_skill only where the ceiling carries admin', async () => {
    expect(await listed(person(['read', 'write']))).toEqual(needing('read', 'write'))
    expect(await listed(person(['read', 'write', 'admin']))).toContain('update_skill')
  })

  it('offers update_skill where a layer\u2019s ceiling carries skill, and nothing else that resolves admin', async () => {
    // The consent screen's per-layer box. `update_skill` is the one tool it
    // offers, and the catalog says so — the tool resolves `admin` for the
    // person, and is offered by `skill` in the ceiling as well as by `admin`.
    const editing = await listed(person(['read', 'skill'], [{ id: 'L', permissions: ['read', 'skill'] }]))
    expect(editing).toEqual([...needing('read'), 'update_skill'].sort())

    // `{skill}` alone: the skill tool and nothing else, not even search.
    expect(await listed(person(['skill'], [{ id: 'L', permissions: ['skill'] }]))).toEqual(['update_skill'])

    // `skill` in the connection's ceiling and on no layer in its narrowing
    // offers nothing — a tool every call to which would be refused is the
    // noise this filter exists to remove.
    const nowhere = await listed(person(['read', 'skill'], [{ id: 'L', permissions: ['read'] }]))
    expect(nowhere).not.toContain('update_skill')
  })

  it('lists everything to a delegation with no ceiling, and to a principal that is not a delegation', async () => {
    const all = needing('read', 'write', 'admin')
    expect(await listed(person())).toEqual(all)
    expect(
      await listed({ orgId: 'o', principal: { type: 'service_account', id: 'agent' }, role: 'member' }),
    ).toEqual(all)
  })
})
