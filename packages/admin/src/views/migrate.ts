import type { Layer, ReferenceQuery, ReindexStatus } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h } from '../dom.js'
import { picker } from '../pick.js'

/**
 * Moving a layer onto a different embedding model, and the gate in front of it.
 *
 * A panel on the layer rather than a screen of its own: a migration is a
 * property of one layer, and a list of migrations across an organization is a
 * report nobody asked for — there is at most one running at a time and the
 * layer it belongs to is the thing an operator navigates by.
 *
 * ─── what this screen is careful about ───
 *
 * The reindex is the most expensive operation the product has and the only one
 * that changes what every future search is answered by. So nothing here starts
 * one on a single click, the running state is legible without reading a
 * progress bar's tooltip, and **the recall verdict is shown as three outcomes
 * rather than a number with a colour**: passed, below the floor, and a
 * reference set that names documents which are not there. The third is not a
 * bad score — it is a stale set — and a screen that rendered it as a low number
 * would report the wrong problem.
 */

const POLL_MS = 4000

export async function migratePanel(layer: Layer): Promise<void> {
  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  let timer: ReturnType<typeof setInterval> | undefined

  const dialog = h('dialog', { class: 'dialog dialog-wide' },
    h('h2', {}, 'Embedding model'),
    h('p', { class: 'hint' },
      'Layer ',
      h('span', { class: 'slug' }, layer.slug),
      '. Moving it onto a different model rebuilds its vectors. Search keeps',
      ' answering from the current ones the whole time, and switches in one step',
      ' at the end.'),
    body,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Close'),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => {
    // Stopped on close, not left running. A dialog that keeps polling after it
    // is dismissed is a request every four seconds for as long as the tab is
    // open, and nothing is looking at the answer.
    if (timer !== undefined) clearInterval(timer)
    dialog.remove()
  })
  dialog.showModal()

  const draw = async (): Promise<void> => {
    let status: ReindexStatus | undefined
    let queries: readonly ReferenceQuery[] | undefined
    try {
      ;[status, queries] = await Promise.all([
        client().layers.reindexStatus(layer.id),
        client().layers.referenceQueries(layer.id),
      ])
    } catch (error) {
      clear(body)
      body.append(h('div', { class: 'error' }, explain(error)))
      if (timer !== undefined) clearInterval(timer)
      return
    }

    clear(body)
    body.append(
      statusSection(status, queries?.length ?? 0),
      gateSection(layer, queries, () => void draw()),
      startSection(layer, status, () => void draw()),
    )

    // Only while something is moving. A completed or failed migration does not
    // change on its own, so polling one is a request that can never differ from
    // the last.
    const moving = status?.status === 'running'
    if (moving && timer === undefined) timer = setInterval(() => void draw(), POLL_MS)
    if (!moving && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  await draw()
}

function statusSection(status: ReindexStatus | undefined, gateSize: number): HTMLElement {
  if (status === undefined) {
    return h('section', { class: 'panel' },
      h('h3', {}, 'No migration has run'),
      h('p', { class: 'muted' },
        'This layer is on the model it was created with.'),
    )
  }

  const percent = Math.round(status.progress * 100)

  return h('section', { class: 'panel' },
    h('h3', {},
      'Migration ',
      h('span', { class: `chip chip-${status.status === 'failed' ? 'deny' : status.status === 'complete' ? 'read' : 'write'}` },
        status.status),
    ),
    h('dl', { class: 'facts' },
      h('dt', {}, 'Searching with'),
      h('dd', {}, h('code', {}, status.currentVector)),
      h('dt', {}, 'Building'),
      h('dd', {}, h('code', {}, status.shadowVector)),
      h('dt', {}, 'Phase'),
      // The two halves are not the same kind of work and the number only
      // measures one of them, so saying which is running is what makes a
      // progress of 0 readable rather than alarming.
      h('dd', {},
        status.phase === 'copying'
          ? 'copying — rebuilding the collection, no embeddings computed'
          : 'embedding — this layer, one batch at a time'),
      h('dt', {}, 'Documents'),
      h('dd', { class: 'tabular' }, `${status.done} of ${status.total}`),
      ...(status.failed === 0 ? [] : [h('dt', {}, 'Failed'), h('dd', { class: 'tabular' }, String(status.failed))]),
    ),
    // `<progress>` rather than a div with a width.
    //
    // Two reasons, and the first was found by looking at a screenshot: the CSP
    // on this page is `style-src 'self'` with no `'unsafe-inline'`, so a
    // `style="width:…"` attribute is dropped by the browser and the bar renders
    // full for *every* migration whatever the number says. Nothing in the tests
    // could see it — the element was there, the attribute was set, and the
    // browser threw it away.
    //
    // The second is that this element already means "progress": the value, the
    // maximum and the role come with it, so the three ARIA attributes that were
    // here by hand are three fewer things to keep in step with the number.
    h('progress', { class: 'meter', max: 100, value: percent,
      'aria-label': 'migration progress' }),
    status.error === null ? '' : h('p', { class: 'error' }, status.error),
    checkSection(status.check, gateSize),
  )
}

/**
 * The recall verdict — and `null` means two different things.
 *
 * It is the permanent answer for a layer with no reference set, and it is also
 * the answer for one that has a set which has not been scored yet, because the
 * check runs once at the end. The status alone cannot tell them apart; the size
 * of the set can, which is why this takes it.
 *
 * Written the other way round first, and the screenshot said "No recall gate"
 * directly above a saved reference query. Both readings of `null` are honest
 * sentences and only one of them was true.
 */
function checkSection(check: ReindexStatus['check'], gateSize: number): HTMLElement {
  if (check === null) {
    return gateSize === 0
      ? h('p', { class: 'muted' },
          'No recall gate — this layer has no reference queries, so the migration',
          ' switches when every document carries the new vector.')
      : h('p', { class: 'muted' },
          `Not scored yet — the ${gateSize} reference `,
          gateSize === 1 ? 'query' : 'queries',
          ' below run once every document carries the new vector, and the switch',
          ' waits on the result.')
  }

  const pct = (n: number) => `${(n * 100).toFixed(1)}%`

  if (check.unresolved !== undefined && check.unresolved.length > 0) {
    // Deliberately not shown alongside the score. The score may be 1.0 and the
    // check still failed, and putting them side by side invites reading the
    // number as the reason.
    return h('div', { class: 'verdict verdict-stale' },
      h('b', {}, 'The reference set is out of date'),
      h('p', {},
        'It names ',
        String(check.unresolved.length),
        check.unresolved.length === 1 ? ' document that is not there' : ' documents that are not there',
        ', so the migration stopped without being scored. A missing document and',
        ' a model that lost recall are different problems.'),
      h('ul', { class: 'plain' }, ...check.unresolved.slice(0, 5).map((id) => h('li', {}, h('code', {}, id)))),
    )
  }

  return h('div', { class: `verdict ${check.passed ? 'verdict-pass' : 'verdict-fail'}` },
    h('b', {}, check.passed ? `Recall ${pct(check.recall)} — passed` : `Recall ${pct(check.recall)} — below the floor`),
    h('p', {},
      `Scored against ${check.queries} reference `,
      check.queries === 1 ? 'query' : 'queries',
      `, floor ${pct(check.floor)}.`,
      check.passed ? '' : ' The layer stayed on the model it was already on.'),
  )
}

/** The reference set: what the gate scores against, edited whole. */
function gateSection(
  layer: Layer,
  queries: readonly ReferenceQuery[] | undefined,
  redraw: () => void,
): HTMLElement {
  if (queries === undefined) {
    // `admin` on the layer, and 404 covers "not yours" and "not there" alike.
    return h('section', { class: 'panel' },
      h('h3', {}, 'Reference queries'),
      h('p', { class: 'muted' }, 'This token may not administer this layer.'),
    )
  }

  const rows = h('div', { class: 'qrows' })
  const add = (query = '', expected = ''): void => {
    const q = h('input', { class: 'input', placeholder: 'notice period', value: query })
    const e = h('input', { class: 'input mono', placeholder: 'contracts/acme.md, contracts/globex.md', value: expected })
    const row = h('div', { class: 'qrow' },
      h('label', { class: 'field grow' }, h('span', {}, 'Query'), q),
      h('label', { class: 'field grow' }, h('span', {}, 'Must still find'), e),
      h('button', { type: 'button', class: 'btn btn-quiet', title: 'Remove', onclick: () => row.remove() }, '×'),
    )
    rows.append(row)
  }

  for (const entry of queries) add(entry.query, entry.expected.join(', '))
  if (queries.length === 0) add()

  const message = h('p', { class: 'form-message' })

  return h('section', { class: 'panel' },
    h('h3', {}, 'Reference queries'),
    h('p', { class: 'hint' },
      'Before a migration switches this layer over, each of these is run against',
      ' the new model and scored on whether it still finds the documents you',
      ' named. One that lost recall stops instead of going live. Leave the list',
      ' empty and there is no gate — the check needs documents only you can',
      ' pick.'),
    rows,
    h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => add() }, 'Add a query'),
      h('button', { type: 'button', class: 'btn btn-primary', onclick: async (event: Event) => {
        const button = event.currentTarget as HTMLButtonElement
        const entries = [...rows.querySelectorAll('.qrow')].flatMap((row) => {
          const [queryInput, expectedInput] = [...row.querySelectorAll('input')] as HTMLInputElement[]
          const query = (queryInput?.value ?? '').trim()
          const expected = (expectedInput?.value ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s !== '')
          // A row with neither is somebody who clicked "add" and changed their
          // mind, and dropping it is kinder than refusing the save. A row with
          // one of the two is a mistake, and the server names which.
          if (query === '' && expected.length === 0) return []
          return [{ query, expected }]
        })

        button.disabled = true
        message.className = 'form-message'
        message.textContent = 'Saving…'
        try {
          const saved = await client().layers.setReferenceQueries(layer.id, entries)
          if (saved === undefined) {
            message.className = 'form-message error'
            message.textContent = 'This token may not administer this layer.'
            return
          }
          redraw()
        } catch (error) {
          message.className = 'form-message error'
          message.textContent = explain(error)
        } finally {
          button.disabled = false
        }
      } }, 'Save the set'),
    ),
    message,
  )
}

