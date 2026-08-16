/**
 * A very small amount of DOM plumbing.
 *
 * No framework, and that is a decision rather than an omission. This UI has
 * four screens, no client-side state worth reconciling, and ships inside a
 * container whose selling point is that it has no supply chain to speak of. A
 * framework here would be the largest dependency in the repository, and it
 * would be carrying four tables.
 *
 * The one place that argument is worth re-examining is the migration panel,
 * which polls and redraws itself — and it redraws by rebuilding, because four
 * seconds apart is not a rate anybody can see and a diff is the thing a
 * framework is for.
 *
 * `h` builds elements and sets text through `textContent`, never `innerHTML`.
 * Everything on these screens — layer names, grant principals, document titles
 * — is text somebody else wrote, and an admin UI is exactly where a stored
 * cross-site script would be read by the person with the most permissions.
 */

type Child = Node | string | null | undefined | false

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)

  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') {
      el.addEventListener(key.replace(/^on/, '').toLowerCase(), value as EventListener)
    } else if (value === false) {
      continue
    } else if (value === true) {
      el.setAttribute(key, '')
    } else {
      el.setAttribute(key, String(value))
    }
  }

  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(typeof child === 'string' ? document.createTextNode(child) : child)
  }

  return el
}

export const clear = (el: HTMLElement): void => {
  el.replaceChildren()
}

/**
 * An inline icon.
 *
 * `createElementNS` and not `h`, which calls `createElement` — an `<svg>` built
 * in the HTML namespace parses and renders nothing at all, which is the kind of
 * failure that looks like a missing file. Not an icon font and not an emoji
 * either: this page loads no font, and an emoji renders differently on every
 * platform at a size nobody chose.
 *
 * `currentColor` throughout, so a state is a class on the button rather than a
 * second copy of the drawing.
 */
export const icon = (...paths: readonly { d?: string; rect?: readonly [number, number, number, number] }[]): SVGElement => {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  })) svg.setAttribute(key, value)

  for (const part of paths) {
    if (part.rect) {
      const rect = document.createElementNS(NS, 'rect')
      const [x, y, w, height] = part.rect
      rect.setAttribute('x', String(x))
      rect.setAttribute('y', String(y))
      rect.setAttribute('width', String(w))
      rect.setAttribute('height', String(height))
      rect.setAttribute('rx', '2')
      svg.append(rect)
    } else {
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', part.d ?? '')
      svg.append(path)
    }
  }
  return svg
}

const COPY_GLYPH = [{ rect: [9, 9, 12, 12] as const }, { d: 'M5 15V5a2 2 0 0 1 2-2h10' }]
const DONE_GLYPH = [{ d: 'M20 6 9 17l-5-5' }]

/**
 * A short id, monospaced, with the whole thing available on hover.
 *
 * Head and tail, not the first eight characters. Ids generated together share a
 * prefix far more often than they share a suffix — three principals in one
 * fixture all rendered as `aaaaaaaa`, which made the table unreadable for the
 * one thing it exists to show.
 */
export const shortId = (id: string): HTMLElement =>
  h('code', { class: 'id', title: id }, `${id.slice(0, 6)}…${id.slice(-4)}`)

/**
 * Copy text, on an origin that is not `https:` as well as one that is.
 *
 * `navigator.clipboard` exists **only in a secure context** — HTTPS, or
 * `localhost`. A self-hosted admin UI is very often neither: it is reached at
 * `http://10.8.0.1:8082` or some other address on a private network, and there
 * the property is simply `undefined`. Every copy button here awaited
 * `navigator.clipboard.writeText(…)`, which threw a `TypeError` before it
 * reached a clipboard, and each caller caught it and fell back — so the buttons
 * were dead for exactly the deployments this product is for, and worked
 * perfectly in development, where the address is `localhost`.
 *
 * That is the same shape as the two subsystems that only ever worked because
 * development connects to Postgres as a superuser: a capability the developer's
 * environment grants for free and the operator's does not.
 *
 * So there are two paths and the older one is not a courtesy. A hidden
 * `<textarea>` plus `document.execCommand('copy')` is deprecated, and it is
 * also the only thing that copies on a plain-HTTP origin — no permission, no
 * secure context, just a selection and a user gesture.
 *
 * Returns what actually happened, because a button that says "copied" when
 * nothing was copied is worse than one that does nothing: the person closes the
 * dialog holding a key that is shown once.
 */
export type CopyResult = 'copied' | 'blocked'

interface CopyIo {
  /** `navigator.clipboard.writeText`, when this origin has one. */
  readonly writeToClipboard: ((text: string) => Promise<void>) | undefined
  /** The selection-and-execCommand path. `false` when the browser refused. */
  readonly selectAndCopy: (text: string) => boolean
}

/**
 * The `<textarea>` is positioned by a class, never by a style attribute.
 *
 * `index.html` sets `style-src 'self'` with no `'unsafe-inline'`, and the
 * migration progress bar is the scar: it rendered full for every migration
 * because the browser dropped its inline `style="width:…"`. Off-screen also has
 * to mean *off-screen and still selectable* — `display:none`, `hidden` and
 * `visibility:hidden` all make `select()` a no-op.
 */
const selectAndCopy = (text: string): boolean => {
  const area = document.createElement('textarea')
  area.value = text
  area.className = 'clipfield'
  area.setAttribute('readonly', '')
  document.body.append(area)

  // Whatever the person had selected is put back. Copying an id should not
  // silently destroy the sentence they had highlighted.
  const selection = document.getSelection()
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  area.select()
  // Safari on iOS ignores `select()` on a readonly field and needs the range.
  area.setSelectionRange(0, text.length)

  let ok: boolean
  try {
    ok = document.execCommand('copy')
  } catch {
    // Deprecated, and a browser is entitled to refuse it outright. The caller
    // is told, rather than shown "copied" over an empty clipboard.
    ok = false
  }

  area.remove()
  if (selection !== null) {
    selection.removeAllRanges()
    if (previous !== null) selection.addRange(previous)
  }
  return ok
}

