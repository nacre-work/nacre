import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HttpEmbedder } from '../adapters.js'

/**
 * The search path's embedder, reached through `pool` the way a tenant's layer
 * reaches it.
 *
 * A server on loopback stands in for everything internal. A tenant's provider
 * naming it is refused before a socket opens — which is what a row written
 * before the create-time guard existed, or one whose name has since rebound,
 * looks like by the time it is used. The installation's own embedder at the
 * same address is fetched, because that is the arrangement every Compose
 * profile ships.
 */
let server: Server
let origin = ''
let hits = 0

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits += 1
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('HttpEmbedder.pool', () => {
  it("refuses a tenant's provider that names an internal address, without connecting", async () => {
    const embedderFor = HttpEmbedder.pool(1000, 32, [])
    const before = hits
    await expect(
      embedderFor({ id: 'tenant', endpoint: origin, model: 'm', dimensions: 2, operatorOrigins: [] }).embed(['q']),
    ).rejects.toThrow(/not a public address/)
    expect(hits).toBe(before)
  })

  it("fetches the installation's own embedder as written", async () => {
    const embedderFor = HttpEmbedder.pool(1000, 32, [])
    const vectors = await embedderFor({
      id: 'global',
      endpoint: origin,
      model: 'm',
      dimensions: 2,
      operatorOrigins: [origin],
    }).embed(['q'])
    expect(vectors).toEqual([[0.1, 0.2]])
  })

  it('fetches an origin in NACRE_EMBED_ALLOWED_HOSTS', async () => {
    const embedderFor = HttpEmbedder.pool(1000, 32, [origin])
    const vectors = await embedderFor({ id: 'allowed', endpoint: origin, model: 'm', dimensions: 2, operatorOrigins: [] }).embed(['q'])
    expect(vectors).toEqual([[0.1, 0.2]])
  })
})
