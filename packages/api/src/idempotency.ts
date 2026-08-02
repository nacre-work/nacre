import { createHash } from 'node:crypto'

import type { Redis } from '@nacre.work/core'

/**
 * `Idempotency-Key`, cached for 24 hours.
 *
 * `POST /v1/documents` does not need this — it is idempotent on
 * `(layer, external_id)` and the content hash, which is a stronger guarantee
 * because it survives the cache expiring. This is for everything else unsafe:
 * issuing a grant, revoking one, creating a service account. A client that
 * times out and retries should not end up with two accounts.
 *
 * ## Scoped to the caller, not to the tenant
 *
 * The cache key mixes the key the caller sent with the organization, **the
 * principal**, the method, the path, and a hash of the body. Three of those are
 * not optional.
 *
 * The organization, because a key is a string the caller chose: without it,
 * `Idempotency-Key: 1` from one tenant hands another tenant's response to
 * whoever asks next.
 *
 * The principal, for the same reason one level down, and this one was missing.
 * Two principals in one organization see different things — that is the whole
 * product — so a cache scoped to the tenant let any of them replay any other's
 * response, verbatim and unchecked, because a replay is sent before any handler
 * runs. It bypassed the pre-filter (invariant 2), handed read results to a
 * `write`-only service account (invariant 6), and kept serving a principal
 * whose grant had been revoked for a further 24 hours (invariant 4).
 *
 * The body, because reusing a key with different content is a client bug, and
 * the useful answer to it is `409` rather than silently replaying the first
 * result. A caller who changes the payload and keeps the key is not asking for
 * the old answer.
 *
 * ## Only responses, and only successful ones
 *
 * A failure is never stored. The point is to stop a retry repeating an
 * **effect**, and a request that failed had none — while a cached `500` makes a
 * transient fault permanent for a day and denies the retry the feature exists
 * to serve.
 *
 * ## Failing open
 *
 * If Redis is unreachable the request is processed normally, uncached. The risk
 * is a duplicate on a retry, which is what the feature exists to prevent — so
 * this is a real degradation, logged as one. The alternative is refusing writes
 * because a cache is down, which trades a rare duplicate for a certain outage.
 */

const TTL_SECONDS = 24 * 60 * 60

/** Long enough that a collision is not a thing, short enough to read in a log. */
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('base64url').slice(0, 32)

export interface CachedResponse {
  readonly status: number
  readonly body: unknown
}

export interface Replay {
  /** The response to send back verbatim. */
  readonly cached: CachedResponse
}

export interface Conflict {
  /** The same key was used for a different request. */
  readonly conflict: true
}

export interface Proceed {
  /** Nothing cached; run the handler and call `store`. */
  readonly proceed: true
  store(status: number, body: unknown): Promise<void>
}

export type Outcome = Replay | Conflict | Proceed

export const isReplay = (o: Outcome): o is Replay => 'cached' in o
export const isConflict = (o: Outcome): o is Conflict => 'conflict' in o

/**
 * What the server needs, which is one method.
 *
 * Named separately from the class so that a test can record what reaches the
 * cache without standing up a Redis — and the thing worth recording is *which
 * responses get there at all*, since one of them must never.
 */
export interface IdempotencyStore {
  begin(
    key: string,
    principal: Principal,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Outcome>
}

/**
 * Who a cached response belongs to.
 *
 * A response is cached for the principal that produced it and for nobody else.
 * Two principals in one organization are as separate here as two organizations
 * are — they see different things, which is the entire product.
 */
export interface Principal {
  readonly orgId: string
  readonly type: string
  readonly id: string
}

/** Organization, then principal. Both, in that order, so neither can be crossed. */
const orgId = (p: Principal): string => `${p.orgId}:${p.type}:${p.id}`

export interface IdempotencyOptions {
  readonly redis: Redis
  readonly onDegraded?: (error: unknown) => void
}

export class Idempotency implements IdempotencyStore {
  constructor(private readonly options: IdempotencyOptions) {}

  /**
   * Look up a key, or reserve it.
   *
   * `SET NX` is what makes two concurrent retries safe: exactly one reserves
   * the slot and runs the handler, and the other sees a reservation rather than
   * a result. A reservation is reported as a conflict — the honest answer to
   * "the first attempt is still in flight" is not to replay a response that
   * does not exist yet.
   */
  async begin(
    key: string,
    principal: Principal,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Outcome> {
    const fingerprint = digest(JSON.stringify({ method, path, body: body ?? null }))
    // The organization AND the principal, and the second one is not optional.
    //
    // Scoped to the organization alone, this was a cross-principal read: the
    // key is a string the caller chose, so any principal in the tenant who
    // presented the same key and the same body was handed whatever the first
    // one got — replayed verbatim, with no permission check on the way out,
    // because the cached response is sent before any handler runs.
    //
    // That is invariant 2 bypassed (the answer comes from a cache rather than
    // from a filtered index traversal), invariant 6 bypassed (a `write`-only
    // service account receives read results), and invariant 4 defeated for
    // 24 hours (a principal whose grant was revoked replays their own key and
    // keeps being served). One convenience feature, four rules.
    const cacheKey = `nacre:idem:${orgId(principal)}:${digest(key)}`

    try {
      const existing = await this.options.redis.command('GET', cacheKey)

      if (typeof existing === 'string') {
        const record = JSON.parse(existing) as {
          fingerprint: string
          status?: number
          body?: unknown
          pending?: boolean
        }
        if (record.fingerprint !== fingerprint) return { conflict: true }
        if (record.pending === true) return { conflict: true }
        return { cached: { status: record.status as number, body: record.body } }
      }

      const reserved = await this.options.redis.command(
        'SET',
        cacheKey,
        JSON.stringify({ fingerprint, pending: true }),
        'NX',
        'EX',
        String(TTL_SECONDS),
      )

      // Somebody else reserved it between the GET and the SET.
      if (reserved === null) return { conflict: true }

      return {
        proceed: true,
        store: async (status, responseBody) => {
          // Only what succeeded. A cached failure is never useful and is often
          // harmful: the point of this cache is to stop a retry repeating an
          // *effect*, and a request that failed had none to repeat. Storing one
          // makes a transient 500 permanent for 24 hours and turns the retry
          // the feature exists to serve into the one thing it cannot do.
          if (status >= 400) {
            await this.options.redis.command('DEL', cacheKey).catch(() => undefined)
            return
          }

          try {
            await this.options.redis.command(
              'SET',
              cacheKey,
              JSON.stringify({ fingerprint, status, body: responseBody }),
              'EX',
              String(TTL_SECONDS),
            )
          } catch (error) {
            // The work is already done and the caller is getting their answer.
            // Losing the cache entry means a retry redoes it, which is the
            // situation before this feature existed.
            this.options.onDegraded?.(error)
          }
        },
      }
    } catch (error) {
      this.options.onDegraded?.(error)
      return { proceed: true, store: async () => {} }
    }
  }
}
