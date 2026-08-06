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
/**
 * The cases the specification actually lists, read out of it.
 *
 * Only table rows — `| T7 | … |`. The prose names ids too ("T22 is the one that
 * matters", "T9's argument"), and a mention is not a requirement.
 */
const specified = ((): readonly string[] => {
  const doc = readFileSync(join(here, '..', '..', '..', '..', 'docs', 'authz.md'), 'utf8')
  return [...doc.matchAll(/^\|\s*(T\d+)\s*\|/gm)].map((m) => m[1]!)
})()

describe('test plan coverage', () => {
  /**
   * The inventory is exactly what docs/authz.md lists.
   *
   * This used to compare against a hard-coded 15, which made the count a third
   * place the same fact lived — the document, this file, and that literal — with
   * nothing holding them together. Adding T16-T22 to the specification left the
   * assertion describing a suite that no longer existed, and the failure named a
   * number rather than the case that was missing.
   *
   * Reading the document instead makes it the one source: a case added to the
   * specification and not to the plan fails here, and so does a case dropped
   * from the plan while the specification still requires it. The other direction
   * — plan to tests — is the assertion below, so the chain is complete.
   */
  it('is exactly the set docs/authz.md specifies, with no gaps or duplicates', () => {
    const ids = TEST_PLAN.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(specified.length, 'no T-cases found in docs/authz.md — the regex or the tables moved').toBeGreaterThan(0)

    const byNumber = (a: string, b: string): number => Number(a.slice(1)) - Number(b.slice(1))
    expect([...ids].sort(byNumber)).toEqual([...specified].sort(byNumber))
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
