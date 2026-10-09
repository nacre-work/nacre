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
 * No framework. The look is this product's: the build inlines the brand
 * mirror the console ships — tokens and faces — and `STYLE` below is the
 * console's own control vocabulary at one height, so a panel reads as a
 * piece of Nacre inside the conversation. What the host decides is the
 * theme: `data-theme` from the host context picks light or dark, and the
 * page's own `prefers-color-scheme` answers when the host says nothing. The
 * host's style variables are deliberately not applied — a palette chosen
 * per host is a palette the brand does not control, and the permission
 * colours here carry meaning rather than mood.
 */
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps'

export const STYLE = `
  /* The palette and the faces are the brand mirror, inlined by the build.
     What this adds is the console's own derivations (admin.css): a sunk
     surface, a rule, faint text, an accent, and the dense strata on light
     and the ink strata on dark — the host says which theme through
     data-theme, and prefers-color-scheme decides when it says nothing. */
  :root {
    --n-surface-sunk: var(--n-pearl-050); --n-rule: var(--n-pearl-300);
    --n-text-faint: color-mix(in srgb, var(--n-ink-300) 55%, var(--n-ink-500));
    --n-accent: var(--n-strata-2-dense);
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --n-bg: var(--n-ink-900); --n-surface: var(--n-ink-800); --n-border-color: var(--n-ink-700);
    --n-text: var(--n-pearl-100); --n-text-muted: var(--n-ink-300);
    --n-surface-sunk: var(--n-ink-900); --n-rule: var(--n-ink-700); --n-text-faint: var(--n-ink-300);
    --n-accent: var(--n-strata-3-on-dark); color-scheme: dark;
  } }
  :root[data-theme="dark"] {
    --n-surface-sunk: var(--n-ink-900); --n-rule: var(--n-ink-700); --n-text-faint: var(--n-ink-300);
    --n-accent: var(--n-strata-3-on-dark); color-scheme: dark;
  }

  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    padding: 14px 16px 16px;
    background: var(--n-surface); color: var(--n-text);
    font-family: var(--n-font-body); font-size: 14px; line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  h1 { font-family: var(--n-font-display); font-weight: 700; font-size: 17px; letter-spacing: -0.01em; margin: 0 0 12px; }
  h1 .kind { margin-left: 8px; }
  .kind { font-family: var(--n-font-mono); font-weight: 400; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--n-text-faint); }
  code { font-family: var(--n-font-mono); font-size: 12.5px; word-break: break-all; }
  .muted { color: var(--n-text-muted); }

  /* ─── Controls: every one is 36px tall, whatever the element ─────── */
  .row { display: flex; gap: 8px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 12px; }
  .row > * { margin: 0; }
  .row.after-table { margin: 12px 0 0; }
  .field { display: flex; flex-direction: column; gap: 4px; flex: 1 1 12em; min-width: 0; }
  .field.fit { flex: 0 0 auto; }
  .field > span { font-family: var(--n-font-mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--n-text-faint); }
  .input, .btn, .select > select, .file {
    height: 36px; font: inherit; font-size: 14px; line-height: 20px;
    border-radius: var(--n-radius); border: 1px solid var(--n-border-color);
    margin: 0;
  }
  .input { width: 100%; padding: 0 10px; background: var(--n-bg); color: var(--n-text); }
  .input::placeholder { color: var(--n-text-faint); }
  .input.mono { font-family: var(--n-font-mono); font-size: 13px; }
  .btn { display: inline-flex; align-items: center; padding: 0 14px; background: var(--n-surface); color: var(--n-text); cursor: pointer; touch-action: manipulation; white-space: nowrap; }
  .btn:hover { border-color: var(--n-rule); }
  .btn-primary { background: var(--n-accent); border-color: var(--n-accent); color: var(--n-pearl-000); font-weight: 600; }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn:disabled, .btn:disabled:hover { opacity: 0.45; cursor: not-allowed; filter: none; }
  /* A select drawn like the input beside it: the native arrow is replaced by
     a chevron the wrapper draws, so the control is the same box at the same
     height on every platform and the face matches. */
  .select { position: relative; display: block; }
  .select > select { width: 100%; appearance: none; -webkit-appearance: none; padding: 0 30px 0 10px; background: var(--n-bg); color: var(--n-text); cursor: pointer; }
  .select::after { content: ""; position: absolute; right: 12px; top: 13px; width: 7px; height: 7px; border-right: 1.5px solid var(--n-text-muted); border-bottom: 1.5px solid var(--n-text-muted); transform: rotate(45deg); pointer-events: none; }
  /* The file control is a label over a visually hidden input, so it is the
     same button as every other control rather than the platform's own
     widget, which is a different height on every browser. The input stays
     in the tree and focusable; the label shows its state. */
  .file { position: relative; display: inline-flex; align-items: center; gap: 8px; padding: 0 12px; background: var(--n-surface); color: var(--n-text); cursor: pointer; max-width: 100%; }
  .file:hover { border-color: var(--n-rule); }
  .file > input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .file:has(> input:focus-visible) { outline: 2px solid var(--n-accent); outline-offset: 2px; }
  .file > .name { font-family: var(--n-font-mono); font-size: 12.5px; color: var(--n-text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file.picked > .name { color: var(--n-text); }
  :where(button, input, select):focus-visible { outline: 2px solid var(--n-accent); outline-offset: 2px; }

  /* ─── Tables ─────────────────────────────────────────────────────── */
  .table-wrap { overflow-x: auto; }
  .table { width: 100%; border-collapse: collapse; background: var(--n-surface); border: 1px solid var(--n-border-color); border-radius: var(--n-radius); }
  .table th, .table td { padding: 8px 12px; text-align: left; vertical-align: top; }
  .table thead th { font-family: var(--n-font-mono); font-weight: 400; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--n-text-faint); border-bottom: 1px solid var(--n-rule); background: var(--n-surface-sunk); white-space: nowrap; }
  .table tbody tr + tr td { border-top: 1px solid var(--n-border-color); }
  .table th.num { text-align: right; }
  .table td.num { text-align: right; font-family: var(--n-font-mono); font-size: 12.5px; white-space: nowrap; }
  /* A second line under a cell's value — a layer's description, a hit's
     document id. A column each would be four columns, and at 390 four
     columns of this content do not fit; stacked, three do. */
  .table .sub { display: block; margin-top: 2px; font-size: 12.5px; color: var(--n-text-muted); }
  .table .sub code { font-size: 12px; color: var(--n-text-muted); white-space: nowrap; word-break: normal; }
  .table tr.snippet td { border-top: 0; padding-top: 0; }
  /* A slug is one word: a uuid may break anywhere, a slug must not —
     engineeri/ng reads as two things. */
  .slug { font-family: var(--n-font-mono); font-size: 12.5px; background: var(--n-surface-sunk); border: 1px solid var(--n-border-color); border-radius: var(--n-radius); padding: 1px 6px; white-space: nowrap; word-break: normal; }
  .snippet-text { white-space: pre-wrap; max-height: 6.5em; overflow: hidden; font-size: 13px; color: var(--n-text-muted); }

  /* ─── Status ─────────────────────────────────────────────────────── */
  .status { margin: 10px 0 0; font-size: 13px; color: var(--n-text-muted); }
  .status[data-kind=error] { color: var(--n-text); border: 1px solid var(--n-deny); border-left: 3px solid var(--n-deny); border-radius: var(--n-radius); background: var(--n-surface); padding: 10px 12px; }
  /* The sheen is what the brand reserves for "in progress", which is exactly
     what this bar says; a track and no width of its own, since the page is
     style-src inline only through the host and a width in the stylesheet
     is what the console learned to use. */
  progress { display: block; width: 100%; height: 6px; margin-top: 12px; border: 0; border-radius: var(--n-radius-pill); background: var(--n-surface-sunk); overflow: hidden; appearance: none; -webkit-appearance: none; }
  progress::-webkit-progress-bar { background: var(--n-surface-sunk); border-radius: var(--n-radius-pill); }
  progress::-webkit-progress-value { background: var(--n-sheen); border-radius: var(--n-radius-pill); transition: width var(--n-motion-base) var(--n-ease); }
  progress::-moz-progress-bar { background: var(--n-sheen); border-radius: var(--n-radius-pill); }
  progress[hidden] { display: none; }
`

