import type { AuditRecord, AuditQuery } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { agoCell, clear, h, shortId } from '../dom.js'

/**
 * The access log.
 *
 * ## Why this screen exists
 *
 * `GET /v1/audit` has been readable since the journal landed and nothing in the
 * product showed it. `docs/audit.md` opens on "who read what" and calls the log
 * what an investigation starts from — and the only way to start one was `curl`
 * with an `Accept` header, or `psql`. That is the shape this repository keeps
 * closing: the model offers something and the product gives no route to it.
 *
 * It is the **core's** screen and not a commercial one on the boundary's own
 * test. Reading your own organization's access log is what a single developer
 * on a laptop needs the day something looks wrong; forwarding it to a SIEM is
 * what a security team buys, and that is the `audit` module.
 *
 * ## Two roles see two different logs, and this screen does not decide which
 *
 * `org_admin` sees its organization's log in full, including which documents
 * were read. `platform_admin` sees administrative actions and never that — rule
 * 2 applied to the journal. **The server sets that**, from the role on the
 * token; there is no parameter here that could widen it, and this screen sends
 * none. What it does instead is *say* which log is on the page, because a
 * platform administrator looking at a log with no document reads in it should
 * not have to wonder whether the organization simply has none.
 *
 * ## Nobody types an actor's id
 *
 * `actorId` is the axis an investigation actually turns on — "show me
 * everything this account did" — and the obvious control for it is a field.
 * `pick.ts` is where this console already decided that question: nobody knows a
 * uuid, and a person who has one copied it out of the list directly above,
 * which means the list already had the answer. A log is the strongest form of
 * that argument, because the list *is* the log: every actor worth filtering on
 * is one already on the screen.
 *
 * So the actor on each row is the control, and the active filter is a chip with
 * a way to clear it. The **whole** actor — the name and the id under it — rather
 * than a control beside them, for two reasons found by measuring. A second
 * control in that cell would be a 28px target six pixels from another one, and
 * two hit areas grown to what a finger needs then overlap, which is a press
 * landing on the neighbour and a defect the sibling stand shipped and had
 * reported from a phone. And making only the id pressable put a control 2px
 * under the name above it — named by the console's own headroom pass, which is
 * the check that exists for a control flush against whatever it follows.
 *
 * The wrong id therefore cannot be asked for. It also cannot be *typed*, which
 * is the one thing lost: somebody arriving with an id from elsewhere uses the
 * export, which the lede names.
 *
 * ## Reading it is recorded
 *
 * As `audit.read`, which means this screen appears in its own next page. Said
 * out loud on the screen rather than left as a surprise: somebody investigating
 * an incident needs to know their own looking is in the record they are
 * reading.
 *
 * ## No export button
 *
 * The endpoint serves JSONL and CSV by content negotiation, and a browser
 * cannot set `Accept` on a link. Fetching the whole thing into a blob to hand
 * over would put an entire organization's journal in a tab's memory to save a
 * file — and this console has already learned what `<a download>` does on iOS.
 * The lede names the header instead, which is what a person exporting a log to
 * somewhere else is going to use anyway.
 */

/** Newest first, and one page is what a screen can hold. */
const PAGE = 50

/**
 * A calendar day's edges, as instants.
 *
 * An ISO string with **no** offset is parsed as local time, which is what a
 * person picking "19 August" in a date field means — the UTC day is a different
 * eight hours in every timezone that is not UTC, and an investigation reading a
 * day boundary wrong is reading the wrong day. `toISOString` then hands the API
 * the instant, which is what it stores.
 */
const startOf = (day: string): string => new Date(`${day}T00:00:00.000`).toISOString()
const endOf = (day: string): string => new Date(`${day}T23:59:59.999`).toISOString()

