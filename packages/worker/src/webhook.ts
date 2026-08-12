import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Announcing that a document reached a terminal state.
 *
 * `docs/api.md` has said "there is no completion callback: a client polls
 * `GET /v1/jobs/{id}`" since the API existed, and for a product whose caller is
 * an agent that is the wrong half of the trade. Polling is a loop inside
 * somebody's tool, and a tool that stops looping loses the document.
 *
 * Three properties, and each is a refusal of an easier design.
 *
 * **The URL is the operator's and never a tenant's.** A callback destination
 * chosen through the API would be an authenticated caller pointing this
 * installation at an address of their choosing — the outbound-request surface
 * `NACRE_PARSER_ALLOW_PRIVATE_URLS` exists to bound on the one service that
 * already had it. Per-organization callbacks are a real feature and they need a
 * destination allowlist to be one; this is the version that does not pretend.
 *
 * **It is signed, or it does not exist.** `loadConfig` refuses a URL without a
 * secret, because a receiver cannot tell an unsigned callback from anybody
 * else's POST to the same address, and "document X is indexed" is worth forging
 * to whoever wants a pipeline to act on it. The timestamp is inside the signed
 * material rather than beside it, so a captured body cannot be replayed later
 * with a fresh one.
 *
 * **A failure to deliver never fails the document.** The document is indexed;
 * the announcement is a courtesy on top. Anything else would make an unrelated
 * outage upstream look like an ingest failure, and the recovery for that is
 * re-indexing a corpus that was already fine.
 */

export interface Completion {
  readonly documentId: string
  readonly externalId: string
  readonly layerId: string
  readonly orgId: string
  readonly status: 'indexed' | 'failed'
  readonly chunkCount: number
  /** The worker's message, for `failed`. `null` otherwise. */
  readonly error: string | null
}

export interface WebhookOptions {
  readonly url: string
  readonly secret: string
  readonly attempts: number
  readonly fetch?: typeof globalThis.fetch
  /** Injected by the tests; real delivery waits between attempts. */
  readonly wait?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly onFailure?: (detail: { attempts: number; reason: string }) => void
}

/**
 * `sha256=<hex>` over `${timestamp}.${body}`.
 *
 * The timestamp is part of what is signed rather than a separate header the
 * receiver is trusted to check, which is the difference between a signature
 * that proves origin and one that also bounds age. Exported because a receiver
 * has to reproduce it, and the documentation quotes this function rather than
 * describing it — a description is a second implementation.
 */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

/** Constant-time comparison, for a receiver written against this module. */
export function verify(secret: string, timestamp: number, body: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, timestamp, body))
  const given = Buffer.from(signature)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/**
 * What the callback carries, and deliberately not what it could.
 *
 * No text, no title, no metadata. The document's *contents* are what this
 * product exists to keep inside a permission boundary, and a callback is a
 * request leaving the installation to an address with no principal attached to
 * it — there is nothing on the other end to evaluate a grant against. So it
 * carries identifiers and a status, which is what a pipeline needs to go and
 * ask for the rest through the API, as itself.
 *
 * `external_id` is in it because that is the name the caller chose and the one
 * they can act on without a lookup.
 */
export function body(completion: Completion): string {
  return JSON.stringify({
    event: `document.${completion.status}`,
    document_id: completion.documentId,
    external_id: completion.externalId,
    layer_id: completion.layerId,
    org_id: completion.orgId,
    status: completion.status,
    chunk_count: completion.chunkCount,
    error: completion.error,
  })
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * Deliver, and give up quietly.
 *
 * Retries only what retrying can fix. A `400` or a `401` from the receiver is
 * an answer — the body is wrong or the signature is not accepted — and sending
 * it four more times changes nothing while delaying every document behind it.
 */
export async function deliver(completion: Completion, options: WebhookOptions): Promise<boolean> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const wait = options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now

  const payload = body(completion)
  let reason = 'no attempt was made'

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const timestamp = Math.floor(now() / 1000)
    try {
      const response = await send(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nacre-event': `document.${completion.status}`,
          'x-nacre-timestamp': String(timestamp),
          'x-nacre-signature': sign(options.secret, timestamp, payload),
        },
        body: payload,
        // A receiver that hangs must not hold a worker. Ten seconds is long for
        // an acknowledgement and short against the next document.
        signal: AbortSignal.timeout(10_000),
      })

      if (response.ok) return true

      reason = `${response.status} ${response.statusText}`
      if (!RETRYABLE.has(response.status)) break
    } catch (cause) {
      reason = cause instanceof Error ? cause.message : String(cause)
    }

    // Doubling from a second, and only between attempts — a sleep after the
    // last one is time spent achieving nothing.
    if (attempt < options.attempts) await wait(1000 * 2 ** (attempt - 1))
  }

  options.onFailure?.({ attempts: options.attempts, reason })
  return false
}
