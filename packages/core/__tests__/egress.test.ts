import { describe, expect, it } from 'vitest'

import { admitEmbeddingEndpoint, endpointOrigin, isGlobalAddress } from '../egress.js'

/**
 * The egress guard on a tenant-supplied embedder endpoint.
 *
 * The worker POSTs document text to whatever `POST /v1/embedding-providers`
 * stored, so being wrong here is an exfiltration channel: an `org_admin` naming
 * `http://169.254.169.254/…` and reading the cloud metadata back as a search
 * result. The addresses that matter are pinned as literals, because a range
 * table is the thing that gets an entry missed — the parser's own header says
 * so, and this is that guard on the other surface.
 *
 * No network: the resolver is a seam, and every case that turns on DNS hands it
 * a fixed answer. The one thing a real resolver would add — that a public name
 * can answer with a private address — is exactly what the seam lets us assert.
 */

/** A resolver that answers from a fixed map, the shape `dns.lookup({all:true})`
 * returns. An unlisted host throws, like a name that does not resolve. */
function resolvesTo(map: Record<string, string[]>) {
  return async (host: string) => {
    const addresses = map[host]
    if (addresses === undefined) throw new Error('ENOTFOUND')
    return addresses.map((address) => ({ address }))
  }
}

const CONFIGURED = ['http://embedder', 'http://embedding-adapter']

describe('isGlobalAddress', () => {
  it('refuses the addresses a tenant must never reach', () => {
    for (const addr of [
      '169.254.169.254', // the cloud metadata endpoint — the whole point
      '127.0.0.1',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '::1',
      'fe80::1', // link-local
      'fc00::1', // unique-local
      'fd12:3456::1',
      '::ffff:169.254.169.254', // the metadata endpoint, IPv4-mapped
      '::ffff:10.0.0.1',
    ]) {
      expect(isGlobalAddress(addr), addr).toBe(false)
    }
  })

  it('admits genuinely public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.15.0.1', '172.32.0.1']) {
      expect(isGlobalAddress(addr), addr).toBe(true)
    }
  })
})

describe('endpointOrigin', () => {
  it('drops the default port, so http://embedder:80 and http://embedder agree', () => {
    expect(endpointOrigin('http://embedder:80')).toBe('http://embedder')
    expect(endpointOrigin('http://embedder')).toBe('http://embedder')
    expect(endpointOrigin('https://api.example.com:443/v1')).toBe('https://api.example.com')
  })

  it('rejects what is not an http(s) URL', () => {
    expect(endpointOrigin('minio:9000')).toBeUndefined() // scheme minio:, empty host
    expect(endpointOrigin('not a url')).toBeUndefined()
    expect(endpointOrigin('file:///etc/passwd')).toBeUndefined()
  })
})

describe('admitEmbeddingEndpoint', () => {
  it('admits the configured internal embedder as written, whatever it resolves to', async () => {
    // The operator named it; refusing it would refuse every Compose profile.
    // Its resolver is not even consulted, which is why this passes with an empty
    // map.
    expect(
      await admitEmbeddingEndpoint('http://embedder:80', CONFIGURED, resolvesTo({})),
    ).toBe('ok')
    expect(
      await admitEmbeddingEndpoint('http://embedding-adapter', CONFIGURED, resolvesTo({})),
    ).toBe('ok')
  })

  it('admits a public https endpoint — the point-at-your-own-embedder case', async () => {
    expect(
      await admitEmbeddingEndpoint(
        'https://my-embedder.example.com/v1',
        CONFIGURED,
        resolvesTo({ 'my-embedder.example.com': ['203.0.113.10', '8.8.8.8'] }),
      ),
    ).toBe('ok')
  })

  it('refuses a private address behind a public-looking name', async () => {
    // The trick the DNS resolve exists for: a name that is not in the allow-list
    // and answers with an internal address.
    const verdict = await admitEmbeddingEndpoint(
      'https://sneaky.example.com',
      CONFIGURED,
      resolvesTo({ 'sneaky.example.com': ['169.254.169.254'] }),
    )
    expect(verdict).not.toBe('ok')
    expect(verdict).toMatchObject({ refused: expect.stringContaining('own network') })
  })

  it('refuses when even one of several answers is private', async () => {
    // One public and one private is the whole trick, so every address is checked.
    const verdict = await admitEmbeddingEndpoint(
      'https://mixed.example.com',
      CONFIGURED,
      resolvesTo({ 'mixed.example.com': ['8.8.8.8', '10.0.0.9'] }),
    )
    expect(verdict).not.toBe('ok')
  })

  it('refuses a private IP literal that is not the configured embedder', async () => {
    const verdict = await admitEmbeddingEndpoint('http://169.254.169.254/latest', CONFIGURED)
    expect(verdict).not.toBe('ok')
  })

  it('refuses a public endpoint that is not https', async () => {
    // Document text on the wire in the clear is the reason. https is the least
    // this can be for a host outside the installation.
    const verdict = await admitEmbeddingEndpoint(
      'http://public-embedder.example.com',
      CONFIGURED,
      resolvesTo({ 'public-embedder.example.com': ['8.8.8.8'] }),
    )
    expect(verdict).not.toBe('ok')
    expect(verdict).toMatchObject({ refused: expect.stringContaining('https') })
  })

  it('refuses a value that is not a URL', async () => {
    expect(await admitEmbeddingEndpoint('minio:9000', CONFIGURED)).not.toBe('ok')
    expect(await admitEmbeddingEndpoint('nonsense', CONFIGURED)).not.toBe('ok')
  })

  it('refuses a name that does not resolve, rather than admitting it', async () => {
    // Failing open here would be the invariant-3 direction: a name nobody can
    // resolve is not one the worker should be told to fetch.
    const verdict = await admitEmbeddingEndpoint(
      'https://nowhere.example.com',
      CONFIGURED,
      resolvesTo({}),
    )
    expect(verdict).not.toBe('ok')
  })
})
