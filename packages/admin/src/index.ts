import {
  client,
  explain,
  readBase,
  readToken,
  signInWithPassword,
  signInWithToken,
  signOut,
  whenSessionEnds,
} from './api.js'
import { clear, h } from './dom.js'
import { accountsView } from './views/accounts.js'
import { grantsView } from './views/grants.js'
import { layersView } from './views/layers.js'
import { searchView } from './views/search.js'

/**
 * The community admin UI.
 *
 * One organization, which is the whole of the open core's model — the global
 * admin, quotas, and cross-organization anything are commercial and do not
 * belong here (docs/licensing.md).
 *
 * Sign in with the address and password `init` printed, or paste a token. The
 * first is what a person has and it renews itself; the second is what `init`
 * and a service account key are, and it lasts exactly as long as the credential
 * does.
 *
 * Routed on the hash so it can be served as static files from any path without
 * the server needing a rewrite rule, which is what makes it a directory nginx
 * hands out rather than an application to deploy.
 */

const ROUTES = [
  { hash: '#/search', label: 'Search', render: (root: HTMLElement) => searchView(root) },
  { hash: '#/layers', label: 'Layers', render: (root: HTMLElement) => void layersView(root) },
  { hash: '#/grants', label: 'Grants', render: (root: HTMLElement) => void grantsView(root) },
  { hash: '#/accounts', label: 'Service accounts', render: (root: HTMLElement) => void accountsView(root) },
]

function mark(): SVGElement {
  // The six strata, in order, as the mark draws them. Not reordered and not
  // recoloured — the progression mirrors how the layer grows, and it is the one
  // thing in the brand that is not a stylistic call.
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 32 32')
  svg.setAttribute('class', 'mark')
  svg.setAttribute('aria-hidden', 'true')

  const defs = document.createElementNS(ns, 'defs')
  const g = document.createElementNS(ns, 'g')
  g.setAttribute('fill', 'none')
  g.setAttribute('stroke-width', '3.4')
  g.setAttribute('stroke-linecap', 'round')
  g.setAttribute('stroke-linejoin', 'round')

  for (let i = 0; i < 6; i++) {
    const clip = document.createElementNS(ns, 'clipPath')
    clip.setAttribute('id', `adm-s${i}`)
    const rect = document.createElementNS(ns, 'rect')
    rect.setAttribute('x', '0')
    rect.setAttribute('y', String(4 + i * 4.115))
    rect.setAttribute('width', '32')
    rect.setAttribute('height', '3.42')
    clip.append(rect)
    defs.append(clip)

    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', 'M5.7 26.3 V5.7 L26.3 26.3 V5.7')
    path.setAttribute('stroke', `var(--n-s${i + 1})`)
    path.setAttribute('clip-path', `url(#adm-s${i})`)
    g.append(path)
  }

  svg.append(defs, g)
  return svg
}

