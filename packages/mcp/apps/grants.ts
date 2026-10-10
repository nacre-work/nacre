/**
 * `ui://nacre/grants.html` — grants as issued, and the form that changes them.
 * docs/mcp-admin.md, "Panels".
 *
 * Opened by the core's `list_grants`, and by any module's read that names this
 * panel — `acl-advanced`'s `list_document_grants` is the one today, which is how
 * a document's access is set from a conversation. Both answer in one shape:
 * who, on what, which permission, allow or deny.
 *
 * Revoke on a row is the core's `revoke_grant`, which withdraws any grant by
 * id, a module's included. The form under the table offers only what the
 * server put in the result's `_meta` — the writes on this surface the read said
 * fit its scope, each already checked by the core to be a write — and a press
 * **proposes**: the server's sentence appears under the form with Apply and
 * Cancel, and nothing changes until the person presses Apply. After that the
 * panel asks the same read again, so what it shows is what the server says now.
 *
 * Every name is somebody's text, drawn with `textContent`.
 */
import { call, clear, connect, el, field, mount, parsed, permissionChip, proposeHere, status } from './shared.js'

interface Grant {
  readonly id: string
  readonly principal: { readonly type: string; readonly name: string | null }
  readonly scope: { readonly type: string; readonly id?: string; readonly name: string | null }
  readonly permission: string
  readonly effect: string
}

interface Page {
  readonly layer?: string
  readonly grants?: readonly Grant[]
  readonly next_cursor?: string | null
}

interface Offer {
  readonly tool: string
  readonly label: string
  readonly document: 'none' | 'optional' | 'required'
  readonly fixed: Readonly<Record<string, string>>
}

interface PanelMeta {
  readonly tool?: string
  readonly offers?: readonly Offer[]
}

const KIND_WORD: Readonly<Record<string, string>> = { user: 'person', group: 'group', service_account: 'service account' }

