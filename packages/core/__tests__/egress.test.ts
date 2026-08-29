import { describe, expect, it } from 'vitest'

import { admitEmbeddingEndpoint, endpointOrigin, isGlobalAddress } from '../egress.js'

/**
 * The egress guard on a tenant-supplied embedder endpoint.
 *
 * In multi-tenancy an `org_admin` administers one tenant and not the
 * installation, so an endpoint they supply that the shared worker POSTs to is an
 * SSRF primitive against the internal network — the metadata endpoint, the API
 * beside it, the vector store. The addresses that matter are pinned as literals,
 * because a range table is the thing that gets an entry missed (the parser's own
 * header says so), and a tenant endpoint is additionally held to the strict
 * form: https, a hostname and not an IP literal, resolving only to global
 * addresses.
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
      '192.0.2.5', // TEST-NET-1
      '198.51.100.9', // TEST-NET-2
      '203.0.113.7', // TEST-NET-3
      '192.88.99.1', // 6to4 relay anycast
      '2001:db8::1', // documentation
      '64:ff9b::a9fe:a9fe', // NAT64 mapping of 169.254.169.254 — the metadata endpoint
      '64:ff9b::a00:1', // NAT64 mapping of 10.0.0.1
    ]) {
      expect(isGlobalAddress(addr), addr).toBe(false)
    }
  })

  it('admits genuinely public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '172.15.0.1', '172.32.0.1', '93.184.216.34']) {
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
        resolvesTo({ 'my-embedder.example.com': ['93.184.216.34', '8.8.8.8'] }),
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

  it('refuses an IP-literal endpoint outright, even a public one', async () => {
    // A public embedder is a DNS name; a literal is either internal or an
    // obfuscation. Only the configured allow-list may be an address.
    for (const endpoint of [
      'https://8.8.8.8/v1', // public, but still a literal — refused
      'http://169.254.169.254/latest', // the metadata endpoint
      'https://[::1]/', // bracketed IPv6 literal
      'http://[::ffff:169.254.169.254]/', // IPv4-mapped in brackets
    ]) {
      const verdict = await admitEmbeddingEndpoint(endpoint, CONFIGURED, resolvesTo({}))
      expect(verdict, endpoint).not.toBe('ok')
    }
  })

  it('refuses decimal and octal IP obfuscations, which a range check misses', async () => {
    // new URL('http://2130706433') parses the host as the name "2130706433",
    // which resolves to 127.0.0.1 on a real system — the range check never sees
    // an address. Refusing non-IP names that are all digits, and refusing the
    // resolved address, both cover it; here the name resolves to loopback.
    const verdict = await admitEmbeddingEndpoint(
      'https://2130706433',
      CONFIGURED,
      resolvesTo({ '2130706433': ['127.0.0.1'] }),
    )
    expect(verdict).not.toBe('ok')
  })

  it('admits an internal host that is in the env allow-list', async () => {
    // NACRE_EMBED_ALLOWED_HOSTS is how an operator trusts a second internal
    // embedder. Passed as an allowed origin, it is admitted as written.
    expect(
      await admitEmbeddingEndpoint('http://embedder-2:8080', ['http://embedder-2:8080'], resolvesTo({})),
    ).toBe('ok')
    // But only that exact origin — a different internal host is still refused.
    expect(
      await admitEmbeddingEndpoint('http://embedder-3:8080', ['http://embedder-2:8080'], resolvesTo({})),
    ).not.toBe('ok')
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
