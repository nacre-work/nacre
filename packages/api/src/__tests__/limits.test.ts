import { Redis } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Idempotency, isConflict, isReplay } from '../idempotency.js'
import { limitHeaders, RateLimiter } from '../limits.js'

/**
 * Rate limiting and Idempotency-Key, against a real Redis.
 *
 * Against a real one because both are built out of exactly the behaviours a
 * fake would be written to have: `INCR` returning a monotone count under
 * concurrency, and `SET NX` letting exactly one caller win. Testing a fake of
 * those is testing the fake.
 *
 * The cases that matter are the failure ones. Both features fail **open** —
 * deliberately, and against the grain of every other decision in this codebase
 * — because neither is an authorization control, and failing closed would turn
 * a Redis restart into an outage.
 */

const url = process.env.NACRE_REDIS_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_REDIS_URL is not set and CI is; the rate limiter would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'org-limits-1'
const ALICE = { orgId: ORG, type: 'user', id: 'alice' }
const BOB = { orgId: ORG, type: 'user', id: 'bob' }
const OTHER = 'org-limits-2'
const OTHER_ORG_ALICE = { orgId: OTHER, type: 'user', id: 'alice' }

let redis: Redis

when('rate limiting', () => {
  beforeAll(() => {
    redis = new Redis({ url: url as string })
  })

  afterAll(() => {
    redis.close()
  })

  const limiter = (limit: number) =>
    new RateLimiter({
      redis,
      policies: {
        search: { limit, windowSeconds: 60 },
        ingest: { limit, windowSeconds: 3600 },
        login: { limit, windowSeconds: 900 },
      },
    })

  /** A fresh organization per test, since the window key carries the id. */
  const org = () => `${ORG}-${Math.random().toString(36).slice(2, 10)}`

  it('allows up to the limit and refuses the one after', async () => {
    const rl = limiter(3)
    const id = org()

    for (let i = 1; i <= 3; i++) {
      const decision = await rl.check(id, 'search')
      expect(decision.allowed, `request ${i} should be allowed`).toBe(true)
      expect(decision.remaining).toBe(3 - i)
    }

    const refused = await rl.check(id, 'search')
    expect(refused.allowed).toBe(false)
    expect(refused.remaining).toBe(0)
    // Something to wait for, rather than a bare refusal.
    expect(refused.reset).toBeGreaterThan(0)
    expect(refused.reset).toBeLessThanOrEqual(60)
  })

  it('counts per organization, which is the whole point', async () => {
    const rl = limiter(2)
    const a = org()
    const b = `${OTHER}-${Math.random().toString(36).slice(2, 10)}`

    await rl.check(a, 'search')
    await rl.check(a, 'search')
    expect((await rl.check(a, 'search')).allowed).toBe(false)

    // A limit counted per credential is bypassed by minting another credential,
    // and this product hands out service account keys through an endpoint.
    expect((await rl.check(b, 'search')).allowed).toBe(true)
  })

  it('counts each resource separately', async () => {
    const rl = limiter(1)
    const id = org()

    expect((await rl.check(id, 'search')).allowed).toBe(true)
    expect((await rl.check(id, 'search')).allowed).toBe(false)
    // Spending the search budget must not stop an ingest.
    expect((await rl.check(id, 'ingest')).allowed).toBe(true)
  })

  it('is atomic under concurrency', async () => {
    const rl = limiter(10)
    const id = org()

    const decisions = await Promise.all(Array.from({ length: 25 }, () => rl.check(id, 'search')))
    const allowed = decisions.filter((d) => d.allowed).length

    // Exactly ten, not "about ten". A read-modify-write would let more through
    // under load, which is precisely when a limit matters.
    expect(allowed).toBe(10)
  })

  it('fails open when redis is unreachable, and says so', async () => {
    const broken = new Redis({ url: 'redis://127.0.0.1:6390', timeoutMs: 300 })
    const degraded: unknown[] = []
    const rl = new RateLimiter({
      redis: broken,
      policies: {
        search: { limit: 1, windowSeconds: 60 },
        ingest: { limit: 1, windowSeconds: 3600 },
        login: { limit: 1, windowSeconds: 900 },
      },
      onDegraded: (_r, e) => degraded.push(e),
    })

    const decision = await rl.check(org(), 'search')

    // The opposite of invariant I3, on purpose: a rate limit is availability
    // protection, not an authorization control, and refusing every request
    // because a cache is down trades a rare over-serve for a certain outage.
    expect(decision.allowed).toBe(true)
    expect(decision.degraded).toBe(true)
    expect(degraded).toHaveLength(1)
    broken.close()
  })

  it('reports RFC 9331 headers, and Retry-After only on a refusal', () => {
    const policy = { limit: 60, windowSeconds: 60 }
    const allowed = limitHeaders(
      { allowed: true, limit: 60, remaining: 59, reset: 42, degraded: false },
      policy,
      'search',
    )
    expect(allowed['ratelimit-limit']).toBe('60')
    expect(allowed['ratelimit-remaining']).toBe('59')
    expect(allowed['ratelimit-policy']).toBe('search;q=60;w=60')
    expect(allowed['retry-after']).toBeUndefined()

    const refused = limitHeaders(
      { allowed: false, limit: 60, remaining: 0, reset: 42, degraded: false },
      policy,
      'search',
    )
    expect(refused['retry-after']).toBe('42')
  })
})

