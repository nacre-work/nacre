import type { Grant, Group, Layer, ServiceAccount, User, Workspace } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { chip, clear, h, shortId } from '../dom.js'
import { picker } from '../pick.js'

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

/**
 * What each id is called, so the table reads as sentences rather than as hex.
 *
 * Every row here used to be `USER 22b7d5…679f` on `LAYER 5daa62…4bc3`, which is
 * a screen you cannot check your own work on: the one question it exists to
 * answer — who may reach what — needs both halves named, and a truncated uuid
 * names nothing. Reported from a running console, where three grants differed
 * only in the middle of a hash.
 *
 * ## It degrades rather than fails
 *
 * Listing users and groups is `org_admin`, and `admin` on a scope is not — the
 * picker below already carries that argument. So a caller who may legitimately
 * issue and revoke grants may be refused every one of these lists, and a
 * resolver that treated the refusal as an error would take the whole screen
 * away over decoration. Each list is asked separately, a refusal leaves that
 * kind unresolved, and an unresolved id renders exactly as it did before.
 *
 * ## Documents keep their id, and that is not laziness
 *
 * There is no list of documents to load — and by rule 6 a caller may hold
 * `admin` on a layer, be entitled to grant on a document inside it, and not be
 * permitted to read that document. Asking for its title one row at a time would
 * be a screen that answers `404` for reasons a visitor would read as a bug.
 */
type Names = ReadonlyMap<string, string>

async function names(): Promise<Names> {
  const found = new Map<string, string>()
  // Separately, so one refusal costs one kind rather than all five. `allSettled`
  // and not `all` for the same reason.
  await Promise.allSettled([
    client().users.list().then((rows: readonly User[]) => {
      for (const u of rows) found.set(u.id, u.disabledAt === null ? u.email : `${u.email} (disabled)`)
    }),
    client().groups.list().then((rows: readonly Group[]) => {
      for (const g of rows) found.set(g.id, g.name)
    }),
    client().serviceAccounts.list().then((rows: readonly ServiceAccount[]) => {
      for (const a of rows) found.set(a.id, a.name)
    }),
    client().layers.list().then((rows: readonly Layer[]) => {
      for (const l of rows) found.set(l.id, l.slug)
    }),
    client().workspaces.list().then((rows: readonly Workspace[]) => {
      for (const w of rows) found.set(w.id, w.slug)
    }),
  ])
  return found
}

/**
 * The name where there is one, the short id where there is not.
 *
 * The id stays reachable either way: it is the `title`, which is what the rest
 * of these screens do, and it is what another screen asks for when somebody
 * carries a grant somewhere else.
 */
function named(names: Names, id: string): HTMLElement {
  const label = names.get(id)
  return label === undefined ? shortId(id) : h('span', { class: 'named', title: id }, label)
}

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
    // Both at once: the names are for reading the rows, so waiting for them
    // serially would show a table that rewrites itself under the cursor.
    const [grants, resolved] = await Promise.all([client().grants.list(), names()])
    clear(body)
    body.append(grants.length === 0 ? empty() : table(grants, resolved, root))
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

function table(grants: readonly Grant[], resolved: Names, root: HTMLElement): HTMLElement {
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
          named(resolved, g.principalId),
        ),
        h('td', {},
          h('span', { class: 'kind' }, g.scopeType),
          ' ',
          named(resolved, g.scopeId),
        ),
        h('td', {}, chip(g.permission, g.effect)),
        h('td', { class: 'muted' }, g.source),
        h('td', { class: 'right' },
          h('button', {
            class: 'btn btn-quiet btn-danger',
            onclick: () => confirmRevoke(g, resolved, root),
          }, 'Revoke'),
        ),
      ),
    )),
  )
}

