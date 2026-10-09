import type { BaseSkill, Layer, SkillFiles, SkillLevel, SkillVersion, SkillWrite } from '@nacre.work/sdk'

import { client, explain } from '../api.js'
import { ago, clear, h } from '../dom.js'
import { renderMarkdown, splitFrontmatter } from '../markdown.js'
import { names, type Names } from '../names.js'
import { carriesScripts, fileTree, folderFiles, orderPaths, writtenBy, type PickedFile, type TreeNode } from '../skillfiles.js'

/**
 * One skill at one level, drawn the same way wherever it appears.
 *
 * docs/skills.md asks for the organization's skill on a screen of its own and
 * a layer's on that layer, "both drawn the same way" — so this is one panel and
 * two hosts, rather than two screens that would come to disagree about what a
 * marker means or which version a restore starts from.
 *
 * Everything here asks the server rather than deriving. Whether the caller may
 * write a level is whether `versions` answers, because history is shown exactly
 * to whoever may write; a screen that guessed from the role would draw an Edit
 * button an `admin` on one layer cannot use on the next, and the server's `403`
 * would then be the first thing to say so.
 *
 * Writing a skill is the most dangerous write in the product — a skill is
 * instruction every later agent follows — so nothing here writes on one press.
 * A loaded folder or `.zip` is shown before it is sent, with the scripts it
 * carries named; clearing says which skill applies afterwards; and the two
 * markers, written by an agent and contains scripts, are on every version, the
 * old ones included, because an injected rewrite is found by reading history.
 */

export interface SkillPanelOptions {
  readonly level: SkillLevel
  /** What a new skill at this level starts as. */
  readonly template: () => Promise<SkillFiles>
  /** Said where the level has no skill: what an agent gets instead. */
  readonly absent: string
  /** The skill that applies instead, shown read-only where this level has none. */
  readonly fallback?: () => Promise<BaseSkill | undefined>
  /** After a write, so a host listing several levels can redraw its row. */
  readonly onChange?: () => void
}

interface State {
  readonly current: SkillVersion | undefined
  /** `undefined` where this token may not write the level. */
  readonly history: readonly SkillVersion[] | undefined
  readonly names: Names
}

export async function skillPanel(host: HTMLElement, options: SkillPanelOptions): Promise<void> {
  clear(host)
  host.append(h('p', { class: 'muted' }, 'Loading…'))
  let state: State
  try {
    const [current, history, known] = await Promise.all([
      client().skills.get(options.level),
      client().skills.versions(options.level),
      names(),
    ])
    state = { current, history, names: known }
  } catch (error) {
    clear(host)
    host.append(h('div', { class: 'error' }, explain(error)))
    return
  }

  const redraw = (): void => {
    void skillPanel(host, options)
    options.onChange?.()
  }

  clear(host)
  if (state.current === undefined) {
    host.append(await absentView(state, options, redraw))
    return
  }
  host.append(presentView(state.current, state, options, redraw))
}

/** A level with no skill: what applies instead, and the way to write one. */
async function absentView(state: State, options: SkillPanelOptions, redraw: () => void): Promise<HTMLElement> {
  const writable = state.history !== undefined
  const box = h('div', { class: 'skill' })
  const head = h('div', { class: 'skill-head' },
    h('div', {}, h('p', { class: 'skill-absent' }, options.absent)),
  )
  box.append(head)

  if (writable) {
    const actions = h('div', { class: 'skill-actions' },
      h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: () => {
          void options.template().then((files) => {
            editFile(options.level, files, 'SKILL.md', latestVersion(state), redraw)
          })
        },
      }, 'Write one'),
      ...loadControls(options.level, latestVersion(state), redraw),
    )
    head.append(actions)
  }

  // A history with versions but no current skill is a cleared one, and
  // restoring is how it comes back — so the selector is offered here too.
  if (writable && (state.history?.length ?? 0) > 0) {
    box.append(historyRow(state, options, undefined, redraw))
  }

  const fallback = await options.fallback?.().catch(() => undefined)
  if (fallback !== undefined) {
    box.append(
      h('p', { class: 'hint skill-fallback' },
        fallback.level === 'default'
          ? 'Until then, agents get the default skill shipped with Nacre:'
          : 'Until then, agents get the installation\'s skill:'),
      h('div', { class: 'skill-title skill-fallback-title' }, h('span', { class: 'slug' }, fallback.name)),
      h('p', { class: 'skill-description' }, fallback.description),
      viewer(fallback.files),
    )
  }
  return box
}

