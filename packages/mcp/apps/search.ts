/**
 * `ui://nacre/search.html` — what this principal can see, as a table.
 *
 * Rendered when the model calls `search`: the host hands the view the call's
 * result, and the view shows every hit with its layer, its document id and
 * its score, which is the one thing a transcript cannot show — that the
 * answer is the permitted set and nothing else. A search box re-runs the
 * tool through the host, so a person can check a query the model did not
 * think to make, against exactly the access the model has.
 */
import { call, clear, connect, el, field, layers, mount, select, status, type LayerRow } from './shared.js'

interface Hit {
  chunk_id: string
  doc_id: string
  layer: string
  title: string | null
  score: number
  text?: string
}

/**
 * A uuid shortened to its ends, the console's own treatment: thirty-six
 * characters of hex in a table on a phone break mid-value and read as three
 * ids. The whole id is the cell's title, and it is in the tool result the
 * model already has.
 */
function shortId(id: string): string {
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

async function main(): Promise<void> {
  const root = mount('Search')
  const app = await connect('nacre-search')

  const query = el('input', { class: 'input', type: 'text', placeholder: 'What are you looking for?' })
  const scope = el('select', {}, el('option', { value: '' }, 'every layer'))
  const button = el('button', { type: 'button', class: 'btn btn-primary' }, 'Search')
  const table = el('table', { class: 'table', hidden: '' })
  root.append(
    el('div', { class: 'row' }, field('Query', query), field('Layer', select(scope), true), el('div', { class: 'field fit' }, button)),
    el('div', { class: 'table-wrap' }, table),
  )

  app.ontoolinput = (params) => {
    const args = (params.arguments ?? {}) as { query?: unknown; layers?: unknown }
    if (typeof args.query === 'string') query.value = args.query
    if (Array.isArray(args.layers) && typeof args.layers[0] === 'string') scope.value = args.layers[0]
  }
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
      show(JSON.parse(text) as Hit[])
    } catch {
      status(root, 'The result could not be read.', 'error')
    }
  }

  void layers(app)
    .then((known: LayerRow[]) => {
      for (const layer of known) scope.append(el('option', { value: layer.slug }, layer.name))
    })
    .catch(() => undefined)

  function show(hits: Hit[]): void {
    clear(table)
    if (hits.length === 0) {
      table.hidden = true
      status(root, 'Nothing you may see matched. That is not an error, and retrying will not change it.')
      return
    }
    table.hidden = false
    table.append(
      el('thead', {}, el('tr', {}, el('th', {}, 'Document'), el('th', {}, 'Layer'), el('th', { class: 'num' }, 'Score'))),
    )
    const body = el('tbody')
    for (const hit of hits) {
      const row = el(
        'tr',
        {},
        el('td', {}, hit.title ?? el('span', { class: 'muted' }, 'untitled'), el('span', { class: 'sub' }, el('code', { title: hit.doc_id }, shortId(hit.doc_id)))),
        el('td', {}, el('code', { class: 'slug' }, hit.layer)),
        el('td', { class: 'num' }, hit.score.toFixed(3)),
      )
      body.append(row)
      if (hit.text) body.append(el('tr', { class: 'snippet' }, el('td', { colspan: '3' }, el('div', { class: 'snippet-text' }, hit.text))))
    }
    table.append(body)
    status(root, `${hits.length} result${hits.length === 1 ? '' : 's'} — the permitted set, filtered inside the index.`)
  }

  async function run(): Promise<void> {
    const q = query.value.trim()
    if (q === '') return
    button.disabled = true
    status(root, 'Searching…')
    const answer = await call(app, 'search', {
      query: q,
      top_k: 20,
      ...(scope.value === '' ? {} : { layers: [scope.value] }),
    })
    button.disabled = false
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    show(answer.value as Hit[])
  }
  button.addEventListener('click', () => void run())
  query.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void run()
  })
}

void main()
