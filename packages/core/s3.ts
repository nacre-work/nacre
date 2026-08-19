import { createHash, createHmac } from 'node:crypto'

import { logger } from './logging.js'

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
 * Five operations are needed: put, get, delete, head, list. `@aws-sdk/client-s3`
 * is **22 MB across 26 packages**, measured with `--omit=dev` at 3.1113.0 rather
 * than remembered — this paragraph said "tens of megabytes and hundreds of
 * transitive packages", which was true of v3 before it consolidated its clients
 * and is not true now. The argument survives the correction and is smaller than
 * it was: 22 MB of somebody else's code in a container whose job is reading
 * documents other people send it, for five operations, which is the argument
 * `metrics.ts` already makes for not taking prom-client. SigV4 is a documented
 * algorithm with a published set of test vectors, it fits in this file, and it
 * has no release cadence to track.
 *
 * What the SDK would genuinely buy is **credential providers** — IRSA, an
 * instance role, SSO — which this client has no answer to beyond a static key
 * pair. If that is ever needed the shape is `@aws-sdk/credential-providers`
 * feeding a session token into the signer below, not the whole client: the
 * signing is the part that is written and verified, and the credentials are the
 * part that is not.
 *
 * The rule that comes with that choice: **anything here is verified against a
 * real MinIO before it is believed**, because a signing bug produces a 403 that
 * says nothing about which of the six inputs was wrong.
 *
 * ─── what is deliberately not here ───
 *
 * No multipart upload, so an object is one PUT and `NACRE_MAX_DOCUMENT_BYTES`
 * bounds it. Nothing streams either: a body is a `Uint8Array` in and out, which
 * is affordable only because every object here is bounded — 8 MiB for an
 * archive part, `NACRE_MAX_DOCUMENT_BYTES` for a document — and because the
 * caller already holds the whole thing anyway. A streaming client would not
 * lower peak memory without reworking the ingest path that buffers to hash.
 *
 * **Retries were on that list and are not any more, for the same reason
 * listing was.** The argument given was that the callers — the ingest queue and
 * the collector — already retry whole units of work. That was true of them and
 * is not true of the caller that arrived afterwards: `backup`'s `verify` and
 * `restore` read an archive part by part, so a 1.6 GB artifact is two hundred
 * GETs, and one transient `503` from a real cloud store ended the whole restore
 * — the operation somebody runs when the database is already gone. See
 * `RetryPolicy`.
 *
 * **Listing was on that list and is not any more.** The reason given was that
 * nothing needed to enumerate a bucket; the backup module's archive reader
 * does, to refuse a part its manifest does not name, and that refusal is a
 * property an archive on a disk has and one in a bucket must not lose. A reason
 * that has stopped being true is corrected here rather than worked around at
 * the caller — the alternative was a stray-part check that holds for one
 * destination and not its sibling, which is the most repeated defect this
 * repository records.
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

  /**
   * How hard to try again. `DEFAULT_RETRIES` where absent.
   *
   * Deliberately **not** an environment variable. Every `NACRE_*` this product
   * has is one somebody sets and then believes something about, and there is
   * nothing an operator would set here that the default gets wrong — a store
   * that needs a different policy needs a different store. The field exists
   * because `backup` reads two hundred parts in a row and may one day want a
   * wider budget than a single ingest does, which is a decision code makes.
   */
  readonly retries?: Partial<RetryPolicy>

  /** Told about each retry. Defaults to a `warn` line; see the constructor. */
  readonly onRetry?: (notice: RetryNotice) => void

  /**
   * The three seams a test needs, and the reason they are here rather than in a
   * test double: what is under test is *when* this client tries again, and a
   * double that replaces the loop proves the double. Waiting a real 100 ms four
   * times over is a suite that runs slower for no assertion, and a jitter drawn
   * from `Math.random` is a case that cannot say what it measured.
   */
  readonly sleep?: (ms: number) => Promise<void>
  readonly random?: () => number
  readonly clock?: () => number
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