function presentView(shown: SkillVersion, state: State, options: SkillPanelOptions, redraw: () => void): HTMLElement {
  const current = state.current as SkillVersion
  const writable = state.history !== undefined
  const isCurrent = shown.version === current.version
  const files = shown.files ?? {}

  const box = h('div', { class: 'skill' })
  const actions = h('div', { class: 'skill-actions' })
  if (isCurrent) {
    actions.append(h('button', { type: 'button', class: 'btn', onclick: () => void download(options.level, shown) }, 'Download .zip'))
  }
  if (writable && isCurrent) {
    actions.append(
      h('button', {
        type: 'button',
        class: 'btn',
        onclick: () => { editFile(options.level, files, 'SKILL.md', current.version, redraw) },
      }, 'Edit'),
      ...loadControls(options.level, current.version, redraw),
      h('button', {
        type: 'button',
        class: 'btn btn-quiet btn-danger',
        onclick: () => { confirmClear(options, current.version, redraw) },
      }, 'Clear'),
    )
  }
  if (writable && !isCurrent) {
    actions.append(
      h('button', {
        type: 'button',
        class: 'btn btn-primary',
        onclick: () => void restore(options.level, shown.version, current.version, actions, redraw),
      }, `Restore version ${String(shown.version)}`),
    )
  }

  box.append(
    h('div', { class: 'skill-head' },
      h('div', {},
        h('div', { class: 'skill-title' },
          h('span', { class: 'slug' }, shown.name ?? '(cleared)'),
          ...markers(shown)),
        shown.description === null ? null : h('p', { class: 'skill-description' }, shown.description),
        h('p', { class: 'skill-meta muted' }, meta(shown, state.names)),
      ),
      actions.childElementCount > 0 ? actions : null,
    ),
  )
  if (writable && (state.history?.length ?? 0) > 1) box.append(historyRow(state, options, shown, redraw))
  if (!isCurrent) {
    box.append(h('p', { class: 'warn' },
      `This is version ${String(shown.version)}. Version ${String(current.version)} is what agents are given now.`))
  }
  box.append(viewer(files))
  return box
}

const markers = (v: { readonly byAgent?: boolean; readonly hasScripts: boolean }): HTMLElement[] => [
  ...(v.byAgent === true
    ? [h('span', { class: 'tag tag-agent', title: 'Written through MCP, by a connected application, or by a service account.' }, 'written by an agent')]
    : []),
  ...(v.hasScripts
    ? [h('span', { class: 'tag tag-warn', title: 'Carries files under scripts/, which an agent runs on its own side — never on this server.' }, 'contains scripts')]
    : []),
]

function meta(v: SkillVersion, known: Names): string {
  const files = `${String(v.fileCount)} ${v.fileCount === 1 ? 'file' : 'files'}`
  const restored = v.restoredFrom === null ? '' : ` · restored from version ${String(v.restoredFrom)}`
  // A connection acts as the person who approved it, so the principal alone
  // reads as if they typed it. Which door it came through is half the answer.
  const through =
    v.connectionId !== null ? ', through a connected application' : v.surface === 'mcp' ? ', over MCP' : ''
  return `Version ${String(v.version)} · ${files} · ${ago(v.createdAt)} by ${writtenBy(v.principal, known)}${through}${restored}`
}

