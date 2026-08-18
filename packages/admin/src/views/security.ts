import type { SecondFactor, SecondFactorKind } from '@nacre.work/sdk'

import { changeOwnPassword, client, explain } from '../api.js'
import { clear, h } from '../dom.js'
import * as webauthn from '../webauthn.js'

/**
 * The caller's own second factor.
 *
 * **Not an administrative screen, and there is deliberately no administrative
 * counterpart.** An administrator resets a password; a second factor is a thing
 * the person holds, and one an administrator could enrol or remove would be a
 * thing the account's administrator holds instead. So this view names nobody
 * and takes no id — everything it calls is under `/v1/me`.
 *
 * **Which kinds are offered is read and never assumed.** `kinds` comes back
 * with the listing: `totp` needs `NACRE_2FA_KEY` and `webauthn` needs only the
 * canonical URL, so an installation can offer the stronger of the two and not
 * the weaker one. A page that offers what the server refuses is the defect this
 * console already shipped once, when it drew administrative screens for a
 * platform administrator the API answers 404 to.
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
      if (changed === false) {
        message.className = 'form-message error'
        message.textContent = 'That is not your current password.'
        return
      }
      if (changed !== true) {
        /*
         * A gate answered, and **the password is already changed** — the server
         * commits the statement before it mints the session. So this is not a
         * failure: it is a person with a new password and no session, and
         * saying otherwise would leave them typing the old one.
         *
         * The session is gone with it, so the honest next screen is the sign-in
         * one, which is where the enrolment step lives. Reloading is what puts
         * it up: this view is inside a console the router will not draw
         * without a token.
         */
        message.className = 'form-message'
        message.textContent = `${changed.reason} Your password was changed — sign in with the new one and add a factor.`
        globalThis.setTimeout(() => globalThis.location.reload(), 4000)
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

interface Factors {
  readonly items: readonly SecondFactor[]
  readonly recoveryCodesLeft: number
  readonly kinds: readonly SecondFactorKind[]
}

async function renderFactors(panel: HTMLElement, root: HTMLElement): Promise<void> {
  let state: Factors
  try {
    state = await client().secondFactor.list()
  } catch (error) {
    clear(panel)
    // 404 here is the installation, not the caller: it offers neither kind, so
    // there is nothing to offer and saying why is better than an empty panel.
    panel.append(
      h('h2', {}, 'Second factor'),
      h('div', { class: 'empty' },
        h('h2', {}, 'Not available on this installation'),
        h('p', {},
          'An authenticator app needs a key to seal its secret with, and a security key needs a canonical URL to register against. This installation has neither.'),
        h('p', { class: 'muted' }, explain(error)),
      ),
    )
    return
  }

  clear(panel)
  panel.append(
    h('h2', {}, 'Second factor'),
    h('p', { class: 'muted' }, describeKinds(state.kinds)),
    state.items.length === 0 ? none(state, root) : enrolled(state, root),
    ...insecure(state.kinds),
  )
}

/** What this installation can enrol, in the words a person reads. */
function describeKinds(kinds: readonly SecondFactorKind[]): string {
  const both = kinds.includes('totp') && kinds.includes('webauthn')
  if (both) {
    return 'A security key, or a code that changes every thirty seconds. Either decides whether a session starts and neither grants anything.'
  }
  if (kinds.includes('webauthn')) {
    return 'A security key or the authenticator built into this device. It decides whether a session starts and grants nothing.'
  }
  return 'A code that changes every thirty seconds, from an authenticator app. It decides whether a session starts and grants nothing.'
}

/*
 * The one thing the server cannot know and this page can.
 *
 * `PublicKeyCredential` does not exist outside a secure context, and this
 * console is served over plain HTTP on a private network more often than not —
 * so an installation that offers WebAuthn perfectly correctly still has a
 * browser that cannot run the ceremony. Said here rather than left to a
 * `navigator.credentials is undefined` from a pressed button, which reads as a
 * broken application instead of a deployment fact.
 */
