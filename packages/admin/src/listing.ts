import { clear, h } from './dom.js'

/**
 * Search and pages for a list screen.
 *
 * ## Why
 *
 * Layers, Grants, People, Service accounts and Connected applications each
 * rendered their whole collection as one table. At a few hundred rows that is a
 * screen you scroll through with the browser's find bar, and a row somebody is
 * looking for is found by luck. Reported by the product owner with screenshots
 * of exactly that.
 *
 * ## Client-side, over the whole collection, and that is not a shortcut
 *
 * The SDK's listings already walk the cursor to the end — up to 10,000 rows,
 * and they throw past that rather than hand back a truncation that reads as
 * complete. So the full set is in the page already, and filtering it here is
 * exact: a match on the fifth page of the server's cursor is as findable as one
 * on the first. Server-side search over a collection too large to load is the
 * commercial `directory` module; adding it to the core's listings would be the
 * boundary moving for a problem this does not have.
 *
 * ## One module, because five copies would disagree
 *
 * Every list screen goes through `listing()`. Written per screen, the pager
 * math and the "no matches" state would be five things that have to agree —
 * whether the page resets when the query changes, whether an empty filter
 * says so or shows an empty table — with nothing that knew there were five.
 * The pure half (`filterRows`, `sliceOf`, `rangeLabel`, `matchActor`) takes no
 * DOM and is what the unit tests ask.
 */

/** Rows per page. Enough to read a screen of, few enough that it renders at once. */
export const PAGE_SIZE = 50

type Field = string | null | undefined

const fold = (text: string): string => text.toLocaleLowerCase()

/**
 * The query's words, each of which must appear in some field.
 *
 * Words rather than the whole string, so `handbook read` finds the grant of
 * `read` on `handbook` whichever column each word is in. Case-insensitive and
 * a substring match, because the thing somebody types is a fragment of a slug
 * or an address, not the whole of it.
 */
function terms(query: string): readonly string[] {
  return fold(query).split(/\s+/u).filter((term) => term !== '')
}

export function filterRows<T>(rows: readonly T[], query: string, fields: (row: T) => readonly Field[]): readonly T[] {
  const wanted = terms(query)
  if (wanted.length === 0) return rows
  return rows.filter((row) => {
    const haystack = fields(row)
      .filter((field): field is string => typeof field === 'string')
      .map(fold)
    return wanted.every((term) => haystack.some((field) => field.includes(term)))
  })
}

export interface Slice<T> {
  readonly rows: readonly T[]
  /** 1-based, clamped into range. */
  readonly page: number
  /** At least 1, so "page 1 of 1" is what an empty list is. */
  readonly pages: number
  /** 1-based position of the first row shown, or 0 when there is none. */
  readonly first: number
  /** 1-based position of the last row shown, or 0 when there is none. */
  readonly last: number
  readonly total: number
}

/**
 * One page of `rows`.
 *
 * The page is clamped rather than trusted: deleting the last row of the last
 * page, or narrowing the query while on page six, would otherwise ask for a
 * page that no longer exists and show an empty table under a pager that says
 * there are rows.
 */
export function sliceOf<T>(rows: readonly T[], page: number, size: number = PAGE_SIZE): Slice<T> {
  const total = rows.length
  const pages = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(1, Math.floor(page)), pages)
  const start = (current - 1) * size
  const shown = rows.slice(start, start + size)
  return {
    rows: shown,
    page: current,
    pages,
    first: shown.length === 0 ? 0 : start + 1,
    last: start + shown.length,
    total,
  }
}

/** `1–50 of 312`, with an en dash because it is a range. */
export const rangeLabel = (slice: Slice<unknown>): string =>
  `${String(slice.first)}–${String(slice.last)} of ${String(slice.total)}`

export interface Named {
  readonly id: string
  readonly label: string
}

export type ActorMatch =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly actor: Named }
  | { readonly kind: 'many'; readonly actors: readonly Named[] }

/**
 * Which account a typed name means.
 *
 * An exact match wins, case-insensitively, even when it is also a substring of
 * others — `sam@example.com` must not be ambiguous because `sam@example.com.au`
 * exists. Otherwise a fragment that names exactly one account is that account,
 * and one that names several is refused with the candidates rather than
 * guessed: the log for the wrong person is the answer to a question nobody
 * asked, and it looks exactly like the right one.
 */
export function matchActor(query: string, actors: readonly Named[]): ActorMatch {
  const wanted = fold(query.trim())
  if (wanted === '') return { kind: 'none' }
  const exact = actors.filter((a) => fold(a.label) === wanted)
  if (exact.length === 1) return { kind: 'one', actor: exact[0] as Named }
  const partial = exact.length > 1 ? exact : actors.filter((a) => fold(a.label).includes(wanted))
  if (partial.length === 0) return { kind: 'none' }
  if (partial.length === 1) return { kind: 'one', actor: partial[0] as Named }
  return { kind: 'many', actors: partial }
}

export interface ListingOptions<T> {
  readonly rows: readonly T[]
  /** The text a row is found by. */
  readonly fields: (row: T) => readonly Field[]
  /** Draws the table for the rows on the current page. */
  readonly render: (rows: readonly T[]) => HTMLElement
  /** Says what the box searches, e.g. "Search layers by slug or name". */
  readonly label: string
  readonly size?: number
}

/**
 * A search box, the table, and a pager under it.
 *
 * The pager is absent while everything fits on one page — a "1–2 of 2" with
 * two disabled buttons is furniture — and the query resets to page one,
 * because page four of a new query is a page nobody asked for.
 *
 * The box is always there when there are rows. Hiding it below some count
 * would make the same screen look different on two installations for a
 * reason nobody on either could see.
 */
export function listing<T>(options: ListingOptions<T>): HTMLElement {
  const size = options.size ?? PAGE_SIZE
  const input = h('input', {
    class: 'input',
    type: 'search',
    placeholder: options.label,
    'aria-label': options.label,
  }) as HTMLInputElement
  const slot = h('div', {})
  const pager = h('div', { class: 'pager' })
  let page = 1

  const bar = h('div', { class: 'searchbar' }, input)

  /**
   * A page turned from the pager, which sits under the table: without this the
   * new page arrives with the reader looking at its last row. The bar rather
   * than the table, so the range they are on and the box are both in view;
   * `scroll-margin-top` in the stylesheet keeps it clear of the sticky
   * masthead.
   */
  const turn = (to: number): void => {
    page = to
    draw()
    bar.scrollIntoView({ block: 'nearest' })
  }

  const draw = (): void => {
    const matched = filterRows(options.rows, input.value, options.fields)
    const slice = sliceOf(matched, page, size)
    page = slice.page
    clear(slot)
    clear(pager)

    if (matched.length === 0) {
      slot.append(h('div', { class: 'empty' }, h('p', {}, `No matches for “${input.value.trim()}”.`)))
      return
    }
    slot.append(options.render(slice.rows))
    if (slice.pages === 1) return

    const prev = h('button', { class: 'btn', type: 'button', onclick: () => { turn(page - 1) } }, 'Previous') as HTMLButtonElement
    const next = h('button', { class: 'btn', type: 'button', onclick: () => { turn(page + 1) } }, 'Next') as HTMLButtonElement
    prev.disabled = slice.page === 1
    next.disabled = slice.page === slice.pages
    pager.append(h('span', { class: 'muted', 'aria-live': 'polite' }, rangeLabel(slice)), prev, next)
  }

  input.addEventListener('input', () => {
    page = 1
    draw()
  })
  draw()

  return h('div', {}, bar, slot, pager)
}
