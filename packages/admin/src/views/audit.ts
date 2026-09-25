import { AUDIT_ACTIONS, type AuditRecord, type AuditQuery } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { agoCell, clear, h, shortId } from '../dom.js'
import { matchActor } from '../listing.js'
import { type Directory, type Names, directory } from '../names.js'

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
 * ## A name can be typed, though
 *
 * Pressing an actor needs the actor to be on the page already, and on a busy
 * log the person being investigated may be three hundred records down. So
 * there is a **User** field that takes what a person knows — an address, or a
 * service account's name — offers the accounts the console can resolve as a
 * list, and turns the choice into the `actor_id` the endpoint takes. A name
 * matching nobody, or several, is said so and not sent: an empty log would
 * read as "they did nothing", and the log of the wrong one looks exactly like
 * the right one. Absent where no account can be resolved — a platform
 * administrator, whom the listings refuse — because a field that can only ever
 * answer "no match" is a control that does not work.
 *
 * ## The action names are offered, not guessed
 *
 * The Action box's example was `grant.issue`, which nothing records — the
 * handler writes `issue_grant` — and the filter is an exact match, so the
 * example was an empty log. It offers `AUDIT_ACTIONS` now, the SDK's copy of
 * the core's catalogue that `lint:audit-actions` holds against every writer.
 * Still free text: a request that failed is recorded under its path, and a
 * commercial module records names this list cannot know.
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
 * An actor's kind, as a word rather than as a column value.
 *
 * This is what the Actor cell falls back to when the id resolves to nothing —
 * a deleted account, or a caller the listing endpoints refuse. `service_account`
 * is the only one whose stored spelling is not already a word, and the rest are
 * passed through rather than being enumerated, so a principal type added later
 * reads as itself instead of as `unknown`.
 */
const readableType = (type: string): string => type.replaceAll('_', ' ')

/** Which fill each result gets. One control, one size, three treatments. */
const FILL: Record<AuditRecord['result'], string> = {
  allow: 'plain',
  deny: 'deny',
  error: 'error',
}

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

  // Once per visit rather than per filter: the names are what the Actor column
  // and the User field both read, and they do not change while somebody is
  // narrowing a log.
  const known: Promise<Directory> = directory()

  const actions = h('datalist', { id: 'audit-actions' },
    ...AUDIT_ACTIONS.map((a) => h('option', { value: a.name, label: a.summary })),
  )
  const action = h('input', {
    class: 'input',
    list: 'audit-actions',
    placeholder: 'Any action',
    autocomplete: 'off',
    'aria-label': 'Action',
  }) as HTMLInputElement
  const people = h('datalist', { id: 'audit-actors' })
  const who = h('input', {
    class: 'input',
    list: 'audit-actors',
    placeholder: 'Email or service account',
    autocomplete: 'off',
    'aria-label': 'User',
  }) as HTMLInputElement
  const whoField = h('label', { class: 'field grow' }, h('span', {}, 'User'), who, people)
  const result = h('select', { class: 'input', 'aria-label': 'Result' },
    h('option', { value: '' }, 'Any result'),
    h('option', { value: 'allow' }, 'allow'),
    h('option', { value: 'deny' }, 'deny'),
    h('option', { value: 'error' }, 'error'),
  ) as HTMLSelectElement
  const from = h('input', { class: 'input', type: 'date', 'aria-label': 'From' }) as HTMLInputElement
  const to = h('input', { class: 'input', type: 'date', 'aria-label': 'To' }) as HTMLInputElement
  // `.error` draws a box, so this is hidden while it has nothing to say.
  const problem = h('div', { class: 'error', hidden: true })

  const scope = h('div', {})
  const body = h('div', {})

  /**
   * Set by pressing an actor in the log or by the User field, cleared by the
   * chip beside it. `actorLabel` is what the field shows for it — undefined
   * for an actor the console cannot name, so an empty field does not clear a
   * filter that was set by a press.
   */
  let actorId: string | undefined
  let actorLabel: string | undefined

  void known.then((found) => {
    whoField.hidden = found.actors.length === 0
    people.append(...found.actors.map((a) => h('option', { value: a.label })))
  })

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

  const setActor = (id: string | undefined, label: string | undefined): void => {
    actorId = id
    actorLabel = label
    who.value = label ?? ''
  }

  /**
   * What the User field means, or a sentence saying why it means nothing.
   *
   * Refused rather than sent when it names nobody or several: see the header.
   */
  const resolveWho = async (): Promise<string | undefined> => {
    const typed = who.value.trim()
    if (typed === '') {
      if (actorLabel !== undefined) setActor(undefined, undefined)
      return undefined
    }
    if (actorLabel !== undefined && typed.toLocaleLowerCase() === actorLabel.toLocaleLowerCase()) return undefined
    const match = matchActor(typed, (await known).actors)
    if (match.kind === 'none') return `No user or service account matches “${typed}”.`
    if (match.kind === 'many') {
      const some = match.actors.slice(0, 3).map((a) => a.label).join(', ')
      return `“${typed}” matches ${String(match.actors.length)} accounts (${some}${match.actors.length > 3 ? ', …' : ''}). Type more of it.`
    }
    setActor(match.actor.id, match.actor.label)
    return undefined
  }

  const apply = (): void => {
    void (async () => {
      problem.hidden = true
      const refused = await resolveWho()
      if (refused !== undefined) {
        problem.textContent = refused
        problem.hidden = false
        return
      }
      const resolved = await known
      clear(scope)
      if (actorId !== undefined) {
        const id = actorId
        scope.append(
          h('div', { class: 'row' },
            h('span', { class: 'muted' }, 'Only this actor:'),
            resolved.names.get(id) === undefined ? shortId(id) : h('span', { class: 'named', title: id }, resolved.names.get(id) as string),
            h('button', { class: 'btn btn-quiet', onclick: () => { setActor(undefined, undefined); apply() } }, 'Clear'),
          ),
        )
      }
      void load(body, query(), resolved.names, (id) => {
        setActor(id, resolved.actors.find((a) => a.id === id)?.label)
        apply()
      })
    })()
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
    actions,
    // Two rows rather than one: six controls do not fit a phone's width on one
    // line, and the two text fields are the ones that want the room.
    h('div', { class: 'row' },
      h('label', { class: 'field grow' }, h('span', {}, 'Action'), action),
      whoField,
    ),
    h('div', { class: 'row wrap' },
      h('label', { class: 'field' }, h('span', {}, 'Result'), result),
      h('label', { class: 'field' }, h('span', {}, 'From'), from),
      h('label', { class: 'field' }, h('span', {}, 'To'), to),
      h('button', { class: 'btn', onclick: apply }, 'Filter'),
    ),
    problem,
    // The one interaction on this screen that nothing else announces. A
    // pressable actor looks like an actor until a pointer is over it, and on a
    // phone there is no pointer at all — so the affordance is a sentence rather
    // than a decoration on fifty rows.
    h('p', { class: 'hint' }, 'Press an actor to see only what they did, or type their address above.'),
    scope,
    body,
  )

  // Enter in either text field is Filter, which is what a person typing into
  // a filter box expects and what the date and select controls do not need.
  for (const field of [action, who]) {
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') apply()
    })
  }

  apply()
}

