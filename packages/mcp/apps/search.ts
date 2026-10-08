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
import { call, clear, connect, el, layers, mount, status, type LayerRow } from './shared.js'

interface Hit {
  chunk_id: string
  doc_id: string
  layer: string
  title: string | null
  score: number
  text?: string
}

async function main(): Promise<void> {
  const root = mount()
  const app = await connect('nacre-search')

  const query = el('input', { type: 'text', 'aria-label': 'Query', placeholder: 'Search…' })
  const scope = el('select', { 'aria-label': 'Layer' }, el('option', { value: '' }, 'every layer'))
  const button = el('button', { type: 'button' }, 'Search')
  const table = el('table')
  root.append(el('div', { class: 'row' }, query, scope, button), table)

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
      status(root, 'Nothing you may see matched. That is not an error, and retrying will not change it.')
      return
    }
    table.append(
      el('thead', {}, el('tr', {}, el('th', {}, 'Title'), el('th', {}, 'Layer'), el('th', {}, 'Document'), el('th', {}, 'Score'))),
    )
    const body = el('tbody')
    for (const hit of hits) {
      const row = el(
        'tr',
        {},
        el('td', {}, hit.title ?? el('span', { class: 'muted' }, 'untitled')),
        el('td', {}, el('code', {}, hit.layer)),
        el('td', {}, el('code', {}, hit.doc_id)),
        el('td', {}, hit.score.toFixed(3)),
      )
      body.append(row)
      if (hit.text) body.append(el('tr', {}, el('td', { colspan: '4', class: 'snippet muted' }, hit.text)))
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
