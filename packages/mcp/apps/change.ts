/**
 * `ui://nacre/change.html` — a proposed change on the administrative MCP, with
 * Apply and Cancel. docs/mcp-admin.md, "A change is proposed, and a person
 * applies it".
 *
 * Rendered when the model calls a write tool on `/mcp/admin`. The tool stored
 * what it would do and answered with it; this panel shows that answer whole and
 * is the only thing in the conversation that can apply it. Its two buttons are
 * tools declared `visibility: ["app"]`, which a host leaves out of what the
 * model is offered, and the proposal they name arrives in the result's `_meta`
 * — the host's and the view's, not the model's. So a model that was talked into
 * proposing something can get it as far as this screen, and a person reads it
 * here before anything happens.
 *
 * Everything shown is the server's own sentence and facts, written from names
 * it resolved — never text the model typed — and drawn with `textContent`.
 */
import { call, clear, connect, el, mount, status } from './shared.js'

interface Proposed {
  readonly proposed?: string
  readonly details?: readonly { readonly label: string; readonly value: string }[]
  readonly expires_at?: string
}

interface ProposalMeta {
  readonly id?: string
  /** What Apply presents. Handed to this panel and to nothing the model reads. */
  readonly key?: string
  readonly expires_at?: string
}

const CHANGE_STYLE = `
  .summary { margin: 0 0 12px; font-size: 15px; line-height: 1.5; font-weight: 600; }
  .facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0 0 14px; font-size: 13.5px; }
  .facts dt { font-family: var(--n-font-mono); font-size: 12px; color: var(--n-text-muted); text-transform: uppercase; letter-spacing: 0.04em; padding-top: 2px; }
  .facts dd { margin: 0; overflow-wrap: break-word; min-width: 0; }
  .when { margin: 0 0 12px; font-size: 13px; color: var(--n-text-muted); }
  .decided { font-weight: 600; color: var(--n-text); }
`

async function main(): Promise<void> {
  const root = mount('Proposed change')
  const style = el('style')
  style.textContent = CHANGE_STYLE
  document.head.append(style)
  const app = await connect('nacre-change')

  const summary = el('p', { class: 'summary', hidden: '' })
  const facts = el('dl', { class: 'facts', hidden: '' })
  const when = el('p', { class: 'when', hidden: '' })
  const apply = el('button', { type: 'button', class: 'btn btn-primary', hidden: '' }, 'Apply')
  const cancel = el('button', { type: 'button', class: 'btn', hidden: '' }, 'Cancel')
  root.append(summary, facts, when, el('div', { class: 'row' }, apply, cancel))

  let id: string | undefined
  let key: string | undefined
  let expiresAt = Number.NaN
  let decided = false
  let timer: ReturnType<typeof setInterval> | undefined

  const settle = (text: string, kind: 'info' | 'error' = 'info'): void => {
    decided = true
    apply.hidden = true
    cancel.hidden = true
    if (timer !== undefined) clearInterval(timer)
    when.hidden = true
    status(root, text, kind)
  }

  const tick = (): void => {
    if (decided || Number.isNaN(expiresAt)) return
    const left = expiresAt - Date.now()
    if (left <= 0) {
      settle('This proposal expired without being applied. Nothing changed; ask for it again if it is still wanted.')
      return
    }
    const minutes = Math.ceil(left / 60_000)
    when.textContent = `Nothing has changed yet. This proposal expires in ${String(minutes)} minute${minutes === 1 ? '' : 's'}.`
  }

  app.ontoolresult = (result) => {
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (result.isError === true) {
      // The tool refused to propose — a name it could not resolve, a value it
      // will not take. The sentence is the server's own.
      status(root, text || 'Nothing was proposed.', 'error')
      return
    }
    let value: Proposed
    try {
      value = JSON.parse(text) as Proposed
    } catch {
      status(root, 'The proposal could not be read.', 'error')
      return
    }
    summary.textContent = value.proposed ?? ''
    summary.hidden = summary.textContent === ''
    clear(facts)
    for (const fact of value.details ?? []) facts.append(el('dt', {}, fact.label), el('dd', {}, fact.value))
    facts.hidden = (value.details ?? []).length === 0

    const meta = (result._meta as Record<string, unknown> | undefined)?.['nacre/proposal'] as ProposalMeta | undefined
    id = typeof meta?.id === 'string' ? meta.id : undefined
    key = typeof meta?.key === 'string' ? meta.key : undefined
    expiresAt = Date.parse(meta?.expires_at ?? value.expires_at ?? '')
    if (id === undefined || key === undefined) {
      // A host that drops `_meta` cannot hand the panel what it applies. The
      // proposal is still waiting, where the person can reach it.
      status(root, "This panel was not handed the proposal, so it cannot apply it. It is waiting on the console's Proposals screen.")
      return
    }
    apply.hidden = false
    cancel.hidden = false
    when.hidden = false
    tick()
    timer = setInterval(tick, 15_000)
  }

  const decide = (tool: 'apply_proposal' | 'cancel_proposal'): void => {
    // No id is nothing to decide, whatever the buttons look like.
    if (id === undefined || key === undefined || decided) return
    void (async () => {
      apply.disabled = true
      cancel.disabled = true
      const answer = await call(app, tool, { proposal: id, key })
      if (answer.ok) {
        settle(tool === 'apply_proposal' ? 'Applied.' : 'Cancelled. Nothing changed.')
        root.querySelector('.status')?.classList.add('decided')
        return
      }
      settle(answer.message, 'error')
    })()
  }

  apply.addEventListener('click', () => decide('apply_proposal'))
  cancel.addEventListener('click', () => decide('cancel_proposal'))
}

void main()
