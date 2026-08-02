import { describe, expect, it } from 'vitest'

import { hashingLoad, hashPassword, needsRehash, TooBusy, verifyPassword } from '../passwords.js'

/**
 * Password hashing.
 *
 * Slow on purpose — each of these spends a real scrypt call, which is the
 * property under test as much as anything else. A suite that ran instantly
 * would mean the cost parameters were not being applied.
 */

describe('hashing', () => {
  it('verifies the right password and refuses the wrong one', async () => {
    const encoded = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('correct horse battery staple', encoded)).toBe(true)
    expect(await verifyPassword('correct horse battery stapl', encoded)).toBe(false)
    expect(await verifyPassword('', encoded)).toBe(false)
  })

  it('salts, so two identical passwords do not share a hash', async () => {
    const a = await hashPassword('same')
    const b = await hashPassword('same')
    expect(a).not.toBe(b)
    // A rainbow table is only worth building against an unsalted column.
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })

  it('carries its parameters, so the cost can be raised later', async () => {
    const encoded = await hashPassword('x')
    const [scheme, n, r, p] = encoded.split('$')
    expect(scheme).toBe('scrypt')
    // OWASP's minimum for scrypt. A bare hash could not be verified after a
    // change here, so raising the cost would mean invalidating every password.
    expect(Number(n)).toBe(131_072)
    expect(Number(r)).toBe(8)
    expect(Number(p)).toBe(1)
  })

  it('normalizes, so the same characters typed two ways still match', async () => {
    // "é" as one code point and as e + combining acute. A person typing their
    // password on a different keyboard produces the second and cannot sign in.
    const composed = 'café-password'
    const decomposed = 'café-password'
    expect(composed).not.toBe(decomposed)
    expect(await verifyPassword(decomposed, await hashPassword(composed))).toBe(true)
  })

  it('refuses a malformed record rather than throwing', async () => {
    // The caller turns every failure into one refusal, so an exception on one
    // of them would be a way to tell them apart from outside.
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'argon2id$v=19$m=1,t=1,p=1$aaa$bbb']) {
      expect(await verifyPassword('x', bad), bad).toBe(false)
    }
  })

  it('refuses a work factor large enough to hang the process', async () => {
    // One poisoned row should not become an outage. A stored record asking for
    // N=2^30 would allocate gigabytes before failing.
    const absurd = `scrypt$${1 << 30}$8$1$YWJj$YWJj`
    expect(await verifyPassword('x', absurd)).toBe(false)
  })
})

describe('needsRehash', () => {
  it('is false for a hash made with the current parameters', async () => {
    expect(needsRehash(await hashPassword('x'))).toBe(false)
  })

  it('is true for weaker parameters and for anything unreadable', () => {
    // The moment of a successful sign-in is the only one where the plaintext
    // exists, so it is the only chance to bring an old hash up to date.
    expect(needsRehash('scrypt$16384$8$1$YWJj$YWJj')).toBe(true)
    expect(needsRehash('nonsense')).toBe(true)
  })
})

/**
 * The concurrency gate.
 *
 * scrypt runs on libuv's thread pool, which has four threads by default and is
 * shared with `dns.lookup` and file I/O. Unbounded, a handful of simultaneous
 * sign-in attempts occupy all of it — so a login flood stops the request path
 * on a DNS resolution, which reads as a database problem on a dashboard.
 *
 * These assert the two properties that make the gate a gate: it never lets more
 * than the limit run at once, and it sheds load rather than queueing forever.
 */
describe('the hashing gate', () => {
  it('never runs more hashes at once than its limit', async () => {
    const { limit } = hashingLoad()
    let peak = 0

    // Deliberately more than the limit, started in the same tick, which is
    // what a spray looks like from the process's side.
    await Promise.all(
      Array.from({ length: limit * 4 }, async () => {
        await hashPassword('gate')
        peak = Math.max(peak, hashingLoad().active)
      }),
    )

    expect(peak).toBeLessThanOrEqual(limit)
    // And the gate is empty afterwards, so nothing leaked a permit.
    expect(hashingLoad()).toEqual({ active: 0, queued: 0, limit })
  })

  it('sheds load instead of queueing without bound', async () => {
    // 64 is the queue bound; ask for well past it in one tick. The refusals
    // must be immediate, and they must be refusals rather than a process that
    // accepts everything and answers nothing.
    const attempts = Array.from({ length: 200 }, () =>
      hashPassword('flood').then(
        () => 'ok' as const,
        (e: unknown) => (e instanceof TooBusy ? ('busy' as const) : ('other' as const)),
      ),
    )
    const results = await Promise.all(attempts)

    expect(results.filter((r) => r === 'busy').length).toBeGreaterThan(0)
    expect(results.filter((r) => r === 'other')).toEqual([])
    // The ones that were not refused still completed. Shedding is not failing.
    expect(results.filter((r) => r === 'ok').length).toBeGreaterThan(0)
    expect(hashingLoad().queued).toBe(0)
    // Long, and legitimately: 66 real scrypt calls two at a time is the point.
    // Faking the work would test the queue and not the thing it protects.
  }, 120_000)
})
