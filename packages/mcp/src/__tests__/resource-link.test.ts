import type { AuthContext } from '@nacre.work/api'
import { describe, expect, it } from 'vitest'

import { buildServer } from '../factory.js'
import { InMemoryTransport } from '@modelcontextprotocol/server'
import { Client } from '@modelcontextprotocol/client'

/**
 * `get_document` links the original bytes.
 *
 * Where a document has a presigned `source_url`, the result carries a
 * `resource_link` block beside the JSON — the revision's way of saying "the
 * result is somewhere else", which a client fetches directly. Only there:
 * `search` carries none, and a document without an object carries none.
 */

const auth: AuthContext = { orgId: 'o', principal: { type: 'user', id: 'u' }, role: 'member' }

async function client(answer: unknown): Promise<Client> {
  const server = await buildServer({
    auth,
    requestId: () => 'r',
    layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
    tools: { call: async () => answer },
  })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  const c = new Client({ name: 'link', version: '0' })
  await c.connect(clientSide)
  return c
}

describe('resource_link on get_document', () => {
  it('is there with a source_url, named after the document', async () => {
    const c = await client({ document_id: 'd1', title: 'Q3 plan', source_url: 'https://bucket.example/q3?sig=x' })
    try {
      const result = await c.callTool({ name: 'get_document', arguments: { document_id: 'd1' } })
      const content = result.content as { type: string; uri?: string; name?: string; text?: string }[]
      expect(content.map((b) => b.type)).toEqual(['text', 'resource_link'])
      expect(content[1]).toMatchObject({ uri: 'https://bucket.example/q3?sig=x', name: 'Q3 plan' })
      // The JSON stays whole for a client that reads nothing else.
      expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ source_url: 'https://bucket.example/q3?sig=x' })
    } finally {
      await c.close()
    }
  })

  it('is absent without one, and absent on every other tool', async () => {
    const c = await client({ document_id: 'd1', title: 'inline', source_url: undefined })
    try {
      const got = await c.callTool({ name: 'get_document', arguments: { document_id: 'd1' } })
      expect((got.content as { type: string }[]).map((b) => b.type)).toEqual(['text'])
    } finally {
      await c.close()
    }
    const s = await client([{ doc_id: 'd1', source_url: 'https://bucket.example/leak' }])
    try {
      const got = await s.callTool({ name: 'search', arguments: { query: 'x' } })
      expect((got.content as { type: string }[]).map((b) => b.type)).toEqual(['text'])
    } finally {
      await s.close()
    }
  })
})
