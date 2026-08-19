import type { Group, Layer, ServiceAccount, User, Workspace } from '@nacre.work/sdk'

import { client } from './api.js'
import { h, shortId } from './dom.js'

/**
 * What each id is called, so a table reads as sentences rather than as hex.
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
 * Grants screen's picker carries that argument too. So a caller who may legitimately
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
 *
 * ## Two views ask it now, so it lives here
 *
 * The access log needs the same answer for the same reason, and a second copy
 * of a resolver is two chances to disagree about what a disabled account is
 * called — the shape this repository closes with a check when it cannot close
 * it with a module. This is a module, so it is one.
 */
export type Names = ReadonlyMap<string, string>

export async function names(): Promise<Names> {
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
export function named(names: Names, id: string): HTMLElement {
  const label = names.get(id)
  return label === undefined ? shortId(id) : h('span', { class: 'named', title: id }, label)
}

