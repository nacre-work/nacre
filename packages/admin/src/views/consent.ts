import { isAdministrativeResource, type CeilingValue } from '@nacre.work/sdk'

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

  // The administrative MCP asks for a different thing, so it gets a different
  // screen rather than this one with boxes greyed out: there is nothing to
  // choose — no agent, no layers, no verbs — and one fact to decide.
  if (isAdministrativeResource(request.resource)) {
    await administrativeConsent(root, request, host)
    return
  }

  const chosen = h('select', { class: 'input' }) as HTMLSelectElement
  const fresh = h('input', { class: 'input', placeholder: 'name for a new agent', maxlength: 100 }) as HTMLInputElement
  const approve = h('button', { type: 'button', class: 'btn btn-primary' }, 'Approve') as HTMLButtonElement
  const deny = h('button', { type: 'button', class: 'btn' }, 'Cancel')

  const asSelf = h('input', { type: 'radio', name: 'acts-as', value: 'self', checked: 'checked' }) as HTMLInputElement
  const asAgent = h('input', { type: 'radio', name: 'acts-as', value: 'agent' }) as HTMLInputElement

  /**
   * A labelled group of choices that can be emptied back to just its label.
   *
   * The label is a `<legend>`, which is what attaches the question to the
   * controls answering it. Both of these were `<p class="hint">` sitting above
   * a bare div, so "It may" and "In these layers" were unattached sentences —
   * and since both groups are rebuilt by `load`, the label has to be part of
   * what rebuilding puts back rather than something appended once beside it.
   */
  const group = (label: string): { el: HTMLFieldSetElement; reset: () => void } => {
    const el = h('fieldset', { class: 'field-group nested' })
    const reset = (): void => {
      clear(el)
      el.append(h('legend', {}, label))
    }
    reset()
    return { el, reset }
  }
  const agentPanel = h('div', { class: 'field-group nested' },
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

  /**
   * One row per layer, and a `read`/`write` box on each.
   *
   * It was one list of layers beside one set of permissions, and what those two
   * questions could express together was their product: the same verbs applied
   * to every layer. A person does not mean a product. "Read the handbook, write
   * to scratch" needed `write` on the handbook to say, which is precisely the
   * thing they were trying not to give.
   *
   * A row with nothing ticked is a layer that is not in the narrowing at all —
   * the same meaning an unticked box had before.
   */
  const narrowing = group('It may, in each layer')
  /**
   * `skill` is present only on a row where the person holds `admin` — the box
   * is "edit this layer's skill", and offering it anywhere else would be
   * offering something that resolves to nothing. See docs/skills.md.
   */
  const rows: { id: string; read: HTMLInputElement; write: HTMLInputElement; skill?: HTMLInputElement }[] = []
  const boxes = (r: (typeof rows)[number]): HTMLInputElement[] =>
    r.skill === undefined ? [r.read, r.write] : [r.read, r.write, r.skill]

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
   *
   * Two boxes and not three. See where they are built for why `admin` is not
   * on this screen.
   */
  const verb = (value: string, label: string, note: string, checked: boolean): HTMLInputElement => {
    const box = h('input', { type: 'checkbox', value, ...(checked ? { checked: 'checked' } : {}) }) as HTMLInputElement
    verbs.push(box)
    ceiling.el.append(
      h('label', { class: 'choice' }, box,
        h('span', {}, h('strong', {}, label), h('span', { class: 'hint' }, ' — ' + note)),
      ),
    )
    return box
  }
  const ceiling = group('It may')
  const verbs: HTMLInputElement[] = []

  /**
   * The connection-wide group asks what the application may do *everywhere*,
   * and the rows below answer it per layer. Both at once is one question with
   * two answers, so the group steps aside the moment any row is ticked — and
   * comes back when the last one is cleared.
   */
  const showCeiling = (): void => {
    const perLayer = rows.some((r) => boxes(r).some((b) => b.checked))
    ceiling.el.hidden = asAgent.checked || perLayer
  }

  const showAgentFields = (): void => {
    agentPanel.hidden = !asAgent.checked
    narrowing.el.hidden = asAgent.checked
    showCeiling()
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
    ceiling.reset()
    verbs.length = 0
    verb('read', 'Search and read documents', 'what it can see is exactly what you can see', true)
    verb('write', 'Add and change documents', 'it can ingest and delete in the layers below', false)

    // No `admin` box, and that is about *this screen* rather than about the
    // mechanism. The person arriving here was sent by an MCP client, and the
    // MCP surface's one tool that resolves `admin` writes a layer's skill —
    // which has its own box, per layer, in the table below — so `admin`
    // itself would do little more where they are looking and something
    // considerable through the REST API, where they are not: renaming and
    // deleting a layer, issuing grants on it.
    //
    // The ceiling still admits it and `POST /v1/oauth/consent` still takes it,
    // for an `org_admin` who deliberately wants an administrative delegation:
    // it is not an escalation, since a ceiling cannot exceed what its person
    // already holds, and it dies when they are disabled, which a service
    // account's key does not. docs/openapi.yaml says so, so the contract and
    // this screen do not quietly disagree.

    // The layers this person reads, which is the only sensible set to narrow
    // to: the delegation cannot reach anything else anyway, so offering more
    // would be offering a restriction that restricts nothing.
    narrowing.reset()
    rows.length = 0
    const layers = await api.layers.list()
    if (layers.length === 0) {
      narrowing.el.append(h('p', { class: 'hint' }, 'You do not read any layer yet, so there is nothing to restrict.'))
      return
    }
    narrowing.el.append(
      h('p', { class: 'hint' }, 'Leave every row empty to give it everything above, everywhere you can read.'),
    )

    // "Edit skill" is a column only where it can be ticked somewhere. The
    // API says what this person holds on each layer, so the screen does not
    // guess — and a person who administers no layer is not shown a column of
    // empty cells asking them a question they cannot answer.
    const administered = layers.some((l) => l.permissions.includes('admin'))

    const body = h('tbody', {})
    for (const layer of layers) {
      const read = h('input', { type: 'checkbox', 'aria-label': `Read ${layer.name}` }) as HTMLInputElement
      const write = h('input', { type: 'checkbox', 'aria-label': `Write ${layer.name}` }) as HTMLInputElement
      const skill = layer.permissions.includes('admin')
        ? (h('input', { type: 'checkbox', 'aria-label': `Edit the skill of ${layer.name}` }) as HTMLInputElement)
        : undefined
      const row = { id: layer.id, read, write, ...(skill === undefined ? {} : { skill }) }
      // Ticking anything per layer answers the question the group above asks,
      // so that group steps aside rather than sitting there contradicting it.
      for (const box of boxes(row)) box.addEventListener('change', showCeiling)
      rows.push(row)
      body.append(
        h('tr', {},
          h('td', {}, `${layer.name} · ${layer.slug}`),
          h('td', { class: 'tick' }, read),
          h('td', { class: 'tick' }, write),
          ...(administered ? [h('td', { class: 'tick' }, skill ?? '')] : []),
        ),
      )
    }
    narrowing.el.append(
      h('table', { class: 'table matrix' },
        h('thead', {}, h('tr', {},
          h('th', {}, 'Layer'),
          h('th', { class: 'tick' }, 'Read'),
          h('th', { class: 'tick' }, 'Write'),
          ...(administered ? [h('th', { class: 'tick' }, 'Edit skill')] : []),
        )),
        body,
      ),
    )
    if (administered) {
      // What the box gives, said where it is offered. A skill is what every
      // later agent is told about the layer, so this is the one write here
      // that outlives the conversation that made it — and it gives nothing
      // else, which is the half a person needs told to tick it at all.
      narrowing.el.append(
        h('p', { class: 'hint' },
          'Edit skill lets it rewrite what agents are told about that layer — offered where you administer it. ',
          'Nothing else comes with it: no documents, no renaming, no grants. Every version is kept and can be restored.'),
      )
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
        const layers = rows
          .map((r) => ({
            id: r.id,
            permissions: [
              ...(r.read.checked ? ['read' as const] : []),
              ...(r.write.checked ? ['write' as const] : []),
              ...(r.skill?.checked === true ? ['skill' as const] : []),
            ],
          }))
          .filter((l) => l.permissions.length > 0)

        // Permissions are the other way round: none ticked *is* an application
        // that can do nothing, so it is refused here rather than sent as an
        // empty array the server would have to interpret.
        //
        // With a per-layer answer given, the connection's ceiling is the
        // **union** of it rather than a second thing to fill in. That is not a
        // convenience: the server refuses a layer set the ceiling excludes, so
        // sending anything narrower here would refuse the very rows the person
        // just ticked — and anything wider would leave administration bounded
        // by a verb they never granted anywhere.
        const permissions: CeilingValue[] =
          layers.length > 0
            ? (['read', 'write', 'skill'] as const).filter((p) => layers.some((l) => l.permissions.includes(p)))
            : (verbs.filter((b) => b.checked).map((b) => b.value) as CeilingValue[])
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
      // Each group carries its own question as a `<legend>`. They were two
      // `<p class="hint">` above two bare divs, which read on the page as
      // "It may" and "In these layers" left hanging as sentence fragments.
      ceiling.el,
      narrowing.el,
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

/**
 * The consent for the administrative MCP. docs/mcp-admin.md.
 *
 * One decision and no choices. The server fixes what such a connection may do
 * and refuses a request that tries to set it, so a screen offering layers or
 * verbs here would be offering controls that change nothing — which this
 * console has shipped before and removed. What the person needs instead is the
 * whole of what they are agreeing to, in both directions, and the one thing
 * that stops it.
 *
 * Offered to an organization administrator only, and said plainly to anybody
 * else rather than drawn and then refused: the server answers `404` to a member
 * here, and a screen whose only button fails is the defect `GET /v1/me`'s
 * `administers` exists to prevent.
 */
async function administrativeConsent(root: HTMLElement, request: Request, host: string): Promise<void> {
  const api = client()
  const message = h('p', { class: 'form-message' })
  const approve = h('button', { type: 'button', class: 'btn btn-primary' }, 'Approve') as HTMLButtonElement
  const deny = h('button', { type: 'button', class: 'btn' }, 'Cancel')

  deny.addEventListener('click', () => {
    const to = new URL(request.redirectUri)
    to.searchParams.set('error', 'access_denied')
    if (request.state !== undefined) to.searchParams.set('state', request.state)
    location.assign(to.toString())
  })

  approve.addEventListener('click', () => {
    void (async () => {
      message.textContent = ''
      approve.disabled = true
      approve.textContent = 'Approving…'
      try {
        const to = await api.consent({
          clientId: request.clientId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          ...(request.state === undefined ? {} : { state: request.state }),
          ...(request.resource === undefined ? {} : { resource: request.resource }),
        })
        location.assign(to)
      } catch (error) {
        message.textContent = explain(error)
      } finally {
        approve.disabled = false
        approve.textContent = 'Approve'
      }
    })()
  })

  const administers = await api.me().then((me) => me.administers, () => false)
  // Cleared again after the wait, not only before it. The router renders on
  // load and again once the nav knows who is signed in, so two calls of this
  // view overlap — each cleared an empty page, both waited here, and both
  // appended: the screen drawn twice, one under the other. Found by looking at
  // the render. The ordinary consent branch appends before it awaits, which is
  // why it never showed this.
  clear(root)

  const list = (items: readonly string[]): HTMLElement => h('ul', { class: 'plain' }, ...items.map((i) => h('li', {}, i)))

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Give an application administrative access'),
        h('p', { class: 'lede' },
          h('strong', {}, host),
          ' is asking to help you administer this organization, acting as you, through Nacre\u2019s administrative connection.'),
      ),
    ),
    administers
      ? h('div', { class: 'panel' },
          h('p', { class: 'hint' }, 'The code will be delivered to'),
          h('p', { class: 'mono' }, request.redirectUri),

          h('fieldset', { class: 'field-group' },
            h('legend', {}, 'It may read'),
            list([
              'people, groups and service accounts',
              'workspaces, layers and the grants on them',
              'what anybody can reach, and the grants that decide it',
              'the organization\u2019s and each layer\u2019s skill, for review',
              'connected applications',
              'the access log, and counts over it',
            ]),
          ),
          h('fieldset', { class: 'field-group' },
            h('legend', {}, 'It may not'),
            list([
              'read, add or change any document',
              'change anything — every change stays yours to make here',
              'see passwords, keys or second factors',
              'reach any other organization',
            ]),
          ),

          h('div', { class: 'note' },
            h('p', {},
              'It works only while you are an organization administrator. Losing that role, being disabled, or ',
              'forgetting it on the Connections screen stops it on the next request. It is a separate connection ',
              'from any ordinary one this application has.'),
            h('p', {},
              'Names, descriptions, skills and logged queries it reads were written by other people. It is told to ',
              'treat them as data and never as instructions.'),
          ),

          message,
          h('div', { class: 'dialog-actions' }, deny, approve),
        )
      : h('div', { class: 'panel' },
          h('p', {},
            'Only an organization administrator can approve administrative access. Ask one to connect this ',
            'application, or connect it to the ordinary Nacre server instead.'),
          h('div', { class: 'dialog-actions' }, deny),
        ),
  )
}
