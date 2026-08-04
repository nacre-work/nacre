import type { SearchHit } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h, shortId } from '../dom.js'

/**
 * Search, and delete.
 *
 * This screen exists to answer the question an operator actually has — "what
 * can this token see?" — and it answers it by being an ordinary caller. There
 * is no administrative bypass: results here are exactly what the same token
 * gets over REST or MCP, which is what makes it useful for checking a grant.
 *
 * The count is stated plainly for the same reason. `top_k` is passed through
 * uncorrected because the filter runs inside the index traversal, so a request
 * for ten returns ten permitted results rather than ten candidates with some
 * removed — and an operator who sees three results knows three exist, not that
 * seven were stripped.
 */

export function searchView(root: HTMLElement): void {
  clear(root)

  const input = h('input', {
    class: 'input',
    type: 'search',
    placeholder: 'What can this token find?',
    autofocus: true,
  })
  const topK = h('input', { class: 'input narrow tabular', type: 'number', value: '10', min: '1', max: '100' })
  const results = h('div', { class: 'results' })

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Search'),
        h('p', { class: 'lede' },
          'Runs as this token, with no administrative bypass — what appears here is exactly what the same token gets over REST and over MCP.'),
      ),
    ),
    h('form', { class: 'searchbar', onsubmit: async (e: Event) => {
      e.preventDefault()
      const query = input.value.trim()
      if (query.length === 0) return

      clear(results)
      results.append(h('p', { class: 'muted' }, 'Searching…'))

      try {
        const hits = await client().search(query, { topK: Number(topK.value) || 10 })
        clear(results)
        results.append(
          h('p', { class: 'count' },
            hits.length === 0
              ? 'Nothing this token may see matches.'
              : `${hits.length} permitted result${hits.length === 1 ? '' : 's'}.`,
            hits.length === 0
              // What is missing on a first run is not a hint about *this*
              // installation — it is the order of the model, which nobody has
              // been told. Stated as the model rather than as the state, on
              // purpose: "no layers exist yet" and "this token reaches none"
              // must stay indistinguishable, and a sentence that is true of
              // both leaks neither.
              ? h('span', { class: 'muted' },
                  ' Documents live in a layer, and a token reaches one only through a grant.'
                  + ' On a new installation the first step is a layer.')
              : h('span', { class: 'muted' },
                  ' The filter runs inside the index traversal, so this is the count, not what survived a trim.'),
          ),
          ...hits.map((hit) => card(hit, root)),
        )
      } catch (error) {
        clear(results)
        results.append(h('div', { class: 'error' }, explain(error)))
      }
    } },
      input,
      h('label', { class: 'field inline' }, h('span', {}, 'top_k'), topK),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Search'),
    ),
    results,
  )
}

function card(hit: SearchHit, root: HTMLElement): HTMLElement {
  return h('article', { class: 'hit' },
    h('div', { class: 'hit-head' },
      h('div', {},
        h('h3', {}, hit.title ?? 'Untitled'),
        h('div', { class: 'hit-meta' },
          h('span', { class: 'slug' }, hit.layer),
          shortId(hit.documentId),
          h('span', { class: 'score tabular', title: 'Similarity score from the index' }, hit.score.toFixed(3)),
        ),
      ),
      h('button', {
        class: 'btn btn-quiet btn-danger',
        onclick: () => confirmDelete(hit, root),
      }, 'Delete'),
    ),
    h('p', { class: 'hit-text' }, hit.text),
  )
}

function confirmDelete(hit: SearchHit, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Deleting…'
      try {
        const done = await client().documents.remove(hit.documentId)
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'Already gone, or not this token’s to delete.'
          return
        }
        dialog.close()
        searchView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'Delete this document?'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Title'), h('dd', {}, hit.title ?? 'Untitled'),
        h('dt', {}, 'Layer'), h('dd', {}, hit.layer),
        h('dt', {}, 'Document'), h('dd', {}, h('code', { class: 'id' }, hit.documentId)),
      ),
      h('p', { class: 'hint' },
        'It leaves search immediately — the vectors are flagged before the row is written. Reclaiming the space is a background job, and nothing depends on when it runs.'),
      h('p', { class: 'hint' },
        'Re-ingesting the same external id brings the document back; this does not blocklist anything.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-danger' }, 'Delete'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}
