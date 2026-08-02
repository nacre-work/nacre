import type { Layer } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h, shortId } from '../dom.js'

/**
 * Layers.
 *
 * The list is what the caller's read plan reaches and nothing else — the
 * narrowing happens in SQL on the server, so this table is already the answer
 * rather than something to filter. Which means an administrator seeing fewer
 * layers than they expect is a permission fact, not a bug in this screen, and
 * the empty state says so.
 */

export async function layersView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Layers'),
        h('p', { class: 'lede' },
          'A layer is the unit permissions are granted on. Documents live in one, and a grant on a layer reaches every document in it.'),
      ),
      h('button', { class: 'btn btn-primary', onclick: () => openCreate(root) }, 'New layer'),
    ),
  )

  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(body)

  try {
    const layers = await client().layers.list()
    clear(body)
    body.append(layers.length === 0 ? empty() : table(layers))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const empty = () =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No layers you can read'),
    // Not "no layers". The catalog is permission data, so an empty list means
    // this token reaches nothing — which for a fresh install and for a
    // misconfigured grant look the same from here, and both are worth saying.
    h('p', {}, 'Either none exist yet, or this token has no grant reaching one. Both look the same from here, by design.'),
  )

function table(layers: readonly Layer[]): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Slug'),
        h('th', {}, 'Name'),
        h('th', {}, 'Description'),
        h('th', { class: 'num' }, 'Documents'),
        h('th', {}, 'Id'),
      ),
    ),
    h('tbody', {}, ...layers.map((l) =>
      h('tr', {},
        h('td', {}, h('span', { class: 'slug' }, l.slug)),
        h('td', {}, l.name),
        h('td', { class: 'muted' }, l.description || '—'),
        h('td', { class: 'num tabular' }, String(l.documentCount)),
        h('td', {}, shortId(l.id)),
      ),
    )),
  )
}

function openCreate(root: HTMLElement): void {
  const workspace = h('input', { class: 'input', placeholder: 'workspace id (uuid)', required: true })
  const slug = h('input', { class: 'input', placeholder: 'handbook', required: true })
  const name = h('input', { class: 'input', placeholder: 'Handbook', required: true })
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Creating…'
      try {
        const created = await client().layers.create({
          workspaceId: workspace.value.trim(),
          slug: slug.value.trim(),
          name: name.value.trim(),
        })
        if (created === undefined) {
          // 404 covers "no such workspace" and "you may not administer it"
          // together — the server will not say which, and neither will this.
          message.className = 'form-message error'
          message.textContent = 'No such workspace, or this token may not administer it.'
          return
        }
        dialog.close()
        void layersView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'New layer'),
      h('label', { class: 'field' }, h('span', {}, 'Workspace'), workspace),
      h('label', { class: 'field' }, h('span', {}, 'Slug'), slug),
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('p', { class: 'hint' },
        'The slug is unique across the organization, not per workspace — every surface addresses a layer by slug alone.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}
