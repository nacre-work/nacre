import type { Group, GroupMember, User } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { agoCell, clear, copyableId, copyText, h, shortId } from '../dom.js'
import { picker } from '../pick.js'

/**
 * People: the users and groups a grant is issued to.
 *
 * One screen for both, because the whole reason a group exists is what it does
 * to a grant — grant the group once and joining the team becomes a membership
 * change rather than a new grant nobody remembers to revoke. Splitting them
 * into two screens would separate the mechanism from the reason for it.
 *
 * The two irreversible moments are the same shape as the service account key:
 * a password exists in the response that creates it and nowhere else. It is
 * stored as a scrypt hash, so a dialog somebody can click past without noticing
 * is a support ticket whose only remedy is another reset.
 */

export async function peopleView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'People'),
        h('p', { class: 'lede' },
          'Users sign in; groups are what a grant is issued to so it survives somebody leaving. Both need org_admin — anyone else gets the same answer as an organization with none.'),
      ),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => openGroup(root) }, 'New group'),
        h('button', { class: 'btn btn-primary', onclick: () => openUser(root) }, 'New user'),
      ),
    ),
  )

  const body = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(body)

  try {
    const [users, groups] = await Promise.all([client().users.list(), client().groups.list()])
    clear(body)
    body.append(
      h('h2', { class: 'section' }, 'Users'),
      users.length === 0 ? noUsers() : userTable(users, root),
      h('h2', { class: 'section' }, 'Groups'),
      groups.length === 0 ? noGroups(root) : groupTable(groups, root),
    )
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const noUsers = () =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No users you can see'),
    h('p', {}, 'Either this organization has only the administrator init created, or this token is not one.'),
  )

const noGroups = (root: HTMLElement) =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No groups'),
    h('p', {}, 'A grant to a group reaches everyone in it, and stays correct when the team changes. '
      + 'Granting each person individually is what leaves an ex-colleague with access nobody remembers to revoke.'),
    h('button', { class: 'btn btn-primary', onclick: () => openGroup(root) }, 'New group'),
  )

function userTable(users: readonly User[], root: HTMLElement): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Email'),
        h('th', {}, 'Role'),
        h('th', {}, 'Id'),
        h('th', {}, 'Created'),
        h('th', { class: 'right' }, ''),
      ),
    ),
    h('tbody', {}, ...users.map((u) => {
      const off = u.disabledAt !== null
      return h('tr', { class: off ? 'revoked' : '' },
        h('td', {}, u.email,
          off ? h('span', { class: 'tag tag-off' }, 'disabled') : null,
          // An SSO-only account has no local password, which is why a reset
          // would be answering a question nobody asked.
          u.hasPassword ? null : h('span', { class: 'tag' }, 'sso'),
          // A credential several people hold. Shown because it is fixed at
          // creation and decides whether this person can hold a second factor
          // at all — an administrator who ticked that box has no other way to
          // see it afterwards, and the row is where they would look.
          u.shared ? h('span', { class: 'tag' }, 'shared') : null,
        ),
        h('td', {}, h('span', { class: 'slug' }, u.role)),
        // The id, because issuing a grant to one person takes it.
        h('td', {}, copyableId(u.id)),
        agoCell(u.createdAt),
        h('td', { class: 'right' },
          h('button', { class: 'btn btn-quiet', onclick: () => void editUser(u, root) }, 'Edit'),
          h('button', { class: 'btn btn-quiet', onclick: () => confirmReset(u, root) }, 'Reset password'),
          off
            ? null
            : h('button', {
                class: 'btn btn-quiet btn-danger',
                onclick: () => confirmDisable(u, root),
              }, 'Disable'),
        ),
      )
    })),
  )
}

function groupTable(groups: readonly Group[], root: HTMLElement): HTMLElement {
  return h('table', { class: 'table' },
    h('thead', {},
      h('tr', {},
        h('th', {}, 'Name'),
        h('th', {}, 'Id'),
        h('th', { class: 'num' }, 'Members'),
        h('th', { class: 'right' }, ''),
      ),
    ),
    h('tbody', {}, ...groups.map((g) =>
      h('tr', {},
        h('td', {}, g.name),
        h('td', {}, copyableId(g.id)),
        h('td', { class: 'num tabular' }, String(g.memberCount)),
        h('td', { class: 'right' },
          h('button', { class: 'btn btn-quiet', onclick: () => void membersPanel(g, root) }, 'Members'),
          h('button', {
            class: 'btn btn-quiet btn-danger',
            onclick: () => confirmDeleteGroup(g, root),
          }, 'Delete'),
        ),
      ),
    )),
  )
}

