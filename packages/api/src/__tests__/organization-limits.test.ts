import { randomBytes } from 'node:crypto'

import {
  loadedExtensions,
  organizationLimits,
  Redis,
  registerRateLimits,
  resetExtensionsForTests,
  withLoadingModuleForTests,
} from '@nacre.work/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { admitRequest, limitPoliciesFrom, policyFor, RateLimiter } from '../limits.js'

/**
 * Per-organization limits: what a module may set, what the open core does
 * without one, and the order every request is counted in.
 *
 * The second half is against a real Redis, for the reason `limits.test.ts`
 * gives — the property is a counter shared between requests, and a fake of one
 * is a test of the fake. Two things are held there: whatever a later limit
 * refuses is given back to every earlier one, and a caller who has spent their
 * own budget is told so, whatever else is full.
 */

const policies = limitPoliciesFrom({
  rateRequestsPerMin: 5,
  rateSearchPerMin: 3,
  rateIngestPerHour: 100,
  rateLoginPer15Min: 10,
  rateLoginSourcePer15Min: 60,
  rateClientRegistrationPerHour: 100,
})

const org = (): string => `0a999999-9999-4999-8999-${randomBytes(6).toString('hex')}`
const caller = (orgId: string) => ({ orgId, principal: { type: 'user', id: randomBytes(4).toString('hex') } })

/** Register a source the way a module does, from inside loading. */
function holding(limits: Record<string, Record<string, number> | undefined>, name = 'tenancy'): void {
  withLoadingModuleForTests(name, () => {
    registerRateLimits({ name: 'limits', limitsFor: (orgId) => limits[orgId] })
  })
}

afterEach(() => {
  resetExtensionsForTests()
})

describe('an organization limit source', () => {
  it('is absent in the open core, where the organization total is not counted at all', () => {
    expect(organizationLimits(org())).toBeUndefined()
    expect(policyFor(policies, 'org_requests', org())).toBeUndefined()
    // The installation's limits stand as they are.
    expect(policyFor(policies, 'requests', org())).toEqual({ limit: 5, windowSeconds: 60 })
    expect(policyFor(policies, 'search', org())).toEqual({ limit: 3, windowSeconds: 60 })
  })

  it('sets how many and never over how long', () => {
    const big = org()
    holding({ [big]: { org_requests: 9000, requests: 1200, search: 600 } })
    expect(policyFor(policies, 'org_requests', big)).toEqual({ limit: 9000, windowSeconds: 60 })
    expect(policyFor(policies, 'requests', big)).toEqual({ limit: 1200, windowSeconds: 60 })
    expect(policyFor(policies, 'search', big)).toEqual({ limit: 600, windowSeconds: 60 })
    // A resource it does not name keeps the installation's.
    expect(policyFor(policies, 'ingest', big)).toEqual({ limit: 100, windowSeconds: 3600 })
    // Another organization is untouched.
    expect(policyFor(policies, 'requests', org())).toEqual({ limit: 5, windowSeconds: 60 })
  })

  it('cannot reach the limits counted before anybody signs in', () => {
    const o = org()
    holding({ [o]: { login: 1, client_registration: 1 } as never })
    expect(policyFor(policies, 'login', o)).toEqual({ limit: 10, windowSeconds: 900 })
    expect(policyFor(policies, 'client_registration', o)).toEqual({ limit: 100, windowSeconds: 3600 })
  })

  it('ignores a value that is not a positive integer, so a form cannot type an outage', () => {
    const o = org()
    holding({ [o]: { requests: 0, search: -1, ingest: 2.5, org_requests: Number.NaN } })
    expect(organizationLimits(o)).toEqual({})
    expect(policyFor(policies, 'requests', o)).toEqual({ limit: 5, windowSeconds: 60 })
    expect(policyFor(policies, 'org_requests', o)).toBeUndefined()
  })

  it('fails open when the source throws', () => {
    withLoadingModuleForTests('tenancy', () => {
      registerRateLimits({
        name: 'broken',
        limitsFor: () => {
          throw new Error('cache not loaded')
        },
      })
    })
    expect(organizationLimits(org())).toBeUndefined()
    expect(policyFor(policies, 'requests', org())).toEqual({ limit: 5, windowSeconds: 60 })
  })

  it('is one source, and a second is refused rather than layered', () => {
    holding({}, 'tenancy')
    expect(() => holding({}, 'other')).toThrow(/two rate-limit sources were registered — tenancy and other/)
    expect(loadedExtensions().rateLimits).toBe('tenancy:limits')
  })

  it('is registered only while modules load', () => {
    expect(() => registerRateLimits({ name: 'late', limitsFor: () => undefined })).toThrow(/outside module loading/)
  })
})

