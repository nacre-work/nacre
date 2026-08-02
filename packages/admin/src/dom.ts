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