function openUser(root: HTMLElement): void {
  const email = h('input', { class: 'input', type: 'email', placeholder: 'dana@example.com', required: true })
  const role = h('select', { class: 'input' },
    h('option', { value: 'member' }, 'member — reaches only what a grant gives'),
    h('option', { value: 'org_admin' }, 'org_admin — administers this organization'),
  )
  const shared = h('input', { type: 'checkbox' }) as HTMLInputElement
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Creating…'
      try {
        const created = await client().users.create(
          email.value.trim(),
          role.value === 'org_admin' ? 'org_admin' : 'member',
          { shared: shared.checked },
        )
        showSecret(dialog, created.password, `${created.email} created`, root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'New user'),
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Role'), role),
      h('label', { class: 'field inline' }, shared, h('span', {}, 'Several people will hold this password')),
      h('p', { class: 'hint' },
        'A new member reaches nothing until a grant says otherwise — issue one to them, or add them to a group that already has one.'),
      h('p', { class: 'hint' },
        'The password is generated here and shown once. It is not accepted as input: a password an administrator chose is one they know.'),
      // What the box does, in the terms of what goes wrong without it. An
      // administrator ticking it is publishing a credential, and the thing they
      // need to know is that this is the choice which stops the first person to
      // use it from taking it away from the rest.
      h('p', { class: 'hint' },
        'Tick it for a login you will publish or hand round — a demonstration, a kiosk, a read-only account for a team. It then cannot enrol a second factor, change its own password, or be sent a reset link: there is nobody for a factor to belong to, and whoever enrolled one first would lock out everybody else, which no administrator can undo. You still reset its password here, which is how you rotate a published one.'),
      h('p', { class: 'hint' },
        'It cannot be changed afterwards — clearing it on an account whose password is already out would reopen that door to whoever holds it. Make a new account instead.'),
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

function editUser(user: User, root: HTMLElement): void {
  const role = h('select', { class: 'input' },
    h('option', { value: 'member' }, 'member'),
    h('option', { value: 'org_admin' }, 'org_admin'),
  )
  role.value = user.role === 'org_admin' ? 'org_admin' : 'member'
  const enabled = h('input', { type: 'checkbox' })
  enabled.checked = user.disabledAt === null
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Saving…'
      try {
        const done = await client().users.update(user.id, {
          role: role.value === 'org_admin' ? 'org_admin' : 'member',
          disabled: !enabled.checked,
        })
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'No such user, or this token may not administer this organization.'
          return
        }
        dialog.close()
        void peopleView(root)
      } catch (error) {
        // The 409 lands here, and its message is the one worth showing: it
        // names what to do first rather than saying the change failed.
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, user.email),
      h('label', { class: 'field' }, h('span', {}, 'Role'), role),
      h('label', { class: 'field inline' }, enabled, h('span', {}, 'Can sign in')),
      h('p', { class: 'hint' },
        'platform_admin is not issued here — it administers the installation rather than this organization.'),
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

function confirmReset(user: User, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Issuing…'
      try {
        const password = await client().users.resetPassword(user.id)
        if (password === undefined) {
          message.className = 'form-message error'
          message.textContent = 'No such user, or this token may not administer this organization.'
          return
        }
        showSecret(dialog, password, `New password for ${user.email}`, root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, `Reset the password for ${user.email}?`),
      h('p', {}, 'The old one stops working immediately, and the new one is shown once.'),
      h('p', { class: 'hint' },
        'Sessions already open keep working until their access token expires — revoking those is signing out, which only they can do.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-primary' }, 'Reset'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

function confirmDisable(user: User, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Disabling…'
      try {
        const done = await client().users.disable(user.id)
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'No such user, or this token may not administer this organization.'
          return
        }
        dialog.close()
        void peopleView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, `Disable ${user.email}?`),
      h('p', {}, 'Signing in and refreshing both stop. The row is kept, because the access log names it — Edit is how somebody comes back.'),
      h('p', { class: 'hint' },
        'An access token already issued keeps working until it expires. That is a property of a JWT, not of this button.'),
      h('p', { class: 'hint' },
        'Grants issued to them are left alone. If they are leaving for good, revoke those too — disabling stops the credential and not the permission.'),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn btn-danger' }, 'Disable'),
      ),
    ),
  )

  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
}

function openGroup(root: HTMLElement): void {
  const name = h('input', { class: 'input', placeholder: 'legal', required: true })
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Creating…'
      try {
        await client().groups.create(name.value.trim())
        dialog.close()
        void peopleView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, 'New group'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), name),
      h('p', { class: 'hint' },
        'Grant the group once. Adding somebody to it gives them everything it holds, and removing them takes it back on their next request — the permitted set is computed per request, so there is nothing to wait for.'),
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

