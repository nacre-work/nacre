import { describe, expect, it } from 'vitest'

import { pruneOnce, type PrunePorts } from '../prune.js'

/**
 * The pass is thin, so the tests are about the one thing that is not obvious:
 * the two tables fail apart from each other. Retention on `audit_events` goes
 * through a function that can refuse — a retention below its floor, a database
 * migrated by hand where the grant never landed — and refusing it must not stop
 * expired refresh tokens from going, which is the sweep that was missing in the
 * first place.
 */

const ports = (overrides: Partial<PrunePorts> = {}): PrunePorts & { errors: string[] } => {
  const errors: string[] = []
  return {
    errors,
    tokens: async () => 0,
    audit: async () => 0,
    onError: (what) => errors.push(what),
    ...overrides,
  }
}

describe('pruneOnce', () => {
  it('reports what each sweep removed', async () => {
    const p = ports({ tokens: async () => 12, audit: async () => 300 })
    expect(await pruneOnce(p, 1000, 400)).toEqual({ tokens: 12, audit: 300, failed: 0 })
    expect(p.errors).toEqual([])
  })

  it('expires tokens even when audit retention is refused', async () => {
    // The shape of a real refusal: the definer function raises on a retention
    // below its floor. Everything about the token sweep is independent of it.
    const p = ports({
      tokens: async () => 7,
      audit: async () => {
        throw new Error('retention below the 30 day floor: 7')
      },
    })

    const result = await pruneOnce(p, 1000, 7)

    expect(result.tokens).toBe(7)
    expect(result.audit).toBe(0)
    expect(result.failed).toBe(1)
    expect(p.errors).toEqual(['audit'])
  })

  it('prunes audit events even when the token sweep fails', async () => {
    const p = ports({
      tokens: async () => {
        throw new Error('connection terminated')
      },
      audit: async () => 42,
    })

    const result = await pruneOnce(p, 1000, 400)

    expect(result.tokens).toBe(0)
    expect(result.audit).toBe(42)
    expect(result.failed).toBe(1)
    expect(p.errors).toEqual(['tokens'])
  })

  it('passes the configured retention through untouched', async () => {
    // Not clamped here. The floor lives in the database, and the startup check
    // refuses a value below it — a pass that quietly substituted 30 for 7 would
    // hide a misconfiguration the operator needs to see.
    let seen: number | undefined
    await pruneOnce(
      ports({
        audit: async (days) => {
          seen = days
          return 0
        },
      }),
      1000,
      90,
    )
    expect(seen).toBe(90)
  })

  it('refuses a batch of zero', async () => {
    await expect(pruneOnce(ports(), 0, 400)).rejects.toThrow('batch must be at least 1')
  })
})
