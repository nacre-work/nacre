import { authorizationServerMetadata, redirectAllowed, redirectAllowedForMetadataClient } from '@nacre.work/core'
import { describe, expect, it } from 'vitest'

import {
  cacheSeconds,
  DEFAULT_CACHE_SECONDS,
  fetchClientMetadata,
  isMetadataClientId,
  MAX_CACHE_SECONDS,
  MAX_DOCUMENT_BYTES,
  MIN_CACHE_SECONDS,
  validateMetadataDocument,
  type GuardedFetch,
} from '../client-metadata.js'

/**
 * Client ID Metadata Documents: which ids name one, what a document must say,
 * and what a fetch of one may cost.
 *
 * The network half is a stand-in for `egressFetch` here, and deliberately so:
 * the guard is held by its own suite against real sockets, and what this file
 * holds is what happens to whatever the guard hands back — every refusal is a
 * sentence the person setting the client up reads, so each is asked directly.
 */

const ID = 'https://client.example.com/oauth/metadata.json'

const document = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  client_id: ID,
  client_name: 'Example agent',
  redirect_uris: ['http://127.0.0.1/callback', 'https://client.example.com/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  ...overrides,
})

const answering =
  (body: string | Uint8Array, init: ResponseInit = {}): GuardedFetch =>
  async () =>
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' }, ...init })

describe('which client_id names a metadata document', () => {
  it('takes an https URL with a path', () => {
    expect(isMetadataClientId(ID)).toBe(true)
    expect(isMetadataClientId('https://client.example.com/client.json')).toBe(true)
  })

  it('refuses everything else, before anything is fetched', () => {
    // A registration's id is random and never a URL.
    expect(isMetadataClientId('nacre_client_0123456789abcdef')).toBe(false)
    // The specification requires https and a path.
    expect(isMetadataClientId('http://client.example.com/client.json')).toBe(false)
    expect(isMetadataClientId('https://client.example.com/')).toBe(false)
    expect(isMetadataClientId('https://client.example.com')).toBe(false)
    // No credentials, no fragment.
    expect(isMetadataClientId('https://user:pw@client.example.com/client.json')).toBe(false)
    expect(isMetadataClientId('https://client.example.com/client.json#x')).toBe(false)
    expect(isMetadataClientId(`https://client.example.com/${'a'.repeat(600)}`)).toBe(false)
  })

  it('refuses a spelling the URL parser would rewrite', () => {
    // Each of these fetches the same document as some canonical id while
    // comparing unequal to that document's own client_id — so two strings
    // could be one client, or one string two.
    expect(isMetadataClientId('https://Client.Example.com/client.json')).toBe(false)
    expect(isMetadataClientId('https://client.example.com:443/client.json')).toBe(false)
    expect(isMetadataClientId('https://client.example.com/a/../client.json')).toBe(false)
    expect(isMetadataClientId('https://client.example.com/./client.json')).toBe(false)
  })
})

describe('what a metadata document must say', () => {
  it('names the client and its redirect URIs', () => {
    expect(validateMetadataDocument(ID, document(), redirectAllowed)).toEqual({
      clientName: 'Example agent',
      redirectUris: ['http://127.0.0.1/callback', 'https://client.example.com/callback'],
    })
  })

  it('falls back to the host for a client with no name', () => {
    const judged = validateMetadataDocument(ID, document({ client_name: '  ' }), redirectAllowed)
    expect(judged).toMatchObject({ clientName: 'client.example.com' })
  })

  it('refuses a document vouching for another client', () => {
    // The byte comparison is what stops a document at one URL describing a
    // client whose id is somewhere else.
    for (const other of ['https://client.example.com/other.json', `${ID}/`, ID.toUpperCase(), undefined]) {
      const judged = validateMetadataDocument(ID, document({ client_id: other }), redirectAllowed)
      expect(judged).toEqual({
        refusal: 'the client metadata document names a different client_id than the URL it was fetched from',
      })
    }
  })

  it('refuses redirect URIs a registration could not have', () => {
    for (const uris of [[], ['http://client.example.com/cb'], ['javascript:alert(1)'], 'https://x.example/cb', [42]]) {
      const judged = validateMetadataDocument(ID, document({ redirect_uris: uris }), redirectAllowed)
      expect(judged).toHaveProperty('refusal')
    }
  })

  it('refuses client authentication by name rather than ignoring it', () => {
    const judged = validateMetadataDocument(ID, document({ token_endpoint_auth_method: 'private_key_jwt' }), redirectAllowed)
    expect(judged).toEqual({
      refusal:
        'the client metadata document asks for token_endpoint_auth_method "private_key_jwt"; this server issues public clients only and binds the exchange with PKCE',
    })
  })

  it('refuses a client that does not ask for the code grant', () => {
    const judged = validateMetadataDocument(ID, document({ grant_types: ['client_credentials'] }), redirectAllowed)
    expect(judged).toHaveProperty('refusal')
  })

  it('refuses what is not an object', () => {
    for (const body of [null, [], 'text', 7]) {
      expect(validateMetadataDocument(ID, body, redirectAllowed)).toEqual({
        refusal: 'the client metadata document is not a JSON object',
      })
    }
  })
})

