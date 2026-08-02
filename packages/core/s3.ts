import { createHash, createHmac } from 'node:crypto'

/**
 * Object storage, signed by hand.
 *
 * `NACRE_S3_*` has been in `docs/config.md` since before there was a server and
 * read by nothing — not used, not validated, so a wrong endpoint or a missing
 * credential was silent while the `full` profile started a MinIO nobody talked
 * to. This is the client that ends that.
 *
 * ─── why not the AWS SDK ───
 *
 * Four operations are needed: put, get, delete, head. `@aws-sdk/client-s3` is
 * tens of megabytes and hundreds of transitive packages, in a container whose
 * job is to read documents other people send it — which is the argument
 * `metrics.ts` already makes for not taking prom-client. SigV4 is a documented
 * algorithm with a published set of test vectors, it fits in this file, and it
 * has no release cadence to track.
 *
 * The rule that comes with that choice: **anything here is verified against a
 * real MinIO before it is believed**, because a signing bug produces a 403 that
 * says nothing about which of the six inputs was wrong.
 *
 * ─── what is deliberately not here ───
 *
 * No multipart upload, so an object is one PUT and `NACRE_MAX_DOCUMENT_BYTES`
 * bounds it. No listing, because nothing needs to enumerate a bucket and a
 * paginated list is where this file would stop being small. No retries: the
 * callers are the ingest queue and the collector, both of which already retry
 * whole units of work and would otherwise retry twice.
 */

export interface S3Options {
  /** Including the scheme and port, e.g. `http://minio:9000`. No trailing slash. */
  readonly endpoint: string
  readonly bucket: string
  readonly region: string
  readonly accessKey: string
  readonly secretKey: string
  /**
   * `{endpoint}/{bucket}/{key}` rather than `{bucket}.{endpoint}/{key}`.
   *
   * True for MinIO and for anything reached by IP or through a name that is not
   * a wildcard DNS entry, which is every self-hosted deployment. AWS itself
   * wants it false.
   */
  readonly forcePathStyle: boolean
}

const UNSIGNED = 'UNSIGNED-PAYLOAD'
const ALGORITHM = 'AWS4-HMAC-SHA256'
const SERVICE = 's3'

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')

const hmac = (key: Uint8Array | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest()

/**
 * Percent-encode one path segment the way SigV4 wants it.
 *
 * `encodeURIComponent` leaves `!'()*` alone and AWS does not, and it encodes
 * nothing else differently — so this is that function plus five characters. A
 * key containing any of them signs one way and is requested another, which is a
 * 403 with no clue in it.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Keys are `a/b/c`; each segment is encoded and the separators are not. */
const encodeKey = (key: string): string => key.split('/').map(encodeSegment).join('/')

export class S3Error extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly key: string,
    body: string,
  ) {
    // The body, because S3 and MinIO both answer with an XML document naming
    // the exact code — SignatureDoesNotMatch, NoSuchBucket, AccessDenied — and
    // a status alone sends the reader to the wrong one of six inputs.
    super(`s3 ${method} ${key} failed: ${status} ${body.slice(0, 512)}`)
    this.name = 'S3Error'
  }
}

export class S3 {
  readonly #options: S3Options

  constructor(options: S3Options) {
    this.#options = { ...options, endpoint: options.endpoint.replace(/\/+$/, '') }
  }

  get bucket(): string {
    return this.#options.bucket
  }

