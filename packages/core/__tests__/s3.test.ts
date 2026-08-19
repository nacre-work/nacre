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

/**
 * A `fetch` that answers a list of responses in order.
 *
 * The single-response `capture` above cannot express a paginated listing, and a
 * listing that stops after one page is exactly the defect the pagination
 * exists against — so the case has to be able to hand back two.
 */
function captureSequence(responses: readonly { status: number; body?: string }[]) {
  const calls: { url: string; method: string }[] = []
  let n = 0
  const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' })
    const response = responses[Math.min(n, responses.length - 1)]
    n += 1
    return {
      ok: (response?.status ?? 500) >= 200 && (response?.status ?? 500) < 300,
      status: response?.status ?? 500,
      statusText: '',
      text: async () => response?.body ?? '',
      arrayBuffer: async () => new TextEncoder().encode(response?.body ?? '').buffer,
    } as Response
  })
  vi.stubGlobal('fetch', fake)
  return calls
}

const page = (keys: readonly string[], next?: string): string =>
  `<?xml version="1.0"?><ListBucketResult>` +
  keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('') +
  (next === undefined
    ? '<IsTruncated>false</IsTruncated>'
    : `<IsTruncated>true</IsTruncated><NextContinuationToken>${next}</NextContinuationToken>`) +
  `</ListBucketResult>`


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

describe('presign', () => {
  // What a valid link does against a real store is checked by running it
  // against MinIO — a signature is only correct if an S3 accepts it. What is
  // pinned here is the shape, because a missing parameter is a 403 with nothing
  // in it about which one.
  const url = () => new URL(new S3(options).presign('org/a/layer/b/c', 900))

  it('carries everything that authenticates it in the query', () => {
    const q = url().searchParams
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(q.get('X-Amz-Credential')).toMatch(/^key\/\d{8}\/us-east-1\/s3\/aws4_request$/)
    expect(q.get('X-Amz-Date')).toMatch(/^\d{8}T\d{6}Z$/)
    expect(q.get('X-Amz-Expires')).toBe('900')
    expect(q.get('X-Amz-SignedHeaders')).toBe('host')
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('points at the object and nothing else', () => {
    expect(url().origin + url().pathname).toBe('http://minio:9000/nacre/org/a/layer/b/c')
  })

  it('sends no credential in a header, because a link has none', () => {
    // The whole point is a URL a client can follow. Anything that has to be
    // sent alongside it is a capability the holder does not have.
    expect(new S3(options).presign('a', 900)).not.toContain('Authorization')
  })

  it('refuses to mint a link that expires immediately', () => {
    expect(new URL(new S3(options).presign('a', 0)).searchParams.get('X-Amz-Expires')).toBe('1')
  })

  it('signs two keys differently', () => {
    const s3 = new S3(options)
    const a = new URL(s3.presign('org/a/layer/b/one', 900)).searchParams.get('X-Amz-Signature')
    const b = new URL(s3.presign('org/a/layer/b/two', 900)).searchParams.get('X-Amz-Signature')
    expect(a).not.toBe(b)
  })

  it('escapes the key the same way a request does', () => {
    // Signed one way and requested another is the failure this shares with the
    // header path.
    expect(new S3(options).presign("a/b!c", 900)).toContain('/nacre/a/b%21c?')
  })
})

/**
 * Listing, which this file said for a long time was deliberately absent.
 *
 * The reason given was that nothing needed to enumerate a bucket. The backup
 * module's archive reader does — it refuses a part its manifest does not name,
 * and an archive in a bucket must not lose a refusal an archive on a disk has.
 *
 * The signature half is verified against a real MinIO, as everything in this
 * client is; what is pinned here is the shape around it, and the two ways a
 * paginated listing goes quietly wrong.
 */
describe('S3.list', () => {
  it('addresses the bucket rather than a key, and asks for version 2', async () => {
    const calls = captureSequence([{ status: 200, body: page(['a/one', 'a/two']) }])
    const keys = await new S3(options).list('a/')
    expect(keys).toEqual(['a/one', 'a/two'])
    expect(calls[0]?.url).toContain('/nacre?')
    expect(calls[0]?.url).toContain('list-type=2')
    expect(calls[0]?.url).toContain('prefix=a%2F')
  })

  it('follows the continuation token to the end', async () => {
    const calls = captureSequence([
      { status: 200, body: page(['a/one'], 'TOKEN-1') },
      { status: 200, body: page(['a/two']) },
    ])
    expect(await new S3(options).list('a/')).toEqual(['a/one', 'a/two'])
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toContain('continuation-token=TOKEN-1')
  })

  /*
   * The failure that matters. A caller treating a short list as complete is a
   * stray-part check that passes on an archive it should refuse, and a weaker
   * refusal reporting success is worse than none — so a bucket that says it
   * truncated and hands back no token is a refusal rather than a partial answer.
   */
  it('refuses a truncated listing with no token rather than returning half of it', async () => {
    captureSequence([{ status: 200, body: page(['a/one'], '') }])
    await expect(new S3(options).list('a/')).rejects.toThrow(/continuation token/u)
  })

  it('undoes the escaping a bucket applies, numeric references included', async () => {
    // A real MinIO returns an apostrophe as `&#39;`, not `&apos;` — found by
    // listing such a key against one. Left encoded, the name no manifest
    // matches and a good archive is condemned.
    captureSequence([{ status: 200, body: page(['a/odd &#39;name&#39;', 'a/&amp;b', 'a/&#x2F;c']) }])
    expect(await new S3(options).list('a/')).toEqual(["a/odd 'name'", 'a/&b', 'a//c'])
  })

  it('reports a refusal with the store’s own words, like every other call', async () => {
    captureSequence([{ status: 403, body: '<Error><Code>AccessDenied</Code></Error>' }])
    await expect(new S3(options).list('a/')).rejects.toThrow(/AccessDenied/u)
  })
})