function confirmRevoke(grant: Grant, resolved: Names, root: HTMLElement): void {
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
        // Named here too, and the id kept beside it: this is the dialog where
        // somebody checks they are revoking the row they meant, and two grants
        // that differ in the middle of a uuid are two grants nobody can tell
        // apart under a confirmation.
        h('dt', {}, 'Principal'),
        h('dd', {}, grant.principalType, ' ', named(resolved, grant.principalId)),
        h('dt', {}, 'Scope'),
        h('dd', {}, grant.scopeType, ' ', named(resolved, grant.scopeId)),
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
  const scopeType = h('select', { class: 'input' },
    h('option', { value: 'layer' }, 'layer'),
    h('option', { value: 'workspace' }, 'workspace'),
  )
  const permission = h('select', { class: 'input' },
    ...PERMISSIONS.map((p) => h('option', { value: p }, p)),
  )
  const message = h('p', { class: 'form-message' })

  // It follows the scope type rather than only listing layers. Workspaces had
  // no list on this screen — which was once true of the API as well — so
  // granting on one meant knowing a uuid, the same hole the layer dialog had.
  const scope = picker('scope')

  const fillScope = (): void => {
    const type = scopeType.value
    void scope.fill(async () =>
      type === 'workspace'
        ? (await client().workspaces.list()).map((w: Workspace) => ({
            id: w.id,
            label: `${w.slug} — ${w.name}`,
          }))
        : (await client().layers.list()).map((l: Layer) => ({ id: l.id, label: `${l.slug} — ${l.name}` })),
    )
  }

  scopeType.addEventListener('change', fillScope)
  fillScope()

  // The same for the principal, which had no picker at all — so the scope came
  // from a list and the principal had to be a uuid somebody carried by hand.
  // Somebody typed a service account's *name* into it, and the only answer was
  // about the field that was correct.
  //
  // It could not have been built until all three types were listable: service
  // accounts always were, users and groups only since `/v1/users` and
  // `/v1/groups` landed. Before that this picker would have had one working
  // option out of three, which is worse than none.
  //
  // Listing users and groups is `org_admin` and `admin` on a scope is not, so
  // this can legitimately fail for a caller who may nonetheless issue the
  // grant — and that refusal is the one case where a field taking an id is
  // still the right control. `picker` shows it there and only there.
  const principal = picker('principal')

  const fillPrincipal = (): void => {
    const type = principalType.value
    void principal.fill(async () => {
      if (type === 'user') {
        return (await client().users.list()).map((u: User) => ({
          id: u.id,
          label: u.disabledAt === null ? u.email : `${u.email} (disabled)`,
        }))
      }
      if (type === 'group') {
        return (await client().groups.list()).map((g: Group) => ({
          id: g.id,
          label: `${g.name} — ${String(g.memberCount)} member(s)`,
        }))
      }
      // A revoked account is not offered: its key stopped working and is never
      // reissued, so a grant to it can never be exercised — and the server
      // refuses one now rather than storing a row that does nothing.
      return (await client().serviceAccounts.list())
        .filter((a: ServiceAccount) => a.revokedAt === null)
        .map((a: ServiceAccount) => ({ id: a.id, label: `${a.name} — ${a.keyPrefix}…` }))
    })
  }

  principalType.addEventListener('change', fillPrincipal)
  fillPrincipal()

  const dialog = h('dialog', { class: 'dialog' },
    h('form', { method: 'dialog', onsubmit: async (e: Event) => {
      e.preventDefault()
      message.className = 'form-message'
      message.textContent = 'Issuing…'
      try {
        const who = principal.value()
        const what = scope.value()
        if (who === '' || what === '') {
          message.className = 'form-message error'
          message.textContent = who === '' ? 'Choose a principal.' : 'Choose a scope.'
          return
        }
        const issued = await client().grants.issue({
          principalType: principalType.value as 'user' | 'group' | 'service_account',
          principalId: who,
          scopeType: scopeType.value as 'workspace' | 'layer',
          scopeId: what,
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
        h('div', { class: 'field grow' }, h('span', {}, 'Principal'), principal.el),
      ),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', {}, 'Scope type'), scopeType),
        h('div', { class: 'field grow' }, h('span', {}, 'Scope'), scope.el),
      ),
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