/**
 * A page, and the button that asks for the next one.
 *
 * Cursor paging rather than a page number, because that is what the endpoint
 * has — and it has it because a journal grows while you read it, so an offset
 * would skip a record between one page and the next.
 *
 * The names arrive already resolved — the view asks for them once per visit,
 * before the first page, so the table is never a column of uuids that then
 * rewrites itself. `directory` refuses nothing — every list it asks for is
 * settled separately — so a `platform_admin`, whom `GET /v1/users` does not
 * answer, gets an empty map and every actor falls back to its kind.
 */
async function load(
  body: HTMLElement,
  query: AuditQuery,
  resolved: Names,
  onActor: (id: string) => void,
): Promise<void> {
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
    for (const record of page.items) rows.append(row(record, resolved, onActor))

    let cursor = page.nextCursor
    if (cursor === undefined) return
    const more = h('button', { class: 'btn' }, 'Load more')
    more.addEventListener('click', () => {
      void (async () => {
        more.disabled = true
        more.textContent = 'Loading…'
        try {
          const next = await client().audit.read({ ...query, limit: PAGE, cursor: cursor as string })
          for (const record of next.items) rows.append(row(record, resolved, onActor))
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
        : 'No record matches those filters. They are exact rather than a search: an action is the whole action name, as the Action box lists it.'),
  )

/**
 * One record.
 *
 * The target is rendered as its own fields rather than as JSON, because the
 * question a reader has is "which document" or "which layer" and a brace does
 * not help them. A uuid is shortened the way every other id on these screens
 * is; anything else is printed whole.
 *
 * ## The actor is named, and `actor.label` is deliberately not what names it
 *
 * That field looks like the answer and is not: every writer of an event builds
 * it as `` `${type}:${id}` ``, so it carries nothing the `type` and `id` beside
 * it do not already say. Rendering it put a whole uuid above a shortened one —
 * two spellings of the same value, and no name — which is what a running stand
 * showed while this screen's own picture looked fine, because the fixture had
 * been written with an email in that field and no server sends one.
 *
 * So the id is resolved the way the Grants screen resolves a principal, and
 * where it cannot be — a deleted account, or a caller whom `GET /v1/users`
 * refuses — the fallback is the actor's *kind* as a word. Never the stored
 * label: falling back to it would put the uuid back exactly where a name was
 * missing, which is the case this exists for.
 *
 * The result is one control at one size, and only the fill differs. It shipped
 * as three sizes — `allow` at the table's 15px sans, `deny` at the chip's 12px
 * mono, `error` at `.tag`'s 10px uppercase — which a reader going down the
 * column sees as three kinds of thing rather than as three values of one field.
 * Reported by somebody looking at it; `screenshots.mjs` asks it of every column
 * of every table now.
 *
 * An `allow` still carries no fill, because it is what almost every row says:
 * fifty filled pills carry no information while making the few denials harder
 * to find, and teal is `read` in the permission palette, which the brand says
 * carries a meaning rather than a mood. It is ringed rather than bare, because
 * the frame is what makes the column read as one control with three states.
 * And `error` is `--n-error` rather than `--n-deny` — the same hex, a different
 * statement, since a deny is the permission model working and an error is this
 * system failing.
 *
 * The width is one width for all three, taken from the longest of them, and it
 * comes from the stylesheet rather than from here: a chip in a table cell is
 * part of a column, so nothing on this line has to remember it. A ragged right
 * edge reads as the values meaning different amounts of something, when what
 * differs is how many letters they happen to have.
 */
function row(record: AuditRecord, resolved: Names, onActor: (id: string) => void): HTMLElement {
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
        ? h('div', { class: 'named' }, readableType(record.actor.type))
        : h('button', { class: 'filterlink', title: 'Show only this actor', onclick: () => { onActor(actorId) } },
            h('div', { class: 'named' }, resolved.get(actorId) ?? readableType(record.actor.type)),
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
    h('td', {}, h('span', { class: `chip chip-${FILL[record.result]}` }, record.result)),
  )
}