/** Exported for the test; the default is built from the real globals. */
export async function copyWith(text: string, io: CopyIo): Promise<CopyResult> {
  if (io.writeToClipboard !== undefined) {
    try {
      await io.writeToClipboard(text)
      return 'copied'
    } catch {
      // Refused rather than absent — a denied permission, or a document that
      // was not focused. The fallback is worth trying and usually fails too,
      // because the gesture is over by the time this rejects.
    }
  }
  return io.selectAndCopy(text) ? 'copied' : 'blocked'
}

export const copyText = (text: string): Promise<CopyResult> =>
  copyWith(text, {
    // Bound, not passed as a method reference: `writeText` throws
    // "Illegal invocation" when it is called with the wrong receiver.
    writeToClipboard:
      typeof navigator !== 'undefined' && navigator.clipboard !== undefined
        ? (t: string) => navigator.clipboard.writeText(t)
        : undefined,
    selectAndCopy,
  })

/**
 * A truncated id with a button that copies the whole one.
 *
 * `shortId` alone puts the full value in a `title`, which shows on hover and
 * cannot be selected — so every id on these screens was readable and none was
 * usable. That is fine where the id is decoration and wrong wherever another
 * screen asks for it: issuing a grant takes a principal id, and a service
 * account's was not displayed at all.
 *
 * The clipboard can be refused, so the fallback says what actually happened
 * rather than claiming a copy that did not occur.
 *
 * ## Why it is an icon
 *
 * It was the word `copy`, which measured 39×19 in a browser — a tap target
 * under half the 44px the platforms ask for, sitting inside a table on a phone.
 * It also read as a label rather than as something to press, next to the id it
 * was labelling. It is a square with a glyph now, and the glyph becomes a
 * checkmark for a moment so the press has an answer.
 */
export const copyableId = (id: string): HTMLElement => {
  const note = h('span', { class: 'copied' })
  const button = h('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: `Copy ${id}`, 'aria-label': `Copy ${id}` })
  button.append(icon(...COPY_GLYPH))

  let timer: ReturnType<typeof setTimeout> | undefined
  button.addEventListener('click', () => {
    void (async () => {
      const ok = (await copyText(id)) === 'copied'
      button.replaceChildren(icon(...(ok ? DONE_GLYPH : COPY_GLYPH)))
      button.classList.toggle('is-copied', ok)
      // The glyph is the whole answer for somebody looking at it and no answer
      // at all for somebody who is not, so the accessible name carries the same
      // state. Without this a screen reader announces `Copy <id>` before the
      // press and `Copy <id>` after it.
      const said = ok ? 'Copied' : `Copy failed — ${id} is on the page`
      button.setAttribute('aria-label', said)
      button.title = said
      // On failure the whole id is put on the page rather than into the
      // clipboard: it is the one thing this control exists to hand over, and
      // a selectable line of text is a worse answer than a copy and a much
      // better one than nothing.
      note.textContent = ok ? '' : id
      clearTimeout(timer)
      timer = setTimeout(() => {
        button.replaceChildren(icon(...COPY_GLYPH))
        button.classList.remove('is-copied')
        button.setAttribute('aria-label', `Copy ${id}`)
        button.title = `Copy ${id}`
      }, 2000)
    })()
  })

  return h('span', { class: 'idcopy' }, shortId(id), button, note)
}

/**
 * A permission chip.
 *
 * The one place a pill radius is allowed, and the colours carry information
 * rather than mood: read teal, write blue, admin violet, deny red. Deny sits
 * outside the mark palette on purpose — it is the state that must not look like
 * it belongs.
 */
export const chip = (permission: string, effect = 'allow'): HTMLElement =>
  h('span', { class: `chip chip-${effect === 'deny' ? 'deny' : permission}` }, permission)

/** A relative time, because an operator reads "4 minutes ago" faster. */
export function ago(iso: string | null): string {
  if (iso === null) return 'never'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86_400, 'day'],
  ]
  let value = seconds
  let label = 'second'
  for (const [size, name] of units) {
    if (seconds >= size) {
      value = Math.floor(seconds / size)
      label = name
    }
  }
  return `${value} ${label}${value === 1 ? '' : 's'} ago`
}

/**
 * A relative time as a table cell, which is the only way one appears.
 *
 * "204 days ago" is three words and one value, and a table cell is happy to
 * break it across three lines. It did: measured in Chromium at 390, a People
 * row carrying that string was **89px** while the rows beside it, reading "7
 * days ago" and "1 day ago", were 66px. The column is as wide as its widest
 * entry, so the oldest row in a table deforms only itself, which reads as a
 * rendering glitch rather than as a wrapped word.
 *
 * The same shape as the action column, which wrapped for the same reason and
 * was fixed on `.right`. That fix is why this is a helper and not a sixth
 * class on a fifth call site: `ago()` is rendered into a `<td>` in three views
 * and five places, every one of which had to remember, with nothing that knew
 * there were five. `lint:admin-layout` asks.
 *
 * The class is taken rather than assumed so this changes no view's colour —
 * three of the five cells are `muted` and two are not.
 */
export const agoCell = (iso: string | null, className = 'muted'): HTMLElement =>
  h('td', { class: `ago${className === '' ? '' : ` ${className}`}` }, ago(iso))
