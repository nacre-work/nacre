import { client, explain } from '../api.js'
import { agoCell, clear, h } from '../dom.js'

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

export async function connectionsView(root: HTMLElement): Promise<void> {
  clear(root)
  const body = h('tbody', {})
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
    message,
    h('div', { class: 'panel' },
      h('table', { class: 'table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Application'),
            h('th', {}, 'Acts as'),
            h('th', {}, 'Approved'),
            h('th', {}, 'Last renewed'),
            h('th', {}, ''),
          ),
        ),
        body,
      ),
    ),
  )

  // Read once for the screen rather than per row, and tolerated when it fails:
  // an older API answers 404 here, and a list that names every approver by
  // address is a worse screen than one that says "you" for one of them, not a
  // broken one.
  let me: string | undefined
  try {
    me = (await client().me()).principalId
  } catch {
    me = undefined
  }

  const load = async (): Promise<void> => {
    clear(body)
    let listed
    try {
      listed = await client().connections.list()
    } catch (error) {
      message.textContent = explain(error)
      return
    }

    if (listed.items.length === 0) {
      body.append(
        h('tr', {}, h('td', { colspan: 5 },
          h('div', { class: 'empty' },
            h('p', {}, 'Nothing is connected. An application appears here after somebody approves it.')))),
      )
      return
    }

    for (const c of listed.items) {
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

      body.append(
        h('tr', { class: ended ? 'muted' : '' },
          h('td', {}, c.clientName),
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
        ),
      )
    }
  }

  await load()
}
