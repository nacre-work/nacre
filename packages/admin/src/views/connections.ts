import { client, explain } from '../api.js'
import { ago, clear, h } from '../dom.js'

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
export async function connectionsView(root: HTMLElement): Promise<void> {
  clear(root)
  const body = h('tbody', {})
  const message = h('p', { class: 'form-message' })

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Connected applications'),
        h('p', { class: 'lede' },
          'Each one acts as an agent you chose — not as you. Forgetting an application ends that one connection; ',
          'the agent, and anything else using it, keeps working.'),
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
          h('td', {}, c.serviceAccountName),
          h('td', {}, ago(c.createdAt)),
          // Renewal is the only thing the server sees: an access token is
          // verified locally and its use touches nothing.
          h('td', {}, c.lastRefreshedAt === null ? 'never' : ago(c.lastRefreshedAt)),
          h('td', {}, ended ? h('span', { class: 'muted' }, 'forgotten') : forget),
        ),
      )
    }
  }

  await load()
}