/** Starting one. Deliberately the last thing on the panel. */
function startSection(
  layer: Layer,
  status: ReindexStatus | undefined,
  redraw: () => void,
): HTMLElement {
  const running = status?.status === 'running'
  // The last field on any screen that asked a person to type a uuid, and it
  // could not stop until `embedding_providers` had an API: there was nothing to
  // list, because there was nothing to create either. `psql` was the route.
  const provider = picker('model')
  void provider.fill(async () =>
    (await client().embeddingProviders.list()).map((p) => ({
      id: p.id,
      // Dimensions in the label, because they are what a person is choosing
      // between when two providers run the same model family — and what a
      // layer's vector slot is built from.
      label: `${p.name} — ${p.model}, ${String(p.dimensions)}d${p.isDefault ? ' (default)' : ''}`,
    })),
  )
  const message = h('p', { class: 'form-message' })

  return h('section', { class: 'panel' },
    h('h3', {}, 'Start a migration'),
    h('p', { class: 'hint' },
      'The provider whose model the layer should move to. Its dimensions decide',
      ' the name of the vector being built. Starting one back onto the provider',
      ' a layer came from is how a migration is undone — there is no cancel,',
      ' because a half-built vector is inert until the switch.'),
    h('div', { class: 'field' }, h('span', {}, 'Provider'), provider.el),
    running
      ? h('p', { class: 'muted' }, 'One is already running on this layer.')
      : h('button', { type: 'button', class: 'btn btn-primary', onclick: async (event: Event) => {
          const id = provider.value()
          if (id === '') {
            message.className = 'form-message error'
            message.textContent = 'A provider id is required.'
            return
          }
          // Confirmed, because this is the most expensive thing on any of these
          // screens and the only one that changes what every future search is
          // answered by. A single click is the wrong shape for it.
          if (!confirm(`Re-embed every document in ${layer.slug} onto that model?`)) return

          const button = event.currentTarget as HTMLButtonElement
          button.disabled = true
          message.className = 'form-message'
          message.textContent = 'Starting…'
          try {
            const started = await client().layers.reindex(layer.id, id)
            if (started === undefined) {
              message.className = 'form-message error'
              message.textContent = 'No such layer, or this token may not administer it.'
              return
            }
            redraw()
          } catch (error) {
            message.className = 'form-message error'
            message.textContent = explain(error)
          } finally {
            button.disabled = false
          }
        } }, 'Start'),
    message,
  )
}