/** The version selector — shown to whoever may write, as history is. */
function historyRow(state: State, options: SkillPanelOptions, shown: SkillVersion | undefined, redraw: () => void): HTMLElement {
  const history = state.history ?? []
  const select = h('select', { class: 'input', 'aria-label': 'Version' })
  for (const v of history) {
    const label = [
      `Version ${String(v.version)}`,
      v.version === state.current?.version ? 'current' : null,
      v.name === null ? 'cleared' : null,
      ago(v.createdAt),
      writtenBy(v.principal, state.names),
      v.byAgent ? 'by an agent' : null,
      v.hasScripts ? 'scripts' : null,
    ].filter((p): p is string => p !== null).join(' · ')
    const option = h('option', { value: String(v.version) }, label)
    if (v.version === (shown?.version ?? -1)) option.setAttribute('selected', '')
    select.append(option)
  }
  if (shown === undefined) {
    select.prepend(h('option', { value: '', selected: true, disabled: true }, 'Earlier versions…'))
  }
  const message = h('div', {})
  select.addEventListener('change', () => {
    const n = Number(select.value)
    const host = select.closest('.skill')?.parentElement
    if (!(host instanceof HTMLElement)) return
    void client().skills.version(options.level, n).then((version) => {
      if (version === undefined) {
        clear(message)
        message.append(h('div', { class: 'error' }, 'That version is not there any more.'))
        return
      }
      if (version.name === null) {
        // A cleared version has nothing to draw; restoring the one before it is
        // the way back, and the selector already lists it.
        clear(message)
        message.append(h('p', { class: 'hint' }, `Version ${String(n)} cleared the skill. Pick the version before it to restore that one.`))
        return
      }
      clear(host)
      host.append(state.current === undefined
        ? presentStandalone(version, state, options, redraw)
        : presentView(version, state, options, redraw))
    }).catch((error: unknown) => {
      clear(message)
      message.append(h('div', { class: 'error' }, explain(error)))
    })
  })
  return h('div', { class: 'skill-history' }, h('label', { class: 'field grow' }, h('span', {}, 'History'), select), message)
}

/** An old version of a level that is cleared now: readable, and restorable. */
function presentStandalone(v: SkillVersion, state: State, options: SkillPanelOptions, redraw: () => void): HTMLElement {
  const actions = h('div', { class: 'skill-actions' })
  actions.append(h('button', {
    type: 'button',
    class: 'btn btn-primary',
    onclick: () => void restore(options.level, v.version, latestVersion(state), actions, redraw),
  }, `Restore version ${String(v.version)}`))
  return h('div', { class: 'skill' },
    h('div', { class: 'skill-head' },
      h('div', {},
        h('div', { class: 'skill-title' }, h('span', { class: 'slug' }, v.name ?? ''), ...markers(v)),
        v.description === null ? null : h('p', { class: 'skill-description' }, v.description),
        h('p', { class: 'skill-meta muted' }, meta(v, state.names)),
      ),
      actions,
    ),
    historyRow(state, options, v, redraw),
    h('p', { class: 'warn' }, `This is version ${String(v.version)}. The skill is cleared now, so agents get the level above.`),
    viewer(v.files ?? {}),
  )
}

const latestVersion = (state: State): number => state.history?.[0]?.version ?? state.current?.version ?? 0

/**
 * The files, and one of them drawn.
 *
 * `SKILL.md` is what an agent reads first, so it is what opens; the others are
 * a list beside it, because a skill's reference files are how it keeps its main
 * file short and a reader needs to see that they exist. Markdown is rendered by
 * default and its source is one tab away — the source is what an agent is
 * actually given, and frontmatter is part of it.
 */
