import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentKey, S3, S3Error } from '../s3.js'

/**
 * The object-storage client.
 *
 * The signature itself is verified against a real MinIO rather than here — a
 * unit test that asserts a hex string only proves the algorithm has not
 * changed, not that any S3 accepts it, and the failure mode of SigV4 is a `403`
 * that names none of its six inputs. What this file pins is everything around
 * the signature: which URL is built, which characters are escaped, and which
 * responses are errors.
 */

const options = {
  endpoint: 'http://minio:9000',
  bucket: 'nacre',
  region: 'us-east-1',
  accessKey: 'key',
  secretKey: 'secret',
  forcePathStyle: true,
}

function capture(response: { status: number; body?: string }) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = []
  const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: '',
      text: async () => response.body ?? '',
      arrayBuffer: async () => new TextEncoder().encode(response.body ?? '').buffer,
    } as Response
  })
  vi.stubGlobal('fetch', fake)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('documentKey', () => {
  it('is derived from identity, never from the content', async () => {
    const a = documentKey('org', 'layer', 'notes.md')
    const b = documentKey('org', 'layer', 'notes.md')
    expect(a).toBe(b)
    // Content addressing would let two documents share an object, and deleting
    // one would either strand the other or need a reference count nothing else
    // in this system has.
    expect(a).toMatch(/^org\/org\/layer\/layer\/[0-9a-f]{64}$/)
  })

  it('hashes the external id rather than escaping it', () => {
    // It is caller-chosen text. Escaping would put its length and its shape
    // under the caller's control, which is how a key ends up too long for the
    // store or containing a traversal.
    const key = documentKey('o', 'l', '../../etc/passwd')
    expect(key).not.toContain('..')
    expect(key.split('/')).toHaveLength(5)
  })

  it('separates documents that differ only by layer', () => {
    expect(documentKey('o', 'l1', 'x')).not.toBe(documentKey('o', 'l2', 'x'))
    expect(documentKey('o1', 'l', 'x')).not.toBe(documentKey('o2', 'l', 'x'))
  })
})

describe('S3', () => {
  it('addresses path style when asked', async () => {
    const calls = capture({ status: 200 })
    await new S3(options).put('a/b', new Uint8Array([1]))
    expect(calls[0]?.url).toBe('http://minio:9000/nacre/a/b')
  })

  it('addresses virtual host style otherwise', async () => {
    const calls = capture({ status: 200 })
    await new S3({ ...options, forcePathStyle: false }).put('a/b', new Uint8Array([1]))
    expect(calls[0]?.url).toBe('http://nacre.minio:9000/a/b')
  })

  it('escapes the characters encodeURIComponent leaves behind', async () => {
    // `!'()*` sign one way and get requested another if they are not encoded,
    // which is a 403 with nothing in it pointing at the key.
    const calls = capture({ status: 200 })
    await new S3(options).put("a/b!c'd(e)f*g", new Uint8Array([1]))
    expect(calls[0]?.url).toBe('http://minio:9000/nacre/a/b%21c%27d%28e%29f%2Ag')
  })

  it('keeps the separators between key segments', async () => {
    const calls = capture({ status: 200 })
    await new S3(options).put('org/x/layer/y/z', new Uint8Array([1]))
    expect(calls[0]?.url).toBe('http://minio:9000/nacre/org/x/layer/y/z')
  })

  it('signs every request, naming the credential and the scope', async () => {
    const calls = capture({ status: 200 })
    await new S3(options).put('a', new Uint8Array([1]))
    const headers = calls[0]?.headers ?? {}
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=\S+ Signature=[0-9a-f]{64}$/,
    )
    // Every signed header must actually be sent, or the receiver recomputes a
    // different canonical request and answers 403.
    const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization as string)?.[1]?.split(';') ?? []
    for (const name of signed) expect(Object.keys(headers).map((h) => h.toLowerCase())).toContain(name)
  })

  it('hashes the body it is about to send, so a body that changes fails', async () => {
    const calls = capture({ status: 200 })
    await new S3(options).put('a', new TextEncoder().encode('hello'))
    // sha256("hello")
    expect(calls[0]?.headers['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('treats a missing object as absent rather than as a failure', async () => {
    capture({ status: 404 })
    expect(await new S3(options).get('gone')).toBeUndefined()
  })

  it('lets a delete of something already gone succeed', async () => {
    // The collector must be able to run twice over the same target.
    capture({ status: 404 })
    await expect(new S3(options).remove('gone')).resolves.toBeUndefined()
  })

  it('puts the store reason in the error, not just the status', async () => {
    // A status alone sends the reader to the wrong one of six inputs. Both S3
    // and MinIO answer with an XML document naming the code.
    capture({ status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code></Error>' })
    await expect(new S3(options).put('a', new Uint8Array([1]))).rejects.toThrow(
      /SignatureDoesNotMatch/,
    )
    capture({ status: 403, body: 'x' })
    await expect(new S3(options).get('a')).rejects.toBeInstanceOf(S3Error)
  })

  it('checks the bucket rather than a key for readiness', async () => {
    // A key would have to exist. The bucket fails for the three reasons that
    // matter: unreachable, wrong bucket, wrong credential.
    const calls = capture({ status: 200 })
    await new S3(options).ready()
    expect(calls[0]?.method).toBe('HEAD')
    expect(calls[0]?.url).toBe('http://minio:9000/nacre')
  })

  it('is not ready when the bucket answers an error', async () => {
    capture({ status: 404 })
    await expect(new S3(options).ready()).rejects.toBeInstanceOf(S3Error)
  })

  it('tolerates a trailing slash on the endpoint', async () => {
    const calls = capture({ status: 200 })
    await new S3({ ...options, endpoint: 'http://minio:9000/' }).put('a', new Uint8Array([1]))
    expect(calls[0]?.url).toBe('http://minio:9000/nacre/a')
  })
})
