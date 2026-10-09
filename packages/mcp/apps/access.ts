/**
 * `ui://nacre/access.html` — what one person, group or service account can
 * actually reach, layer by layer, in the permission colours.
 * docs/mcp-admin.md, "Panels".
 *
 * Rendered when the model calls `effective_access`, which computes the answer
 * with the resolver search uses — groups, grants, the role and any deny. A
 * row per layer and a column per permission, because rule 6 makes them three
 * questions rather than a ladder: `write` without `read` is a row with one
 * chip in it, and that is the answer, not a gap. The grants that decide it are
 * under the matrix. Another principal can be asked from the panel by address
 * or name.
 */
import { call, clear, connect, el, field, mount, parsed, permissionChip, status } from './shared.js'

type Reach =
  | { readonly every_layer: true }
  | {
      readonly every_layer: false
      readonly layers: readonly string[]
      readonly more_layers?: number
      readonly documents_outside_those_layers?: number
      readonly documents_denied_inside_them?: number
    }

interface Access {
  readonly principal: { readonly type: string; readonly name: string | null; readonly role?: string | null }
  readonly note?: string
  readonly groups: readonly { readonly name: string | null }[]
  readonly read: Reach
  readonly write: Reach
  readonly admin: Reach
  readonly deciding_grants: readonly {
    readonly through: string
    readonly scope: { readonly type: string; readonly name: string | null; readonly id: string }
    readonly permission: string
    readonly effect: string
  }[]
}

const PERMISSIONS = ['read', 'write', 'admin'] as const

async function main(): Promise<void> {
  const root = mount('Effective access')
  const app = await connect('nacre-access')

  const facts = el('p', { class: 'facts-line', hidden: '' })
  const matrix = el('table', { class: 'table', hidden: '' })
  const extra = el('p', { class: 'facts-line', hidden: '' })
  const grantsTitle = el('h2', { hidden: '' }, 'Deciding grants')
  const grants = el('table', { class: 'table', hidden: '' })
  const who = el('input', { class: 'input', placeholder: 'dana@example.com', 'aria-label': 'A person, group or service account' })
  const kind = el('select', { 'aria-label': 'Kind' })
  for (const [value, label] of [['person', 'person'], ['group', 'group'], ['service_account', 'service account']]) {
    kind.append(el('option', { value: value as string }, label as string))
  }
  const ask = el('button', { type: 'button', class: 'btn' }, 'Show')
  const kindField = el('label', { class: 'field fit' }, el('span', {}, 'Kind'), el('span', { class: 'select' }, kind))
  root.append(
    facts,
    el('div', { class: 'table-wrap' }, matrix),
    extra,
    grantsTitle,
    el('div', { class: 'table-wrap' }, grants),
    el('h2', {}, 'Someone else'),
    el('div', { class: 'row' }, field('Address or name', who), kindField, ask),
  )

  app.ontoolresult = (result) => {
    const answer = parsed<Access>(result)
    if (!answer.ok) {
      status(root, answer.message, 'error')
      return
    }
    show(answer.value)
  }

  function show(access: Access): void {
    const name = access.principal.name ?? access.principal.type
    facts.hidden = false
    facts.replaceChildren(
      el('b', {}, name),
      ` — ${access.principal.type.replace('_', ' ')}`,
      access.principal.role ? `, ${access.principal.role}` : '',
      access.groups.length === 0 ? '' : `, in ${access.groups.map((g) => g.name ?? 'a group').join(', ')}`,
      '.',
      ...(access.note === undefined ? [] : [el('span', { class: 'sub' }, access.note)]),
    )

    const layers = new Map<string, Set<string>>()
    const everywhere = new Set<string>()
    for (const p of PERMISSIONS) {
      const reach = access[p]
      if (reach.every_layer) {
        everywhere.add(p)
        continue
      }
      for (const layer of reach.layers) layers.set(layer, (layers.get(layer) ?? new Set()).add(p))
    }

    clear(matrix)
    matrix.append(el('thead', {}, el('tr', {}, el('th', {}, 'Layer'), ...PERMISSIONS.map((p) => el('th', {}, p)))))
    const body = el('tbody')
    if (everywhere.size > 0) {
      body.append(
        el('tr', {}, el('td', {}, el('b', {}, 'Every layer')), ...PERMISSIONS.map((p) => el('td', {}, everywhere.has(p) ? permissionChip(p) : el('span', { class: 'muted' }, '—')))),
      )
    }
    for (const [layer, has] of [...layers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      body.append(
        el(
          'tr',
          {},
          el('td', {}, el('code', { class: 'slug' }, layer)),
          ...PERMISSIONS.map((p) => el('td', {}, has.has(p) || everywhere.has(p) ? permissionChip(p) : el('span', { class: 'muted' }, '—'))),
        ),
      )
    }
    matrix.append(body)
    matrix.hidden = everywhere.size === 0 && layers.size === 0
    if (matrix.hidden) status(root, `${name} reaches no layer.`)
    else status(root, '')

    const notes: string[] = []
    for (const p of PERMISSIONS) {
      const reach = access[p]
      if (reach.every_layer) continue
      if (reach.more_layers) notes.push(`${String(reach.more_layers)} more layers with ${p}`)
      if (reach.documents_outside_those_layers) notes.push(`${String(reach.documents_outside_those_layers)} documents with ${p} outside these layers`)
      if (reach.documents_denied_inside_them) notes.push(`${String(reach.documents_denied_inside_them)} documents denied ${p} inside them`)
    }
    extra.hidden = notes.length === 0
    extra.textContent = notes.length === 0 ? '' : `Also: ${notes.join('; ')}.`

    clear(grants)
    grantsTitle.hidden = access.deciding_grants.length === 0
    grants.hidden = access.deciding_grants.length === 0
    if (access.deciding_grants.length > 0) {
      grants.append(el('thead', {}, el('tr', {}, el('th', {}, 'Through'), el('th', {}, 'On'), el('th', {}, 'Permission'))))
      const rows = el('tbody')
      for (const g of access.deciding_grants) {
        rows.append(
          el(
            'tr',
            {},
            el('td', {}, g.through),
            el('td', {}, g.scope.name ?? g.scope.id, el('span', { class: 'sub' }, g.scope.type)),
            el('td', {}, permissionChip(g.effect === 'deny' ? 'deny' : g.permission), ...(g.effect === 'deny' ? [el('span', { class: 'sub' }, `${g.permission} denied`)] : [])),
          ),
        )
      }
      grants.append(rows)
    }
  }

  ask.addEventListener('click', () => {
    const ref = who.value.trim()
    if (ref === '') return
    ask.disabled = true
    void (async () => {
      const answer = await call(app, 'effective_access', { [kind.value]: ref })
      ask.disabled = false
      if (!answer.ok) {
        status(root, answer.message, 'error')
        return
      }
      show(answer.value as Access)
    })()
  })
}

void main()
