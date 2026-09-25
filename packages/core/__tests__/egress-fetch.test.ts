import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { egressFetch, EgressRefused, publicOnlyLookup, type LookupAll } from '../egress-fetch.js'

/**
 * The guard is at connect time, so these connect.
 *
 * A server on loopback stands in for everything a tenant must not reach — the
 * metadata endpoint, the API, the vector store — and a resolver seam stands in
 * for DNS, so a name can answer one way to a check and another to the socket.
 * What is asserted is that the socket never opens: the server counts requests.
 */
let server: Server
let port = 0
let hits = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/` }).end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const answering =
  (...addresses: string[]): LookupAll =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))

describe('egressFetch', () => {
  it('refuses a name that resolves to loopback, without opening a socket', async () => {
    const before = hits
    await expect(
      egressFetch(`http://embedder.example.com:${port}/`, {}, { trustedOrigins: [], lookupAll: answering('127.0.0.1') }),
    ).rejects.toBeInstanceOf(EgressRefused)
    expect(hits).toBe(before)
  })

  it('refuses a rebinding name: public to the first answer, private to the connect', async () => {
    // What a create-time check sees and what the socket gets are two lookups;
    // here they are one, so the private answer is the one judged.
    let calls = 0
    const rebinding: LookupAll = async () => {
      calls += 1
      return [{ address: calls === 1 ? '127.0.0.1' : '93.184.216.34', family: 4 }]
    }
    const before = hits
    await expect(
      egressFetch(`http://rebind.example.com:${port}/`, {}, { trustedOrigins: [], lookupAll: rebinding }),
    ).rejects.toBeInstanceOf(EgressRefused)
    expect(hits).toBe(before)
  })

  it('refuses when one of several answers is private', async () => {
    await expect(
      egressFetch(`http://mixed.example.com:${port}/`, {}, {
        trustedOrigins: [],
        lookupAll: answering('93.184.216.34', '127.0.0.1'),
      }),
    ).rejects.toBeInstanceOf(EgressRefused)
  })

  it('refuses IP literals in every spelling the URL parser normalises', async () => {
    const before = hits
    for (const host of ['127.0.0.1', '2130706433', '0x7f.0.0.1', '0177.0.0.1', '[::1]', '[::ffff:7f00:1]']) {
      await expect(
        egressFetch(`http://${host}:${port}/`, {}, { trustedOrigins: [] }),
        host,
      ).rejects.toBeInstanceOf(EgressRefused)
    }
    expect(hits).toBe(before)
  })

  it('fetches a trusted origin as written, although it is internal', async () => {
    const origin = `http://127.0.0.1:${port}`
    const response = await egressFetch(`${origin}/embeddings`, { method: 'POST', body: '{}' }, { trustedOrigins: [origin] })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })

  it('refuses a redirect even from a trusted origin', async () => {
    const origin = `http://127.0.0.1:${port}`
    await expect(egressFetch(`${origin}/redirect`, {}, { trustedOrigins: [origin] })).rejects.toThrow()
  })

  it('refuses a non-http scheme', async () => {
    await expect(egressFetch('file:///etc/passwd', {}, { trustedOrigins: [] })).rejects.toThrow(/only http/)
  })
})

describe('publicOnlyLookup', () => {
  const lookup = (resolver: LookupAll, options: object) =>
    new Promise<{ error: Error | null; address: unknown; family?: number }>((resolve) => {
      publicOnlyLookup(resolver)('host.example.com', options as never, ((error: Error | null, address: unknown, family?: number) =>
        resolve({ error, address, ...(family === undefined ? {} : { family }) })) as never)
    })

  it('hands the socket the address it judged', async () => {
    expect(await lookup(answering('93.184.216.34'), {})).toEqual({ error: null, address: '93.184.216.34', family: 4 })
  })

  it('answers the all:true form net.connect uses for happy eyeballs', async () => {
    const result = await lookup(answering('93.184.216.34', '2606:4700:4700::1111'), { all: true })
    expect(result.error).toBeNull()
    expect(result.address).toHaveLength(2)
  })

  it('honours the requested family', async () => {
    const result = await lookup(answering('93.184.216.34', '2606:4700:4700::1111'), { family: 6 })
    expect(result.address).toBe('2606:4700:4700::1111')
  })

  it('refuses a private answer by name', async () => {
    const result = await lookup(answering('169.254.169.254'), {})
    expect(result.error).toBeInstanceOf(EgressRefused)
    expect(result.error?.message).toContain('169.254.169.254')
  })
})