const url = process.env.NACRE_REDIS_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_REDIS_URL is not set and CI is; the organization total would go untested.')
}
const when = url ? describe : describe.skip

when('admitting a request, in order', () => {
  let redis: Redis
  let limits: RateLimiter
  beforeAll(() => {
    redis = new Redis({ url: url as string })
    limits = new RateLimiter({ redis, policies })
  })
  afterAll(() => {
    redis.close()
  })

  it('holds an organization to its total across every caller in it', async () => {
    const o = org()
    holding({ [o]: { org_requests: 4 } })
    // Four callers, one request each, and then nobody: each is well inside
    // their own five, and together they are the organization's four.
    for (let i = 0; i < 4; i++) expect((await admitRequest(limits, policies, caller(o), undefined)).allowed).toBe(true)
    const refused = await admitRequest(limits, policies, caller(o), undefined)
    expect(refused.allowed).toBe(false)
    if (refused.allowed) return
    expect(refused.resource).toBe('org_requests')
    expect(refused.headers['ratelimit-policy']).toBe('org_requests;q=4;w=60')

    // Another organization on the same installation is not refused for it.
    expect((await admitRequest(limits, policies, caller(org()), undefined)).allowed).toBe(true)
  })

  it('names the caller’s own limit to a caller who has spent it, even once the organization is full too', async () => {
    const o = org()
    holding({ [o]: { org_requests: 7 } })
    const loop = caller(o)
    for (let i = 0; i < 5; i++) expect((await admitRequest(limits, policies, loop, undefined)).allowed).toBe(true)
    const own = await admitRequest(limits, policies, loop, undefined)
    expect(own.allowed === false && own.resource).toBe('requests')
    // Its refusals spent none of the organization's: two more callers fit,
    // and then the organization is full.
    expect((await admitRequest(limits, policies, caller(o), undefined)).allowed).toBe(true)
    expect((await admitRequest(limits, policies, caller(o), undefined)).allowed).toBe(true)
    const full = await admitRequest(limits, policies, caller(o), undefined)
    expect(full.allowed === false && full.resource).toBe('org_requests')
    // Both limits are spent now, and the looping caller is still told it is
    // its own loop — not sent to blame everybody else in its organization.
    const again = await admitRequest(limits, policies, loop, undefined)
    expect(again.allowed === false && again.resource).toBe('requests')
  })

  it('gives back the caller and the organization when the operation refuses', async () => {
    const o = org()
    holding({ [o]: { org_requests: 5, search: 1 } })
    const me = caller(o)
    expect((await admitRequest(limits, policies, me, 'search')).allowed).toBe(true)
    const search = await admitRequest(limits, policies, me, 'search')
    expect(search.allowed === false && search.resource).toBe('search')
    // One request counted so far, on both: four more fit for the caller and
    // for the organization. Without the give-back the fourth would be refused.
    for (let i = 0; i < 4; i++) expect((await admitRequest(limits, policies, me, undefined)).allowed).toBe(true)
    expect((await admitRequest(limits, policies, me, undefined)).allowed).toBe(false)
  })

  it('raises a limit for the organization a module names', async () => {
    const o = org()
    holding({ [o]: { requests: 8 } })
    const busy = caller(o)
    for (let i = 0; i < 8; i++) expect((await admitRequest(limits, policies, busy, undefined)).allowed).toBe(true)
    expect((await admitRequest(limits, policies, busy, undefined)).allowed).toBe(false)
  })
})