function viewer(files: SkillFiles): HTMLElement {
  const paths = orderPaths(Object.keys(files))
  const known = new Set(paths)
  const box = h('div', { class: 'skill-body' })
  const list = h('nav', { class: 'skill-files', 'aria-label': 'Files' })
  const pane = h('div', { class: 'skill-pane' })
  let selected = paths[0] ?? 'SKILL.md'
  let mode: 'rendered' | 'source' = 'rendered'

  const draw = (): void => {
    clear(list)
    // Folders as folders: a label, and what is in it indented under a rule,
    // so `reference/teams/finance.md` reads as a file two levels down rather
    // than as one long name. A folder is not a control — there is nothing to
    // open — so it is text, and only files are buttons.
    const nodes = (tree: readonly TreeNode[]): HTMLElement[] => tree.map((node) =>
      node.kind === 'dir'
        ? h('div', { class: 'skill-dir' },
            h('div', { class: 'skill-dir-name' }, `${node.name}/`),
            h('div', { class: 'skill-dir-items' }, ...nodes(node.children)))
        : h('button', {
            type: 'button',
            class: `skill-file${node.path === selected ? ' active' : ''}`,
            title: node.path,
            'aria-current': node.path === selected ? 'true' : 'false',
            onclick: () => {
              selected = node.path
              draw()
            },
          }, node.name))
    list.append(...nodes(fileTree(paths)))

    clear(pane)
    // The whole path, because the list shows a file's name and its folder
    // separately and two folders can each hold a README.md.
    if (paths.length > 1) pane.append(h('div', { class: 'skill-path' }, selected))
    const text = files[selected] ?? ''
    const markdown = selected.toLowerCase().endsWith('.md')
    if (markdown) {
      pane.append(h('div', { class: 'tabs skill-tabs', role: 'tablist' },
        h('button', { type: 'button', role: 'tab', class: `tab${mode === 'rendered' ? ' active' : ''}`, onclick: () => { mode = 'rendered'; draw() } }, 'Rendered'),
        h('button', { type: 'button', role: 'tab', class: `tab${mode === 'source' ? ' active' : ''}`, onclick: () => { mode = 'source'; draw() } }, 'Source'),
      ))
    }
    if (markdown && mode === 'rendered') {
      const { body } = splitFrontmatter(text)
      pane.append(renderMarkdown(body, {
        files: known,
        open: (path) => {
          selected = path
          draw()
        },
      }))
    } else {
      pane.append(h('pre', { class: 'skill-source' }, text))
    }
  }

  draw()
  if (paths.length > 1) box.append(list)
  else box.classList.add('single')
  box.append(pane)
  return box
}

async function download(level: SkillLevel, v: SkillVersion): Promise<void> {
  const bytes = await client().skills.export(level).catch(() => undefined)
  if (bytes === undefined) return
  const name = `${v.name ?? 'skill'}.zip`
  const file = new File([bytes as BlobPart], name, { type: 'application/zip' })
  // Web Share where the browser has it, for the reason the recovery codes give:
  // Safari navigates to a blob rather than saving it.
  if (navigator.canShare?.({ files: [file] }) === true) {
    void navigator.share({ files: [file], title: name }).catch(() => undefined)
    return
  }
  const url = URL.createObjectURL(file)
  const link = h('a', { href: url, download: name })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 60_000)
}

/** Load a folder or a `.zip` — both reviewed before they are written. */
function loadControls(level: SkillLevel, basedOn: number, redraw: () => void): HTMLElement[] {
  const folder = h('input', { type: 'file', hidden: true, multiple: true, webkitdirectory: true })
  folder.addEventListener('change', () => {
    const picked = Array.from(folder.files ?? [])
    folder.value = ''
    if (picked.length === 0) return
    void Promise.all(picked.map(async (f): Promise<PickedFile> => ({ path: f.webkitRelativePath || f.name, text: await f.text() })))
      .then((read) => { reviewFolder(level, folderFiles(read), basedOn, redraw) })
  })
  const zip = h('input', { type: 'file', hidden: true, accept: '.zip,application/zip' })
  zip.addEventListener('change', () => {
    const file = zip.files?.[0]
    zip.value = ''
    if (file === undefined) return
    void file.arrayBuffer().then((buffer) => { reviewZip(level, file.name, new Uint8Array(buffer), basedOn, redraw) })
  })
  return [
    folder,
    zip,
    h('button', { type: 'button', class: 'btn', onclick: () => { folder.click() } }, 'Load a folder'),
    h('button', { type: 'button', class: 'btn', onclick: () => { zip.click() } }, 'Load a .zip'),
  ]
}