when('idempotency', () => {
  beforeAll(() => {
    redis ??= new Redis({ url: url as string })
  })

  const key = () => `key-${Math.random().toString(36).slice(2, 12)}`
  const idem = () => new Idempotency({ redis })

  it('replays the stored response for a repeat of the same request', async () => {
    const k = key()
    const first = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(first)).toBe(false)
    if (isReplay(first) || isConflict(first)) throw new Error('expected to proceed')

    await first.store(201, { id: 'grant-1' })

    const second = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(second)).toBe(true)
    if (!isReplay(second)) throw new Error('expected a replay')
    expect(second.cached).toEqual({ status: 201, body: { id: 'grant-1' } })
  })

  it('the same key from another principal in the same organization is a different key', async () => {
    // The leak this replaced. Scoped to the organization alone, any principal
    // in the tenant who presented the same key and the same body was handed
    // whatever the first one got — replayed before any handler runs, so with no
    // permission check left to catch it. Two principals in one organization see
    // different things; that is the entire product.
    const k = key()
    const mine = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    if (isReplay(mine) || isConflict(mine)) throw new Error('expected to proceed')
    await mine.store(201, { id: 'alice-only' })

    const theirs = await idem().begin(k, BOB, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(theirs), 'Bob must not receive Alice’s cached response').toBe(false)
    // And not a conflict either — Bob's key is simply his own, so his request
    // proceeds and is answered by the handler, which will refuse him if it must.
    expect(isConflict(theirs)).toBe(false)
  })

  it('never stores a failure, so one cannot be replayed or poison a key', async () => {
    const k = key()
    const first = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    if (isReplay(first) || isConflict(first)) throw new Error('expected to proceed')
    await first.store(404, { title: 'Not found' })

    // A retry must reach the handler rather than the cached refusal. Storing a
    // failure makes a transient fault permanent for a day and denies exactly
    // the retry this feature exists to serve.
    const retry = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(retry)).toBe(false)
    expect(isConflict(retry)).toBe(false)
  })

  it('the same key from another organization is a different key', async () => {
    const k = key()
    const mine = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    if (isReplay(mine) || isConflict(mine)) throw new Error('expected to proceed')
    await mine.store(201, { id: 'mine' })

    // The key is a string the caller chose. Without the organization in the
    // cache key, `Idempotency-Key: 1` would hand one tenant's response to
    // another — invariant I1 broken by a convenience feature.
    const theirs = await idem().begin(k, OTHER_ORG_ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(theirs)).toBe(false)
  })

  it('the same key with a different body is a conflict, not a replay', async () => {
    const k = key()
    const first = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    if (isReplay(first) || isConflict(first)) throw new Error('expected to proceed')
    await first.store(201, { id: 'grant-1' })

    // A caller who changed the payload and kept the key is not asking for the
    // old answer, and giving it to them silently is the worst of the options.
    const changed = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 2 })
    expect(isConflict(changed)).toBe(true)
  })

  it('a second attempt while the first is still running is a conflict', async () => {
    const k = key()
    const first = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isReplay(first) || isConflict(first)).toBe(false)

    // Nothing stored yet: replaying a response that does not exist is not an
    // option, and neither is running the work twice.
    const concurrent = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    expect(isConflict(concurrent)).toBe(true)
  })

  it('exactly one of many concurrent attempts proceeds', async () => {
    const k = key()
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })),
    )
    const proceeded = outcomes.filter((o) => !isReplay(o) && !isConflict(o))
    expect(proceeded).toHaveLength(1)
  })

  it('the method and the path are part of the key', async () => {
    const k = key()
    const post = await idem().begin(k, ALICE, 'POST', '/v1/grants', { a: 1 })
    if (isReplay(post) || isConflict(post)) throw new Error('expected to proceed')
    await post.store(201, { id: 'x' })

    expect(isConflict(await idem().begin(k, ALICE, 'DELETE', '/v1/grants', { a: 1 }))).toBe(true)
    expect(isConflict(await idem().begin(k, ALICE, 'POST', '/v1/layers', { a: 1 }))).toBe(true)
  })

  it('fails open when redis is unreachable', async () => {
    const broken = new Redis({ url: 'redis://127.0.0.1:6390', timeoutMs: 300 })
    const degraded: unknown[] = []
    const outcome = await new Idempotency({ redis: broken, onDegraded: (e) => degraded.push(e) }).begin(
      key(),
      ALICE,
      'POST',
      '/v1/grants',
      {},
    )

    // A duplicate on a retry is the risk, which is what the feature prevents —
    // so this is a real degradation. Refusing writes because a cache is down
    // trades a rare duplicate for a certain outage.
    expect(isReplay(outcome) || isConflict(outcome)).toBe(false)
    expect(degraded).toHaveLength(1)
    broken.close()
  })
})
