import type { Grant, Group, Layer, ServiceAccount, User, Workspace } from '@nacre.work/sdk'

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

  // A convenience only. Picking fills the id in, and the field stays editable
  // because either list is permission data and can legitimately be empty.
  //
  // It follows the scope type rather than only listing layers. Workspaces had
  // no list on this screen — which was once true of the API as well — so
  // granting on one meant knowing a uuid, the same hole the layer dialog had.
  const scopePicker = h('select', { class: 'input', onchange: (e: Event) => {
    const value = (e.target as HTMLSelectElement).value
    if (value !== '') scopeId.value = value
  } })

  const fillScopePicker = (): void => {
    const type = scopeType.value
    scopePicker.replaceChildren(h('option', { value: '' }, `pick a ${type}…`))
    if (type === 'workspace') {
      void client().workspaces.list().then((workspaces: readonly Workspace[]) => {
        for (const w of workspaces) {
          scopePicker.append(h('option', { value: w.id }, `${w.slug} — ${w.name}`))
        }
      })
    } else {
      void client().layers.list().then((layers: readonly Layer[]) => {
        for (const l of layers) scopePicker.append(h('option', { value: l.id }, `${l.slug} — ${l.name}`))
      })
    }
  }

  scopeType.addEventListener('change', fillScopePicker)
  fillScopePicker()

  // The same shortcut for the principal, which had none — so the scope could be
  // picked from a list and the principal had to be a uuid somebody carried by
  // hand. Somebody typed a service account's *name* into it, and the only
  // answer was about the field that was correct.
  //
  // It could not have been built until all three types were listable: service
  // accounts always were, users and groups only since `/v1/users` and
  // `/v1/groups` landed. Before that this picker would have had one working
  // option out of three, which is worse than none.
  const principalPicker = h('select', { class: 'input', onchange: (e: Event) => {
    const value = (e.target as HTMLSelectElement).value
    if (value !== '') principalId.value = value
  } })

  const fillPrincipalPicker = (): void => {
    const type = principalType.value
    const label = type === 'service_account' ? 'service account' : type
    principalPicker.replaceChildren(h('option', { value: '' }, `pick a ${label}…`))
    // Listing users and groups needs org_admin, and admin on a scope is not
    // that — so this can legitimately fail for a caller who may nonetheless
    // issue the grant. The field behind it still takes an id, which is why the
    // failure is silent here rather than an error on a form that is fine.
    if (type === 'user') {
      void client().users.list().then((users: readonly User[]) => {
        for (const u of users) {
          principalPicker.append(h('option', { value: u.id },
            u.disabledAt === null ? u.email : `${u.email} (disabled)`))
        }
      }).catch(() => undefined)
    } else if (type === 'group') {
      void client().groups.list().then((groups: readonly Group[]) => {
        for (const g of groups) {
          principalPicker.append(h('option', { value: g.id }, `${g.name} — ${String(g.memberCount)} member(s)`))
        }
      }).catch(() => undefined)
    } else {
      void client().serviceAccounts.list().then((accounts: readonly ServiceAccount[]) => {
        // A revoked account is not offered: its key stopped working and is
        // never reissued, so a grant to it can never be exercised — and the
        // server refuses one now rather than storing a row that does nothing.
        for (const a of accounts) {
          if (a.revokedAt !== null) continue
          principalPicker.append(h('option', { value: a.id }, `${a.name} — ${a.keyPrefix}…`))
        }
      }).catch(() => undefined)
    }
  }

  principalType.addEventListener('change', fillPrincipalPicker)
  fillPrincipalPicker()

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
      h('label', { class: 'field' }, h('span', {}, 'Principal shortcut'), principalPicker),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, 'Scope type'), scopeType),
        h('label', { class: 'field grow' }, h('span', {}, 'Scope'), scopeId),
      ),
      h('label', { class: 'field' }, h('span', {}, 'Scope shortcut'), scopePicker),
      h('label', { class: 'field' }, h('span', {}, 'Permission'), permission),
      h('p', { class: 'hint' },
        'Requires admin on the scope being granted, not admin in general. Document scope and deny effect are commercial capabilities and are refused here.'),
      h('p', { class: 'hint' },
        'The three permissions are not a ladder. write does not imply read — an agent that only ingests '
        + 'cannot search what it ingested — so both means two grants on the same scope. admin implies both, '
        + 'and also lets the principal rename or delete the scope and issue grants on it.'),
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
