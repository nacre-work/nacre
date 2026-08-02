import { client, explain, readBase, readToken, signIn, signOut } from './api.js'
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
 * belong here (docs/licensing.md). There is no login either, so this takes a
 * token or a service account key directly and says so rather than pretending
 * to be one.
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
          signOut()
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
 * It says what the token is and where it comes from, because there is no login
 * to guess at: `init` prints one, `/v1/service-accounts` mints the other. A
 * screen that just said "Token" would leave a first-time operator with nowhere
 * to look.
 */
function signInView(): void {
  const token = h('input', { class: 'input mono', type: 'password', placeholder: 'eyJ… or nacre_sk_…', required: true })
  const base = h('input', { class: 'input mono', value: location.origin })
  const message = h('p', { class: 'form-message' })

  document.body.replaceChildren(
    h('main', { class: 'signin' },
      h('form', { class: 'card', onsubmit: async (e: Event) => {
        e.preventDefault()
        message.className = 'form-message'
        message.textContent = 'Checking…'
        signIn(token.value.trim(), base.value.trim().replace(/\/+$/, ''))
        try {
          // A real call, not a health check. Health needs no token, so it would
          // accept a wrong one and fail on the first screen instead.
          await client().layers.list()
          start()
        } catch (error) {
          signOut()
          message.className = 'form-message error'
          message.textContent = explain(error)
        }
      } },
        h('div', { class: 'brand brand-lg' }, mark(), h('span', {}, 'Nacre'), h('span', { class: 'brand-sub' }, 'admin')),
        h('h1', {}, 'Sign in'),
        h('p', { class: 'lede' },
          'There is no login yet. Paste the token ',
          h('code', {}, 'init'),
          ' printed, or a service account key.',
        ),
        h('label', { class: 'field' }, h('span', {}, 'Token'), token),
        h('label', { class: 'field' }, h('span', {}, 'API'), base),
        h('p', { class: 'hint' },
          'Kept in sessionStorage and gone when this tab closes. It is a bearer credential with nothing behind it to invalidate, so that is the only sign-out this build can honestly offer.'),
        message,
        h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Sign in'),
      ),
    ),
  )
}

function start(): void {
  if (readToken() === null) {
    signInView()
    return
  }
  const { main, nav } = shell()
  route(main, nav)
  window.onhashchange = () => route(main, nav)
}

start()