function shell(): { main: HTMLElement; nav: HTMLElement } {
  const main = h('main', { class: 'main', id: 'main' })
  const nav = h('nav', { class: 'nav', 'aria-label': 'Sections' })

  const status = h('span', { class: 'status', title: 'Liveness only; it touches no dependency' }, 'checking…')
  void client()
    .health()
    .then((ok) => {
      status.className = `status ${ok ? 'up' : 'down'}`
      status.textContent = ok ? 'API reachable' : 'API unreachable'
    })

  document.body.replaceChildren(
    h('a', { class: 'skip', href: '#main' }, 'Skip to content'),
    h('header', { class: 'masthead' },
      h('div', { class: 'brand' }, mark(), h('span', {}, 'Nacre'), h('span', { class: 'brand-sub' }, 'admin')),
      nav,
      h('div', { class: 'masthead-right' },
        status,
        h('code', { class: 'base', title: 'Where this UI is sending requests' }, readBase().replace(/^https?:\/\//, '')),
        h('button', { class: 'btn btn-quiet', onclick: () => {
          // The screen changes first. Revoking the refresh token is a request
          // that can fail, and someone who clicked "sign out" should not be
          // left looking at an administration console while it retries.
          void signOut()
          start()
        } }, 'Sign out'),
      ),
    ),
    main,
  )

  return { main, nav }
}

function route(main: HTMLElement, nav: HTMLElement): void {
  const hash = location.hash === '' ? ROUTES[0]!.hash : location.hash
  const current = ROUTES.find((r) => r.hash === hash) ?? ROUTES[0]!

  clear(nav)
  for (const r of ROUTES) {
    nav.append(
      h('a', {
        href: r.hash,
        class: r === current ? 'active' : '',
        ...(r === current ? { 'aria-current': 'page' } : {}),
      }, r.label),
    )
  }

  clear(main)
  current.render(main)
}

/**
 * The sign-in screen.
 *
 * Two tabs, and the order is the recommendation. A password gets a session that
 * renews itself; a pasted token expires when it expires — an hour for the one
 * `init` prints, and never for a service account key, which is why both are
 * still here.
 *
 * The token tab says where each kind comes from, because a field labelled just
 * "Token" leaves a first-time operator with nowhere to look.
 */
function signInView(): void {
  const message = h('p', { class: 'form-message' })
  const forms = h('div', {})

  const say = (text: string, bad = false): void => {
    message.className = bad ? 'form-message error' : 'form-message'
    message.textContent = text
  }

  const passwordForm = (): HTMLElement => {
    const email = h('input', { class: 'input', type: 'email', autocomplete: 'username', required: true })
    const password = h('input', {
      class: 'input',
      type: 'password',
      autocomplete: 'current-password',
      required: true,
    })
    const organization = h('input', { class: 'input', placeholder: 'only if you have accounts in several' })
    const base = h('input', { class: 'input mono', value: readBase() })

    return h('form', { onsubmit: async (e: Event) => {
      e.preventDefault()
      say('Signing in…')
      try {
        const ok = await signInWithPassword({
          email: email.value.trim(),
          password: password.value,
          organization: organization.value.trim(),
          baseUrl: base.value.trim().replace(/\/+$/, ''),
        })
        // One refusal with one message, deliberately. The server does not say
        // which of five things was wrong and neither does this.
        if (!ok) return say('Those credentials are not valid.', true)
        start()
      } catch (error) {
        say(explain(error), true)
      }
    } },
      h('label', { class: 'field' }, h('span', {}, 'Email'), email),
      h('label', { class: 'field' }, h('span', {}, 'Password'), password),
      h('label', { class: 'field' }, h('span', {}, 'Organization'), organization),
      h('label', { class: 'field' }, h('span', {}, 'API'), base),
      h('p', { class: 'hint' },
        'The address and password ',
        h('code', {}, 'init'),
        ' printed. The session renews itself and ends when you sign out or close the tab.'),
      message,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in'),
    )
  }

  const tokenForm = (): HTMLElement => {
    const token = h('input', {
      class: 'input mono',
      type: 'password',
      placeholder: 'eyJ… or nacre_sk_…',
      required: true,
    })
    const base = h('input', { class: 'input mono', value: readBase() })

    return h('form', { onsubmit: async (e: Event) => {
      e.preventDefault()
      say('Checking…')
      signInWithToken(token.value.trim(), base.value.trim().replace(/\/+$/, ''))
      try {
        // A real call, not a health check. Health needs no token, so it would
        // accept a wrong one and fail on the first screen instead.
        await client().layers.list()
        start()
      } catch (error) {
        void signOut()
        say(explain(error), true)
      }
    } },
      h('label', { class: 'field' }, h('span', {}, 'Token'), token),
      h('label', { class: 'field' }, h('span', {}, 'API'), base),
      h('p', { class: 'hint' },
        'The token ',
        h('code', {}, 'init'),
        ' printed, which lasts an hour, or a service account key, which lasts until it is revoked. ',
        'Neither can be renewed, so this session ends when the credential does.'),
      message,
      h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in'),
    )
  }

  const TABS = [
    { label: 'Password', build: passwordForm },
    { label: 'Token', build: tokenForm },
  ]
  const tabs = h('div', { class: 'tabs', role: 'tablist' })

  const show = (index: number): void => {
    clear(tabs)
    for (const [i, tab] of TABS.entries()) {
      tabs.append(
        h('button', {
          type: 'button',
          role: 'tab',
          class: i === index ? 'tab active' : 'tab',
          'aria-selected': i === index ? 'true' : 'false',
          onclick: () => show(i),
        }, tab.label),
      )
    }
    say('')
    clear(forms)
    forms.append(TABS[index]!.build())
  }

  document.body.replaceChildren(
    h('main', { class: 'signin' },
      h('div', { class: 'card' },
        h('div', { class: 'brand brand-lg' }, mark(), h('span', {}, 'Nacre'), h('span', { class: 'brand-sub' }, 'admin')),
        h('h1', {}, 'Sign in'),
        tabs,
        forms,
      ),
    ),
  )
  show(0)
}

function start(): void {
  // Re-registered on every start so a session that ends mid-use puts the
  // sign-in screen back rather than leaving a console nothing can load into.
  whenSessionEnds(() => start())

  if (readToken() === null) {
    signInView()
    return
  }
  const { main, nav } = shell()
  route(main, nav)
  window.onhashchange = () => route(main, nav)
}

start()
