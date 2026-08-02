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
 * ## Scoped to the organization and to the request
 *
 * The cache key mixes the key the caller sent with the organization from the
 * token, the method, the path, **and a hash of the body**. Two of those are not
 * optional:
 *
 * The organization, because a key is a string the caller chose. Without it,
 * `Idempotency-Key: 1` from one tenant would hand another tenant's cached
 * response to whoever asked next — a cross-tenant leak through a cache, which
 * is invariant I1 broken by a convenience feature.
 *
 * The body, because reusing a key with different content is a client bug, and
 * the useful answer to it is `409` rather than silently replaying the first
 * result. A caller who changes the payload and keeps the key is not asking for
 * the old answer.
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
  begin(key: string, orgId: string, method: string, path: string, body: unknown): Promise<Outcome>
}

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
    orgId: string,
    method: string,
    path: string,
    body: unknown,
  ): Promise<Outcome> {
    const fingerprint = digest(JSON.stringify({ method, path, body: body ?? null }))
    // The organization first, so the namespace cannot be crossed by a key the
    // caller picked.
    const cacheKey = `nacre:idem:${orgId}:${digest(key)}`

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