/** The connected app, with the host's theme applied and tracked. */
export async function connect(name: string): Promise<App> {
  const app = new App({ name, version: '0' })
  app.onhostcontextchanged = (context) => {
    if (context.theme) applyDocumentTheme(context.theme)
  }
  await app.connect()
  const context = app.getHostContext()
  if (context?.theme) applyDocumentTheme(context.theme)
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

/** The page: the stylesheet, a heading naming the view, and the root the view draws into. */
export function mount(title: string): HTMLElement {
  const style = el('style')
  style.textContent = STYLE
  document.head.append(style)
  document.body.append(el('h1', {}, title, el('span', { class: 'kind' }, 'Nacre')))
  const root = el('main')
  document.body.append(root)
  return root
}

/** A labelled control, the console's `.field`: a mono caption over the control. */
export function field(label: string, control: Node, fit = false): HTMLElement {
  return el('label', { class: fit ? 'field fit' : 'field' }, el('span', {}, label), control)
}

/** A `<select>` drawn like the input beside it. */
export function select(control: HTMLSelectElement): HTMLElement {
  control.classList.add('input')
  return el('span', { class: 'select' }, control)
}

/**
 * A file control that is the same button as every other control. The native
 * widget is a different height on every browser and cannot be styled; the
 * input stays in the tree, over the label and invisible, so a press and a
 * focus land on it and the label says what was picked.
 */
export function fileControl(input: HTMLInputElement, prompt: string): HTMLElement {
  const name = el('span', { class: 'name' }, prompt)
  const label = el('label', { class: 'file' }, input, name)
  input.addEventListener('change', () => {
    const picked = input.files?.[0]
    name.textContent = picked === undefined ? prompt : picked.name
    label.classList.toggle('picked', picked !== undefined)
  })
  return label
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