function dialogShell(title: string, ...body: (Node | null)[]): { dialog: HTMLDialogElement; message: HTMLElement; actions: HTMLElement } {
  const message = h('div', {})
  const actions = h('div', { class: 'dialog-actions' })
  const dialog = h('dialog', { class: 'dialog dialog-wide' }, h('h2', {}, title), ...body, message, actions)
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
  return { dialog, message, actions }
}

/** The answer to a write, said where the person is looking. */
function settle(outcome: SkillWrite | undefined, message: HTMLElement, done: () => void): void {
  clear(message)
  if (outcome === undefined) {
    message.append(h('div', { class: 'error' }, 'Not found, or not visible to this token.'))
    return
  }
  if (outcome.kind === 'conflict') {
    // Somebody else wrote first. Not an overwrite and not an error: their
    // version is current, and the change has to be made again on top of it.
    message.append(h('div', { class: 'error' },
      `Version ${String(outcome.current)} was saved while this was open. Close, look at it, and make the change again on top of it.`))
    return
  }
  done()
}

function editFile(level: SkillLevel, files: SkillFiles, path: string, basedOn: number, redraw: () => void): void {
  const text = h('textarea', { class: 'input mono skill-editor', spellcheck: 'false', rows: 20, 'aria-label': path })
  text.value = files[path] ?? ''
  const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save as a new version')
  const { dialog, message, actions } = dialogShell(`Edit ${path}`,
    h('p', { class: 'hint' },
      'The frontmatter names the skill and says when an agent should use it — lower-case letters, digits and hyphens for the name. ' +
      'Saving writes a new version; every earlier one stays and can be restored.'),
    text,
  )
  actions.append(h('button', { type: 'button', class: 'btn', onclick: () => { dialog.close() } }, 'Cancel'), save)
  save.addEventListener('click', () => {
    save.disabled = true
    void client().skills.write(level, { files: { ...files, [path]: text.value } }, basedOn)
      .then((outcome) => { settle(outcome, message, () => { dialog.close(); redraw() }) })
      .catch((error: unknown) => {
        clear(message)
        message.append(h('div', { class: 'error' }, explain(error)))
      })
      .finally(() => { save.disabled = false })
  })
}

function reviewFolder(level: SkillLevel, folder: ReturnType<typeof folderFiles>, basedOn: number, redraw: () => void): void {
  const paths = orderPaths(Object.keys(folder.files))
  const write = h('button', { type: 'button', class: 'btn btn-primary' }, 'Write as a new version')
  const { dialog, message, actions } = dialogShell('Load a folder',
    h('p', { class: 'hint' }, `${String(paths.length)} ${paths.length === 1 ? 'file' : 'files'} become the new version. Nothing is merged with the current one.`),
    h('ul', { class: 'plain skill-review' }, ...paths.map((p) => h('li', {}, h('code', {}, p)))),
    carriesScripts(paths)
      ? h('p', { class: 'warn' }, 'This folder carries scripts. An agent that follows this skill runs them on its own side, so read them first.')
      : null,
    folder.skipped.length > 0
      ? h('p', { class: 'hint' }, `Left out: ${folder.skipped.map((s) => `${s.path} (${s.why})`).join(', ')}.`)
      : null,
  )
  actions.append(h('button', { type: 'button', class: 'btn', onclick: () => { dialog.close() } }, 'Cancel'), write)
  write.addEventListener('click', () => {
    write.disabled = true
    void client().skills.write(level, { files: folder.files }, basedOn)
      .then((outcome) => { settle(outcome, message, () => { dialog.close(); redraw() }) })
      .catch((error: unknown) => {
        clear(message)
        message.append(h('div', { class: 'error' }, explain(error)))
      })
      .finally(() => { write.disabled = false })
  })
}

