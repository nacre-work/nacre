import type { ServiceAccount } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { ago, clear, h } from '../dom.js'

/**
 * Service accounts.
 *
 * The screen with the one irreversible moment in the product: a key exists in
 * the response that creates it and nowhere else, ever again. It is stored
 * hashed, so it cannot be recovered from the database or from a backup, and a
 * dialog that lets someone click past it without noticing is a support ticket
 * with no remedy. That is why the key screen has its own step, a copy button,
 * and a confirmation that says what is about to become impossible.
 */

export async function accountsView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Service accounts'),
        h('p', { class: 'lede' },
          'How an agent authenticates. A key is a bearer credential with no expiry — grants decide what it reaches, and revoking is the only way to stop it.'),
      ),
      h('button', { class: 'btn btn-primary', onclick: () => openCreate(root) }, 'New account'),
    ),
  )

  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(body)

  try {
    const accounts = await client().serviceAccounts.list()
    clear(body)
    body.append(accounts.length === 0 ? empty() : table(accounts, root))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const empty = () =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No service accounts'),
    h('p', {}, 'Requires org_admin to list. Anyone else gets the same answer as an organization with none.'),
  )

function table(accounts: readonly ServiceAccount[], root: HTMLElement): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Name'),
        h('th', {}, 'Key'),
        h('th', {}, 'Created'),
        h('th', {}, 'Last used'),
        h('th', { class: 'right' }, ''),
      ),
    ),
    h('tbody', {}, ...accounts.map((a) => {
      const revoked = a.revokedAt !== null
      return h('tr', { class: revoked ? 'revoked' : '' },
        h('td', {}, a.name, revoked ? h('span', { class: 'tag tag-off' }, 'revoked') : null),
        // The prefix, which is all the database holds. Enough to tell two keys
        // apart in a log and useless to anyone who reads it.
        h('td', {}, h('code', { class: 'id' }, `${a.keyPrefix}…`)),
        h('td', { class: 'muted' }, ago(a.createdAt)),
        h('td', { class: 'muted' }, ago(a.lastUsedAt)),
        h('td', { class: 'right' },
          revoked
            ? null
            : h('button', {
                class: 'btn btn-quiet btn-danger',
                onclick: () => confirmRevoke(a, root),
              }, 'Revoke'),
        ),
      )
    })),
  )
}

function confirmRevoke(account: ServiceAccount, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Revoking…'
      try {
        const done = await client().serviceAccounts.revoke(account.id)
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'Already revoked, or not this token’s to revoke.'
          return
        }
        dialog.close()
        void accountsView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, `Revoke ${account.name}?`),
      h('p', {}, 'Every request carrying this key starts failing immediately. There is no way to restore it — issue a new account instead.'),
      h('p', { class: 'hint' }, 'Anything running with this key stops working the moment you confirm.'),
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

function openCreate(root: HTMLElement): void {
  const name = h('input', { class: 'input', placeholder: 'indexing-bot', required: true })
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Creating…'
      try {
        const created = await client().serviceAccounts.create(name.value.trim())
        showKey(dialog, created.key, created.name, root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'New service account'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('p', { class: 'hint' },
        'A new account reaches nothing. Issue it a grant afterwards — and remember that write does not imply read, so an ingest-only agent needs write and nothing else.'),
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

/**
 * The only time the key exists outside the server.
 *
 * Replaces the dialog's contents rather than opening a second one: there is no
 * path from here that loses the key by accident, and closing takes a deliberate
 * click on a button that says what closing means.
 */
function showKey(dialog: HTMLDialogElement, key: string, name: string, root: HTMLElement): void {
  // A textarea, not an input. The key is 50-odd characters and an input scrolls
  // it out of sight — which is fine until the clipboard is refused, and then the
  // person is looking at half of the one thing they cannot ask for again.
  const field = h('textarea', { class: 'input mono keyfield', readonly: true, rows: 2, spellcheck: 'false' })
  field.value = key
  const copied = h('span', { class: 'copied' })

  dialog.replaceChildren(
    h('div', { class: 'keyout' },
      h('h2', {}, `${name} created`),
      h('p', { class: 'warn' },
        'This key is shown once. It is stored hashed, so it cannot be recovered from the database or from a backup — if it is lost, the only remedy is a new account.'),
      h('div', { class: 'row' },
        field,
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          field.select()
          try {
            await navigator.clipboard.writeText(key)
            copied.textContent = 'copied'
          } catch {
            // Clipboard access can be refused, and the field is selected
            // anyway — saying "copied" when nothing was would be worse.
            copied.textContent = 'selected — copy it now'
          }
        } }, 'Copy'),
      ),
      copied,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
          dialog.close()
          void accountsView(root)
        } }, 'I have saved the key'),
      ),
    ),
  )
}