async function main(): Promise<void> {
  const root = mount('Grants')
  const app = await connect('nacre-grants')

  const facts = el('p', { class: 'facts-line', hidden: '' })
  const table = el('table', { class: 'table', hidden: '' })
  const more = el('button', { type: 'button', class: 'btn', hidden: '' }, 'More')
  const decide = el('div')

  const who = el('input', { class: 'input', placeholder: 'dana@example.com', 'aria-label': 'A person, group or service account' })
  const kind = el('select', { 'aria-label': 'Kind' })
  for (const [value, label] of [['person', 'person'], ['group', 'group'], ['service_account', 'service account']] as const) {
    kind.append(el('option', { value }, label))
  }
  const doc = el('input', { class: 'input', placeholder: 'an external id or the exact title', 'aria-label': 'Document' })
  const permission = el('select', { 'aria-label': 'Permission' })
  for (const p of ['read', 'write', 'admin']) permission.append(el('option', { value: p }, p))
  const docField = field('Document', doc)
  const buttons = el('div', { class: 'row' })
  const form = el(
    'div',
    { hidden: '' },
    el('h2', {}, 'Change access'),
    el('div', { class: 'row' }, field('Address or name', who), el('label', { class: 'field fit' }, el('span', {}, 'Kind'), el('span', { class: 'select' }, kind))),
    el('div', { class: 'row' }, docField, el('label', { class: 'field fit' }, el('span', {}, 'Permission'), el('span', { class: 'select' }, permission))),
    buttons,
    el('p', { class: 'facts-line' }, 'A press proposes the change; nothing happens until you apply it. Write does not include read; admin includes both.'),
  )

  root.append(facts, el('div', { class: 'table-wrap' }, table), el('div', { class: 'row after-table' }, more), form, decide)

  /** The read and its arguments, so a change can be followed by the same question. */
  let tool: string | null = null
  let query: Record<string, unknown> = {}
  let cursor: string | null = null
  const rows: Grant[] = []

  app.ontoolinput = (params) => {
    query = { ...(params.arguments ?? {}) }
    delete query.cursor
  }
  app.ontoolresult = (result) => {
    const meta = ((result as { _meta?: Record<string, unknown> })._meta?.['nacre/panel'] ?? {}) as PanelMeta
    tool = typeof meta.tool === 'string' ? meta.tool : null
    offer(meta.offers ?? [])
    const page = parsed<Page>(result)
    if (!page.ok) {
      status(root, page.message, 'error')
      return
    }
    replace(page.value)
  }

  function replace(page: Page): void {
    rows.length = 0
    add(page)
  }

  function add(page: Page): void {
    rows.push(...(page.grants ?? []))
    cursor = page.next_cursor ?? null
    const on = page.layer ?? (typeof query.layer === 'string' ? query.layer : typeof query.workspace === 'string' ? query.workspace : null)
    facts.hidden = on === null
    if (on !== null) facts.replaceChildren('On ', el('code', { class: 'slug' }, on), '.')
    show()
  }

  function show(): void {
    clear(table)
    if (rows.length === 0) {
      table.hidden = true
      more.hidden = true
      status(root, 'No grants here.')
      return
    }
    table.hidden = false
    // Three columns, so the panel fits a phone: what the grant is on is a line
    // under its permission rather than a column of its own.
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Who'), el('th', {}, 'Access'), el('th', {}, ''))))
    const body = el('tbody')
    for (const g of rows) {
      const revoke = el('button', { type: 'button', class: 'btn' }, 'Revoke')
      revoke.addEventListener('click', () => {
        void (async () => {
          const outcome = await proposeHere(app, decide, 'revoke_grant', { grant: g.id })
          if (outcome === 'applied') await reload()
        })()
      })
      const deny = g.effect === 'deny'
      body.append(
        el(
          'tr',
          {},
          el('td', {}, g.principal.name ?? 'no longer exists', el('span', { class: 'sub' }, KIND_WORD[g.principal.type] ?? g.principal.type)),
          el(
            'td',
            {},
            permissionChip(deny ? 'deny' : g.permission),
            el('span', { class: 'sub' }, `${deny ? `${g.permission} denied, ` : ''}on ${g.scope.name ?? g.scope.id ?? 'a scope that no longer exists'} · ${g.scope.type}`),
          ),
          el('td', {}, revoke),
        ),
      )
    }
    table.append(body)
    more.hidden = cursor === null
    const denies = rows.filter((g) => g.effect === 'deny').length
    status(
      root,
      `${String(rows.length)} grant${rows.length === 1 ? '' : 's'}${denies === 0 ? '' : `, ${String(denies)} of them deny`}${cursor === null ? '.' : ' so far.'}`,
    )
  }

  function offer(offers: readonly Offer[]): void {
    clear(buttons)
    form.hidden = offers.length === 0
    docField.hidden = offers.every((o) => o.document === 'none')
    for (const o of offers) {
      const press = el('button', { type: 'button', class: o.label.toLowerCase().startsWith('deny') ? 'btn' : 'btn btn-primary' }, o.label)
      press.addEventListener('click', () => {
        void propose(o)
      })
      buttons.append(press)
    }
  }

  async function propose(o: Offer): Promise<void> {
    const name = who.value.trim()
    const document = doc.value.trim()
    if (name === '') {
      status(decide, 'Say who: an address, a group name or a service account name.', 'error')
      return
    }
    if (o.document === 'required' && document === '') {
      status(decide, `${o.label} needs a document: its external id or its exact title.`, 'error')
      return
    }
    const args: Record<string, unknown> = {
      ...o.fixed,
      [kind.value]: name,
      permission: permission.value,
      ...(o.document !== 'none' && document !== '' ? { document } : {}),
    }
    const outcome = await proposeHere(app, decide, o.tool, args)
    if (outcome === 'applied') {
      who.value = ''
      doc.value = ''
      await reload()
    }
  }

  async function ask(args: Record<string, unknown>, append: boolean): Promise<void> {
    if (tool === null) return
    const answer = await call(app, tool, args)
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    if (append) add(answer.value as Page)
    else replace(answer.value as Page)
  }

  async function reload(): Promise<void> {
    await ask(query, false)
  }

  more.addEventListener('click', () => {
    if (cursor === null) return
    more.disabled = true
    void ask({ ...query, cursor }, true).finally(() => {
      more.disabled = false
    })
  })
}

void main()
