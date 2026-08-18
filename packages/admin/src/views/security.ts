import type { SecondFactor } from '@nacre.work/sdk'

import { changeOwnPassword, client, explain } from '../api.js'
import { clear, h } from '../dom.js'

/**
 * The caller's own second factor.
 *
 * **Not an administrative screen, and there is deliberately no administrative
 * counterpart.** An administrator resets a password; a second factor is a thing
 * the person holds, and one an administrator could enrol or remove would be a
 * thing the account's administrator holds instead. So this view names nobody
 * and takes no id — everything it calls is under `/v1/me`.
 *
 * The whole section is absent where the installation configured no
 * `NACRE_2FA_KEY_REF`: the API answers 404 and this says so plainly rather than
 * offering a control that cannot work. A page that offers what the server
 * refuses is the defect this console already shipped once, when it drew
 * administrative screens for a platform administrator the API answers 404 to.
 */
export async function securityView(root: HTMLElement): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Security'),
        h('p', { class: 'lede' },
          'How this account is signed into. Neither of these grants anything — what you may reach is computed from your grants on every request.'),
      ),
    ),
  )

  /*
   * Two panels, and the password one is rendered first and independently.
   *
   * The whole view used to return early when the second factor was unavailable,
   * so on an installation with no key the *password* control would have been
   * hidden by a message about TOTP — a screen refusing something that works,
   * which is the mirror of the defect the message beside it exists against.
   */
  const passwords = h('section', { class: 'panel' })
  const factors = h('section', { class: 'panel' }, h('p', { class: 'muted' }, 'Loading…'))
  root.append(passwords, factors)

  await Promise.all([renderPassword(passwords), renderFactors(factors, root)])
}

/**
 * Changing your own password.
 *
 * Offered only to a person. A service account signs in with a key, has no
 * password at all, and is rotated by minting another — so the API answers 404,
 * and a form that produced one would be a control that cannot work.
 */
async function renderPassword(panel: HTMLElement): Promise<void> {
  clear(panel)

  let isPerson = false
  try {
    isPerson = (await client().me()).principalType === 'user'
  } catch {
    // An older API with no /v1/me. Showing less than it could is a better
    // failure than offering a form that answers 404.
  }
  if (!isPerson) return

  const current = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' }) as HTMLInputElement
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' }) as HTMLInputElement
  const again = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Repeat the new password' }) as HTMLInputElement
  const message = h('p', { class: 'form-message' })

  const submit = async (event: Event): Promise<void> => {
    const button = event.currentTarget as HTMLButtonElement
    message.className = 'form-message'

    // Compared here because only this screen has both fields. The server never
    // sees the second one — a typo is not something to spend a request on, and
    // the answer would be identical either way.
    if (next.value !== again.value) {
      message.className = 'form-message error'
      message.textContent = 'The two new passwords are not the same.'
      return
    }

    button.disabled = true
    message.textContent = 'Changing…'
    try {
      const changed = await changeOwnPassword(current.value, next.value)
      if (!changed) {
        message.className = 'form-message error'
        message.textContent = 'That is not your current password.'
        return
      }
      current.value = ''
      next.value = ''
      again.value = ''
      message.className = 'form-message'
      message.textContent =
        'Changed. Every other session was signed out; this one carried on with a new token. Any second factor is untouched.'
    } catch (error) {
      message.className = 'form-message error'
      message.textContent = explain(error)
    } finally {
      button.disabled = false
    }
  }

  panel.append(
    h('h2', {}, 'Password'),
    h('p', { class: 'muted' },
      'Changing it signs out every other session, which is the point: the reason to change a password is usually that somebody else knows it. This browser stays signed in.'),
    h('label', { class: 'field' }, h('span', {}, 'Current password'), current),
    h('label', { class: 'field' }, h('span', {}, 'New password'), next),
    h('p', { class: 'hint' }, 'At least 12 characters. Length is the whole rule — no requirement about digits or symbols.'),
    h('label', { class: 'field' }, h('span', {}, 'Repeat the new password'), again),
    message,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', onclick: (event: Event) => void submit(event) }, 'Change password'),
    ),
  )
}