/**
 * When a request is worth sending again, and how long to wait first.
 *
 * ## What is retried, and what deliberately is not
 *
 * A transport failure — a reset connection, a DNS blip, a TLS handshake that
 * did not finish — and a `5xx`, and `429`. Nothing else. A `403` is a
 * signature, a credential or a policy, and every attempt re-signs with the same
 * inputs, so retrying one spends the budget to arrive at the same answer; the
 * worst version of that is `RequestTimeTooSkewed`, where the clock is wrong and
 * four identical refusals hide a one-line diagnosis. A `404` is an answer. A
 * `400` is a request this store will never accept. `501` is the one status in
 * the 5xx range that is permanent — the store does not implement the operation
 * — so it is excluded by name rather than by falling under `>= 500`.
 *
 * ## Every operation here is idempotent, and that is a property rather than a hope
 *
 * `GET`, `HEAD`, `DELETE` and a listing trivially. `PUT` because a key here is
 * derived from identity — `documentKey` from the organization, layer and
 * external id; an archive part from its index — never from a sequence, so
 * sending the same bytes to the same key twice is one object either way. And
 * because the body is a `Uint8Array` this process still holds, so an attempt is
 * replayable **byte for byte**. A client that streamed its body could not make
 * that claim, which is the reason a streaming rewrite would have to revisit
 * this and not merely inherit it.
 *
 * ## Full jitter, not a doubling delay
 *
 * The callers are a fleet: worker replicas share a bucket, and a blip they all
 * see is a blip they would all retry from at the same instant. So the wait is
 * `random() × min(cap, base × 2^n)` — the whole window, not half of it —
 * because what has to be spread is the retry of every replica, and equal jitter
 * leaves half the delay in lockstep.
 *
 * `Retry-After` overrides the formula where the store sends one, since a server
 * saying how long it wants knows better than a constant here; it is still
 * capped, or a hostile or mistaken value would park a restore for an hour.
 *
 * ## A budget as well as a count
 *
 * `attempts` alone bounds one request. A restore reads two hundred parts, so
 * four attempts each with a five second ceiling is a run that can spend twenty
 * minutes discovering the store is down. `budgetMs` is the wall-clock bound on
 * one operation, checked *before* sleeping — so the failure arrives while
 * somebody is still watching.
 */
export interface RetryPolicy {
  /** Total attempts including the first. `1` disables retrying entirely. */
  readonly attempts: number
  /** The first backoff window, in milliseconds. Doubles each attempt. */
  readonly baseDelayMs: number
  /** The ceiling on any one wait, `Retry-After` included. */
  readonly maxDelayMs: number
  /** Wall-clock bound on one operation, retries and waits included. */
  readonly budgetMs: number
}

/**
 * Four attempts inside thirty seconds.
 *
 * Chosen against the caller that needed this rather than as a round number: a
 * restore reads its parts in sequence, so the cost of the policy is paid per
 * part, and thirty seconds × two hundred parts is already the outer edge of
 * what somebody will sit through before deciding the store is down. Three
 * retries at 100/200/400 ms of window absorbs the transient answers a real
 * store gives; anything past that is an outage rather than a blip, and waiting
 * longer only delays the sentence that says so.
 */
export const DEFAULT_RETRIES: RetryPolicy = {
  attempts: 4,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  budgetMs: 30_000,
}

/**
 * Whether a status is worth asking again.
 *
 * Exported because it is the whole of the policy's judgement and a test that
 * re-derives it is a test of its own copy.
 */
export function worthRetrying(status: number): boolean {
  if (status === 429) return true
  // Permanent, and the only 5xx that is: the store is telling you it does not
  // have this operation. Asking again gets the same answer more slowly.
  if (status === 501) return false
  return status >= 500
}

/**
 * `Retry-After`, in milliseconds, or nothing.
 *
 * Both forms RFC 9110 allows: a count of seconds, and an HTTP-date. The second
 * is what a proxy in front of a store tends to send, and reading only the first
 * would silently fall back to the formula for exactly those deployments.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header === null) return undefined
  const trimmed = header.trim()
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  if (Number.isNaN(at)) return undefined
  // A date in the past is "now", not a negative wait.
  return Math.max(0, at - now)
}

/** What a caller is told about a retry that happened. */
export interface RetryNotice {
  readonly method: string
  readonly key: string
  readonly attempt: number
  readonly of: number
  readonly delayMs: number
  readonly status?: number
  readonly error?: string
}

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

/**
 * RFC 3986 percent-encoding, which `encodeURIComponent` is close to and not.
 *
 * It leaves `!'()*` unescaped and SigV4 requires them escaped, so a key or a
 * prefix containing one signs differently at each end — a `403` naming none of
 * its inputs, which is the failure mode this whole file is written against.
 */
function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * The canonical query string: sorted by key, both halves encoded, `=` even for
 * an empty value.
 *
 * This line used to be unconditionally empty with a comment saying no request
 * here takes a query string. One does now, and an empty line for a request that
 * has parameters is a signature over a different request than the one sent.
 */
