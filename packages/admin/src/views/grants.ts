import type { Grant, Layer } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { chip, clear, h, shortId } from '../dom.js'

/**
 * Grants.
 *
 * The screen where a mistake has consequences, so it says what each rule
 * actually means rather than assuming. Two of them surprise people:
 *
 * `write` does not imply `read`. An ingest-only service account holds write and
 * cannot search — which is the point, and the opposite of most systems.
 *
 * Revoking is a removal, not a deny. Deny is a commercial capability and this
 * build refuses to issue one; it also beats an allow at any depth, so a "deny"
 * written here would suppress access held through a group or a parent scope.
 */

const PERMISSIONS = ['read', 'write', 'admin'] as const

export async function grantsView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Grants'),
        h('p', { class: 'lede' },
          'Who may reach what. A grant on a workspace reaches every layer in it; a grant on a layer reaches every document in it.'),
      ),
      h('button', { class: 'btn btn-primary', onclick: () => openIssue(root) }, 'Issue grant'),
    ),
    h('div', { class: 'note' },
      h('strong', {}, 'write does not imply read.'),
      ' ',
      'admin implies both. An ingest-only service account holds write and cannot search — that is deliberate, and the opposite of most permission systems.',
    ),
  )

  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(body)

  try {
    const grants = await client().grants.list()
    clear(body)
    body.append(grants.length === 0 ? empty() : table(grants, root))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const empty = () =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No grants you can administer'),
    h('p', {}, 'The list carries every grant on a scope this token administers. Holding admin on one layer shows that layer’s grants and no others.'),
  )

function table(grants: readonly Grant[], root: HTMLElement): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Principal'),
        h('th', {}, 'Scope'),
        h('th', {}, 'Permission'),
        h('th', {}, 'Source'),
        h('th', { class: 'right' }, ''),
      ),
    ),
    h('tbody', {}, ...grants.map((g) =>
      h('tr', {},
        h('td', {},
          h('span', { class: 'kind' }, g.principalType.replace('_', ' ')),
          ' ',
          shortId(g.principalId),
        ),
        h('td', {},
          h('span', { class: 'kind' }, g.scopeType),
          ' ',
          shortId(g.scopeId),
        ),
        h('td', {}, chip(g.permission, g.effect)),
        h('td', { class: 'muted' }, g.source),
        h('td', { class: 'right' },
          h('button', {
            class: 'btn btn-quiet btn-danger',
            onclick: () => confirmRevoke(g, root),
          }, 'Revoke'),
        ),
      ),
    )),
  )
}

function confirmRevoke(grant: Grant, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Revoking…'
      try {
        const done = await client().grants.revoke(grant.id)
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'Already gone, or not this token’s to revoke.'
          return
        }
        dialog.close()
        void grantsView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'Revoke this grant?'),
      h('dl', { class: 'facts' },
        h('dt', {}, 'Principal'), h('dd', {}, `${grant.principalType} ${grant.principalId}`),
        h('dt', {}, 'Scope'), h('dd', {}, `${grant.scopeType} ${grant.scopeId}`),
        h('dt', {}, 'Permission'), h('dd', {}, chip(grant.permission, grant.effect)),
      ),
      h('p', { class: 'hint' },
        'The row is removed rather than flipped to deny — a deny beats an allow at any depth and would also suppress access held through a group or a parent scope.'),
      h('p', { class: 'hint' },
        'Search stops returning the affected documents on the next request. The permitted set is computed per request from the grants, so revocation is immediate — there is nothing to propagate and nothing to wait on.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-danger' }, 'Revoke'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

function openIssue(root: HTMLElement): void {
  const principalType = h('select', { class: 'input' },
    h('option', { value: 'user' }, 'user'),
    h('option', { value: 'group' }, 'group'),
    h('option', { value: 'service_account' }, 'service account'),
  )
  const principalId = h('input', { class: 'input', placeholder: 'principal id (uuid)', required: true })
  const scopeType = h('select', { class: 'input' },
    h('option', { value: 'layer' }, 'layer'),
    h('option', { value: 'workspace' }, 'workspace'),
  )
  const scopeId = h('input', { class: 'input', placeholder: 'scope id (uuid)', required: true })
  const permission = h('select', { class: 'input' },
    ...PERMISSIONS.map((p) => h('option', { value: p }, p)),
  )
  const message = h('p', { class: 'form-message' })

  // A convenience only. Picking a layer fills the id in; the field stays
  // editable because a workspace has no list on this screen.
  const layerPicker = h('select', { class: 'input', onchange: (e: Event) => {
    const value = (e.target as HTMLSelectElement).value
    if (value !== '') scopeId.value = value
  } }, h('option', { value: '' }, 'pick a layer…'))

  void client().layers.list().then((layers: readonly Layer[]) => {
    for (const l of layers) layerPicker.append(h('option', { value: l.id }, `${l.slug} — ${l.name}`))
  })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Issuing…'
      try {
        const issued = await client().grants.issue({
          principalType: principalType.value as 'user' | 'group' | 'service_account',
          principalId: principalId.value.trim(),
          scopeType: scopeType.value as 'workspace' | 'layer',
          scopeId: scopeId.value.trim(),
          permission: permission.value as 'read' | 'write' | 'admin',
        })
        if (issued === undefined) {
          // Admin on the scope being granted, not admin in general — otherwise
          // holding admin on one layer would be a way to grant yourself another.
          message.className = 'form-message error'
          message.textContent = 'No such scope, or this token may not administer it.'
          return
        }
        dialog.close()
        void grantsView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'Issue a grant'),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, 'Principal type'), principalType),
        h('label', { class: 'field grow' }, h('span', {}, 'Principal'), principalId),
      ),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, 'Scope type'), scopeType),
        h('label', { class: 'field grow' }, h('span', {}, 'Scope'), scopeId),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Layer shortcut'), layerPicker),
      h('label', { class: 'field' }, h('span', {}, 'Permission'), permission),
      h('p', { class: 'hint' },
        'Requires admin on the scope being granted, not admin in general. Document scope and deny effect are commercial capabilities and are refused here.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Issue'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}
