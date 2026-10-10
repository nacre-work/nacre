import type { CeilingValue, Connection } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { connectPanel } from '../connect.js'
import { agoCell, clear, h } from '../dom.js'
import { listing } from '../listing.js'

/**
 * Applications connected to this organization, and forgetting one.
 *
 * Until 0.5.4 there was nothing to show. The flow recorded an authorization
 * *code* — ninety seconds long and consumed on exchange — and nothing that
 * outlived it, so after a client connected there was no record it had, and no
 * way to stop it short of revoking the agent entirely.
 *
 * Those are different acts and the screen keeps them apart. **Forgetting an
 * application** ends one connection: the refresh token is deleted and the
 * client has to be approved again. **Revoking the agent** is on the Service
 * accounts screen and stops everything acting as it, including a key somebody
 * pasted into a config file years ago.
 *
 * The honest part is the access token. It is a JWT verified against a key, so
 * nothing consults a table when it is presented and nothing can take one back
 * before it expires — the screen says how long that is rather than claiming an
 * end that has not happened yet.
 */
/**
 * What the application acts as, as a sentence a reader can act on.
 *
 * `me` is the signed-in principal's id, or undefined where `/v1/me` could not
 * be read — in which case every delegation is named by address rather than one
 * of them saying "you". Degrading to *more* information rather than less is the
 * right direction for a failure nobody can see.
 */
function actsAs(
  c: {
    actsAs: 'service_account' | 'user'
    serviceAccountName: string | null
    approvedBy: string
    approvedByEmail: string | null
    approverDisabled: boolean
  },
  me: string | undefined,
): (Node | string)[] {
  if (c.actsAs === 'service_account') {
    return [c.serviceAccountName ?? h('span', { class: 'muted' }, 'an agent that no longer exists')]
  }
  const who: Node | string =
    c.approvedByEmail === null
      ? h('span', { class: 'muted' }, 'a person this organization no longer has')
      : c.approvedBy === me
        ? 'you'
        : c.approvedByEmail
  // Said on the row rather than left for somebody to work out from the People
  // screen. A delegation of a disabled person is refused on every request and
  // its renewal is refused too, so this is the difference between a connection
  // that is idle and one that cannot answer.
  return c.approverDisabled ? [who, h('span', { class: 'muted' }, ' — suspended')] : [who]
}

/** What each ceiling value lets an application do, as the verb a sentence needs. */
const VERB: Readonly<Record<CeilingValue, string>> = {
  read: 'read',
  write: 'write',
  admin: 'administer',
  skill: 'edit the skill',
}

