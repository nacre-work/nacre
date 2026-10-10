import { organizationLimits, type Config, type OrganizationLimit, type Redis } from '@nacre.work/core'

/**
 * Rate limiting: per organization for the costly operations, per principal for
 * everything, per address and per client for sign-in, per client for client
 * registration.
 *
 * **Per organization and per principal, never per token**, which is the whole
 * point: a limit counted per credential is bypassed by minting another
 * credential, and this product hands out service account keys through an
 * endpoint. A delegation counts as the person it acts for, so connecting a
 * tenth application does not buy a tenth budget.
 *
 * ## A sliding window, and a refusal costs nothing
 *
 * The count is a weighted sum of two fixed windows — the previous one scaled by
 * how much of it still overlaps the last `windowSeconds`, plus the current one.
 * It is the approximation Cloudflare documents, and it removes the fixed
 * window's boundary burst (a full budget at 11:59:59 and another at 12:00:00)
 * without keeping a timestamp per request. Each window is still one `INCR` on a
 * key whose name contains the window, so expiry is the only cleanup there is.
 *
 * **A refused request is given back.** The increment is undone when the answer
 * is no, so a client that keeps asking while refused does not push its own
 * recovery further away: it is let through as soon as the window has slid far
 * enough, and `Retry-After` says when that is — computed from the two windows
 * rather than "the end of this minute". That is the difference between a limit
 * that protects the server and one that locks a person out for longer than
 * their own traffic justifies.
 *
 * Concurrency stays exact. Every `INCR` returns a distinct count, the requests
 * whose count fits are allowed, and the undo only ever removes increments that
 * were refused, so it can never lift the allowed count past the limit.
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
 * - `requests` counts every authenticated request, on REST and on both MCP
 *   surfaces alike, per **principal** inside its organization. It is the one
 *   that keeps a single caller — a runaway agent, a script in a loop — from
 *   taking the server away from everybody else, and it is set high enough that
 *   a person working never meets it.
 * - `org_requests` counts every request of every caller in an organization
 *   together. It is what keeps one tenant from taking a shared installation away
 *   from the others, and it is counted only where a module holds an
 *   organization to one (`registerRateLimits`): with a single organization it
 *   would be a ceiling on the whole installation, which can only refuse
 *   somebody the hardware could have served.
 * - `search` and `ingest` are counted per **organization**, because they are
 *   what costs an embedding call; a per-token limit there is bypassed by issuing
 *   another key.
 * - `login` counts per email address and defends one account against being
 *   guessed at. On its own it is nearly useless against the attack people
 *   actually run: one password sprayed across ten thousand addresses never
 *   repeats a key.
 * - `login_source` counts per client and is what bounds that. It over-trusts
 *   topology — everyone behind one NAT shares a bucket — which is why it is the
 *   looser of the two and why the address limit stays.
 * - `client_registration` counts per client too: `POST /oauth/register` and a
 *   client metadata document this server fetches are the two things anybody
 *   can make it do before signing in, and the second is an outbound request.
 *
 * Failing open matters more on the sign-in ones rather than less: a cache
 * outage that locked everybody out of signing in would be the outage.
 */
export type Resource =
  | 'requests'
  | 'org_requests'
  | 'search'
  | 'ingest'
  | 'login'
  | 'login_source'
  | 'client_registration'

export interface LimitDecision {
  readonly allowed: boolean
  /** RFC 9331 `RateLimit-Limit`. */
  readonly limit: number
  /** RFC 9331 `RateLimit-Remaining`, never negative. */
  readonly remaining: number
  /**
   * Seconds until this request would fit — `Retry-After` on a refusal. On an
   * allowance, seconds until the current window rolls, which is when the
   * oldest of the counted requests starts to fall away.
   */
  readonly reset: number
  /** True when the check could not run and the request was let through. */
  readonly degraded: boolean
  /**
   * True on the first refusal of this subject in this window, and only then.
   *
   * What a caller records in the access log. Writing a row per refusal would
   * make the limit the door a flood comes through: a client hammering at a
   * thousand requests a second would be refused a thousand times a second, and
   * every refusal would be an insert.
   */
  readonly firstRefusal: boolean
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
  /** A seam for the clock, so a case can stand at a chosen point in a window. */
  readonly now?: () => number
}

/**
 * The policies, from the configuration, in one place.
 *
 * The API and the MCP transport share a limiter — same Redis, same keys — and
 * each used to spell this map out by hand. Two literals that must agree, with
 * nothing that knows there are two, is how the second process ends up with a
 * policy the first one does not have.
 */