async function renderFactors(panel: HTMLElement, root: HTMLElement): Promise<void> {
  let state: { items: readonly SecondFactor[]; recoveryCodesLeft: number }
  try {
    state = await client().secondFactor.list()
  } catch (error) {
    clear(panel)
    // 404 here is the installation, not the caller: no key configured, so there
    // is nothing to offer and saying why is better than an empty panel.
    panel.append(
      h('h2', {}, 'Second factor'),
      h('div', { class: 'empty' },
        h('h2', {}, 'Not available on this installation'),
        h('p', {},
          'A second factor needs a key to seal its secret with. Until an operator sets NACRE_2FA_KEY or NACRE_2FA_KEY_REF there is nowhere to keep one, and nothing here stores a secret in the clear in the meantime.'),
        h('p', { class: 'muted' }, explain(error)),
      ),
    )
    return
  }

  clear(panel)
  panel.append(
    h('h2', {}, 'Second factor'),
    h('p', { class: 'muted' },
      'A code that changes every thirty seconds, from an authenticator app. It decides whether a session starts and grants nothing.'),
    state.items.length === 0 ? none(root) : enrolled(state, root),
  )
}

const none = (root: HTMLElement): HTMLElement =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No second factor'),
    h('p', {}, 'Your password alone opens this account. An authenticator app adds a code that changes every thirty seconds.'),
    h('button', { class: 'btn btn-primary', onclick: () => void enrol(root) }, 'Add an authenticator'),
  )

function enrolled(
  state: { items: readonly SecondFactor[]; recoveryCodesLeft: number },
  root: HTMLElement,
): HTMLElement {
  return h('div', {},
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Authenticator'),
        h('th', {}, 'Added'),
        h('th', {}, 'Last used'),
        h('th', { class: 'right' }, ''),
      )),
      h('tbody', {}, ...state.items.map((f) =>
        h('tr', {},
          h('td', {}, f.label),
          h('td', { class: 'muted' }, new Date(f.createdAt).toLocaleDateString()),
          h('td', { class: 'muted' }, f.lastUsedAt === null ? 'never' : new Date(f.lastUsedAt).toLocaleDateString()),
          h('td', { class: 'right' },
            h('button', { class: 'btn btn-quiet btn-danger', onclick: () => remove(f, root) }, 'Remove'),
          ),
        ),
      )),
    ),
    /*
     * The count and not the codes. They were printed once at enrolment, and a
     * screen that could show them again would make them a thing anybody with
     * this session can read — which is the opposite of what they are for.
     */
    h('p', { class: 'note' },
      h('strong', {}, `${String(state.recoveryCodesLeft)} recovery code(s) left.`),
      ' ',
      'They were shown once, when you enrolled. Each works instead of a code and is spent when it is used; they are the way back in when the phone is not.',
    ),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => void enrol(root) }, 'Add another'),
    ),
  )
}

/**
 * Enrolment, in two steps, because the second is what proves the first arrived.
 *
 * The secret is shown as text beside the URL rather than only as a QR code:
 * this console is served over plain HTTP on a private network more often than
 * not, and a person with a desktop authenticator has nothing to scan with.
 */
async function enrol(root: HTMLElement): Promise<void> {
  const message = h('p', { class: 'form-message' })
  const label = h('input', { class: 'input', value: 'Authenticator', 'aria-label': 'Name' }) as HTMLInputElement
  const step = h('div', {})

  const dialog = h('dialog', { class: 'dialog' },
    h('div', {},
      h('h2', {}, 'Add an authenticator'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), label),
      h('p', { class: 'hint' }, 'Two phones need telling apart later.'),
      step,
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          onclick: async (event: Event) => {
            const button = event.currentTarget as HTMLButtonElement
            button.disabled = true
            message.className = 'form-message'
            message.textContent = 'Preparing…'
            try {
              const begun = await client().secondFactor.begin({ label: label.value.trim() })
              message.textContent = ''
              label.disabled = true
              button.remove()
              clear(step)
              step.append(second(begun, dialog, root, message))
            } catch (error) {
              button.disabled = false
              message.className = 'form-message error'
              message.textContent = explain(error)
            }
          },
        }, 'Continue'),
      ),
    ),
  ) as HTMLDialogElement

  document.body.append(dialog)
  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}

