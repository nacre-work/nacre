/**
 * What the three views share: a connected `App`, the host's theme, a way to
 * call a tool and read its answer, and a few DOM helpers.
 *
 * A view is a page in a host's sandboxed iframe. It reaches the server only
 * through the host (`callServerTool`), so every permission check runs where
 * it always runs; what the view adds is that a person can do in the
 * conversation what the model would otherwise have to be asked to do — pick a
 * file, read a result table, page through a list. Nothing here holds a
 * credential: the host holds the token, and the one network request a view
 * makes itself is the upload to a ticket URL, which is its own capability.
 *
 * No framework and no colour of its own: the host hands over its style
 * variables and the page inherits its font, so a view looks like the
 * conversation it is in rather than like this product.
 */
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps'

export const STYLE = `
  :root { font: 14px/1.45 var(--font-sans, system-ui, sans-serif); color: inherit; }
  body { margin: 0; padding: 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 8px; vertical-align: top; border-bottom: 1px solid var(--color-border-primary, currentColor); }
  th { font-weight: 600; opacity: 0.8; }
  code { font: 12px/1.4 var(--font-mono, ui-monospace, monospace); word-break: break-all; }
  /* A slug is one word: a uuid may break anywhere, a slug must not: engineeri/ng reads as two things. */
  .slug { white-space: nowrap; word-break: normal; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .row > * { margin: 0; }
  input[type=text], input[list], select { font: inherit; color: inherit; background: transparent; border: 1px solid var(--color-border-primary, currentColor); border-radius: 6px; padding: 6px 8px; min-height: 36px; }
  input[type=text] { flex: 1 1 12em; }
  button { font: inherit; min-height: 36px; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--color-border-primary, currentColor); background: var(--color-background-secondary, transparent); color: inherit; cursor: pointer; touch-action: manipulation; }
  button:disabled { opacity: 0.5; cursor: default; }
  .status { margin-top: 10px; opacity: 0.85; }
  .status[data-kind=error] { opacity: 1; font-weight: 600; }
  .muted { opacity: 0.7; }
  .snippet { white-space: pre-wrap; max-height: 6.5em; overflow: hidden; }
  progress { width: 100%; }
`

/** The connected app, with the host's theme applied and tracked. */
export async function connect(name: string): Promise<App> {
  const app = new App({ name, version: '0' })
  app.onhostcontextchanged = (context) => {
    if (context.theme) applyDocumentTheme(context.theme)
    if (context.styles?.variables) applyHostStyleVariables(context.styles.variables)
  }
  await app.connect()
  const context = app.getHostContext()
  if (context?.theme) applyDocumentTheme(context.theme)
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables)
  return app
}

/**
 * A tool's answer as the value it carried.
 *
 * This server answers every tool with one text block holding JSON (see
 * `results.ts`), and a failure as `isError` with a sentence; both are
 * returned as what they are, and a view decides what to show.
 */
export async function call(
  app: App,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  const result = await app.callServerTool({ name, arguments: args })
  const text = result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('')
  if (result.isError === true) return { ok: false, message: text || 'The call failed.' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: true, value: text }
  }
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
  for (const child of children) node.append(child)
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function mount(): HTMLElement {
  const style = el('style')
  style.textContent = STYLE
  document.head.append(style)
  const root = el('main')
  document.body.append(root)
  return root
}

export function status(root: HTMLElement, text: string, kind: 'info' | 'error' = 'info'): HTMLElement {
  let node = root.querySelector<HTMLElement>('.status')
  if (node === null) {
    node = el('p', { class: 'status' })
    root.append(node)
  }
  node.textContent = text
  node.dataset.kind = kind
  return node
}

export interface LayerRow {
  id: string
  slug: string
  name: string
  description: string
  documentCount: number
}

/** Every layer the caller may read, paged through `list_layers`. */
export async function layers(app: App): Promise<LayerRow[]> {
  const all: LayerRow[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const answer = await call(app, 'list_layers', { limit: 100, ...(cursor === undefined ? {} : { cursor }) })
    if (!answer.ok) throw new Error(answer.message)
    const value = answer.value as { layers?: LayerRow[]; next_cursor?: string | null }
    all.push(...(value.layers ?? []))
    if (!value.next_cursor) break
    cursor = value.next_cursor
  }
  return all
}
