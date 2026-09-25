import { describe, expect, it } from 'vitest'

import { filterRows, matchActor, PAGE_SIZE, rangeLabel, sliceOf } from '../listing.js'

/**
 * The pure half of `listing.ts`: which rows a query keeps, which page of them
 * is on the screen, and which account a typed name means.
 *
 * The DOM half is photographed by `scripts/screenshots.mjs`; what is asked here
 * is the arithmetic, where an off-by-one is a row nobody can reach and nothing
 * on the screen looks wrong.
 */

interface Row {
  readonly slug: string
  readonly name: string
  readonly note?: string | null
}

const rows: readonly Row[] = [
  { slug: 'handbook', name: 'Handbook', note: 'Onboarding and policy' },
  { slug: 'contracts', name: 'Contracts', note: null },
  { slug: 'eng-handbook', name: 'Engineering handbook' },
]
const fields = (r: Row) => [r.slug, r.name, r.note]

describe('filterRows', () => {
  it('keeps everything for an empty or blank query', () => {
    expect(filterRows(rows, '', fields)).toBe(rows)
    expect(filterRows(rows, '   ', fields)).toBe(rows)
  })

  it('matches a fragment, case-insensitively, in any field', () => {
    expect(filterRows(rows, 'HAND', fields).map((r) => r.slug)).toEqual(['handbook', 'eng-handbook'])
    expect(filterRows(rows, 'policy', fields).map((r) => r.slug)).toEqual(['handbook'])
  })

  it('requires every word, each in whichever field it is in', () => {
    expect(filterRows(rows, 'handbook engineering', fields).map((r) => r.slug)).toEqual(['eng-handbook'])
    expect(filterRows(rows, 'handbook contracts', fields)).toEqual([])
  })

  it('skips an absent field rather than matching the word "null"', () => {
    expect(filterRows(rows, 'null', fields)).toEqual([])
  })
})

describe('sliceOf', () => {
  const many = Array.from({ length: 312 }, (_, i) => i + 1)

  it('pages by PAGE_SIZE by default and says where it is', () => {
    const first = sliceOf(many, 1)
    expect(first.rows).toHaveLength(PAGE_SIZE)
    expect(first.rows[0]).toBe(1)
    expect(first.pages).toBe(7)
    expect(rangeLabel(first)).toBe('1–50 of 312')
  })

  it('shows a short last page, and every row is on exactly one page', () => {
    const last = sliceOf(many, 7)
    expect(last.rows).toEqual(many.slice(300))
    expect(rangeLabel(last)).toBe('301–312 of 312')
    const seen = Array.from({ length: last.pages }, (_, i) => sliceOf(many, i + 1).rows).flat()
    expect(seen).toEqual(many)
  })

  it('clamps a page that no longer exists instead of showing nothing', () => {
    expect(sliceOf(many, 99).page).toBe(7)
    expect(sliceOf(many, 0).page).toBe(1)
    expect(sliceOf(many, -3).rows[0]).toBe(1)
  })

  it('is one page when everything fits, including exactly one page', () => {
    expect(sliceOf(many.slice(0, 50), 1).pages).toBe(1)
    expect(sliceOf(many.slice(0, 51), 1).pages).toBe(2)
  })

  it('is page 1 of 1 with nothing on it when the list is empty', () => {
    const empty = sliceOf([], 3)
    expect(empty).toEqual({ rows: [], page: 1, pages: 1, first: 0, last: 0, total: 0 })
  })

  it('takes a size', () => {
    expect(rangeLabel(sliceOf(many, 2, 100))).toBe('101–200 of 312')
  })
})

describe('matchActor', () => {
  const actors = [
    { id: '1', label: 'sam@example.com' },
    { id: '2', label: 'sam@example.com.au' },
    { id: '3', label: 'dana@example.com' },
    { id: '4', label: 'support-agent' },
  ]

  it('prefers an exact match even when it is a fragment of another', () => {
    expect(matchActor('SAM@example.com', actors)).toEqual({ kind: 'one', actor: actors[0] })
  })

  it('takes a fragment that names exactly one account', () => {
    expect(matchActor('dana', actors)).toEqual({ kind: 'one', actor: actors[2] })
    expect(matchActor(' support ', actors)).toEqual({ kind: 'one', actor: actors[3] })
  })

  it('refuses to guess between several', () => {
    const match = matchActor('sam', actors)
    expect(match.kind).toBe('many')
    expect(match.kind === 'many' ? match.actors.map((a) => a.id) : []).toEqual(['1', '2'])
  })

  it('says none for a name nobody has, and for nothing typed', () => {
    expect(matchActor('alex', actors)).toEqual({ kind: 'none' })
    expect(matchActor('', actors)).toEqual({ kind: 'none' })
  })
})
