import type { Layer, Workspace } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h, shortId } from '../dom.js'
import { picker } from '../pick.js'
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
  const create = newLayerButton(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Layers'),
        h('p', { class: 'lede' },
          'A layer is the unit permissions are granted on. Documents live in one, and a grant on a layer reaches every document in it.'),
      ),
      create,
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
    newLayerButton(root),
  )

/**
 * "New layer", enabled only where it can work.
 *
 * It was always enabled, so a member pressed it, filled the dialog in and got
 * the `404` invariant 4 owes an unreachable object — which reads as a broken
 * application rather than as a permission they do not hold.
 *
 * Decided by **asking**, never by reading `role`. The role is the wrong answer
 * twice over: creating a layer needs `admin` on the *workspace*, so an
 * `org_admin` is not the only principal who may, and a member who can see a
 * workspace with `read` may not. `GET /v1/workspaces` reports what this caller
 * holds on each one, and the button is the same question the picker inside the
 * dialog asks — one fact, asked once, in two places that agree because they
 * read the same field.
 *
 * Disabled until the answer arrives, not enabled: a control that works and
 * then stops is a click somebody already made.
 */
function newLayerButton(root: HTMLElement): HTMLButtonElement {
  const button = h('button', {
    class: 'btn btn-primary',
    disabled: true,
    title: 'Checking which workspaces you administer…',
    onclick: () => openCreate(root),
  }) as HTMLButtonElement
  button.textContent = 'New layer'

  void client()
    .workspaces.list()
    .then((workspaces: readonly Workspace[]) => {
      const mine = workspaces.filter((w) => w.permissions.includes('admin'))
      button.disabled = mine.length === 0
      button.title = button.disabled
        ? 'A layer is created inside a workspace, and you do not administer one.'
        : ''
    })
    .catch(() => {
      // The listing is the only thing that can answer, so a failure leaves the
      // button off. Offering it on a guess is what this replaced.
      button.disabled = true
      button.title = 'Could not check which workspaces you administer.'
    })

  return button
}

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
        h('td', { class: 'num tabular' },
          String(l.documentCount),
          // A layer where everything failed looked exactly like a healthy one:
          // the count is of rows and stays right, but every search over it
          // answers nothing and nothing on the screen said so. `failed` is the
          // one status that waits for a person, so it is the one worth a mark.
          l.failedCount > 0 ? h('span', { class: 'tag tag-off' }, `${String(l.failedCount)} failed`) : null,
        ),
        h('td', {}, shortId(l.id)),
        h('td', { class: 'row-end' },
          h('button', { class: 'btn btn-quiet', onclick: () => void rename(l, root) }, 'Rename'),
          // The embedding model, and the recall gate in front of changing it.
          // On the layer rather than a screen of its own: there is at most one
          // migration running, and the layer is what an operator navigates by.
          h('button', { class: 'btn btn-quiet', onclick: () => void migratePanel(l) }, 'Model'),
          h('button', { class: 'btn btn-quiet btn-danger', onclick: () => confirmDelete(l, root) }, 'Delete'),
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

/**
 * Deleting a layer takes its documents with it and there is no undelete, so
 * the confirmation asks for the slug rather than for a click. The other
 * destructive action on these screens — revoking a grant — is a click, and the
 * difference is deliberate: a grant re-issues, a layer's documents do not come
 * back.
 */
function confirmDelete(layer: Layer, root: HTMLElement): void {
  const typed = h('input', { class: 'input', placeholder: layer.slug, required: true })
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      if (typed.value.trim() !== layer.slug) {
        message.className = 'form-message error'
        message.textContent = `Type ${layer.slug} to confirm.`
        return
      }
      message.className = 'form-message'
      message.textContent = 'Deleting…'
      try {
        const done = await client().layers.remove(layer.id)
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
      h('h2', {}, 'Delete layer'),
      h('p', {}, `${layer.name} holds ${String(layer.documentCount)} document(s). All of them go with it, and there is no undelete.`),
      h('p', { class: 'hint' },
        'Search stops returning them on the next request. Reclaiming the vectors, the chunk rows and anything in object storage is the collector\'s, on its own clock — nothing a caller sees waits for it.'),
      h('p', { class: 'hint' },
        'Grants naming this layer are removed with it: they would resolve to nothing, and leaving them would list rows pointing at something no reader can look up.'),
      h('label', { class: 'field' }, h('span', {}, `Type ${layer.slug} to confirm`), typed),
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

function openCreate(root: HTMLElement): void {
  const slug = h('input', { class: 'input', placeholder: 'handbook', required: true })
  const name = h('input', { class: 'input', placeholder: 'Handbook', required: true })
  const message = h('p', { class: 'form-message' })

  // A layer needs a workspace *id*, and this asked an administrator to know
  // one — so the field took a name, the server answered the 404 it owes an
  // unreachable object, and the screen said "no such workspace" to someone
  // looking straight at it. `GET /v1/workspaces` exists precisely so the id
  // does not have to be carried by hand.
  //
  // Only the workspaces this caller may administer. Creating a layer needs
  // `admin` on the workspace, and the listing answers `read` — so a member who
  // can see one was being offered it and refused on submit.
  const workspace = picker('workspace')
  void workspace.fill(async () =>
    (await client().workspaces.list())
      .filter((w: Workspace) => w.permissions.includes('admin'))
      .map((w: Workspace) => ({ id: w.id, label: `${w.slug} — ${w.name}` })),
  )

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Creating…'
      try {
        const chosen = workspace.value()
        if (chosen === '') {
          message.className = 'form-message error'
          message.textContent = 'Choose the workspace this layer belongs to.'
          return
        }
        const created = await client().layers.create({
          workspaceId: chosen,
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
      h('div', { class: 'field' }, h('span', {}, 'Workspace'), workspace.el),
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