function confirmDeleteGroup(group: Group, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Deleting…'
      try {
        const done = await client().groups.remove(group.id)
        if (!done) {
          message.className = 'form-message error'
          message.textContent = 'No such group, or this token may not administer this organization.'
          return
        }
        dialog.close()
        void peopleView(root)
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      h('h2', {}, `Delete ${group.name}?`),
      h('p', {}, `${String(group.memberCount)} member(s) lose whatever this group gave them, on their next request. Nobody is removed from the organization.`),
      h('p', { class: 'hint' },
        'Grants issued to this group go with it. They would resolve to nothing anyway, and leaving them would list rows pointing at a group no reader can look up.'),
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

/**
 * A group's direct members, with the two writes beside the list.
 *
 * Direct only, and it says so. A nested group is one row rather than its
 * members: flattening here would answer a different question from the one the
 * rows hold, and the transitive closure is the resolver's and is recomputed on
 * every request.
 */
async function membersPanel(group: Group, root: HTMLElement): Promise<void> {
  const list = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  const message = h('p', { class: 'form-message' })

  const type = h('select', { class: 'input' },
    h('option', { value: 'user' }, 'user'),
    h('option', { value: 'group' }, 'group'),
  )
  // A group holds users and other groups, so the list follows the type. The
  // group being edited is not offered as a member of itself.
  const member = picker('member')

  const fillMember = (): void => {
    void member.fill(async () =>
      type.value === 'group'
        ? (await client().groups.list())
            .filter((g: Group) => g.id !== group.id)
            .map((g: Group) => ({ id: g.id, label: `${g.name} — ${String(g.memberCount)} member(s)` }))
        : (await client().users.list()).map((u: User) => ({
            id: u.id,
            label: u.disabledAt === null ? u.email : `${u.email} (disabled)`,
          })),
    )
  }

  type.addEventListener('change', fillMember)
  fillMember()

  const dialog = h('dialog', { class: 'dialog dialog-wide' },
    h('h2', {}, `${group.name} — members`),
    h('p', { class: 'hint' },
      'Direct members only. A nested group is one member here, not its members — what it reaches is worked out per request.'),
    list,
    h('form', { method: 'dialog', class: 'row', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Adding…'
      try {
        const chosen = member.value()
        if (chosen === '') {
          message.className = 'form-message error'
          message.textContent = 'Choose who to add.'
          return
        }
        const added = await client().groups.addMember(group.id, {
          type: type.value === 'group' ? 'group' : 'user',
          id: chosen,
        })
        if (!added) {
          message.className = 'form-message error'
          message.textContent = 'No such group, or no such member in this organization.'
          return
        }
        message.className = 'form-message'
        message.textContent = ''
        fillMember()
        await fill()
      } catch (error) {
        message.className = 'form-message error'
        message.textContent = explain(error)
      }
    } },
      // In a `.field`, like the select in every other row in this UI. Bare, it
      // is a flex item carrying `.input`'s `width: 100%`, so it claimed the
      // whole row and the member picker beside it — `flex: 1` from `.grow`, and
      // therefore a basis of zero — collapsed to a sliver behind the Add
      // button. This was the only row that did not wrap its select.
      h('label', { class: 'field' }, h('span', {}, 'Kind'), type),
      h('div', { class: 'field grow' }, h('span', {}, 'Member'), member.el),
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Add'),
    ),
    message,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => {
        dialog.close()
        void peopleView(root)
      } }, 'Done'),
    ),
  )

  async function fill(): Promise<void> {
    try {
      const members = await client().groups.members(group.id)
      clear(list)
      if (members === undefined) {
        list.append(h('p', { class: 'muted' }, 'This group is no longer here.'))
        return
      }
      list.append(members.length === 0 ? h('p', { class: 'muted' }, 'No members yet.') : memberTable(members))
    } catch (error) {
      clear(list)
      list.append(h('div', { class: 'error' }, explain(error)))
    }
  }

  function memberTable(members: readonly GroupMember[]): HTMLElement {
    return h('table', { class: 'table' },
      h('tbody', {}, ...members.map((m) =>
        h('tr', {},
          h('td', {}, h('span', { class: 'slug' }, m.type)),
          h('td', {}, m.label),
          h('td', {}, shortId(m.id)),
          h('td', { class: 'right' },
            h('button', { class: 'btn btn-quiet btn-danger', onclick: async () => {
              await client().groups.removeMember(group.id, { type: m.type, id: m.id })
              await fill()
            } }, 'Remove'),
          ),
        ),
      )),
    )
  }


  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
  await fill()
}

/**
 * The only time a password exists outside the server.
 *
 * The same treatment the service account key gets, and for the same reason:
 * it is stored hashed, so there is no path from here that recovers it. Closing
 * takes a deliberate click on a button that says what closing means.
 */
function showSecret(dialog: HTMLDialogElement, secret: string, title: string, root: HTMLElement): void {
  const field = h('textarea', { class: 'input mono keyfield', readonly: true, rows: 2, spellcheck: 'false' })
  field.value = secret
  const copied = h('span', { class: 'copied' })

  dialog.replaceChildren(
    h('div', { class: 'keyout' },
      h('h2', {}, title),
      h('p', { class: 'warn' },
        'Shown once. It is stored as a scrypt hash, so it cannot be recovered from the database or from a backup — if it is lost, issue another one.'),
      h('div', { class: 'row' },
        field,
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          field.select()
          // `copyText` falls back to the selection-and-execCommand path, which
          // is the only one that works on a plain-HTTP origin. The field stays
          // selected either way, so even a refusal leaves the person one
          // keystroke from the value they cannot ask for again.
          if (await copyText(secret) === 'copied') {
            copied.textContent = 'copied'
          } else {
            copied.textContent = 'selected — copy it now'
          }
        } }, 'Copy'),
      ),
      copied,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => {
          dialog.close()
          void peopleView(root)
        } }, 'I have saved it'),
      ),
    ),
  )
}
