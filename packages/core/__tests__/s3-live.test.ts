import { randomBytes, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { S3, S3Error } from '../s3.js'

/**
 * The object-storage client, against a real object store.
 *
 * `s3.ts`'s own header says every property here is verified against a real
 * MinIO before it is believed, and until this file **nothing in CI did that** —
 * the verification was somebody running a script by hand, which is a claim that
 * a check exists rather than a check. The same shape as `lint:tokens` being
 * named in a stylesheet header that had no such check: the property held, which
 * is what made it invisible.
 *
 * What only a real store can answer is everything the signature touches. A
 * `403` from SigV4 names none of its six inputs, so a stubbed transport agrees
 * with whatever the signer believed — which is exactly how a signed
 * `content-length` and an `&apos;`-only entity decoder both shipped.
 *
 * The **retry** case is here because a stub proves when a second request is
 * sent and cannot prove the object is afterwards really in the bucket.
 *
 * It deliberately does **not** claim to catch a client that replays the first
 * attempt's headers instead of re-signing, and the first version of this
 * paragraph did. That was measured and it was wrong: restoring the replay left
 * this file green, because the backoff is stubbed to return immediately and S3
 * refuses a stale signature only past fifteen minutes. No suite that finishes
 * in under fifteen minutes can show it, so the re-signing is pinned in the unit
 * file — where the clock is a seam — and this file pins what only a store can
 * answer.
 */

const endpoint = process.env['NACRE_TEST_S3_ENDPOINT']
if (endpoint === undefined && process.env['CI'] !== undefined) {
  throw new Error(
    'NACRE_TEST_S3_ENDPOINT is not set and CI is; the object-storage client would go untested ' +
      'against anything that can refuse a signature.',
  )
}
const when = endpoint === undefined ? describe.skip : describe

const BUCKET = process.env['NACRE_TEST_S3_BUCKET'] ?? 'nacre-live'
const PREFIX = `live/${randomUUID()}`

function s3(over: Record<string, unknown> = {}): S3 {
  return new S3({
    endpoint: endpoint as string,
    bucket: BUCKET,
    region: 'us-east-1',
    accessKey: process.env['NACRE_TEST_S3_ACCESS_KEY'] ?? 'minioadmin',
    secretKey: process.env['NACRE_TEST_S3_SECRET_KEY'] ?? 'minioadmin',
    forcePathStyle: true,
    ...over,
  })
}

when('the s3 client against a real store', () => {
  beforeAll(async () => {
    // The bucket is the harness's: creating one is an operation this client
    // deliberately does not have. A missing one fails here with the store's own
    // words, which is a better message than anything invented.
    expect(await s3().ready()).toBe(true)
  })

  afterAll(async () => {
    for (const key of await s3().list(PREFIX)) await s3().remove(key)
  })

  it('puts, gets and removes an object', async () => {
    const key = `${PREFIX}/round-trip`
    const body = randomBytes(1024)
    await s3().put(key, body, 'application/octet-stream')
    expect(Buffer.from((await s3().get(key)) ?? new Uint8Array())).toEqual(body)
    await s3().remove(key)
    expect(await s3().get(key)).toBeUndefined()
  })

  /**
   * The five characters `encodeURIComponent` leaves alone and SigV4 does not.
   * A key containing one signs one way and is requested another, which is the
   * `403` this whole file exists against.
   */
  it('handles a key with the characters SigV4 escapes and encodeURIComponent does not', async () => {
    const key = `${PREFIX}/a!b'c(d)e*f`
    await s3().put(key, new TextEncoder().encode('x'))
    expect(await s3().get(key)).toBeDefined()
    expect(await s3().list(`${PREFIX}/a`)).toContain(key)
  })

  it('lists what is under a prefix and nothing beside it', async () => {
    const mine = `${PREFIX}/list`
    for (const n of [1, 2, 3]) await s3().put(`${mine}/${String(n)}`, new Uint8Array([n]))
    await s3().put(`${PREFIX}/elsewhere`, new Uint8Array([9]))

    const found = await s3().list(`${mine}/`)
    expect([...found].sort()).toEqual([`${mine}/1`, `${mine}/2`, `${mine}/3`])
  })

  /**
   * The property a stub cannot reach: after a backoff the second request is
   * accepted **and the bytes are afterwards in the bucket**. A stubbed
   * transport can only say a second request went out.
   *
   * The first attempt is refused without leaving this process — a synthetic
   * `503`, because a real store does not produce one on demand — and every
   * attempt after it is the real transport.
   */
  it('retries a write, and the object is really there afterwards', async () => {
    const key = `${PREFIX}/retried`
    const real = globalThis.fetch
    let n = 0
    const flaky: typeof fetch = async (input, init) => {
      n += 1
      if (n === 1) {
        return new Response('<Error><Code>SlowDown</Code></Error>', {
          status: 503,
          headers: { 'content-type': 'application/xml' },
        })
      }
      return real(input, init)
    }

    const waits: number[] = []
    globalThis.fetch = flaky
    try {
      await s3({ sleep: async (ms: number) => void waits.push(ms) }).put(
        key,
        new TextEncoder().encode('written on the second attempt'),
      )
    } finally {
      globalThis.fetch = real
    }

    expect(n).toBeGreaterThan(1)
    expect(waits).toHaveLength(1)
    expect(Buffer.from((await s3().get(key)) ?? new Uint8Array()).toString()).toBe(
      'written on the second attempt',
    )
  })

  /**
   * And the refusal that must not be retried, live: a wrong secret is a `403`
   * and every attempt would re-sign with the same wrong key. Four identical
   * refusals is a budget spent hiding a one-line diagnosis.
   */
  it('does not retry a wrong credential', async () => {
    let n = 0
    const real = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      n += 1
      return real(input, init)
    }
    try {
      await expect(
        s3({ secretKey: 'not-the-secret' }).put(`${PREFIX}/never`, new Uint8Array([1])),
      ).rejects.toBeInstanceOf(S3Error)
    } finally {
      globalThis.fetch = real
    }
    expect(n).toBe(1)
  })

  /**
   * A presigned link works without a credential, and one whose signature has
   * been altered does not. Sixty-four characters of hex, so the tamper flips a
   * character rather than assuming the field is one — an earlier version of
   * this check reported a pass on a tamper that had not applied.
   */
  it('presigns a link that works, and refuses one that has been altered', async () => {
    const key = `${PREFIX}/presigned`
    await s3().put(key, new TextEncoder().encode('readable'))
    const link = s3().presign(key, 300)

    expect((await fetch(link)).status).toBe(200)

    const url = new URL(link)
    const signature = url.searchParams.get('X-Amz-Signature') as string
    expect(signature).toHaveLength(64)
    url.searchParams.set(
      'X-Amz-Signature',
      (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1),
    )
    expect((await fetch(url)).status).toBe(403)
  })
})