export async function auditView(root: HTMLElement, isPlatformAdmin = false): Promise<void> {
  clear(root)

  const action = h('input', { class: 'input', placeholder: 'grant.issue', 'aria-label': 'Action' }) as HTMLInputElement
  const result = h('select', { class: 'input', 'aria-label': 'Result' },
    h('option', { value: '' }, 'Any result'),
    h('option', { value: 'allow' }, 'allow'),
    h('option', { value: 'deny' }, 'deny'),
    h('option', { value: 'error' }, 'error'),
  ) as HTMLSelectElement
  const from = h('input', { class: 'input', type: 'date', 'aria-label': 'From' }) as HTMLInputElement
  const to = h('input', { class: 'input', type: 'date', 'aria-label': 'To' }) as HTMLInputElement

  const scope = h('div', {})
  const body = h('div', {})

  /** Set by pressing an actor in the log, cleared by the chip beside it. */
  let actorId: string | undefined

  // Narrowed rather than cast. `exactOptionalPropertyTypes` is on here, so a
  // cast to `AuditQuery['result']` widens to include `undefined` and a spread of
  // that is a property which may be absent *or* undefined — two different things
  // to the type, and the cast hides which one the select produced. Comparing
  // against the three the endpoint accepts is also the narrowing that stops a
  // value the API would refuse ever reaching it.
  const chosen = (): 'allow' | 'deny' | 'error' | undefined =>
    result.value === 'allow' || result.value === 'deny' || result.value === 'error'
      ? result.value
      : undefined

  const query = (): AuditQuery => {
    const picked = chosen()
    return {
      ...(action.value.trim() === '' ? {} : { action: action.value.trim() }),
      ...(actorId === undefined ? {} : { actorId }),
      ...(picked === undefined ? {} : { result: picked }),
      ...(from.value === '' ? {} : { from: startOf(from.value) }),
      ...(to.value === '' ? {} : { to: endOf(to.value) }),
    }
  }

  const apply = (): void => {
    clear(scope)
    if (actorId !== undefined) {
      scope.append(
        h('div', { class: 'row' },
          h('span', { class: 'muted' }, 'Only this actor:'),
          shortId(actorId),
          h('button', { class: 'btn btn-quiet', onclick: () => { actorId = undefined; apply() } }, 'Clear'),
        ),
      )
    }
    void load(body, query(), (id) => { actorId = id; apply() })
  }

  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Access log'),
        h('p', { class: 'lede' },
          isPlatformAdmin
            ? 'Administrative actions in this organization. A platform administrator is deliberately not shown which documents were read — that is the access the permission model exists to deny, and the journal must not be the way around it.'
            : 'Every grant issued, every account created, and every document read. Newest first.'),
        h('p', { class: 'muted' },
          'Reading this is itself recorded, as audit.read — so this visit appears in the next page. ' +
          'The same endpoint serves JSONL and CSV by content negotiation, for anything larger than a screen.'),
      ),
    ),
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, h('span', {}, 'Action'), action),
      h('label', { class: 'field' }, h('span', {}, 'Result'), result),
      h('label', { class: 'field' }, h('span', {}, 'From'), from),
      h('label', { class: 'field' }, h('span', {}, 'To'), to),
      h('button', { class: 'btn', onclick: apply }, 'Filter'),
    ),
    // The one interaction on this screen that nothing else announces. A
    // pressable actor looks like an actor until a pointer is over it, and on a
    // phone there is no pointer at all — so the affordance is a sentence rather
    // than a decoration on fifty rows.
    h('p', { class: 'hint' }, 'Press an actor to see only what they did.'),
    scope,
    body,
  )

  apply()
}

/**
 * A page, and the button that asks for the next one.
 *
 * Cursor paging rather than a page number, because that is what the endpoint
 * has — and it has it because a journal grows while you read it, so an offset
 * would skip a record between one page and the next.
 */