  #url(key: string): URL {
    const { endpoint, bucket, forcePathStyle } = this.#options
    if (forcePathStyle) return new URL(`${endpoint}/${bucket}/${encodeKey(key)}`)
    const url = new URL(endpoint)
    url.host = `${bucket}.${url.host}`
    url.pathname = `/${encodeKey(key)}`
    return url
  }

  /**
   * Sign a request, returning the headers to send with it.
   *
   * The payload hash goes in `x-amz-content-sha256` and into the canonical
   * request, so a body that changes in flight fails the signature rather than
   * being stored. `UNSIGNED-PAYLOAD` is used for GET and DELETE, which have
   * none — hashing the empty string would also work and this is what every
   * other implementation sends.
   */
  #sign(input: {
    method: string
    url: URL
    payloadHash: string
    headers: Record<string, string>
    now: Date
  }): Record<string, string> {
    const { region, accessKey, secretKey } = this.#options
    const amzDate = input.now.toISOString().replace(/[-:]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)

    const headers: Record<string, string> = {
      ...input.headers,
      host: input.url.host,
      'x-amz-content-sha256': input.payloadHash,
      'x-amz-date': amzDate,
    }

    // Lowercased, sorted, values trimmed — the canonical form. Getting the
    // order wrong is a 403 that reads exactly like a wrong secret.
    const canonicalHeaderNames = Object.keys(headers)
      .map((h) => h.toLowerCase())
      .sort()
    const canonicalHeaders = canonicalHeaderNames
      .map((name) => {
        const key = Object.keys(headers).find((h) => h.toLowerCase() === name) as string
        return `${name}:${String(headers[key]).trim()}\n`
      })
      .join('')
    const signedHeaders = canonicalHeaderNames.join(';')

    const canonicalRequest = [
      input.method,
      input.url.pathname,
      // No request here takes a query string. An empty one is still a line.
      '',
      canonicalHeaders,
      signedHeaders,
      input.payloadHash,
    ].join('\n')

    const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`
    const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n')

    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), SERVICE),
      'aws4_request',
    )
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

    return {
      ...headers,
      authorization:
        `${ALGORITHM} Credential=${accessKey}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    }
  }

  async #send(
    method: string,
    key: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = this.#url(key)
    const headers = this.#sign({
      method,
      url,
      payloadHash: body === undefined ? UNSIGNED : sha256(body),
      headers:
        body === undefined
          ? extraHeaders
          : { ...extraHeaders, 'content-length': String(body.length) },
      now: new Date(),
    })

    return fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    })
  }

  /** Store an object, overwriting whatever was there. */
  async put(key: string, body: Uint8Array, contentType = 'application/octet-stream'): Promise<void> {
    const response = await this.#send('PUT', key, body, { 'content-type': contentType })
    if (!response.ok) throw new S3Error(response.status, 'PUT', key, await response.text())
  }

  /** Fetch an object. `undefined` when it is not there, which is not an error. */
  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.#send('GET', key)
    if (response.status === 404) return undefined
    if (!response.ok) throw new S3Error(response.status, 'GET', key, await response.text())
    return new Uint8Array(await response.arrayBuffer())
  }

  /**
   * Remove an object. Absent is success.
   *
   * S3 answers `204` whether or not the key existed, and the caller — the
   * collector, purging a deleted document — must be able to run twice.
   */
  async remove(key: string): Promise<void> {
    const response = await this.#send('DELETE', key)
    if (!response.ok && response.status !== 404) {
      throw new S3Error(response.status, 'DELETE', key, await response.text())
    }
  }

  /**
   * A URL that fetches one object, for a while, without a credential.
   *
   * Query-string SigV4 rather than the header form: the point is a link a
   * client can follow, so everything that authenticates it has to be in the
   * URL. `host` is the only signed header, and the payload is unsigned because
   * a GET has none.
   *
   * **This is a bearer capability and it leaves the permission model behind.**
   * Nacre checks `read` once, when the link is minted, and the object store
   * checks nothing afterwards — a revocation during the window does not reach a
   * URL already handed out, and neither does a delete. That is what presigning
   * is, in every implementation of it, and it is why the lifetime is a
   * configured number rather than a constant: `NACRE_PRESIGN_TTL` is how long a
   * deployment is willing for that to be true.
   *
   * It is also why the caller of this decides, not this: minting one per search
   * hit would issue ten capabilities to answer a question about relevance, most
   * never followed. See the note on the search response.
   */
  presign(key: string, ttlSeconds: number): string {
    const { region, accessKey, secretKey } = this.#options
    const url = this.#url(key)
    const now = new Date()
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`

    // Sorted by key, and encoded the same way the canonical request will be —
    // a mismatch between the query that is signed and the query that is sent is
    // a 403 with nothing in it about which of the two was wrong.
    const params: [string, string][] = [
      ['X-Amz-Algorithm', ALGORITHM],
      ['X-Amz-Credential', `${accessKey}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(Math.max(1, Math.floor(ttlSeconds)))],
      ['X-Amz-SignedHeaders', 'host'],
    ]
    const canonicalQuery = params
      .map(([k, v]) => [encodeSegment(k), encodeSegment(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&')

    const canonicalRequest = [
      'GET',
      url.pathname,
      canonicalQuery,
      `host:${url.host}\n`,
      'host',
      UNSIGNED,
    ].join('\n')

    const stringToSign = [ALGORITHM, amzDate, scope, sha256(canonicalRequest)].join('\n')
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), SERVICE),
      'aws4_request',
    )
    const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')

    return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
  }

  /**
   * Whether the bucket answers, for readiness.
   *
   * A HEAD on the bucket rather than on an object: it needs no key to exist and
   * it fails for the three reasons that matter — unreachable, wrong bucket,
   * wrong credential. A TCP connect would pass all three.
   */
  async ready(): Promise<boolean> {
    const url = this.#options.forcePathStyle
      ? new URL(`${this.#options.endpoint}/${this.#options.bucket}`)
      : this.#url('')
    const headers = this.#sign({
      method: 'HEAD',
      url,
      payloadHash: UNSIGNED,
      headers: {},
      now: new Date(),
    })
    const response = await fetch(url, { method: 'HEAD', headers })
    if (!response.ok) {
      throw new S3Error(response.status, 'HEAD', this.#options.bucket, response.statusText)
    }
    return true
  }
}

/**
 * Where a document's bytes live.
 *
 * Derived from identity — organization, layer, external id — and never from the
 * content. Content addressing would let two documents share an object, and then
 * deleting one would either strand the other or need a reference count that
 * nothing else in this system has. One document, one object, and a re-ingest
 * overwrites in place.
 *
 * The external id is hashed rather than escaped: it is caller-chosen text that
 * may contain anything, and a key derived by escaping is a key whose length and
 * shape a caller controls.
 */
export function documentKey(orgId: string, layerId: string, externalId: string): string {
  return `org/${orgId}/layer/${layerId}/${sha256(externalId)}`
}
