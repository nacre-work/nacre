/**
 * `ui://nacre/layers.html` — the layers this principal may read, as a table.
 *
 * Rendered when the model calls `list_layers`. The host hands over the first
 * page; a button reads the next through the host, so a person sees the whole
 * catalog the model would have had to page through one call at a time.
 */
import { call, clear, connect, el, mount, status, type LayerRow } from './shared.js'

async function main(): Promise<void> {
  const root = mount('Layers you may read')
  const app = await connect('nacre-layers')

  const table = el('table', { class: 'table', hidden: '' })
  const more = el('button', { type: 'button', class: 'btn', hidden: '' }, 'More')
  root.append(el('div', { class: 'table-wrap' }, table), el('div', { class: 'row after-table' }, more))
  const rows: LayerRow[] = []
  let cursor: string | null = null

  app.ontoolresult = (result) => {
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (result.isError === true) {
      status(root, text, 'error')
      return
    }
    try {
      const page = JSON.parse(text) as { layers?: LayerRow[]; next_cursor?: string | null }
      add(page)
    } catch {
      status(root, 'The result could not be read.', 'error')
    }
  }

  function add(page: { layers?: LayerRow[]; next_cursor?: string | null }): void {
    rows.push(...(page.layers ?? []))
    cursor = page.next_cursor ?? null
    show()
  }

  function show(): void {
    clear(table)
    if (rows.length === 0) {
      table.hidden = true
      status(root, 'No layers are available to you.')
      more.hidden = true
      return
    }
    table.hidden = false
    table.append(
      el('thead', {}, el('tr', {}, el('th', {}, 'Layer'), el('th', {}, 'Slug'), el('th', { class: 'num' }, 'Documents'))),
    )
    const body = el('tbody')
    for (const layer of rows) {
      body.append(
        el(
          'tr',
          {},
          el('td', {}, layer.name, ...(layer.description ? [el('span', { class: 'sub' }, layer.description)] : [])),
          el('td', {}, el('code', { class: 'slug' }, layer.slug)),
          el('td', { class: 'num' }, String(layer.documentCount)),
        ),
      )
    }
    table.append(body)
    more.hidden = cursor === null
    status(root, `${rows.length} layer${rows.length === 1 ? '' : 's'} you may read${cursor === null ? '.' : ' so far.'}`)
  }

  more.addEventListener('click', () => {
    void (async () => {
      more.disabled = true
      const answer = await call(app, 'list_layers', { limit: 100, ...(cursor === null ? {} : { cursor }) })
      more.disabled = false
      if (!answer.ok) {
        status(root, answer.message, 'error')
        return
      }
      add(answer.value as { layers?: LayerRow[]; next_cursor?: string | null })
    })()
  })
}

void main()