export function limitPoliciesFrom(config: Pick<
  Config,
  | 'rateRequestsPerMin'
  | 'rateSearchPerMin'
  | 'rateIngestPerHour'
  | 'rateLoginPer15Min'
  | 'rateLoginSourcePer15Min'
  | 'rateClientRegistrationPerHour'
>): Readonly<Record<Resource, LimitPolicy>> {
  return {
    requests: { limit: config.rateRequestsPerMin, windowSeconds: 60 },
    // Not counted unless a module names a limit for the organization — see
    // `Resource`. The window is the installation's; the number is the module's.
    org_requests: { limit: 0, windowSeconds: 60 },
    search: { limit: config.rateSearchPerMin, windowSeconds: 60 },
    ingest: { limit: config.rateIngestPerHour, windowSeconds: 3600 },
    login: { limit: config.rateLoginPer15Min, windowSeconds: 900 },
    login_source: { limit: config.rateLoginSourcePer15Min, windowSeconds: 900 },
    client_registration: { limit: config.rateClientRegistrationPerHour, windowSeconds: 3600 },
  }
}

/**
 * The policy a request in this organization is held to, or `undefined` where
 * it is not counted.
 *
 * The window is always the installation's: a module changes how many, never
 * over how long, so two organizations' `RateLimit-Policy` headers stay
 * comparable and a key's name keeps meaning one window. A limit of zero is "not
 * counted", which is how `org_requests` stays off in the open core.
 */
export function policyFor(
  policies: Readonly<Record<Resource, LimitPolicy>>,
  resource: Resource,
  orgId?: string,
): LimitPolicy | undefined {
  const base = policies[resource]
  if (base === undefined) return undefined
  const override =
    orgId !== undefined && isOrganizationLimit(resource) ? organizationLimits(orgId)?.[resource] : undefined
  const limit = override ?? base.limit
  return limit > 0 ? { limit, windowSeconds: base.windowSeconds } : undefined
}

function isOrganizationLimit(resource: Resource): resource is OrganizationLimit {
  return resource === 'requests' || resource === 'org_requests' || resource === 'search' || resource === 'ingest'
}

/** What `requests` is counted against: the principal, inside its organization. */
export function principalSubject(auth: { orgId: string; principal: { type: string; id: string } }): string {
  return `${auth.orgId}:${auth.principal.type}:${auth.principal.id}`
}

/**
 * Seconds until one more request fits, given the counts as they now stand.
 *
 * `previous` is the last window's count, `current` this window's without the
 * request being refused, `elapsed` how far into this window we are. Exported
 * because it is arithmetic a case should be able to ask directly.
 */
export function secondsUntilRoom(
  limit: number,
  windowMs: number,
  elapsedMs: number,
  previous: number,
  current: number,
): number {
  const room = limit - 1
  let waitMs: number
  if (current <= room) {
    // Only the previous window's tail is in the way; wait until enough of it
    // has slid out. previous * (1 - (elapsed + t) / W) + current <= room.
    waitMs = previous <= 0 ? 0 : windowMs * (1 - (room - current) / previous) - elapsedMs
  } else {
    // This window alone is over: it has to become the previous one and slide.
    // After the roll, current * (1 - t' / W) <= room.
    const intoNext = current <= 0 ? 0 : Math.max(0, windowMs * (1 - room / current))
    waitMs = windowMs - elapsedMs + intoNext
  }
  return Math.max(1, Math.ceil(waitMs / 1000))
}

export class RateLimiter {
  constructor(private readonly options: RateLimiterOptions) {}

  policy(resource: Resource): LimitPolicy {
    return this.options.policies[resource]
  }