const sentence = (words: readonly string[]): string =>
  words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] ?? ''}`

/**
 * What a delegation may do, said under its name.
 *
 * The consent screen is the only place a person sees what they approved, and
 * then never again — so "this application may read the handbook and edit its
 * skill" had nowhere to be checked afterwards, and a connection that may
 * rewrite what agents are told about a layer looked exactly like one that may
 * only search. It could not have been said before 0.31.0 in any case: the API
 * sent the narrowing as objects under a contract that said ids, and sent no
 * ceiling at all.
 *
 * Layer names come from the caller's own listing, so a layer the reader cannot
 * see is named as one — an administrator looking at somebody else's
 * connection is not told what that person reads.
 *
 * An agent has no line: its reach is its grants, which the Grants screen says.
 */
function mayLine(c: Connection, names: ReadonlyMap<string, string>): string | undefined {
  if (c.actsAs !== 'user') return undefined
  // The administrative connection's reach is fixed by the server rather than
  // chosen, so the line says what it is rather than reading out a ceiling of
  // `read` and `admin` that would suggest it can read documents and change
  // things directly — it can do neither. A change it asks for is a proposal
  // that waits for its person to apply it. docs/mcp-admin.md.
  if (c.surface === 'admin') {
    return 'Administrative: may read how the organization is set up and its access log, and propose changes that wait for its person to apply them.'
  }
  const verbs = (values: readonly CeilingValue[]): string =>
    values.length === 0 ? 'do anything its person can' : sentence(values.map((v) => VERB[v]))
  if (c.layers.length === 0) return `May ${verbs(c.permissions)}, in every layer its person reaches.`
  const parts = c.layers.map(
    (l) => `${verbs(l.permissions ?? c.permissions)} in ${names.get(l.id) ?? 'a layer you cannot see'}`,
  )
  return `May ${parts.join('; ')}.`
}

export async function connectionsView(root: HTMLElement): Promise<void> {
  clear(root)
  // Read once for the screen and asked twice: who "you" is in the list, and
  // whether the panel above it offers the administrative half. Tolerated when
  // it fails: an older API answers 404 here, and a list that names every
  // approver by address is a worse screen than one that says "you" for one of
  // them, not a broken one — and a panel offering only the MCP endpoint is the
  // one every caller may use.
  const self = client().me().catch(() => undefined)
  const body = h('div', {})
  const message = h('p', { class: 'form-message' })

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Connected applications'),
        // The old lede said "each one acts as an agent you chose — not as you",
        // which was true of the only shape that existed when it was written and
        // became false the day a person could delegate their own reach. Both
        // shapes are on this screen and the difference is the whole of the
        // "Acts as" column, so the lede has to admit there are two.
        h('p', { class: 'lede' },
          'Each one acts either as an agent you chose or as a person — the "Acts as" column says which. ',
          'Forgetting an application ends that one connection; the agent, or the person, keeps working.'),
      ),
    ),
    // Where to connect sits above what is connected: it is the question a
    // person arriving here with nothing connected yet came to ask.
    connectPanel(self.then((m) => m?.administers ?? false)),
    message,
    h('div', { class: 'panel' }, body),
  )

  const me = (await self)?.principalId
  // Names for the layers a narrowing points at, from what this reader can see.
  // Tolerated when it fails for the same reason: ids would be a worse line,
  // not a broken screen.
  const names = new Map<string, string>()
  try {
    for (const layer of await client().layers.list()) names.set(layer.id, layer.name)
  } catch {
    // Every narrowed layer reads as one this reader cannot see.
  }

  const load = async (): Promise<void> => {
    let listed
    try {
      listed = await client().connections.list()
    } catch (error) {
      message.textContent = explain(error)
      return
    }
    clear(body)

    if (listed.items.length === 0) {
      body.append(
        h('div', { class: 'empty' },
          h('p', {}, 'Nothing is connected. An application appears here after somebody approves it.')),
      )
      return
    }

    // Searched by the application and by who it acts as — the two columns a
    // person scanning this list is looking for. The same page and the same
    // box as every other list screen, through `listing`.
    body.append(listing({
      rows: listed.items,
      fields: (c) => [c.clientName, c.serviceAccountName, c.approvedByEmail],
      label: 'Search by application, agent or person',
      render: (shown) => h('table', { class: 'table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Application'),
            h('th', {}, 'Acts as'),
            h('th', {}, 'Approved'),
            h('th', {}, 'Last renewed'),
            h('th', {}, ''),
          ),
        ),
        h('tbody', {}, ...shown.map((c) => connectionRow(c, me, names, message, load))),
      ),
    }))
  }

  await load()
}

function connectionRow(
  c: Connection,
  me: string | undefined,
  names: ReadonlyMap<string, string>,
  message: HTMLElement,
  load: () => Promise<void>,
): HTMLElement {
  const ended = c.revokedAt !== null
  const forget = h('button', { class: 'btn btn-quiet', type: 'button' }, 'Forget') as HTMLButtonElement
  forget.addEventListener('click', () => {
    void (async () => {
      forget.disabled = true
      try {
        const result = await client().connections.end(c.id)
        if (result === undefined) {
          message.textContent = 'That connection is already gone.'
        } else {
          // The window, stated. Saying "ended" alone would overstate what
          // just happened: the refresh token is gone, and an access token
          // already issued keeps working until it expires.
          const minutes = Math.ceil(result.accessTokenTtlSeconds / 60)
          message.textContent =
            `${c.clientName} can no longer renew. A token it already holds stops working within ${minutes} minute${minutes === 1 ? '' : 's'}; ` +
            'revoke the agent to end it now.'
        }
        await load()
      } catch (error) {
        message.textContent = explain(error)
      } finally {
        forget.disabled = false
      }
    })()
  })

  const may = mayLine(c, names)
  return h('tr', { class: ended ? 'muted' : '' },
    // What it may do sits under its name rather than in a column of its own:
    // it is a sentence of unbounded length, and a table that is five columns
    // at 1440 has to stay readable at 390. The same treatment the Skills
    // screen gives a skill's description.
    // Which server it is connected to, on every row and not only the
    // administrative ones. The same application is often connected to both,
    // as two rows with one name, and a label on one of them leaves the reader
    // to infer the other — which is the row they are about to forget.
    h('td', { class: 'cell-stack' },
      c.clientName, ' ', h('span', { class: c.surface === 'admin' ? 'tag tag-admin' : 'tag' }, c.surface === 'admin' ? 'admin MCP' : 'MCP'),
      ...(may === undefined ? [] : [h('div', { class: 'cell-note' }, may)]),
    ),
    // A delegation names no agent, so the cell names the *person*.
    //
    // It used to read "the person who approved it" on every row, which is
    // a constant and therefore carries nothing: on an administrator's
    // list, where every delegation is somebody else's, it withheld the
    // one fact the column exists for, and on a person's own list it
    // restated the question. The comment that stood here said the
    // approver is named on an administrator's list — it was not, and a
    // comment describing behaviour the code beside it does not have is
    // the shape this repository keeps finding.
    //
    // "you" for your own, the address for anyone else's, and the id only
    // where the row points at a user this organization no longer has.
    h('td', {}, ...actsAs(c, me)),
    agoCell(c.createdAt, ''),
    // Renewal is the only thing the server sees: an access token is
    // verified locally and its use touches nothing. `ago(null)` is
    // already "never", so the ternary this replaced was saying it twice.
    agoCell(c.lastRefreshedAt, ''),
    h('td', {}, ended ? h('span', { class: 'muted' }, 'forgotten') : forget),
  )
}
