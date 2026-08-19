import { h } from './dom.js'

/**
 * Choose a thing the caller can already see.
 *
 * Five dialogs asked for a uuid in a free-text field — a workspace, a grant's
 * principal, a grant's scope, a group member, a provider — and four of them put
 * a picker *beside* the field rather than instead of it, on the argument that
 * the list can legitimately be empty and pasting an id has to keep working.
 *
 * The argument was half right and the shape was wrong. Nobody knows a uuid. A
 * person who has one copied it out of the picker directly above, which means
 * the picker already had the answer; a person who does not is being invited to
 * type something they cannot possibly get right, and the failure lands as the
 * `404` invariant 4 owes an unreachable object — indistinguishable, by design,
 * from a broken screen.
 *
 * So the field is what is left when there is no list, rather than what sits
 * under one. Four states, and each is a different fact:
 *
 * - **several** — a `<select>`, which is the whole of it;
 * - **exactly one** — the name, as text. Asking somebody to choose from a list
 *   of one is asking a question with a single answer, and `init` creates
 *   exactly one workspace, so this is the common case rather than the corner;
 * - **none** — a sentence saying so. There is nothing to paste either: an id
 *   of something the caller cannot see resolves to the same `404`;
 * - **the listing failed** — the free-text field, and only here. Listing users
 *   and groups is `org_admin` and issuing a grant is not, so a caller who may
 *   legitimately do the second can be refused the first. That is the one case
 *   the old field existed for, and it is now the only one it appears in.
 */

export interface Choice {
  readonly id: string
  readonly label: string
}

export interface Picker {
  /** What to put in the form. */
  readonly el: HTMLElement
  /** The chosen id, or `''` when nothing is chosen. */
  value(): string
  /** Load, or reload, the things to choose from. */
  fill(load: () => Promise<readonly Choice[]>): Promise<void>
  /** How many there were, after the last `fill`. `-1` if it could not be read. */
  count(): number
}

/**
 * @param noun what is being chosen, lower case: `workspace`, `layer`, `user`.
 *   It appears in every message, so "pick a workspace…" and "No workspace to
 *   choose" come from one string rather than from four written separately.
 */
export function picker(noun: string): Picker {
  const el = h('div', { class: 'pick' })
  // The three controls one of which is shown at a time. Built once and kept,
  // so `value()` never has to ask what state the picker is in.
  const select = h('select', { class: 'input' }) as HTMLSelectElement
  const typed = h('input', { class: 'input mono', placeholder: `${noun} id` }) as HTMLInputElement
  let fixed = ''
  let n = -1

  const show = (...children: (Node | string)[]): void => el.replaceChildren(...children)

  show(h('p', { class: 'muted' }, 'Loading…'))

  return {
    el,
    count: () => n,
    value: () => {
      if (n === 1) return fixed
      if (n < 0) return typed.value.trim()
      return select.value
    },
    fill: async (load) => {
      fixed = ''
      typed.value = ''
      show(h('p', { class: 'muted' }, 'Loading…'))

      let choices: readonly Choice[]
      try {
        choices = await load()
      } catch {
        // Deliberately not an error on the form. The form is fine; this one
        // input could not be filled in for the caller, and they may still be
        // able to complete it.
        n = -1
        show(typed, h('p', { class: 'hint' }, `Could not list ${noun}s here, so the id has to be given.`))
        return
      }

      n = choices.length
      const only = choices[0]
      if (n === 1 && only !== undefined) {
        fixed = only.id
        show(h('p', { class: 'picked' }, only.label))
        return
      }
      if (n === 0) {
        show(h('p', { class: 'hint' }, `No ${noun} to choose here.`))
        return
      }

      // No article, and that is the fix rather than the wording.
      //
      // It read `pick a ${noun}…`, which is wrong for every noun beginning with
      // a vowel — `pick a organization…`, seen by rendering the enterprise
      // console's Administrators screen, which is the first caller to pass one.
      // Computing the article from the first letter would fix that and break
      // `user`, which this picker also takes: `an user`. English articles are
      // not a function of spelling, and the label beside the control already
      // names the thing, so the placeholder does not have to.
      select.replaceChildren(h('option', { value: '' }, 'choose…'))
      for (const c of choices) select.append(h('option', { value: c.id }, c.label))
      select.value = ''
      show(select)
    },
  }
}
