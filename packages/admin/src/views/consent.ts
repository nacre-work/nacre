import { client, explain } from '../api.js'
import { chip, clear, h } from '../dom.js'

/**
 * The consent screen — where a person decides what an agent may see.
 *
 * The screen a client is sent to by `/oauth/authorize`, and the only place in
 * the flow where authority is created. Everything before it is a conversation
 * with an unauthenticated caller.
 *
 * **It does not hand the agent your account.** That is what a consent screen
 * usually does and it is the wrong answer here: an agent is a principal of its
 * own with its own grants, and "what may this agent read" is the question this
 * product exists to answer separately from "what may you read". So the choice
 * on this screen is *which service account*, and the token the client receives
 * acts as that account. Revoking it does not touch you; leaving the company
 * does not silently widen it.
 *
 * The request arrives in the fragment rather than the query, because a fragment
 * is not sent to a server: the client's parameters do not end up in this
 * origin's access log on the way past.
 */

interface Request {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state: string | undefined
  readonly resource: string | undefined
}

/** What the authorize endpoint put in the fragment, or nothing usable. */
export function readRequest(hash: string): Request | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  // The router owns the leading `/consent`; the request is what follows it.
  const q = new URLSearchParams(raw.replace(/^\/consent\??/, ''))
  const clientId = q.get('client_id')
  const redirectUri = q.get('redirect_uri')
  const codeChallenge = q.get('code_challenge')
  if (clientId === null || redirectUri === null || codeChallenge === null) return undefined
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state: q.get('state') ?? undefined,
    resource: q.get('resource') ?? undefined,
  }
}

export async function consentView(root: HTMLElement): Promise<void> {
  clear(root)
  const request = readRequest(location.hash)

  if (request === undefined) {
    root.append(
      h('div', { class: 'panel' },
        h('h1', {}, 'Nothing to approve'),
        h('p', { class: 'muted' },
          'This screen is opened by an application asking for access. Reaching it directly means there is no request to act on — start from the application.'),
      ),
    )
    return
  }

  const api = client()
  const message = h('p', { class: 'form-message' })

  // The name is self-asserted; the redirect URI is not. Registration is open,
  // which is what the RFC is for, so a client calling itself something
  // reassuring costs nothing — and the URI is the thing that actually decides
  // where the code goes. Shown together and with the URI in monospace, because
  // it is the field worth reading.
  const host = ((): string => {
    try {
      return new URL(request.redirectUri).host
    } catch {
      return request.redirectUri
    }
  })()

  const chosen = h('select', { class: 'input' }) as HTMLSelectElement
  const fresh = h('input', { class: 'input', placeholder: 'name for a new agent', maxlength: 100 }) as HTMLInputElement
  const approve = h('button', { type: 'button', class: 'btn btn-primary' }, 'Approve') as HTMLButtonElement
  const deny = h('button', { type: 'button', class: 'btn' }, 'Cancel')

  const load = async (): Promise<void> => {
    const accounts = (await api.serviceAccounts.list()).filter((a) => a.revokedAt === null)
    clear(chosen)
    chosen.append(h('option', { value: '' }, accounts.length === 0 ? 'no agents yet — create one' : 'create a new agent…'))
    for (const a of accounts) {
      chosen.append(h('option', { value: a.id }, `${a.name} · ${a.keyPrefix}…`))
    }
  }

  const setBusy = (busy: boolean): void => {
    approve.disabled = busy
    approve.textContent = busy ? 'Approving…' : 'Approve'
  }

  approve.addEventListener('click', () => {
    void (async () => {
      message.textContent = ''
      setBusy(true)
      try {
        let serviceAccountId = chosen.value
        if (serviceAccountId === '') {
          const name = fresh.value.trim()
          if (name === '') {
            message.textContent = 'Name the agent, or pick one that already exists.'
            return
          }
          // Through the endpoint that already exists and already checks. A
          // second creation path here is how the guarded one gets walked
          // around.
          const created = await api.serviceAccounts.create(name)
          serviceAccountId = created.id
        }

        const to = await api.consent({
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          serviceAccountId,
          ...(request.state === undefined ? {} : { state: request.state }),
          ...(request.resource === undefined ? {} : { resource: request.resource }),
        })
        // The page navigates, not the API: this was an XHR from a screen the
        // person is looking at, and a 302 on it would be followed by the
        // fetch rather than by the browser.
        location.assign(to)
      } catch (error) {
        message.textContent = explain(error)
      } finally {
        setBusy(false)
      }
    })()
  })

  deny.addEventListener('click', () => {
    // Back to the client with an error, which is what RFC 6749 asks a refusal
    // to look like: the application is told, rather than left waiting on a tab
    // the person closed.
    const to = new URL(request.redirectUri)
    to.searchParams.set('error', 'access_denied')
    if (request.state !== undefined) to.searchParams.set('state', request.state)
    location.assign(to.toString())
  })

  root.append(
    // The house shape: a page header, then the panel. The first version put the
    // heading inside the panel, which is nothing else here does — and rendering
    // it beside an existing screen is how that showed up.
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Give an application access'),
        h('p', { class: 'lede' },
          h('strong', {}, host),
          ' is asking to act as an agent in your organization. It will act as the agent you pick — ',
          'not as you. What it can see is exactly what that agent has been granted.'),
      ),
    ),

    h('div', { class: 'panel' },
      // The name is self-asserted and the redirect URI is not: registration is
      // open, which is what the RFC is for, so a client calling itself
      // something reassuring costs nothing. The URI is the field that decides
      // where the code actually goes, so it is the one shown.
      h('p', { class: 'hint' }, 'The code will be delivered to'),
      h('p', { class: 'mono' }, request.redirectUri),

      h('label', { class: 'field' }, 'Act as', chosen),
      h('label', { class: 'field' }, 'Or create', fresh),
      h('p', { class: 'hint' },
        'A new agent can reach nothing until it is granted something. Do that on the Grants screen — ',
        chip('read'), ' or ', chip('write'), ' on a layer.'),

      h('div', { class: 'note' },
        h('p', {},
          'Revoking the agent stops this application immediately, and touches nothing else you have access to.'),
      ),

      message,
      h('div', { class: 'dialog-actions' }, deny, approve),
    ),
  )

  await load()
}