function second(
  begun: { id: string; secret: string; otpauthUrl: string },
  dialog: HTMLDialogElement,
  root: HTMLElement,
  message: HTMLElement,
): HTMLElement {
  const code = h('input', {
    class: 'input',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
    'aria-label': 'Code',
  }) as HTMLInputElement

  return h('div', {},
    h('p', {}, 'Add this secret to your authenticator, then type the code it shows.'),
    h('pre', { class: 'secret' }, begun.secret),
    h('p', { class: 'hint' }, 'Or open the setup link on the device that holds the authenticator: '),
    h('code', { class: 'id', title: begun.otpauthUrl }, begun.otpauthUrl.slice(0, 48) + '…'),
    h('label', { class: 'field' }, h('span', {}, 'Code'), code),
    h('div', { class: 'dialog-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: async () => {
          message.className = 'form-message'
          message.textContent = 'Checking…'
          try {
            const codes = await client().secondFactor.confirm(begun.id, code.value.trim())
            dialog.close()
            if (codes.length > 0) showRecoveryCodes(codes, root)
            else void securityView(root)
          } catch (error) {
            message.className = 'form-message error'
            message.textContent = explain(error)
          }
        },
      }, 'Confirm'),
    ),
  )
}

/**
 * The recovery codes, once.
 *
 * No "remind me later": this dialog is the only time they exist outside a hash,
 * so it closes on an acknowledgement rather than on a click anywhere.
 */
function showRecoveryCodes(codes: readonly string[], root: HTMLElement): void {
  const dialog = h('dialog', { class: 'dialog' },
    h('div', {},
      h('h2', {}, 'Save these recovery codes'),
      h('p', {}, 'Each one works instead of a code from your authenticator, once. They are shown now and never again — this installation keeps only their hashes.'),
      h('pre', { class: 'secret' }, codes.join('\n')),
      h('p', { class: 'hint' }, 'If you lose the phone and these, an administrator cannot get you back in: they can reset a password and deliberately cannot touch a second factor.'),
      h('div', { class: 'dialog-actions' },
        h('button', {
          type: 'button',
          class: 'btn btn-primary',
          onclick: () => {
            dialog.close()
            void securityView(root)
          },
        }, 'I have saved them'),
      ),
    ),
  ) as HTMLDialogElement

  document.body.append(dialog)
  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}

/** Removing one takes a current code — see the endpoint's own note on why. */
function remove(factor: SecondFactor, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })
  const code = h('input', {
    class: 'input',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
    'aria-label': 'Code',
  }) as HTMLInputElement

  const dialog = h('dialog', { class: 'dialog' },
    h('div', {},
      h('h2', {}, `Remove ${factor.label}?`),
      h('p', {}, 'Type a current code from it, or one of your recovery codes. Removing a second factor is the first thing somebody with a stolen session would do, which is why this asks.'),
      h('label', { class: 'field' }, h('span', {}, 'Code'), code),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn btn-danger',
          onclick: async () => {
            message.className = 'form-message'
            message.textContent = 'Removing…'
            try {
              await client().secondFactor.remove(factor.id, code.value.trim())
              dialog.close()
              void securityView(root)
            } catch (error) {
              message.className = 'form-message error'
              message.textContent = explain(error)
            }
          },
        }, 'Remove'),
      ),
    ),
  ) as HTMLDialogElement

  document.body.append(dialog)
  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}
