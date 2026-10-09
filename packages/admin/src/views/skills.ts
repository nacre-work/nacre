import type { Layer, SkillEntry } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { clear, h } from '../dom.js'
import { listing } from '../listing.js'
import { layerSkillDialog, skillPanel } from './skill.js'

/**
 * What an agent connected to this organization is told, after the built-in
 * guide every agent gets.
 *
 * Two levels on one screen, because they are read together: the organization's
 * skill is the base, a layer's is added for an agent that can reach the layer,
 * and somebody writing either needs to see the other. The base is the panel;
 * the layers are a table, each opening the same panel the Layers screen opens.
 *
 * A platform administrator sees the installation's level instead and nothing
 * else here. That role reads no organization's skill — rule 2, administering a
 * tenant is not access to its data — and the installation's skill is the one
 * every organization gets until it writes its own, so it belongs on the same
 * screen rather than on a second console. The server decides all of it: the
 * panel asks `versions` whether the caller may write, and a level the caller
 * may not see answers as one with no skill.
 */
export async function skillsView(root: HTMLElement, platformAdmin: boolean): Promise<void> {
  clear(root)
  root.append(
    h('header', { class: 'view-head' },
      h('div', {},
        h('h1', {}, 'Skills'),
        h('p', { class: 'lede' },
          platformAdmin
            ? 'What every agent on this installation is told about working here, after the built-in guide — ' +
              'until an organization writes its own skill, which replaces this one.'
            : 'What every agent connected to this organization is told, after the built-in guide. ' +
              'The organization\'s skill is the base; a layer\'s skill is added for agents that can reach that layer.'),
      ),
    ),
  )

  const base = h('div', {})
  root.append(h('h2', { class: 'section' }, platformAdmin ? 'Installation' : 'Organization'), base)

  if (platformAdmin) {
    await skillPanel(base, {
      level: 'installation',
      absent: 'This installation has no skill of its own. Agents in an organization without one get the default skill shipped with Nacre.',
      template: async () => (await client().skills.base()).files,
      fallback: () => client().skills.base(),
    })
    return
  }

  const layers = h('div', {}, h('p', { class: 'muted' }, 'Loading…'))
  root.append(h('h2', { class: 'section' }, 'Layers'), layers)

  await Promise.all([
    skillPanel(base, {
      level: 'organization',
      absent: 'This organization has no skill of its own.',
      // Starting from what agents get today, rather than from an empty file:
      // the default skill is written to be a good base, and an organization
      // usually wants to add its conventions to it rather than replace it.
      template: async () => (await client().skills.base()).files,
      fallback: () => client().skills.base(),
    }),
    layerTable(layers),
  ])
}

async function layerTable(body: HTMLElement): Promise<void> {
  let rows: readonly Layer[]
  let skills: ReadonlyMap<string, SkillEntry>
  try {
    const [visible, listed] = await Promise.all([client().layers.list(), client().skills.list()])
    rows = visible
    skills = new Map(listed.layers.flatMap((s) => (s.layerId === null ? [] : [[s.layerId, s] as const])))
  } catch (error) {
    clear(body)
    body.append(h('div', { class: 'error' }, explain(error)))
    return
  }

  clear(body)
  if (rows.length === 0) {
    body.append(h('p', { class: 'muted' }, 'No layers this token can reach, so no layer skills to show.'))
    return
  }

  const redraw = (): void => { void layerTable(body) }
  body.append(listing({
    rows,
    fields: (l) => [l.slug, l.name, skills.get(l.id)?.name, skills.get(l.id)?.description],
    label: 'Search layers by slug, name or skill',
    // The skill is a second line under the layer rather than a column of its
    // own: at 390 a fourth column left the description a letter wide, one per
    // line, for the full height of the table. The console treats an annotation
    // this way elsewhere, and a skill is what the layer is *about*.
    render: (shown) =>
      h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Layer and its skill'), h('th', { class: 'num' }, 'Version'), h('th', {}, ''))),
        h('tbody', {}, ...shown.map((layer) => {
          const skill = skills.get(layer.id)
          return h('tr', {},
            h('td', { class: 'skill-cell' },
              h('span', { class: 'slug' }, layer.slug),
              skill === undefined
                ? h('div', { class: 'muted skill-line' }, 'No skill — agents get the organization\'s alone.')
                : h('div', { class: 'skill-line' },
                    h('div', {}, skill.name,
                      skill.hasScripts ? h('span', { class: 'tag tag-warn' }, 'contains scripts') : null),
                    h('div', { class: 'muted' }, skill.description))),
            h('td', { class: 'num tabular' }, skill?.version === null || skill === undefined ? '—' : String(skill.version)),
            h('td', { class: 'right' },
              h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { layerSkillDialog(layer, redraw) } }, 'Open')),
          )
        })),
      ),
  }))
}
