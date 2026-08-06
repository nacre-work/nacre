import { client, explain } from '../api.js'
import { chip, clear, h } from '../dom.js'

/**
 * The consent screen — where a person decides what an agent may see.
 *
 * The screen a client is sent to by `/oauth/authorize`, and the only place in
 * the flow where authority is created. Everything before it is a conversation
 * with an unauthenticated caller.
 *
 * Two things can be approved here, and which one a person wants is not the same
 * question as which one they are allowed to give.
 *
 * **As you** is a delegation: the application acts as you and reaches exactly
 * what you reach, re-resolved on every request. It is what OAuth is for, and it
 * is what this screen offers first — the flow used to offer only the other one,
 * and both listing and minting a service account are `org_admin`, so a member
 * arriving here found an empty picker and a 404 on Approve.
 *
 * **As an agent** is a principal of its own with its own grants, which is the
 * question this product exists to answer separately from "what may you read".
 * An agent belongs to the organization and survives any one person, so it is
 * the right answer for an unattended pipeline and the wrong one for a client on
 * somebody's laptop. Offered only where the person can actually see agents;
 * asking for the list is how that is decided, because the answer is the
 * permission.
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

  const asSelf = h('input', { type: 'radio', name: 'acts-as', value: 'self', checked: 'checked' }) as HTMLInputElement
  const asAgent = h('input', { type: 'radio', name: 'acts-as', value: 'agent' }) as HTMLInputElement
  const agentPanel = h('div', { class: 'field-group' },
    h('label', { class: 'field' }, 'Act as', chosen),
    h('label', { class: 'field' }, 'Or create', fresh),
    h('p', { class: 'hint' },
      'A new agent can reach nothing until it is granted something. Do that on the Grants screen — ',
      chip('read'), ' or ', chip('write'), ' on a layer.'),
  )
  const agentChoice = h('label', { class: 'choice' }, asAgent,
    h('span', {},
      h('strong', {}, 'As an agent'),
      h('span', { class: 'hint' },
        ' — a principal of its own, with its own grants. It belongs to the organization and outlives you.'),
    ),
  )

  /** Layer checkboxes, for narrowing a delegation. */
  const narrowing = h('div', { class: 'field-group' })
  const boxes: HTMLInputElement[] = []

  /**
   * What the application may do, and the dimension people reach for first.
   *
   * `read` is ticked and the others are not, deliberately. A consent screen
   * whose default is everything is a consent screen nobody reads, and a person
   * connecting an MCP client means "let it search". Ticking `write` is a
   * decision they make rather than one they inherit.
   *
   * Independent boxes rather than a level, because `write` does not imply
   * `read` anywhere in this model: write alone is an ingest client that cannot
   * read back what it wrote, and it is a real thing to want.
   */
  const verb = (value: string, label: string, note: string, checked: boolean): HTMLInputElement => {
    const box = h('input', { type: 'checkbox', value, ...(checked ? { checked: 'checked' } : {}) }) as HTMLInputElement
    verbs.push(box)
    ceiling.append(
      h('label', { class: 'choice' }, box,
        h('span', {}, h('strong', {}, label), h('span', { class: 'hint' }, ' — ' + note)),
      ),
    )
    return box
  }
  const ceiling = h('div', { class: 'field-group' })
  const verbs: HTMLInputElement[] = []

  const showAgentFields = (): void => {
    agentPanel.hidden = !asAgent.checked
    narrowing.hidden = asAgent.checked
    ceiling.hidden = asAgent.checked
  }
  asSelf.addEventListener('change', showAgentFields)
  asAgent.addEventListener('change', showAgentFields)

  const load = async (): Promise<void> => {
    // Whether agents can be offered is decided by asking for them, not by
    // reading a role out of the token. A member gets 404 here — invariant 6 —
    // and the honest reading of that is "this option is not yours to give",
    // which is different from "this screen is broken", which is what it looked
    // like before.
    let accounts: readonly { id: string; name: string; keyPrefix: string; revokedAt: string | null }[] = []
    let mayMintAgents = true
    try {
      accounts = (await api.serviceAccounts.list()).filter((a) => a.revokedAt === null)
    } catch {
      mayMintAgents = false
    }
    agentChoice.hidden = !mayMintAgents
    agentPanel.hidden = true
    if (mayMintAgents) {
      clear(chosen)
      chosen.append(
        h('option', { value: '' }, accounts.length === 0 ? 'no agents yet — create one' : 'create a new agent…'),
      )
      for (const a of accounts) {
        chosen.append(h('option', { value: a.id }, `${a.name} · ${a.keyPrefix}…`))
      }
    }

    // What this person can offer. `admin` only where they hold it: a member
    // has no organization-wide administration to lend, so offering the box
    // would be offering something that resolves to nothing — and the honest
    // reading of a screen is that everything on it does something.
    clear(ceiling)
    verbs.length = 0
    verb('read', 'Search and read documents', 'what it can see is exactly what you can see', true)
    verb('write', 'Add and change documents', 'it can ingest and delete in the layers below', false)
    if (mayMintAgents) {
      verb('admin', 'Administer the organization', 'people, groups, agents and the access log', false)
    }

    // The layers this person reads, which is the only sensible set to narrow
    // to: the delegation cannot reach anything else anyway, so offering more
    // would be offering a restriction that restricts nothing.
    clear(narrowing)
    boxes.length = 0
    const layers = await api.layers.list()
    if (layers.length === 0) {
      narrowing.append(h('p', { class: 'hint' }, 'You do not read any layer yet, so there is nothing to restrict.'))
      return
    }
    narrowing.append(h('p', { class: 'hint' }, 'Leave all unticked to give it everything you can read.'))
    for (const layer of layers) {
      const box = h('input', { type: 'checkbox', value: layer.id }) as HTMLInputElement
      boxes.push(box)
      narrowing.append(h('label', { class: 'choice' }, box, h('span', {}, `${layer.name} · ${layer.slug}`)))
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
        let serviceAccountId: string | undefined
        if (asAgent.checked) {
          serviceAccountId = chosen.value
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
        }

        // None ticked is no narrowing, which is not the same as narrowed to
        // nothing — the second would be an application that can reach nothing,
        // and it is not a state this offers.
        const layers = boxes.filter((b) => b.checked).map((b) => b.value)

        // Permissions are the other way round: none ticked *is* an application
        // that can do nothing, so it is refused here rather than sent as an
        // empty array the server would have to interpret.
        const permissions = verbs.filter((b) => b.checked).map((b) => b.value) as ('read' | 'write' | 'admin')[]
        if (!asAgent.checked && permissions.length === 0) {
          message.textContent = 'Choose at least one thing the application may do.'
          return
        }

        const to = await api.consent({
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          ...(serviceAccountId === undefined ? {} : { serviceAccountId }),
          ...(serviceAccountId === undefined && layers.length > 0 ? { layers } : {}),
          ...(serviceAccountId === undefined ? { permissions } : {}),
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
          ' is asking for access to your organization. By default it acts as you and sees exactly what ',
          'you see — never more, and never after you lose it.'),
      ),
    ),

    h('div', { class: 'panel' },
      // The name is self-asserted and the redirect URI is not: registration is
      // open, which is what the RFC is for, so a client calling itself
      // something reassuring costs nothing. The URI is the field that decides
      // where the code actually goes, so it is the one shown.
      h('p', { class: 'hint' }, 'The code will be delivered to'),
      h('p', { class: 'mono' }, request.redirectUri),

      h('label', { class: 'choice' }, asSelf,
        h('span', {},
          h('strong', {}, 'As you'),
          h('span', { class: 'hint' },
            ' — it reaches exactly what you reach, checked again on every request.'),
        ),
      ),
      h('p', { class: 'hint' }, 'It may'),
      ceiling,
      h('p', { class: 'hint' }, 'In these layers'),
      narrowing,
      agentChoice,
      agentPanel,

      h('div', { class: 'note' },
        h('p', {},
          'Forgetting this application on the Connections screen stops it on the next request. ',
          'Nothing else you have access to is touched, and nothing is granted to the application itself.'),
      ),

      message,
      h('div', { class: 'dialog-actions' }, deny, approve),
    ),
  )

  await load()
}