function reviewZip(level: SkillLevel, name: string, bytes: Uint8Array, basedOn: number, redraw: () => void): void {
  const write = h('button', { type: 'button', class: 'btn btn-primary' }, 'Write as a new version')
  const { dialog, message, actions } = dialogShell('Load a .zip',
    h('p', { class: 'hint' },
      h('code', {}, name), ` (${String(Math.max(1, Math.round(bytes.byteLength / 1024)))} KB) becomes the new version — a skill as Claude exports one. ` +
      'The server opens it and checks it the same way it checks a folder; nothing is merged with the current version.'),
  )
  actions.append(h('button', { type: 'button', class: 'btn', onclick: () => { dialog.close() } }, 'Cancel'), write)
  write.addEventListener('click', () => {
    write.disabled = true
    void client().skills.write(level, { zip: bytes }, basedOn)
      .then((outcome) => { settle(outcome, message, () => { dialog.close(); redraw() }) })
      .catch((error: unknown) => {
        clear(message)
        message.append(h('div', { class: 'error' }, explain(error)))
      })
      .finally(() => { write.disabled = false })
  })
}

function confirmClear(options: SkillPanelOptions, basedOn: number, redraw: () => void): void {
  const go = h('button', { type: 'button', class: 'btn btn-primary btn-danger' }, 'Clear')
  const { dialog, message, actions } = dialogShell('Clear this skill?',
    h('p', {}, `${options.absent} Clearing is a version too, so this one can be restored afterwards.`),
  )
  actions.append(h('button', { type: 'button', class: 'btn', onclick: () => { dialog.close() } }, 'Cancel'), go)
  go.addEventListener('click', () => {
    go.disabled = true
    void client().skills.clear(options.level, basedOn)
      .then((outcome) => { settle(outcome, message, () => { dialog.close(); redraw() }) })
      .catch((error: unknown) => {
        clear(message)
        message.append(h('div', { class: 'error' }, explain(error)))
      })
      .finally(() => { go.disabled = false })
  })
}

async function restore(level: SkillLevel, version: number, basedOn: number, near: HTMLElement, redraw: () => void): Promise<void> {
  const message = h('div', {})
  near.after(message)
  try {
    const outcome = await client().skills.restore(level, version, basedOn)
    settle(outcome, message, redraw)
  } catch (error) {
    clear(message)
    message.append(h('div', { class: 'error' }, explain(error)))
  }
}

/** A layer's skill in a dialog — opened from the Layers screen and from Skills. */
export function layerSkillDialog(layer: Pick<Layer, 'id' | 'slug' | 'name'>, onChange?: () => void): void {
  const body = h('div', {})
  const dialog = h('dialog', { class: 'dialog dialog-wide' },
    h('h2', {}, 'Layer skill'),
    h('p', { class: 'hint' },
      'Layer ', h('span', { class: 'slug' }, layer.slug),
      '. What an agent that can reach this layer is told about it, on top of the organization\'s skill: what belongs here, how documents are named, what never goes in.'),
    body,
    h('div', { class: 'dialog-actions' },
      h('button', { type: 'button', class: 'btn', onclick: () => { dialog.close() } }, 'Close')),
  )
  document.body.append(dialog)
  dialog.addEventListener('close', () => dialog.remove())
  dialog.showModal()
  void skillPanel(body, {
    level: { layerId: layer.id },
    absent: 'This layer has no skill. Agents that reach it get the organization\'s skill alone.',
    template: () => Promise.resolve(layerTemplate(layer)),
    ...(onChange === undefined ? {} : { onChange }),
  })
}

/**
 * A layer skill to start from. The name is the slug — already lower-case and
 * hyphenated, which is the format's rule — and the body names the four things
 * docs/skills.md says a layer's skill is for.
 */
export function layerTemplate(layer: Pick<Layer, 'slug' | 'name'>): SkillFiles {
  const name = layer.slug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'layer'
  return {
    'SKILL.md': [
      '---',
      `name: ${name}`,
      `description: What the ${layer.name} layer holds and how a document in it is written. Read before adding to or searching ${layer.slug}.`,
      '---',
      '',
      `# ${layer.name}`,
      '',
      '## What belongs here',
      '',
      '## How a document is named',
      '',
      '## Metadata it expects',
      '',
      '## What never goes in',
      '',
    ].join('\n'),
  }
}