async function load(body: HTMLElement, query: AuditQuery, onActor: (id: string) => void): Promise<void> {
  clear(body)
  body.append(h('p', { class: 'muted' }, 'Loading…'))

  try {
    const page = await client().audit.read({ ...query, limit: PAGE })
    clear(body)
    if (page.items.length === 0) {
      body.append(empty(query))
      return
    }

    const rows = h('tbody', {})
    const table = h('table', { class: 'table' },
      h('thead', {},
        h('tr', {},
          h('th', {}, 'When'),
          h('th', {}, 'Actor'),
          h('th', {}, 'Action'),
          h('th', {}, 'Target'),
          h('th', {}, 'Result'),
        ),
      ),
      rows,
    )
    body.append(table)
    for (const record of page.items) rows.append(row(record, onActor))

    let cursor = page.nextCursor
    if (cursor === undefined) return
    const more = h('button', { class: 'btn' }, 'Load more')
    more.addEventListener('click', () => {
      void (async () => {
        more.disabled = true
        more.textContent = 'Loading…'
        try {
          const next = await client().audit.read({ ...query, limit: PAGE, cursor: cursor as string })
          for (const record of next.items) rows.append(row(record, onActor))
          cursor = next.nextCursor
          if (cursor === undefined) more.remove()
          else {
            more.disabled = false
            more.textContent = 'Load more'
          }
        } catch (error) {
          more.replaceWith(h('div', { class: 'error' }, explain(error)))
        }
      })()
    })
    body.append(h('div', { class: 'row' }, more))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
  }
}

const empty = (query: AuditQuery) =>
  h('div', { class: 'empty' },
    h('h2', {}, 'Nothing in the log'),
    h('p', {},
      Object.keys(query).length === 0
        ? 'Requires org_admin or platform_admin to read. Anyone else gets the same answer as an organization with an empty log — the endpoint answers 404 rather than 403, so "not permitted" and "nothing here" are deliberately the same answer.'
        : 'No record matches those filters. They are exact rather than a search: an action is the whole action name.'),
  )

/**
 * One record.
 *
 * The target is rendered as its own fields rather than as JSON, because the
 * question a reader has is "which document" or "which layer" and a brace does
 * not help them. A uuid is shortened the way every other id on these screens
 * is; anything else is printed whole.
 *
 * The result is a chip only where it is one: an `allow` is what almost every
 * row says, and fifty teal pills carry no information while making the four
 * that matter harder to find. It would also be the wrong colour — teal is
 * `read` in the permission palette, and the brand's rule is that those four
 * carry a meaning rather than a mood.
 */
function row(record: AuditRecord, onActor: (id: string) => void): HTMLElement {
  const target = Object.entries(record.target)
  // `agoCell` rather than a `<td>` built here: `lint:admin-layout` asks that of
  // every view, because "204 days ago" is three words and one value and a table
  // cell will break it across three lines. The exact instant goes in the title,
  // which is where a reader correlating with somebody else's log looks.
  const when = agoCell(record.occurredAt)
  when.title = record.occurredAt
  const actorId = record.actor.id
  return h('tr', {},
    when,
    h('td', {},
      actorId === null
        ? h('div', { class: 'named' }, record.actor.type)
        : h('button', { class: 'filterlink', title: 'Show only this actor', onclick: () => { onActor(actorId) } },
            h('div', { class: 'named' }, record.actor.label ?? record.actor.type),
            shortId(actorId),
          ),
    ),
    h('td', {},
      h('code', { class: 'id' }, record.action),
      record.surface === null ? null : h('span', { class: 'tag' }, record.surface),
    ),
    h('td', { class: 'named' },
      ...(target.length === 0
        ? [h('span', { class: 'muted' }, '—')]
        : target.map(([key, value]) => h('div', { class: 'muted' },
            `${key}: `,
            typeof value === 'string' && /^[0-9a-f-]{36}$/u.test(value) ? shortId(value) : String(value),
          ))),
    ),
    h('td', {},
      record.result === 'allow'
        ? h('span', { class: 'muted' }, 'allow')
        : h('span', { class: record.result === 'deny' ? 'chip chip-deny' : 'tag tag-off' }, record.result),
    ),
  )
}
