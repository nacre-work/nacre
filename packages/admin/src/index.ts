import {
  client,
  explain,
  readBase,
  readToken,
  requestPasswordReset,
  signInMethods,
  signInSecondFactor,
  signInWithPassword,
  signInWithToken,
  signOut,
  whenSessionEnds,
  signInWithKey,
  type SecondFactorPending,
} from './api.js'
import * as webauthn from './webauthn.js'
import { clear, h } from './dom.js'
import { accountsView } from './views/accounts.js'
import { connectionsView } from './views/connections.js'
import { consentView } from './views/consent.js'
import { grantsView } from './views/grants.js'
import { layersView } from './views/layers.js'
import { peopleView } from './views/people.js'
import { resetView } from './views/reset.js'
import { searchView } from './views/search.js'
import { securityView } from './views/security.js'

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

/**
 * `adminOnly` is what a `member` may not reach.
 *
 * Not a second permission model — the API decides, and every one of these
 * screens is behind `org_admin` there. This is the UI declining to *offer* what
 * it knows will be refused, which is a different job: the refusal is a `404` by
 * invariant 4, and a `404` under a button reads as a broken application rather
 * than as a permission the person does not hold. That is exactly what happened
 * — a member saw "New user", pressed it, and got nothing with no explanation.
 *
 * Search and Layers stay for everybody: both answer with whatever the caller
 * has been granted, which for a member with no grants is an empty list and an
 * honest one.
 */