describe('how long a document is trusted', () => {
  it('reads max-age inside the bounds', () => {
    expect(cacheSeconds(null)).toBe(DEFAULT_CACHE_SECONDS)
    expect(cacheSeconds('public, max-age=7200')).toBe(7200)
    expect(cacheSeconds('max-age=5')).toBe(MIN_CACHE_SECONDS)
    expect(cacheSeconds('max-age=99999999')).toBe(MAX_CACHE_SECONDS)
    expect(cacheSeconds('max-age=abc')).toBe(DEFAULT_CACHE_SECONDS)
  })

  it('takes no-store as the floor rather than as a fetch per request', () => {
    // A fetch per authorization would make every person connecting the client
    // an outbound request somebody else chose.
    expect(cacheSeconds('no-store')).toBe(MIN_CACHE_SECONDS)
    expect(cacheSeconds('no-cache, max-age=0')).toBe(MIN_CACHE_SECONDS)
  })
})

describe('fetching a document', () => {
  const options = (fetch: GuardedFetch) => ({ trustedOrigins: [], redirectAllowed, fetch })

  it('hands the guard the id, a timeout and the trusted origins', async () => {
    let seen: { input: string; signal: unknown; trusted: readonly string[] } | undefined
    const fetched = await fetchClientMetadata(ID, {
      trustedOrigins: ['https://intranet.example'],
      redirectAllowed,
      fetch: async (input, init, policy) => {
        seen = { input, signal: init.signal, trusted: policy.trustedOrigins ?? [] }
        return new Response(JSON.stringify(document()), { headers: { 'cache-control': 'max-age=600' } })
      },
    })
    expect(seen?.input).toBe(ID)
    expect(seen?.signal).toBeInstanceOf(AbortSignal)
    expect(seen?.trusted).toEqual(['https://intranet.example'])
    expect(fetched).toEqual({
      client: { clientName: 'Example agent', redirectUris: document().redirect_uris },
      ttlSeconds: 600,
    })
  })

  it('says why a fetch was refused, in words', async () => {
    const refused = (name: string): GuardedFetch => async () => {
      const error = new Error('x')
      error.name = name
      throw error
    }
    expect(await fetchClientMetadata(ID, options(refused('EgressRefused')))).toEqual({
      refusal: 'the client metadata document could not be fetched: its address is not a public one',
    })
    expect(await fetchClientMetadata(ID, options(refused('TimeoutError')))).toEqual({
      refusal: 'the client metadata document could not be fetched: it did not answer within 5 seconds',
    })
    expect(await fetchClientMetadata(ID, options(refused('TypeError')))).toEqual({
      refusal: 'the client metadata document could not be fetched: it could not be reached',
    })
  })

  it('refuses anything but a 200', async () => {
    expect(await fetchClientMetadata(ID, options(answering('', { status: 302 })))).toEqual({
      refusal: 'the client metadata document answered 302',
    })
    expect(await fetchClientMetadata(ID, options(answering('{}', { status: 404 })))).toEqual({
      refusal: 'the client metadata document answered 404',
    })
  })

  it('stops reading at the size bound, declared or not', async () => {
    const big = JSON.stringify(document({ client_name: 'x'.repeat(MAX_DOCUMENT_BYTES) }))
    const tooLarge = { refusal: `the client metadata document is larger than ${String(MAX_DOCUMENT_BYTES)} bytes` }
    expect(await fetchClientMetadata(ID, options(answering(big)))).toEqual(tooLarge)
    // A body that lies about its length is cut off by counting, not trusted.
    expect(
      await fetchClientMetadata(ID, options(answering(big, { headers: { 'content-length': '10' } }))),
    ).toEqual(tooLarge)
  })

  it('refuses what is not JSON', async () => {
    expect(await fetchClientMetadata(ID, options(answering('<html>')))).toEqual({
      refusal: 'the client metadata document is not JSON',
    })
  })
})

describe('a metadata client redirects to loopback on any port', () => {
  const listed = ['http://127.0.0.1/callback', 'http://localhost/cb', 'http://[::1]/cb', 'https://client.example.com/cb']

  it('relaxes the port, RFC 8252 §7.3, and nothing else', () => {
    expect(redirectAllowedForMetadataClient('http://127.0.0.1:54321/callback', listed)).toBe(true)
    expect(redirectAllowedForMetadataClient('http://localhost:3000/cb', listed)).toBe(true)
    expect(redirectAllowedForMetadataClient('http://[::1]:8080/cb', listed)).toBe(true)
    expect(redirectAllowedForMetadataClient('https://client.example.com/cb', listed)).toBe(true)

    expect(redirectAllowedForMetadataClient('http://127.0.0.1:54321/other', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('http://localhost:3000/callback', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('https://client.example.com:8443/cb', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('http://client.example.com/cb', listed)).toBe(false)
  })

  it('refuses a loopback URI the browser would read differently', () => {
    expect(redirectAllowedForMetadataClient('http://evil@127.0.0.1:5/callback', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('http://127.0.0.1:5/callback#x', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('http://127.0.0.1:5/x/../callback', listed)).toBe(false)
    expect(redirectAllowedForMetadataClient('http://LOCALHOST:5/cb', listed)).toBe(false)
  })

  it('leaves a registration exact', () => {
    // The relaxation is for a static document only: a registered client posts
    // the port it is listening on, so it has no need of one.
    expect(redirectAllowed('http://127.0.0.1:54321/callback', listed)).toBe(false)
  })
})

describe('what the authorization server advertises', () => {
  it('names metadata documents only where they are fetched, and registration always', () => {
    const off = authorizationServerMetadata('https://nacre.example')
    expect(off).not.toHaveProperty('client_id_metadata_document_supported')
    expect(off).toHaveProperty('registration_endpoint')

    const on = authorizationServerMetadata('https://nacre.example', { clientIdMetadataDocuments: true })
    expect(on).toHaveProperty('client_id_metadata_document_supported', true)
    expect(on).toHaveProperty('registration_endpoint')
  })
})
