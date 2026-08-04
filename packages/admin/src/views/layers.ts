import type { Layer, Workspace } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h, shortId } from '../dom.js'
import { migratePanel } from './migrate.js'

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
    body.append(layers.length === 0 ? empty(root) : table(layers, root))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const empty = (root: HTMLElement) =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No layers you can read'),
    // Not "no layers". The catalog is permission data, so an empty list means
    // this token reaches nothing — which for a fresh install and for a
    // misconfigured grant look the same from here, and both are worth saying.
    h('p', {}, 'Either none exist yet, or this token has no grant reaching one. Both look the same from here, by design.'),
    // The screen said what the emptiness means and not what to do about it,
    // and this is where somebody arrives on a first run. Naming the order —
    // layer, then documents, then a grant — is the piece nobody has been told
    // and the piece the quickstart holds hostage.
    //
    // It describes the model rather than this installation, so it is equally
    // true of the token that reaches nothing, and gives that token's holder
    // nothing it could not already work out.
    h('p', {}, 'A layer is what documents are ingested into and what a grant is issued on: '
      + 'make one, ingest into it, then grant a principal read on it.'),
    h('button', { class: 'btn btn-primary', onclick: () => openCreate(root) }, 'New layer'),
  )

function table(layers: readonly Layer[], root: HTMLElement): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Slug'),
        h('th', {}, 'Name'),
        h('th', {}, 'Description'),
        h('th', { class: 'num' }, 'Documents'),
        h('th', {}, 'Id'),
        h('th', {}, ''),
      ),
    ),
    h('tbody', {}, ...layers.map((l) =>
      h('tr', {},
        h('td', {}, h('span', { class: 'slug' }, l.slug)),
        h('td', {}, l.name),
        h('td', { class: 'muted' }, l.description || '—'),
        h('td', { class: 'num tabular' }, String(l.documentCount)),
        h('td', {}, shortId(l.id)),
        h('td', { class: 'row-end' },
          h('button', { class: 'btn btn-quiet', onclick: () => void rename(l, root) }, 'Rename'),
          // The embedding model, and the recall gate in front of changing it.
          // On the layer rather than a screen of its own: there is at most one
          // migration running, and the layer is what an operator navigates by.
          h('button', { class: 'btn btn-quiet', onclick: () => void migratePanel(l) }, 'Model'),
        ),
      ),
    )),
  )
}

function rename(layer: Layer, root: HTMLElement): void {
  const name = h('input', { class: 'input', value: layer.name, required: true })
  const description = h('input', { class: 'input', value: layer.description })
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Saving…'
      try {
        // Name and description only. What model built the vectors is not
        // editable here and that is not an omission: changing it is a reindex,
        // and an edit form that quietly started one would be the most expensive
        // operation in the product triggered by a text field.
        const done = await client().layers.update(layer.id, {
          name: name.value.trim(),
          description: description.value.trim(),
        })
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'No such layer, or this token may not administer it.'
          return
        }
        dialog.close()
        void layersView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'Rename layer'),
      h('p', { class: 'hint' },
        'The slug is not editable — every surface addresses a layer by it, and a',
        ' grant, an ingest and a search all name it.'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('label', { class: 'field' }, h('span', {}, 'Description'), description),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

function openCreate(root: HTMLElement): void {
  const workspace = h('input', { class: 'input', placeholder: 'workspace id (uuid)', required: true })
  const slug = h('input', { class: 'input', placeholder: 'handbook', required: true })
  const name = h('input', { class: 'input', placeholder: 'Handbook', required: true })
  const message = h('p', { class: 'form-message' })

  // A layer needs a workspace *id*, and this asked an administrator to know one
  // — so the field took a name, the server answered the 404 it owes an
  // unreachable object, and the screen said "no such workspace" to someone
  // looking straight at it. `GET /v1/workspaces` exists precisely so the id
  // does not have to be carried by hand; it closed that gap in the API and
  // this screen kept it open.
  //
  // The field stays editable behind the picker, which is the same shape the
  // grants screen uses: the list is permission data and can legitimately be
  // empty, and pasting an id from `init` must keep working.
  const picker = h('select', { class: 'input', onchange: (e: Event) => {
    const value = (e.target as HTMLSelectElement).value
    if (value !== '') workspace.value = value
  } }, h('option', { value: '' }, 'pick a workspace…'))

  void client()
    .workspaces.list()
    .then((workspaces: readonly Workspace[]) => {
      for (const w of workspaces) {
        picker.append(h('option', { value: w.id }, `${w.slug} — ${w.name}`))
      }
      // One workspace is the common case — `init` creates exactly one — and
      // making someone choose from a list of one is asking a question with a
      // single answer.
      const only = workspaces[0]
      if (workspaces.length === 1 && only !== undefined) {
        picker.value = only.id
        workspace.value = only.id
      }
    })

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
      h('label', { class: 'field' }, h('span', {}, 'Workspace'), picker, workspace),
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
