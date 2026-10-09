/**
 * `ui://nacre/layer.html` — one layer's health. docs/mcp-admin.md, "Panels".
 *
 * Rendered when the model calls `layer_status`: documents indexed, pending and
 * failed; the most recent failures with their reason; the model the layer is
 * searched by; a reindex in progress and its recall gate.
 *
 * A failure that recovers by itself — an embedder restarting, a store that
 * blinked — is retried by the worker and says so. One that will not says that
 * instead, and offers nothing to press: retrying a document is a write on its
 * layer, and this surface's connection holds no `write` because it changes no
 * documents. The answer to one of those is fixing its cause and re-sending it.
 *
 * A document's title is somebody's text, and the failure's detail is the
 * stored error with every host and address taken out by the server.
 */
import { clear, connect, el, mount, parsed, status, when } from './shared.js'

interface LayerStatus {
  readonly layer: {
    readonly slug: string
    readonly name: string
    readonly description: string
    readonly workspace: string | null
    readonly model: string | null
  }
  readonly documents: { readonly indexed: number; readonly pending: number; readonly failed: number }
  readonly failures: readonly {
    readonly id: string
    readonly external_id: string | null
    readonly title: string | null
    readonly reason: string
    readonly recovers_by_itself: boolean
    readonly detail: string
    readonly attempts: number
    readonly failed_at: string
  }[]
  readonly reindex: {
    readonly status: string
    readonly phase: string
    readonly shadow_vector: string
    readonly done: number
    readonly total: number
    readonly error: string | null
    readonly check: { readonly recall: number; readonly floor: number; readonly passed: boolean; readonly queries: number } | null
  } | null
  readonly reference_queries: number
}

async function main(): Promise<void> {
  const root = mount('Layer')
  const app = await connect('nacre-layer')

  const facts = el('p', { class: 'facts-line', hidden: '' })
  const stats = el('div', { class: 'stats', hidden: '' })
  const reindex = el('div', { hidden: '' })
  const failuresTitle = el('h2', { hidden: '' }, 'Recent failures')
  const failures = el('table', { class: 'table', hidden: '' })
  root.append(facts, stats, reindex, failuresTitle, el('div', { class: 'table-wrap' }, failures))

  app.ontoolresult = (result) => {
    const answer = parsed<LayerStatus>(result)
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    show(answer.value)
  }

  function show(s: LayerStatus): void {
    facts.hidden = false
    facts.replaceChildren(
      el('b', {}, s.layer.name),
      ' ',
      el('code', { class: 'slug' }, s.layer.slug),
      s.layer.workspace === null ? '' : ` in ${s.layer.workspace}`,
      s.layer.model === null ? '' : `, searched by ${s.layer.model}`,
      '.',
      ...(s.layer.description === '' ? [] : [el('span', { class: 'sub' }, s.layer.description)]),
    )

    stats.hidden = false
    stats.replaceChildren(
      ...([
        ['indexed', s.documents.indexed],
        ['pending', s.documents.pending],
        ['failed', s.documents.failed],
      ] as const).map(([label, n]) => el('div', { class: 'stat' }, el('b', {}, String(n)), el('span', {}, label))),
    )

    clear(reindex)
    reindex.hidden = s.reindex === null
    if (s.reindex !== null) {
      const r = s.reindex
      const bar = el('progress', { max: String(Math.max(r.total, 1)), value: String(r.done) })
      const gate =
        r.check === null
          ? s.reference_queries === 0
            ? 'No recall gate: this layer has no reference queries.'
            : `Recall gate: ${String(s.reference_queries)} reference queries, not scored yet.`
          : `Recall gate: ${r.check.recall.toFixed(2)} against a floor of ${r.check.floor.toFixed(2)} — ${r.check.passed ? 'passed' : 'not passed'}.`
      reindex.append(
        el('h2', {}, 'Moving to another model'),
        el('p', { class: 'facts-line' }, `${r.status}, ${r.phase}: ${String(r.done)} of ${String(r.total)} onto `, el('code', {}, r.shadow_vector), '.'),
        bar,
        el('p', { class: 'facts-line' }, gate),
        ...(r.error === null ? [] : [el('p', { class: 'facts-line' }, r.error)]),
      )
    }

    clear(failures)
    failuresTitle.hidden = s.failures.length === 0
    failures.hidden = s.failures.length === 0
    if (s.failures.length === 0) {
      status(root, s.documents.failed === 0 ? 'Nothing has failed in this layer.' : '')
      return
    }
    // Two columns, so the panel fits a phone: when, how often and whether it
    // comes back are lines under the reason rather than columns of their own.
    failures.append(el('thead', {}, el('tr', {}, el('th', {}, 'Document'), el('th', {}, 'Reason'))))
    const body = el('tbody')
    for (const f of s.failures) {
      body.append(
        el(
          'tr',
          {},
          el(
            'td',
            {},
            f.title ?? f.external_id ?? f.id,
            el('span', { class: 'sub' }, `${when(f.failed_at)} · ${String(f.attempts)} attempt${f.attempts === 1 ? '' : 's'}`),
          ),
          el(
            'td',
            {},
            el('span', { class: `chip ${f.recovers_by_itself ? 'chip-plain' : 'chip-error'}` }, f.reason),
            el('span', { class: 'sub' }, f.recovers_by_itself ? 'retried by itself' : 'will not recover by itself'),
            el('span', { class: 'sub' }, f.detail),
          ),
        ),
      )
    }
    failures.append(body)
    status(
      root,
      s.documents.failed > s.failures.length
        ? `The ${String(s.failures.length)} most recent of ${String(s.documents.failed)} failures.`
        : `${String(s.failures.length)} failure${s.failures.length === 1 ? '' : 's'}.`,
    )
  }
}

void main()