const insecure = (kinds: readonly SecondFactorKind[]): readonly HTMLElement[] =>
  kinds.includes('webauthn') && !webauthn.usable()
    ? [h('p', { class: 'note' },
        h('strong', {}, 'A security key needs HTTPS. '),
        'This page is not a secure context, so the browser will not run the ceremony. Reach this console over https, or over http://localhost.')]
    : []

const none = (state: Factors, root: HTMLElement): HTMLElement =>
  h('div', { class: 'empty' },
    h('h2', {}, 'No second factor'),
    h('p', {}, 'Your password alone opens this account.'),
    h('div', { class: 'row' }, ...addButtons(state, root, 'btn btn-primary')),
  )

/**
 * One button per kind this installation offers, in the order they are worth
 * having: a security key is the one whose signature covers the origin, so a
 * page pretending to be this one cannot use what it collects.
 */
function addButtons(state: Factors, root: HTMLElement, cls: string): readonly HTMLElement[] {
  const buttons: HTMLElement[] = []
  if (state.kinds.includes('webauthn')) {
    buttons.push(h('button', {
      class: cls,
      // Disabled rather than absent where the browser cannot run a ceremony:
      // the installation does offer this, and hiding it would say otherwise.
      // The note under the panel is what says why.
      ...(webauthn.usable() ? {} : { disabled: 'disabled' }),
      onclick: () => void enrolKey(root),
    }, 'Add a security key'))
  }
  if (state.kinds.includes('totp')) {
    buttons.push(h('button', {
      class: buttons.length === 0 ? cls : 'btn',
      onclick: () => void enrol(root),
    }, 'Add an authenticator app'))
  }
  return buttons
}

