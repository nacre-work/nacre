import { consoleUrl, message, type Message } from '@nacre.work/core'

/**
 * Every message this product sends, in one file.
 *
 * ## Why they are not at their call sites any more
 *
 * They were, and each was an array of lines assembled where it was sent — so
 * the prose lived in three files and nothing knew how many messages there were.
 * That is how the fifth one was missed while the paragraph about there being
 * four was being written.
 *
 * Collecting them buys two things beyond tidiness. A person can read what this
 * installation says to somebody *without* reading the request handler around
 * it, which is the review that actually matters for a security notice. And
 * `scripts/mail-preview.mjs` can render the real messages rather than
 * reconstructing them — a preview that retypes its subject is a preview of
 * something nobody receives, which is the fixture-written-to-match-the-code
 * shape one surface along.
 *
 * ## What they have in common
 *
 * A statement of what happened, at most one action, and — where somebody taking
 * the account is a live possibility — a caution. The caution is deliberately
 * absent from the reset request: nothing has changed yet, and alarming the
 * person who did not ask is how they learn to ignore the ones that matter.
 */

/** A link that has just been minted, and how long it lasts. */
export function passwordResetMessage(
  to: string,
  consoleBase: string,
  token: string,
  ttlSeconds: number,
): Message {
  const link = consoleUrl(consoleBase, `#/reset?token=${encodeURIComponent(token)}`)
  return message(to, 'Reset your Nacre password', [
    { kind: 'say', text: 'Somebody asked to reset the password for this address.' },
    { kind: 'link', url: link, label: 'Reset your password' },
    {
      kind: 'say',
      text:
        `The link works once and expires in ${String(Math.round(ttlSeconds / 60))} minutes. ` +
        'Resetting a password does not remove a second factor: you will still be asked for ' +
        'a code afterwards.',
    },
    { kind: 'say', text: 'If it was not you, nothing has changed and you can ignore this message.' },
  ])
}

/**
 * A password that has just changed, and how.
 *
 * Two ways in, and the difference is not decoration: somebody who changed it
 * from a signed-in session has a password they knew, and somebody who used a
 * recovery link had a mailbox. The advice differs accordingly — "reset it" is
 * useless to the second, whose mail is what was reached.
 */
export function passwordChangedMessage(to: string, how: 'session' | 'recovery-link'): Message {
  return message(to, 'Your Nacre password was changed', [
    {
      kind: 'say',
      text:
        how === 'session'
          ? 'The password for this account was just changed from a signed-in session.'
          : 'The password for this address has just been changed using a recovery link.',
    },
    {
      kind: 'say',
      text:
        'Every other session was signed out. Any second factor on the account is untouched ' +
        'and is still required.',
    },
    {
      kind: 'caution',
      text:
        how === 'session'
          ? 'If this was not you, somebody knew your password — reset it from the sign-in ' +
            'screen and tell your administrator.'
          : 'If this was not you, whoever did it can read your mail — change the password ' +
            'again from a device you trust and tell your administrator.',
    },
  ])
}

/**
 * A second factor appearing on an account, or disappearing from one.
 *
 * Both are worth a message for the same reason a password change is: it is what
 * somebody taking an account over does first.
 */
export function secondFactorMessage(to: string, what: 'enrolled' | 'removed'): Message {
  return what === 'enrolled'
    ? message(to, 'A second factor was added to your Nacre account', [
        { kind: 'say', text: 'An authenticator was just added to this account.' },
        {
          kind: 'caution',
          text:
            'If it was not you, somebody is signing in as you: change your password and tell ' +
            'your administrator.',
        },
      ])
    : message(to, 'A second factor was removed from your Nacre account', [
        { kind: 'say', text: 'An authenticator was just removed from this account.' },
        {
          kind: 'caution',
          text:
            'Removing one is the first thing somebody with a stolen session does. If it was ' +
            'not you, change your password and tell your administrator.',
        },
      ])
}

/**
 * All of them, for anything that has to reason about the set rather than about
 * one — the preview, and whatever comes after it.
 *
 * A list rather than a count, because a count is the thing that goes stale.
 */
export const everyMessage = (to: string, consoleBase: string): readonly Message[] => [
  passwordResetMessage(to, consoleBase, 'e5b1c0f4-1a2b-4c3d-9e8f-7a6b5c4d3e2f.tok', 1800),
  passwordChangedMessage(to, 'session'),
  passwordChangedMessage(to, 'recovery-link'),
  secondFactorMessage(to, 'enrolled'),
  secondFactorMessage(to, 'removed'),
]
