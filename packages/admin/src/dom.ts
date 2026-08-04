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
 */
export const copyableId = (id: string): HTMLElement => {
  const note = h('span', { class: 'copied' })
  return h('span', { class: 'idcopy' },
    shortId(id),
    h('button', {
      type: 'button',
      class: 'btn btn-quiet',
      title: `Copy ${id}`,
      onclick: async () => {
        // On failure the whole id is put on the page rather than into the
        // clipboard: it is the one thing this control exists to hand over, and
        // a selectable line of text is a worse answer than a copy and a much
        // better one than nothing.
        note.textContent = (await copyText(id)) === 'copied' ? 'copied' : id
      },
    }, 'copy'),
    note,
  )
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