function enrolled(state: Factors, root: HTMLElement): HTMLElement {
  return h('div', {},
    h('table', { class: 'table' },
      h('thead', {}, h('tr', {},
        h('th', {}, 'Authenticator'),
        h('th', {}, 'Kind'),
        h('th', {}, 'Added'),
        h('th', {}, 'Last used'),
        h('th', { class: 'right' }, ''),
      )),
      h('tbody', {}, ...state.items.map((f) =>
        h('tr', {},
          h('td', {}, f.label),
          // Read off the row rather than assumed. Two kinds need telling apart
          // here, because only one of them can be removed without a code.
          h('td', { class: 'muted nowrap' }, f.kind === 'webauthn' ? 'Security key' : 'Authenticator app'),
          h('td', { class: 'muted' }, new Date(f.createdAt).toLocaleDateString()),
          h('td', { class: 'muted' }, f.lastUsedAt === null ? 'never' : new Date(f.lastUsedAt).toLocaleDateString()),
          h('td', { class: 'right' },
            h('button', { class: 'btn btn-quiet btn-danger', onclick: () => remove(f, state, root) }, 'Remove'),
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
      // Not "when the phone is not": on an installation offering only security
      // keys there is no phone in the story, and a sentence naming one reads as
      // being about somebody else's account.
      'They were shown once, when you enrolled. Each works instead of a second factor and is spent when it is used; they are the way back in when the authenticator is gone.',
    ),
    h('div', { class: 'row' }, ...addButtons(state, root, 'btn')),
  )
}

/**
 * Enrolling a security key, which is one dialog rather than two steps.
 *
 * The authenticator's own prompt is the second step, and it belongs to the
 * browser. There is nothing to confirm afterwards either: producing the
 * attestation *is* the proof the credential arrived, which is the difference
 * from a shared secret handed over and only later shown to have landed.
 */
async function enrolKey(root: HTMLElement): Promise<void> {
  const message = h('p', { class: 'form-message' })
  const label = h('input', { class: 'input', value: 'Security key', 'aria-label': 'Name' }) as HTMLInputElement

  const dialog = h('dialog', { class: 'dialog' },
    h('div', {},
      h('h2', {}, 'Add a security key'),
      h('label', { class: 'field' }, h('span', {}, 'Name'), label),
      h('p', { class: 'hint' }, 'Two keys need telling apart later.'),
      h('p', {}, 'Your browser will ask for the key, or for the authenticator built into this device. Nothing about it is stored here except a public key — there is no secret on this side to leak.'),
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
            message.textContent = 'Waiting for the authenticator…'
            try {
              const options = await client().secondFactor.beginWebAuthn()
              const made = await webauthn.create(options)
              const confirmed = await client().secondFactor.finishWebAuthn({
                ...made,
                label: label.value.trim(),
              })
              dialog.close()
              // `tokens` is for the enrolment-challenge door and is always
              // absent here: this screen is reached with a session, so there is
              // nothing to adopt.
              if (confirmed.recoveryCodes.length > 0) showRecoveryCodes(confirmed.recoveryCodes, root)
              else void securityView(root)
            } catch (error) {
              button.disabled = false
              message.className = 'form-message error'
              // A cancelled prompt and a timeout are one `NotAllowedError`, and
              // both are things a person does routinely rather than faults.
              message.textContent = webauthn.describe(error)
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
            const confirmed = await client().secondFactor.confirm(begun.id, code.value.trim())
            dialog.close()
            if (confirmed.recoveryCodes.length > 0) showRecoveryCodes(confirmed.recoveryCodes, root)
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

/**
 * Removing one takes a current proof — see the endpoint's own note on why.
 *
 * **Which proof is decided by what this account can produce, not by what is
 * being removed.** A code is accepted for any factor, so it is offered
 * wherever there is one to type; a key is offered where the account holds one.
 * Deciding by `factor.kind` instead would ask for a key to remove a key on an
 * account whose key is the thing that is lost, which is exactly the case
 * somebody reaches this dialog in.
 *
 * With no TOTP anywhere on the installation there is no code to ask for at
 * all, which is why the assertion path exists: without it a security key could
 * be enrolled and never taken off.
 */
function remove(factor: SecondFactor, state: Factors, root: HTMLElement): void {
  const message = h('p', { class: 'form-message' })
  const byCode = state.kinds.includes('totp')
  const byKey = state.items.some((f) => f.kind === 'webauthn') && webauthn.usable()

  const code = h('input', {
    class: 'input',
    inputmode: 'numeric',
    autocomplete: 'one-time-code',
    placeholder: '000000',
    'aria-label': 'Code',
  }) as HTMLInputElement

  const done = (): void => {
    dialog.close()
    void securityView(root)
  }
  const failed = (error: unknown, describe: (e: unknown) => string): void => {
    message.className = 'form-message error'
    message.textContent = describe(error)
  }

  const dialog = h('dialog', { class: 'dialog' },
    h('div', {},
      h('h2', {}, `Remove ${factor.label}?`),
      h('p', {}, 'Removing a second factor is the first thing somebody with a stolen session would do, which is why this asks for a current one.'),
      ...(byCode
        ? [
            h('p', {}, 'Type a current code from an authenticator app, or one of your recovery codes.'),
            h('label', { class: 'field' }, h('span', {}, 'Code'), code),
          ]
        : []),
      ...(byKey && byCode ? [h('p', { class: 'hint' }, 'Or prove it with a security key instead.')] : []),
      ...(byKey && !byCode ? [h('p', {}, 'Your browser will ask for a security key you have already enrolled.')] : []),
      message,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => dialog.close() }, 'Cancel'),
        ...(byKey
          ? [h('button', {
              type: 'button',
              class: byCode ? 'btn btn-danger btn-quiet' : 'btn btn-danger',
              onclick: async () => {
                message.className = 'form-message'
                message.textContent = 'Waiting for the authenticator…'
                try {
                  const options = await client().secondFactor.beginWebAuthnProof()
                  await client().secondFactor.remove(factor.id, await webauthn.get(options))
                  done()
                } catch (error) {
                  failed(error, webauthn.describe)
                }
              },
            }, byCode ? 'Use a security key' : 'Remove')]
          : []),
        ...(byCode
          ? [h('button', {
              type: 'button',
              class: 'btn btn-danger',
              onclick: async () => {
                message.className = 'form-message'
                message.textContent = 'Removing…'
                try {
                  await client().secondFactor.remove(factor.id, code.value.trim())
                  done()
                } catch (error) {
                  failed(error, explain)
                }
              },
            }, 'Remove')]
          : []),
      ),
    ),
  ) as HTMLDialogElement

  document.body.append(dialog)
  dialog.showModal()
  dialog.addEventListener('close', () => dialog.remove())
}