  /**
   * Count one request against `subject` and say whether it fits.
   *
   * `policy` overrides the installation's for this call — an organization a
   * module holds to its own limit. The key does not change with it, so raising
   * an organization's limit mid-window carries its count over rather than
   * handing it a fresh one.
   */
  async check(subject: string, resource: Resource, policy: LimitPolicy = this.options.policies[resource]): Promise<LimitDecision> {
    const windowMs = policy.windowSeconds * 1000
    const now = this.options.now?.() ?? Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    const elapsed = now - windowStart
    const rolls = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000))

    // The window is in the key, so a stale key belongs to a window nobody will
    // ask about again and expiry is the only cleanup there is.
    const key = `nacre:rl:${resource}:${subject}:${windowStart}`
    const previousKey = `nacre:rl:${resource}:${subject}:${windowStart - windowMs}`

    try {
      // One round trip. The TTL covers two windows now, because this one is
      // read as the previous one for the whole of the next. It is refreshed on
      // every hit rather than set once, so a process dying between the two
      // commands cannot leave the key immortal.
      const [count, , before] = await this.options.redis.pipeline(
        ['INCR', key],
        ['PEXPIRE', key, String(2 * windowMs + 1000)],
        ['GET', previousKey],
      )
      const current = typeof count === 'number' ? count : Number(count ?? 0)
      const previous = before === null || before === undefined ? 0 : Number(before)
      const weight = 1 - elapsed / windowMs
      const estimate = previous * weight + current

      if (estimate <= policy.limit) {
        return {
          allowed: true,
          limit: policy.limit,
          remaining: Math.max(0, Math.floor(policy.limit - estimate)),
          reset: rolls,
          degraded: false,
          firstRefusal: false,
        }
      }

      // Refused: give the increment back, and note the refusal once per window.
      const [, noted] = await this.options.redis.pipeline(
        ['DECR', key],
        ['SET', `nacre:rl:noted:${resource}:${subject}:${windowStart}`, '1', 'NX', 'PX', String(windowMs + 1000)],
      )
      return {
        allowed: false,
        limit: policy.limit,
        remaining: 0,
        reset: secondsUntilRoom(policy.limit, windowMs, elapsed, previous, current - 1),
        degraded: false,
        firstRefusal: noted === 'OK',
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
        reset: rolls,
        degraded: true,
        firstRefusal: false,
      }
    }
  }

  /**
   * Give back a request `check` allowed, because a later limit refused it.
   *
   * A request is counted against every limit it passes through, and one turned
   * away by the second must not have spent the first: refused costs nothing,
   * whichever limit did the refusing. Best effort — a lost `DECR` over-counts
   * one request in one window, which is the safe direction.
   */
  async release(subject: string, resource: Resource): Promise<void> {
    const windowMs = this.options.policies[resource].windowSeconds * 1000
    const now = this.options.now?.() ?? Date.now()
    const windowStart = Math.floor(now / windowMs) * windowMs
    try {
      await this.options.redis.command('DECR', `nacre:rl:${resource}:${subject}:${windowStart}`)
    } catch {
      // Over-counting by one is the conservative failure.
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

/** A request's passage through every limit it counts against. */
export type Admission =
  | { readonly allowed: true; readonly headers: Record<string, string> }
  | {
      readonly allowed: false
      readonly headers: Record<string, string>
      /** The limit that refused, which is what the answer and the access log name. */
      readonly resource: Resource
      readonly decision: LimitDecision
      readonly policy: LimitPolicy
    }

/**
 * Count an authenticated request against the caller, then the organization,
 * then the operation, and say whether it may proceed.
 *
 * **One function both surfaces call**, because the order is the rule and two
 * copies of an order are two chances to disagree about it: REST and MCP spend
 * one budget, and a request one of them counted in a different sequence would
 * be refused in different words.
 *
 * A request a later limit refuses is given back to every earlier one: refused
 * costs nothing, whichever limit refused it. That makes the order invisible to
 * the counts and decisive for the answer — the narrowest subject goes first, so
 * a caller who has spent their own budget is told it is their own loop even
 * when their organization is full as well, rather than sent to blame everybody
 * else in it. The headers are the last limit checked.
 */
export async function admitRequest(
  limits: RateLimiter,
  policies: Readonly<Record<Resource, LimitPolicy>>,
  auth: { readonly orgId: string; readonly principal: { readonly type: string; readonly id: string } },
  operation: Resource | undefined,
): Promise<Admission> {
  const steps: { resource: Resource; subject: string }[] = [
    { resource: 'requests', subject: principalSubject(auth) },
    { resource: 'org_requests', subject: auth.orgId },
  ]
  if (operation !== undefined) steps.push({ resource: operation, subject: auth.orgId })

  const passed: { resource: Resource; subject: string }[] = []
  let headers: Record<string, string> = {}
  for (const step of steps) {
    const policy = policyFor(policies, step.resource, auth.orgId)
    if (policy === undefined) continue
    const decision = await limits.check(step.subject, step.resource, policy)
    headers = limitHeaders(decision, policy, step.resource)
    if (!decision.allowed) {
      for (const earlier of passed) await limits.release(earlier.subject, earlier.resource)
      return { allowed: false, headers, resource: step.resource, decision, policy }
    }
    passed.push(step)
  }
  return { allowed: true, headers }
}
