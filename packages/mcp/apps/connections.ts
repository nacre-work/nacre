/**
 * `ui://nacre/connections.html` — who has connected what, as whom, with which
 * ceiling, and a revoke. docs/mcp-admin.md, "Panels".
 *
 * Rendered when the model calls `list_connections`. Revoke is the write
 * `revoke_connection`, proposed from here exactly as when the model calls it:
 * the server's sentence appears under the table with the person's Apply and
 * Cancel, and the key Apply presents comes from the result's `_meta`, which
 * this panel reads and the model is not shown. Nothing is revoked until the
 * person presses Apply.
 */
import { call, clear, connect, el, mount, parsed, permissionChip, proposeHere, status, when } from './shared.js'

interface Connection {
  readonly id: string
  readonly application: string | null
  readonly administrative: boolean
  readonly acts_as: { readonly person?: string; readonly service_account?: string }
  readonly approved_by: string
  readonly approver_disabled?: boolean
  readonly ceiling: readonly string[] | null
  readonly layers: string | readonly { readonly layer: string; readonly ceiling?: readonly string[] }[]
  readonly created_at: string
  readonly last_refreshed_at: string | null
  readonly revoked: boolean
}

async function main(): Promise<void> {
  const root = mount('Connections')
  const app = await connect('nacre-connections')

  const table = el('table', { class: 'table', hidden: '' })
  const decide = el('div')
  root.append(el('div', { class: 'table-wrap' }, table), decide)
  let rows: readonly Connection[] = []

  app.ontoolresult = (result) => {
    const page = parsed<{ connections?: readonly Connection[] }>(result)
    if (!page.ok) {
      status(root, page.message, 'error')
      return
    }
    rows = page.value.connections ?? []
    show()
  }

  async function reload(): Promise<void> {
    const answer = await call(app, 'list_connections', {})
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    rows = (answer.value as { connections?: readonly Connection[] }).connections ?? []
    show()
  }

  function show(): void {
    clear(table)
    if (rows.length === 0) {
      table.hidden = true
      status(root, 'No application is connected to this organization.')
      return
    }
    table.hidden = false
    // Three columns, so the panel fits a phone: who it acts as, through
    // which surface and when it was last used are lines under its name.
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Application'), el('th', {}, 'May'), el('th', {}, ''))))
    const body = el('tbody')
    for (const c of rows) {
      const actsAs = c.acts_as.person ?? c.acts_as.service_account ?? '—'
      const layers =
        typeof c.layers === 'string'
          ? c.layers
          : c.layers.map((l) => (l.ceiling === undefined ? l.layer : `${l.layer} (${l.ceiling.join(', ')})`)).join(', ')
      const action = c.revoked
        ? el('span', { class: 'chip chip-deny' }, 'revoked')
        : el('button', { type: 'button', class: 'btn' }, 'Revoke')
      if (!c.revoked) {
        action.addEventListener('click', () => {
          void (async () => {
            const outcome = await proposeHere(app, decide, 'revoke_connection', { connection: c.id })
            if (outcome === 'applied') await reload()
          })()
        })
      }
      body.append(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            c.application ?? 'an application',
            el('span', { class: 'sub' }, `as ${actsAs}`),
            el('span', { class: 'sub' }, `${c.administrative ? 'administrative MCP' : 'MCP and the API'} · used ${when(c.last_refreshed_at ?? c.created_at, 'short')}`),
            ...(c.approver_disabled === true ? [el('span', { class: 'sub' }, 'suspended: the person is disabled')] : []),
          ),
          el(
            'td',
            {},
            el('span', { class: 'chips' }, ...(c.ceiling === null ? [el('span', { class: 'chip chip-plain' }, 'all')] : c.ceiling.map(permissionChip))),
            el('span', { class: 'sub' }, layers),
          ),
          el('td', {}, action),
        ),
      )
    }
    table.append(body)
    const live = rows.filter((c) => !c.revoked).length
    status(root, `${String(live)} live connection${live === 1 ? '' : 's'}, ${String(rows.length - live)} revoked.`)
  }
}

void main()