function canonicalQuery(url: URL): string {
  const pairs: [string, string][] = []
  for (const [name, value] of url.searchParams) pairs.push([name, value])
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return pairs.map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`).join('&')
}

/**
 * The escaping a bucket applies to a key in its listing, undone.
 *
 * **Numeric references and not only the five named ones**, which a real MinIO
 * is what showed: it returns an apostrophe as `&#39;` rather than `&apos;`, so
 * a key containing one came back with the reference still in it. On the caller
 * this exists for — the backup archive's stray-part check — that is a name the
 * manifest does not match, and the refusal that follows condemns a perfectly
 * good archive. Found by listing a key with `!'()*` in it against the real
 * thing, which is this file's own rule.
 *
 * `&amp;` is undone last, or `&amp;lt;` — an ampersand somebody actually put in
 * a key — becomes a `<`.
 */
function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export class S3 {
  readonly #options: S3Options
  readonly #retries: RetryPolicy
  readonly #onRetry: (notice: RetryNotice) => void
  readonly #sleep: (ms: number) => Promise<void>
  readonly #random: () => number
  readonly #clock: () => number

  constructor(options: S3Options) {
    this.#options = { ...options, endpoint: options.endpoint.replace(/\/+$/, '') }
    this.#retries = { ...DEFAULT_RETRIES, ...options.retries }
    // Logged from here rather than wired at each construction site. The client
    // is built in three entry points — the API, the worker and the MCP
    // transport — and a notice a caller has to remember to pass is a notice two
    // of the three would not have. A retry that happens silently is a system
    // that got slower for a reason nothing recorded.
    this.#onRetry =
      options.onRetry ??
      ((notice) => {
        logger.warn('s3 request retried', { ...notice })
      })
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.#random = options.random ?? Math.random
    this.#clock = options.clock ?? Date.now
  }

  get bucket(): string {
    return this.#options.bucket
  }

  /** The bucket itself, which is what a listing addresses rather than a key. */
  #bucketUrl(): URL {
    const { endpoint, bucket, forcePathStyle } = this.#options
    if (forcePathStyle) return new URL(`${endpoint}/${bucket}`)
    const url = new URL(endpoint)
    url.host = `${bucket}.${url.host}`
    url.pathname = '/'
    return url
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
      canonicalQuery(input.url),
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

  /**
   * Sign and send, trying again where that is the right thing to do.
   *
   * **One place, and that is the whole design rather than tidiness.** Three
   * methods built a request before this existed — `#send` for put/get/remove,
   * `list` for a paginated GET on the bucket, `ready` for a HEAD on it — each
   * calling `fetch` itself, with nothing that knew there were three. A retry
   * added to `#send` alone would have left a restore's *listing* unretried,
   * which is the request that decides whether the archive's parts are all
   * there: the check that refuses a stray part would have become the check that
   * fails on a blip. So the loop is here and those three are its callers.
   *
   * **Re-signed on every attempt, never replayed.** `x-amz-date` is inside the
   * signature and S3 refuses a request more than fifteen minutes old, so
   * reusing the first attempt's headers after a backoff makes the second
   * failure a different failure from the first — which is the worst shape a
   * retry can have, because it hides the reason the request was retried.
   *
   * The body of a response that is going to be retried is cancelled rather than
   * read: an error document is small but a `5xx` from a proxy can carry a page
   * of HTML, and a stream left unread holds a socket. The response that is
   * finally returned has its body intact, because the caller builds `S3Error`
   * out of it.
   */
  async #signedFetch(input: {
    method: string
    key: string
    url: URL
    payloadHash: string
    body?: Uint8Array
    headers?: Record<string, string>
    /** Overrides the client's policy. `ready` is the one caller that does. */
    retries?: Partial<RetryPolicy>
  }): Promise<Response> {
    const started = this.#clock()
    const { attempts, baseDelayMs, maxDelayMs, budgetMs } = {
      ...this.#retries,
      ...input.retries,
    }

    for (let attempt = 1; ; attempt += 1) {
      const headers = this.#sign({
        method: input.method,
        url: input.url,
        payloadHash: input.payloadHash,
        headers: input.headers ?? {},
        now: new Date(this.#clock()),
      })

      let response: Response | undefined
      let failure: unknown

      try {
        response = await fetch(input.url, {
          method: input.method,
          headers,
          ...(input.body === undefined ? {} : { body: input.body }),
        })
      } catch (cause) {
        failure = cause
      }

      if (response !== undefined && !worthRetrying(response.status)) return response

      const last = attempt >= attempts
      // Full jitter over the whole window. See `RetryPolicy`.
      const window = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const named =
        response === undefined
          ? undefined
          : retryAfterMs(response.headers.get('retry-after'), this.#clock())
      const delay = Math.min(maxDelayMs, named ?? Math.floor(this.#random() * window))
      const spent = this.#clock() - started
      const affordable = spent + delay <= budgetMs

      if (last || !affordable) {
        // Out of attempts or out of budget. A transport failure has no response
        // to hand back, so the original error is thrown — which is what this
        // client did for every failure before there were retries.
        if (response !== undefined) return response
        throw failure
      }

      response?.body?.cancel().catch(() => undefined)
      this.#onRetry({
        method: input.method,
        key: input.key,
        attempt,
        of: attempts,
        delayMs: delay,
        ...(response === undefined ? {} : { status: response.status }),
        ...(failure === undefined ? {} : { error: String(failure).slice(0, 200) }),
      })
      await this.#sleep(delay)
    }
  }

  async #send(
    method: string,
    key: string,
    body?: Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    // **No `content-length` anywhere below.** It is a forbidden request header:
    // the Fetch standard says the runtime computes it from the body, and undici
    // 7 stopped tolerating one set by hand — `InvalidArgumentError: invalid
    // content-length header`, thrown before the request leaves. Node 22 ships
    // undici 6 and accepted it; Node 24 ships 7 and does not, so this was every
    // PUT failing on the next Node.
    //
    // SigV4 does not need it signed. What binds the body is
    // `x-amz-content-sha256`, which is in the canonical request either way — a
    // body that changes in flight still fails the signature rather than being
    // stored.
    //
    // Found by running this client under a runtime that had already moved:
    // vitest brings its own undici 7, so the live case failed where a plain
    // `node` script passed.
    return this.#signedFetch({
      method,
      key,
      url: this.#url(key),
      payloadHash: body === undefined ? UNSIGNED : sha256(body),
      ...(body === undefined ? {} : { body }),
      headers: extraHeaders,
    })
  }

  /**
   * Every key under a prefix, following the continuation token to the end.
   *
   * **Paginated properly rather than bounded**, because the caller that needs
   * this is the backup archive's stray-part check: a truncated list makes that
   * check quietly weaker instead of failing, and a weaker refusal that reports
   * success is worse than none. S3 caps a page at 1000 keys whatever
   * `max-keys` asks for, so "one request is enough" is a property of small
   * archives rather than of the protocol.
   *
   * Keys and nothing else — sizes and timestamps have no caller, and this file
   * stays small by not answering questions nobody asked.
   *
   * The XML is read with two regular expressions rather than a parser. That is
   * a deliberate limit and it is safe for exactly one reason: `<Key>` holds
   * text the *bucket* produced from keys this installation wrote, and the only
   * escaping S3 applies there is the standard five entities, which are undone
   * below. A parser dependency for two fields would be the larger risk on a
   * path that already refuses to grow one.
   */
  async list(prefix: string): Promise<readonly string[]> {
    const keys: string[] = []
    let token: string | undefined

    // A bound on requests, not on keys: without one a bucket answering with a
    // token that never clears is an infinite loop inside a backup verification.
    for (let page = 0; page < 10_000; page += 1) {
      const url = this.#bucketUrl()
      url.searchParams.set('list-type', '2')
      url.searchParams.set('prefix', prefix)
      if (token !== undefined) url.searchParams.set('continuation-token', token)

      const response = await this.#signedFetch({
        method: 'GET',
        key: `${prefix}*`,
        url,
        payloadHash: UNSIGNED,
      })
      if (!response.ok) {
        throw new S3Error(response.status, 'GET', `${prefix}*`, await response.text())
      }
      const xml = await response.text()

      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/gu)) {
        keys.push(unescapeXml(match[1] ?? ''))
      }

      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/iu.test(xml)
      if (!truncated) return keys
      const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/u.exec(xml)?.[1]
      // Truncated and no token is the bucket contradicting itself. Refusing
      // beats returning a list the caller will treat as complete.
      if (next === undefined || next === '') {
        throw new S3Error(200, 'GET', `${prefix}*`, 'truncated listing with no continuation token')
      }
      token = unescapeXml(next)
    }
    throw new S3Error(200, 'GET', `${prefix}*`, 'listing did not end after 10000 pages')
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
    const response = await this.#signedFetch({
      method: 'HEAD',
      key: this.#options.bucket,
      url,
      payloadHash: UNSIGNED,
      // **One attempt, and this is the one caller that says so.** A readiness
      // probe's whole job is to answer now: retrying inside it for thirty
      // seconds turns "the bucket is not answering" into no answer at all, and
      // an orchestrator reads a probe that times out as a pod to kill rather
      // than as a dependency that is down. The retries exist for work that has
      // somewhere to get back to; a probe's caller is the next probe.
      retries: { attempts: 1 },
    })
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
