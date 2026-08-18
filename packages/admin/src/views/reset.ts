import { confirmPasswordReset, readBase } from '../api.js'
import { clear, h } from '../dom.js'

/**
 * Setting a password from a recovery link.
 *
 * Reached with no session, which is the whole point of the link, so this view
 * is outside the nav and outside the sign-in check — the same arrangement the
 * consent screen has.
 *
 * The token is read from the fragment rather than the query, because a
 * fragment is not sent to the server in a `Referer` and does not reach a proxy
 * log. It is a single-use credential either way, and the difference costs
 * nothing.
 */
export function resetView(root: HTMLElement): void {
  clear(root)

  const token = new URLSearchParams(location.hash.split('?')[1] ?? '').get('token') ?? ''
  const message = h('p', { class: 'form-message' })
  const say = (text: string, bad = false): void => {
    message.className = bad ? 'form-message error' : 'form-message'
    message.textContent = text
  }

  if (token === '') {
    root.append(
      h('div', { class: 'signin' },
        h('h1', {}, 'Set a password'),
        h('div', { class: 'error' },
          'This link carries no token. Copy the whole address out of the message — some mail clients cut one that wraps.'),
      ),
    )
    return
  }

  const password = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  }) as HTMLInputElement
  const again = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'new-password',
    required: true,
  }) as HTMLInputElement

  root.append(
    h('div', { class: 'signin' },
      h('h1', {}, 'Set a password'),
      h('form', { onsubmit: async (event: Event) => {
        event.preventDefault()
        /*
         * The two fields are compared here and nowhere else: the server never
         * sees the second one, because a mistyped password is a thing this
         * screen can catch and an endpoint cannot.
         */
        if (password.value !== again.value) return say('Those do not match.', true)
        say('Setting…')
        try {
          const ok = await confirmPasswordReset(readBase(), token, password.value)
          if (!ok) {
            // One message for a link that never existed, one already used, one
            // that expired, and an account disabled since it was sent — which
            // is the one answer the server gives.
            return say('That link is no longer valid. Ask for another from the sign-in screen.', true)
          }
          clear(root)
          root.append(
            h('div', { class: 'signin' },
              h('h1', {}, 'Password set'),
              h('p', {},
                'Every other session was signed out. Any second factor on the account is untouched and is still required.'),
              h('a', { class: 'btn btn-primary btn-block', href: '#/search', onclick: () => location.reload() },
                'Sign in'),
            ),
          )
        } catch (error) {
          // The length rule arrives as a 400 with the number in it, which is
          // worth showing verbatim: a bare refusal is a person retyping
          // something that will never be accepted.
          say(error instanceof Error ? error.message : String(error), true)
        }
      } },
        h('label', { class: 'field' }, h('span', {}, 'New password'), password),
        h('label', { class: 'field' }, h('span', {}, 'Again'), again),
        h('p', { class: 'hint' },
          'At least 12 characters. Length is the whole rule — there is no requirement about digits or symbols, because one produces a password people write down.'),
        message,
        h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Set password'),
      ),
    ),
  )
}
