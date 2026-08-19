import { afterEach, describe, expect, it, vi } from 'vitest'

import { documentKey, retryAfterMs, S3, S3Error, worthRetrying } from '../s3.js'

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

  /*
   * `Content-Length` is a forbidden request header — the Fetch standard has the
   * runtime compute it from the body — and undici 7 stopped tolerating one set
   * by hand, throwing `InvalidArgumentError` before the request leaves. Node 22
   * ships undici 6 and accepted it; Node 24 ships 7, so this was every PUT
   * failing on the next Node.
   *
   * Pinned as an absence, which is the only way to assert a header is gone.
   */
  it('sets no content-length of its own, which the runtime owns', async () => {
    const calls = capture({ status: 200 })
    await new S3(options).put('k', new TextEncoder().encode('body'))
    const headers = calls[0]?.headers ?? {}
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('content-length')
    const signed = /SignedHeaders=([^,]+)/.exec(headers.authorization as string)?.[1] ?? ''
    expect(signed).not.toContain('content-length')
    // And the body is still bound, by the hash that is actually in the
    // canonical request.
    expect(signed).toContain('x-amz-content-sha256')
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

/**
 * Trying again, and the four ways that goes wrong.
 *
 * The transport is stubbed here and says so: what is under test is *when* this
 * client sends a second request, which is a decision made entirely inside it.
 * The signature is checked against a real MinIO, in `s3-live.test.ts`, and the
 * one property those two cannot split between them — that a retry is re-signed
 * rather than replayed — is asserted below by reading the header.
 *
 * `sleep` and `random` are injected, so a case that measures a backoff measures
 * a number rather than a wall clock, and the suite does not wait seconds to
 * assert milliseconds. `lint:test-clock` exists because a case whose claim
 * depends on something it does not control is a case that is green four times
 * in five.
 */
describe('retrying', () => {
  /** A `fetch` that plays a script: a status, or a thrown transport failure. */
  function script(steps: readonly ({ status: number; body?: string; retryAfter?: string } | Error)[]) {
    const calls: { method: string; url: string; authorization: string }[] = []
    let n = 0
    const fake = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        authorization: headers['authorization'] ?? '',
      })
      const step = steps[Math.min(n, steps.length - 1)]
      n += 1
      if (step instanceof Error) throw step
      const status = step?.status ?? 500
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        // A real `Response` always has these two, and the stub that did not is
        // how a fixture stops looking like the wire.
        headers: { get: (name: string) => (name === 'retry-after' ? (step?.retryAfter ?? null) : null) },
        body: { cancel: async () => undefined },
        text: async () => step?.body ?? '',
        arrayBuffer: async () => new TextEncoder().encode(step?.body ?? '').buffer,
      } as unknown as Response
    })
    vi.stubGlobal('fetch', fake)
    return calls
  }

  const waits: number[] = []
  const notices: { status?: number; attempt: number; delayMs: number }[] = []
  /** Deterministic: the full jitter window, so a delay is a number to assert. */
  function client(over: Record<string, unknown> = {}) {
    return new S3({
      ...options,
      random: () => 1,
      sleep: async (ms: number) => {
        waits.push(ms)
      },
      onRetry: (n) => {
        notices.push({ attempt: n.attempt, delayMs: n.delayMs, ...(n.status === undefined ? {} : { status: n.status }) })
      },
      ...over,
    })
  }

  afterEach(() => {
    waits.length = 0
    notices.length = 0
  })

  it('sends again after a 503 and returns the answer', async () => {
    const calls = script([{ status: 503 }, { status: 200 }])
    await client().put('a', new Uint8Array([1]))
    expect(calls).toHaveLength(2)
    expect(notices).toEqual([{ attempt: 1, of: 4, delayMs: 100, status: 503 }].map((n) => ({
      attempt: n.attempt,
      delayMs: n.delayMs,
      status: n.status,
    })))
  })

  /**
   * The whole of the judgement, and each of these is a way to waste a budget
   * arriving at the answer already given.
   */
  it('does not send again for anything a second try cannot change', async () => {
    for (const status of [400, 403, 404, 409, 501]) {
      const calls = script([{ status }, { status: 200 }])
      await client()
        .get('a')
        .catch(() => undefined)
      expect(calls, `status ${String(status)}`).toHaveLength(1)
    }
  })

  it('sends again for 429 and for a 500', async () => {
    for (const status of [429, 500, 502, 503, 504]) {
      const calls = script([{ status }, { status: 200 }])
      await client().get('a')
      expect(calls, `status ${String(status)}`).toHaveLength(2)
    }
  })

  /**
   * The property no other case here can see: `x-amz-date` is inside the
   * signature and S3 refuses a request more than fifteen minutes old, so a
   * retry that replayed the first attempt's headers would fail for a reason
   * that has nothing to do with why the first one did.
   */
  it('re-signs each attempt rather than replaying the first', async () => {
    let clock = Date.parse('2026-08-19T00:00:00Z')
    const calls = script([{ status: 503 }, { status: 503 }, { status: 200 }])
    await client({ clock: () => (clock += 1_000) }).put('a', new Uint8Array([1]))

    expect(calls).toHaveLength(3)
    expect(new Set(calls.map((c) => c.authorization)).size).toBe(3)
    expect(calls[0]?.authorization).not.toBe(calls[1]?.authorization)
  })

  it('gives up after the attempts and reports the last failure', async () => {
    const calls = script([{ status: 503, body: '<Error><Code>SlowDown</Code></Error>' }])
    await expect(client().put('a', new Uint8Array([1]))).rejects.toThrow(/SlowDown/)
    expect(calls).toHaveLength(4)
  })

  /**
   * A transport failure has no response to hand back, so the original error is
   * thrown — which is what this client did for every failure before there were
   * retries, and is what a caller's `catch` is already written against.
   */
  it('retries a thrown transport failure and rethrows it when spent', async () => {
    const calls = script([new TypeError('fetch failed')])
    await expect(client().get('a')).rejects.toThrow(/fetch failed/)
    expect(calls).toHaveLength(4)
  })

  it('doubles the window, and full jitter draws from the whole of it', async () => {
    script([{ status: 503 }])
    await client().get('a').catch(() => undefined)
    // random() === 1, so each wait is the window itself: 100, 200, 400.
    expect(waits).toEqual([100, 200, 400])

    waits.length = 0
    script([{ status: 503 }])
    await client({ random: () => 0 })
      .get('a')
      .catch(() => undefined)
    expect(waits).toEqual([0, 0, 0])
  })

  it('honours Retry-After over the formula, in both of its forms', async () => {
    script([{ status: 429, retryAfter: '2' }, { status: 200 }])
    await client().get('a')
    expect(waits).toEqual([2000])

    waits.length = 0
    const clock = Date.parse('2026-08-19T00:00:00Z')
    script([{ status: 429, retryAfter: 'Wed, 19 Aug 2026 00:00:03 GMT' }, { status: 200 }])
    await client({ clock: () => clock }).get('a')
    expect(waits).toEqual([3000])
  })

  it('caps Retry-After, so a mistaken value does not park a restore', async () => {
    script([{ status: 503, retryAfter: '3600' }, { status: 200 }])
    await client({ retries: { maxDelayMs: 1_000, budgetMs: 60_000 } }).get('a')
    expect(waits).toEqual([1000])
  })

  /**
   * The budget is checked *before* sleeping, so the failure arrives while
   * somebody is still watching rather than after the last wait it could not
   * afford.
   */
  it('stops when the next wait would not fit the budget', async () => {
    const calls = script([{ status: 503 }])
    await client({ retries: { budgetMs: 150 } })
      .get('a')
      .catch(() => undefined)
    // 100 fits, 200 does not.
    expect(waits).toEqual([100])
    expect(calls).toHaveLength(2)
  })

  /**
   * The second of the three call sites, and the reason the loop is one function
   * rather than three: a listing is the request that decides whether an
   * archive's parts are all there, so a blip on it turns the check that refuses
   * a stray part into the check that fails.
   */
  it('retries a listing too', async () => {
    const calls = script([{ status: 503 }, { status: 200, body: page(['a/1']) }])
    expect(await client().list('a/')).toEqual(['a/1'])
    expect(calls).toHaveLength(2)
  })

  /**
   * And the one caller that opts out. A readiness probe's job is to answer now:
   * retrying inside it turns "the bucket is not answering" into no answer, and
   * an orchestrator reads a probe that times out as a pod to kill.
   */
  it('does not retry a readiness probe', async () => {
    const calls = script([{ status: 503 }])
    await expect(client().ready()).rejects.toBeInstanceOf(S3Error)
    expect(calls).toHaveLength(1)
    expect(waits).toEqual([])
  })
})

describe('worthRetrying', () => {
  it('is every 5xx but 501, plus 429', () => {
    for (const yes of [429, 500, 502, 503, 504, 599]) expect(worthRetrying(yes), String(yes)).toBe(true)
    for (const no of [200, 204, 301, 400, 403, 404, 409, 412, 501]) {
      expect(worthRetrying(no), String(no)).toBe(false)
    }
  })
})

describe('retryAfterMs', () => {
  const now = Date.parse('2026-08-19T00:00:00Z')

  it('reads a count of seconds', () => {
    expect(retryAfterMs('5', now)).toBe(5000)
    expect(retryAfterMs(' 5 ', now)).toBe(5000)
  })

  it('reads an HTTP-date, which is what a proxy in front of a store sends', () => {
    expect(retryAfterMs('Wed, 19 Aug 2026 00:00:07 GMT', now)).toBe(7000)
  })

  it('is nothing for an absent or unreadable header, and never negative', () => {
    expect(retryAfterMs(null, now)).toBeUndefined()
    expect(retryAfterMs('soon', now)).toBeUndefined()
    expect(retryAfterMs('Wed, 19 Aug 2020 00:00:00 GMT', now)).toBe(0)
  })
})
