import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TEST_PLAN, pending } from '../test-plan.js'

const here = fileURLToPath(new URL('.', import.meta.url))

const suiteText = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts') && f !== 'coverage.test.ts')
  .map((f) => readFileSync(join(here, f), 'utf8'))
  .join('\n')

/**
 * Keeps the inventory honest in both directions.
 *
 * The failure this guards against is not a missing test — that is visible. It
 * is the inventory drifting: a case marked implemented whose test was deleted
 * in a refactor, or a case quietly dropped from the list so the list looks
 * complete. Either one turns `acl-invariants` into a check that reports on a
 * suite nobody is maintaining, which is the shape of a green light that means
 * nothing.
 */
describe('test plan coverage', () => {
  it('covers T1 through T15 with no gaps and no duplicates', () => {
    const ids = TEST_PLAN.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: 15 }, (_, i) => `T${i + 1}`),
    )
  })

  it('every case marked implemented has a test carrying its marker', () => {
    const missing = TEST_PLAN.filter(
      (t) => t.status === 'implemented' && !new RegExp(`\\b${t.id}\\b`).test(suiteText),
    ).map((t) => `${t.id} (${t.scenario})`)

    expect(missing, 'marked implemented but no test names them').toEqual([])
  })

  it('every pending case says what it is waiting for', () => {
    const unexplained = pending()
      .filter((t) => !t.blockedBy || t.blockedBy.trim() === '')
      .map((t) => t.id)

    expect(unexplained, 'pending without a reason').toEqual([])
  })

  it('no case claims to be pending and implemented at once', () => {
    const contradictory = TEST_PLAN.filter(
      (t) => t.status === 'implemented' && t.blockedBy !== undefined,
    ).map((t) => t.id)

    expect(contradictory).toEqual([])
  })

  it('reports what the suite does not yet cover', () => {
    const outstanding = pending()

    // Not an assertion about the count — pinning it would mean editing this
    // test every time one lands, and a test that has to be edited to stay green
    // stops being read. The value is the printed list: it is what "the suite
    // is incomplete" looks like on every single run.
    for (const t of outstanding) {
      console.warn(`  pending ${t.id} · ${t.scenario}\n            blocked by: ${t.blockedBy}`)
    }

    expect(outstanding.every((t) => t.group !== undefined)).toBe(true)
  })
})