const ROUTES = [
  { hash: '#/search', label: 'Search', render: (root: HTMLElement) => searchView(root), adminOnly: false },
  { hash: '#/layers', label: 'Layers', render: (root: HTMLElement) => void layersView(root), adminOnly: false },
  { hash: '#/grants', label: 'Grants', render: (root: HTMLElement) => void grantsView(root), adminOnly: true },
  { hash: '#/people', label: 'People', render: (root: HTMLElement) => void peopleView(root), adminOnly: true },
  {
    hash: '#/accounts',
    label: 'Service accounts',
    render: (root: HTMLElement) => void accountsView(root),
    adminOnly: true,
  },
  // Not adminOnly. Approving a connection is not an administrative act — it is
  // the same permission as issuing the grant that makes the agent worth
  // anything — so ending one must not be either. The listing shows a member
  // their own and an administrator the organization's; the API decides that,
  // not this table.
  // Not adminOnly, and it cannot be: everybody who signs in has one of these,
  // and an administrator has no more business in this screen than anybody else
  // — the API answers only for the caller.
  { hash: '#/security', label: 'Security', render: (root: HTMLElement) => void securityView(root), adminOnly: false },
  {
    hash: '#/connections',
    label: 'Connections',
    render: (root: HTMLElement) => void connectionsView(root),
    adminOnly: false,
  },
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

function route(main: HTMLElement, nav: HTMLElement, isAdmin: boolean): void {
  // Not a section and deliberately not in the nav: an application sends a
  // browser here, and it carries the request in the fragment. Available to
  // everybody who can sign in, because choosing an agent is not an
  // administrative act — it is the same permission as issuing the grant that
  // makes the agent worth anything.
  /*
   * Setting a password from a recovery link.
   *
   * Before the sign-in check and outside the nav, like the consent screen and
   * for the same reason: whoever arrives here has no session — that is the
   * whole point of the link — and a router that asked them to sign in first
   * would be asking for the thing they came to replace.
   */
  if (location.hash.startsWith('#/reset')) {
    clear(nav)
    clear(main)
    resetView(main)
    return
  }

  if (location.hash.startsWith('#/consent')) {
    clear(nav)
    clear(main)
    void consentView(main)
    return
  }

  const allowed = ROUTES.filter((r) => isAdmin || !r.adminOnly)
  const hash = location.hash === '' ? allowed[0]!.hash : location.hash
  // A member who follows a bookmark to #/people lands on the first screen they
  // can use rather than on an empty one that keeps 404ing in the background.
  const current = allowed.find((r) => r.hash === hash) ?? allowed[0]!

  clear(nav)
  for (const r of allowed) {
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

  /**
     * The recovery link, if this installation can send one.
     *
     * Re-asked whenever the API field changes, because the answer belongs to the
     * deployment being signed in to and somebody pointing the console at a
     * different one is asking a different question.
     */
    const recoveryLink = h('p', { class: 'hint under-action' })
    const askWhetherRecoveryExists = (): void => {
      clear(recoveryLink)
      void signInMethods(base.value.trim().replace(/\/+$/, '')).then((methods) => {
        if (!methods.passwordReset) return
        clear(recoveryLink)
        recoveryLink.append(
          h('a', {
            href: '#',
            onclick: (event: Event) => {
              event.preventDefault()
              forgotten(email.value.trim(), base.value.trim().replace(/\/+$/, ''), say)
            },
          }, 'Forgotten your password?'),
        )
      })
    }

    /**
     * Ask for a link, and say the same thing either way.
     *
     * The message is deliberately about what *this screen* did rather than about
     * what exists: the server answers 204 for an address with no account, and a
     * console that said "sent" only sometimes would hand back the information the
     * API refuses to give.
     */
    const forgotten = (address: string, baseUrl: string, say: (text: string, bad?: boolean) => void): void => {
      if (address === '') return say('Type your email address first.', true)
      say('Asking…')
      void requestPasswordReset(baseUrl, address)
        .then(() => say(`If ${address} has an account here, a link is on its way. It works once and expires in an hour.`))
        .catch((error: unknown) => say(explain(error), true))
    }

    /**
     * The second field, once the password has been accepted.
     *
     * It replaces the form rather than appearing under it: the password is
     * already spent, and a screen still showing it invites somebody to retype and
     * resubmit, which starts a second sign-in and invalidates the challenge they
     * are holding.
     */
    const askForCode = (
      pending: SecondFactorPending,
      say: (text: string, bad?: boolean) => void,
      start: () => void,
    ): void => {
      const code = h('input', {
        class: 'input',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        placeholder: '000000',
        'aria-label': 'Code',
      }) as HTMLInputElement

      /*
       * Whether to offer a key is `pending.kinds`, which came off
       * `/v1/auth/methods` before anybody typed anything — and never off what
       * this account holds, which the server deliberately will not say to
       * somebody who has produced only a password. So the control is offered
       * where the installation can challenge with one, and pressing it on an
       * account with no key enrolled is the same refusal a wrong code is.
       *
       * `usable()` beside it because a browser outside a secure context has no
       * `navigator.credentials` at all, and a button that throws that reads as
       * a broken sign-in rather than as a deployment served over http.
       */
      const offersKey = pending.kinds.includes('webauthn') && webauthn.usable()
      const offersCode = pending.kinds.includes('totp') || !offersKey

      const withKey = async (): Promise<void> => {
        say('Waiting for the authenticator…')
        try {
          const ok = await signInWithKey({ challenge: pending.challenge, baseUrl: pending.baseUrl })
          if (!ok) return say('That key is not one this account holds.', true)
          start()
        } catch (error) {
          say(webauthn.describe(error), true)
        }
      }

      clear(forms)
      forms.append(
        h('form', { onsubmit: async (event: Event) => {
          event.preventDefault()
          say('Checking…')
          try {
            const ok = await signInSecondFactor({
              challenge: pending.challenge,
              code: code.value.trim(),
              baseUrl: pending.baseUrl,
            })
            // One refusal again: a wrong code, an expired challenge and an
            // account disabled in the last five minutes are one answer.
            if (!ok) return say('That code is not valid.', true)
            start()
          } catch (error) {
            say(explain(error), true)
          }
        } },
          h('h2', {}, 'Two-factor'),
          ...(offersCode
            ? [
                h('label', { class: 'field' }, h('span', {}, 'Code'), code),
                h('p', { class: 'hint' },
                  'From your authenticator, or one of the recovery codes you saved when you enrolled.'),
              ]
            : []),
          // The same element `say` writes into. It lives inside the form that is
          // being replaced, so leaving it out here would detach it and every
          // message after this point would go to nothing.
          message,
          ...(offersCode
            ? [h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Continue')]
            : []),
          ...(offersKey
            ? [h('button', {
                type: 'button',
                class: offersCode ? 'btn btn-block' : 'btn btn-primary btn-block',
                onclick: () => void withKey(),
              }, 'Use a security key')]
            : []),
        ),
      )
      if (offersCode) code.focus()
    }
    askWhetherRecoveryExists()
    base.addEventListener('change', askWhetherRecoveryExists)

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
        if (ok === false) return say('Those credentials are not valid.', true)
        /*
         * A correct password and a second factor still to produce.
         *
         * Compared against `false` rather than tested for truthiness, because
         * the pending case is an object: `if (!ok)` would take it for a success
         * and start a console with no token, which is a working sign-in
         * reported as a broken application.
         */
        if (ok !== true) return askForCode(ok, say, start)
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
      /*
       * Placed empty and filled in only if the server says it can send.
       *
       * Asked rather than assumed: a link that answers 404 reads as a broken
       * application, and this console has already shipped a screen offering
       * what the API refuses. It is added asynchronously because the answer
       * needs the API address that is on this very form.
       */
      recoveryLink,
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

  // Drawn as a member until the answer arrives, never the other way round: a
  // nav that shows administrative screens and then removes them is a flicker
  // that invites a click in between, and the failure mode of guessing low is a
  // menu that grows.
  let isAdmin = false
  const draw = (): void => route(main, nav, isAdmin)
  draw()
  window.onhashchange = draw

  void client()
    .me()
    .then((me) => {
      isAdmin = me.role === 'org_admin' || me.role === 'platform_admin'
      draw()
    })
    .catch(() => {
      // Left as a member. An older API with no /v1/me answers 404, and a
      // console that shows less than it could is a better failure than one
      // offering controls that cannot work.
    })
}

start()
