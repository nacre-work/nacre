import type { Proposal } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h } from '../dom.js'

/**
 * Changes an agent proposed on the administrative MCP, waiting for you.
 * docs/mcp-admin.md, "A change is proposed, and a person applies it".
 *
 * Every write there proposes: it stores what it would do and answers with
 * that, and the change happens when the person who approved that connection
 * presses Apply. A client that renders MCP Apps shows the change panel beside
 * the conversation; one that does not — a terminal, say — leaves the proposal
 * here. This screen is the second place the same button is, and the one the
 * model cannot reach at all: the API answers these routes for a person's own
 * session and for nothing a connected application holds.
 *
 * What is drawn is the server's own sentence and facts, written from names it
 * resolved, through `textContent` — a group's name or a layer's slug is still
 * something a person typed.
 */

const minutesLeft = (iso: string): number => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 60_000))

export async function proposalsView(root: HTMLElement): Promise<void> {
  clear(root)
  const body = h('div', {})
  const message = h('p', { class: 'form-message' })

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Proposed changes'),
        h('p', { class: 'lede' },
          'What an agent on the administrative MCP asked to change, waiting for you. Nothing here has happened yet: ',
          'apply what you meant, cancel the rest. Each one expires ten minutes after it was proposed.'),
      ),
    ),
    message,
    body,
  )

  const load = async (): Promise<void> => {
    let listed: readonly Proposal[]
    try {
      listed = await client().proposals.list()
    } catch (error) {
      message.textContent = explain(error)
      return
    }
    clear(body)
    // The nav's count is read from the server, and this screen is where it
    // changes most: tell it to ask again.
    window.dispatchEvent(new Event('nacre:proposals'))
    if (listed.length === 0) {
      body.append(
        h('div', { class: 'empty' },
          h('p', {}, 'Nothing is waiting. A change an agent proposes appears here when its client shows no panel, and stays for ten minutes.')),
      )
      return
    }
    for (const proposal of listed) body.append(card(proposal, message, load))
  }

  await load()
}

function card(proposal: Proposal, message: HTMLElement, load: () => Promise<void>): HTMLElement {
  const apply = h('button', { class: 'btn btn-primary', type: 'button' }, 'Apply') as HTMLButtonElement
  const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel') as HTMLButtonElement
  const busy = (on: boolean): void => {
    apply.disabled = on
    cancel.disabled = on
  }

  apply.addEventListener('click', () => {
    void (async () => {
      busy(true)
      try {
        const outcome = await client().proposals.apply(proposal.id)
        message.textContent =
          outcome.kind === 'applied'
            ? `Applied: ${proposal.summary}`
            : outcome.kind === 'refused'
              ? `Not applied: ${outcome.reason}`
              : 'That proposal is no longer open — it was decided elsewhere, or it expired.'
        await load()
      } catch (error) {
        message.textContent = explain(error)
        busy(false)
      }
    })()
  })
  cancel.addEventListener('click', () => {
    void (async () => {
      busy(true)
      try {
        const cancelled = await client().proposals.cancel(proposal.id)
        message.textContent = cancelled ? 'Cancelled. Nothing changed.' : 'That proposal is no longer open.'
        await load()
      } catch (error) {
        message.textContent = explain(error)
        busy(false)
      }
    })()
  })

  const left = minutesLeft(proposal.expiresAt)
  return h('section', { class: 'panel' },
    h('h3', {}, proposal.summary),
    h('dl', { class: 'facts' }, ...proposal.details.flatMap((d) =>
      d.text === true ? [h('dt', { class: 'path' }, d.label), h('dd', { class: 'text' }, d.value)] : [h('dt', {}, d.label), h('dd', {}, d.value)])),
    h('p', { class: 'muted' },
      `Proposed through ${proposal.connection.application ?? 'an application'}`,
      proposal.module === null ? '' : `, by the ${proposal.module} module`,
      ` — expires in ${String(left)} minute${left === 1 ? '' : 's'}.`),
    h('div', { class: 'row' }, apply, cancel),
  )
}
