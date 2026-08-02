import type { Redis } from '@nacre.work/core'

/**
 * Rate limiting, per organization.
 *
 * **Per organization and not per token**, which is the whole point: a limit
 * counted per credential is bypassed by minting another credential, and this
 * product hands out service account keys through an endpoint.
 *
 * A fixed window rather than a sliding one. The cost is a burst at the
 * boundary — a caller can spend a full window at 11:59:59 and another at
 * 12:00:00 — and the benefit is that the whole thing is one `INCR` against a
 * key whose name contains the window, so there is no set to trim and nothing to
 * clean up. Stated rather than hidden because "60 per minute" is not quite what
 * the boundary delivers.
 *
 * ## Failing open, deliberately
 *
 * If Redis is unreachable the request is **allowed**. That is the opposite of
 * invariant I3, and the difference is the point: I3 is about permissions, where
 * an unanswerable question must deny. A rate limit is availability protection,
 * and failing closed would turn a Redis restart into a total outage of a
 * product whose selling point is that it runs in your own network. The
 * degradation is logged, and `nacre_rate_limit_unavailable_total` is what an
 * operator alerts on.
 */

/**
 * What a limit is counted against.
 *
 * `search` and `ingest` are counted per organization — a per-token limit is
 * bypassed by issuing another key, and this API hands out keys. `login` is the
 * exception and has to be: it runs before there is an organization, and the
 * thing it defends against is guessing one account's password, so it counts per
 * address. Failing open matters more there rather than less: a cache outage
 * that locked everyone out of signing in would be the outage.
 */
export type Resource = 'search' | 'ingest' | 'login'

export interface LimitDecision {
  readonly allowed: boolean
  /** RFC 9331 `RateLimit-Limit`. */
  readonly limit: number
  /** RFC 9331 `RateLimit-Remaining`, never negative. */
  readonly remaining: number
  /** Seconds until the window resets — `RateLimit-Reset` and `Retry-After`. */
  readonly reset: number
  /** True when the check could not run and the request was let through. */
  readonly degraded: boolean
}

export interface LimitPolicy {
  /** Requests allowed per window. */
  readonly limit: number
  /** Window length in seconds. */
  readonly windowSeconds: number
}

export interface RateLimiterOptions {
  readonly redis: Redis
  readonly policies: Readonly<Record<Resource, LimitPolicy>>
  readonly onDegraded?: (resource: Resource, error: unknown) => void
}

export class RateLimiter {
  constructor(private readonly options: RateLimiterOptions) {}

  async check(orgId: string, resource: Resource): Promise<LimitDecision> {
    const policy = this.options.policies[resource]
    const windowMs = policy.windowSeconds * 1000
    const now = Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const reset = Math.ceil((windowStart + windowMs - now) / 1000)

    // The window is in the key, so a stale key belongs to a window nobody will
    // ask about again and expiry is the only cleanup there is.
    const key = `nacre:rl:${resource}:${orgId}:${windowStart}`

    try {
      // INCR and PEXPIRE together: one round trip, and the TTL is refreshed on
      // every hit rather than only on the first. Setting it once would leave
      // the key immortal if the process died in between, and refreshing a
      // window-scoped key changes nothing about when it actually expires.
      const [count] = await this.options.redis.pipeline(
        ['INCR', key],
        ['PEXPIRE', key, String(windowMs + 1000)],
      )

      const used = typeof count === 'number' ? count : Number(count ?? 0)
      return {
        allowed: used <= policy.limit,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - used),
        reset,
        degraded: false,
      }
    } catch (error) {
      this.options.onDegraded?.(resource, error)
      return {
        allowed: true,
        limit: policy.limit,
        // Reporting the full allowance would claim a budget nothing is
        // counting. Reporting the truth — the check did not run — is what the
        // `degraded` flag is for, and the headers say the limit rather than a
        // remaining figure that would be fiction.
        remaining: policy.limit,
        reset,
        degraded: true,
      }
    }
  }
}

/**
 * RFC 9331 headers, plus `Retry-After` when the answer is 429.
 *
 * `RateLimit-Policy` names the window so a client can tell 60/minute from
 * 60/hour without guessing from `Reset`.
 */
export function limitHeaders(
  decision: LimitDecision,
  policy: LimitPolicy,
  resource: Resource,
): Record<string, string> {
  const headers: Record<string, string> = {
    'ratelimit-limit': String(decision.limit),
    'ratelimit-remaining': String(decision.remaining),
    'ratelimit-reset': String(decision.reset),
    'ratelimit-policy': `${resource};q=${policy.limit};w=${policy.windowSeconds}`,
  }
  if (!decision.allowed) headers['retry-after'] = String(decision.reset)
  return headers
}
