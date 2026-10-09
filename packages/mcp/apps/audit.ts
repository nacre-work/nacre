/**
 * `ui://nacre/audit.html` — the access log, on the administrative MCP.
 * docs/mcp-admin.md, "Panels".
 *
 * Rendered when the model calls `query_audit`. The rows the model was handed,
 * drawn as the console draws them: when, who, what, and the result in one
 * column of one size. Pressing an actor narrows the log to that actor — the
 * console's own interaction, for the console's own reason: nobody knows a
 * uuid, and every actor worth filtering on is already on the screen. More
 * reads the next page through the host; nothing here holds a credential.
 *
 * Every value is somebody's text or the server's, drawn with `textContent`.
 */
import { call, clear, connect, el, identifier, mount, parsed, status, when } from './shared.js'

interface AuditEvent {
  readonly at: string
  readonly actor: { readonly type: string; readonly id: string | null; readonly name: string | null }
  readonly action: string
  readonly result: string
  readonly surface: string
  readonly connection: string | null
}

interface Page {
  readonly window?: { readonly from: string; readonly to: string }
  readonly events?: readonly AuditEvent[]
  readonly next_cursor?: string | null
}

const actorWord = (a: AuditEvent['actor']): string =>
  a.name ?? (a.type === 'service_account' ? 'a service account' : a.type === 'user' ? 'a person' : a.type)

async function main(): Promise<void> {
  const root = mount('Access log')
  const app = await connect('nacre-audit')

  const facts = el('p', { class: 'facts-line', hidden: '' })
  const everyone = el('button', { type: 'button', class: 'btn', hidden: '' }, 'Everyone')
  const table = el('table', { class: 'table', hidden: '' })
  const more = el('button', { type: 'button', class: 'btn', hidden: '' }, 'More')
  root.append(facts, el('div', { class: 'row', hidden: '' }, everyone), el('div', { class: 'table-wrap' }, table), el('div', { class: 'row after-table' }, more))

  /** The arguments the rows answer: the window and filters the model asked with. */
  let query: Record<string, unknown> = {}
  let narrowedTo: string | null = null
  let cursor: string | null = null
  const rows: AuditEvent[] = []

  app.ontoolinput = (params) => {
    query = { ...(params.arguments ?? {}) }
    delete query.cursor
  }
  app.ontoolresult = (result) => {
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
    rows.push(...(page.events ?? []))
    cursor = page.next_cursor ?? null
    if (page.window !== undefined) {
      facts.hidden = false
      facts.replaceChildren('From ', el('b', {}, when(page.window.from)), ' to ', el('b', {}, when(page.window.to)), narrowedTo === null ? '' : `, only ${narrowedTo}`, '.')
    }
    show()
  }

  function show(): void {
    clear(table)
    const bar = everyone.parentElement as HTMLElement
    bar.hidden = narrowedTo === null
    everyone.hidden = narrowedTo === null
    if (rows.length === 0) {
      table.hidden = true
      more.hidden = true
      status(root, 'Nothing in this window matches. That is an answer about the window and the filters, not proof nothing happened.')
      return
    }
    table.hidden = false
    // Three columns, so the panel fits a phone: the moment and the surface
    // are a second line under the action rather than columns of their own.
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'Action'), el('th', {}, 'Who'), el('th', {}, 'Result'))))
    const body = el('tbody')
    for (const event of rows) {
      const who =
        event.actor.id === null
          ? el('span', { class: 'muted' }, actorWord(event.actor))
          : el('button', { type: 'button', class: 'narrow', title: 'Only this actor' }, actorWord(event.actor))
      if (event.actor.id !== null) {
        const id = event.actor.id
        const name = actorWord(event.actor)
        who.addEventListener('click', () => void narrow(id, name))
      }
      body.append(
        el(
          'tr',
          {},
          el('td', {}, identifier(event.action), el('span', { class: 'sub' }, `${when(event.at, 'short')} · ${event.surface}`)),
          el('td', {}, who, ...(event.connection === null ? [] : [el('span', { class: 'sub' }, 'through a connected application')])),
          el(
            'td',
            {},
            el('span', { class: `chip ${event.result === 'deny' ? 'chip-deny' : event.result === 'error' ? 'chip-error' : 'chip-plain'}` }, event.result),
          ),
        ),
      )
    }
    table.append(body)
    more.hidden = cursor === null
    status(root, `${String(rows.length)} event${rows.length === 1 ? '' : 's'}${cursor === null ? '.' : ' so far.'}`)
  }

  async function ask(args: Record<string, unknown>, append: boolean): Promise<void> {
    const answer = await call(app, 'query_audit', args)
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    if (append) add(answer.value as Page)
    else replace(answer.value as Page)
  }

  async function narrow(actorId: string, name: string): Promise<void> {
    narrowedTo = name
    query = { ...query, actor: actorId }
    await ask(query, false)
  }

  everyone.addEventListener('click', () => {
    narrowedTo = null
    query = Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'actor'))
    void ask(query, false)
  })

  more.addEventListener('click', () => {
    if (cursor === null) return
    more.disabled = true
    void ask({ ...query, cursor }, true).finally(() => {
      more.disabled = false
    })
  })
}

void main()
