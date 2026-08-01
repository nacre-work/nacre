import type { Principal, PrincipalRef } from '../types.js'
import { effectivePrincipals, type GroupGraph } from './principals.js'

/**
 * The effective-principals cache.
 *
 * Resolving a user's transitive groups is the one query on the search path that
 * does not depend on the search, so it is the one worth caching. It is also the
 * one where a stale answer is a leak that lasts exactly as long as the cache
 * entry.
 *
 * **The key carries `groups_version`, so staleness is impossible rather than
 * time-bounded.** A membership change increments the version in Postgres, by
 * trigger, and every subsequent read composes a different key — the old entry
 * is not invalidated, it is simply never asked for again. The TTL is a memory
 * bound, not the correctness mechanism.
 *
 * That distinction is invariant I4. A TTL-only cache honours a 60-second SLA
 * on average and misses it whenever the clock is unkind; a version-keyed cache
 * cannot serve a revoked grant at all, because the request that would have hit
 * the stale entry is looking somewhere else.
 */

export interface CacheStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

/** For a single process, and for tests. Redis is the shared implementation. */
export class MemoryCache implements CacheStore {
  readonly #entries = new Map<string, { value: string; expires: number }>()

  async get(key: string): Promise<string | undefined> {
    const entry = this.#entries.get(key)
    if (entry === undefined) return undefined
    if (entry.expires <= Date.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#entries.set(key, { value, expires: Date.now() + ttlSeconds * 1000 })
  }

  get size(): number {
    return this.#entries.size
  }
}

export function principalsCacheKey(orgId: string, principal: Principal, groupsVersion: number): string {
  return `acl:principals:${orgId}:${principal.type}:${principal.id}:v${groupsVersion}`
}

export interface CachedPrincipalsOptions {
  readonly orgId: string
  readonly principal: Principal
  /** Read from organizations.groups_version in the same transaction as the grants. */
  readonly groupsVersion: number
  readonly ttlSeconds: number
}

/**
 * Effective principals, from cache when the version matches.
 *
 * The graph loader is only called on a miss. Note what is *not* here: no
 * invalidation, no deletion, no pub/sub. A version bump changes the key, and
 * the old entry ages out on its own.
 *
 * A cache failure is not a permission failure — it falls through to the graph
 * rather than denying. Reading it as a denial would turn a Redis restart into
 * an outage, and reading it as an allow is not on the table because there is
 * nothing to allow: the fallback computes the same answer, slower.
 */
export async function cachedEffectivePrincipals(
  options: CachedPrincipalsOptions,
  cache: CacheStore,
  loadGraph: () => Promise<GroupGraph>,
): Promise<ReadonlySet<PrincipalRef>> {
  const key = principalsCacheKey(options.orgId, options.principal, options.groupsVersion)

  try {
    const hit = await cache.get(key)
    if (hit !== undefined) {
      const parsed: unknown = JSON.parse(hit)
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) {
        return new Set(parsed as PrincipalRef[])
      }
      // Unparseable means somebody else wrote this key with a different shape.
      // Recompute rather than guess; a malformed principal set is a wrong
      // permission set.
    }
  } catch {
    // Cache unreachable. Fall through.
  }

  const principals = effectivePrincipals(options.principal, await loadGraph())

  try {
    await cache.set(key, JSON.stringify([...principals]), options.ttlSeconds)
  } catch {
    // Writing is best effort. A cache that cannot be written is slow, not wrong.
  }

  return principals
}
