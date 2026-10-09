/**
 * `ui://nacre/skill.html` — a skill as the console shows one. docs/skills.md.
 *
 * Opened by `get_skill`, which hands over one file of a skill, and by
 * `list_skills`, which hands over the catalog. The file tree, `SKILL.md`
 * rendered and as source, who wrote the version and whether it carries
 * scripts — and, where this caller may write it, loading a folder or a `.zip`,
 * shown before it is written and written through `update_skill` in the host, so
 * the permission check runs where it always runs.
 *
 * **One renderer, not two.** The Markdown is the console's own module, imported
 * across the package boundary at build time and bundled into this page: a skill
 * is written by somebody with `admin` on one layer and read by people with more,
 * which is the stored-script shape, and that module is the one place that has
 * already been made to draw it as text and nothing else. A second renderer here
 * would be a second chance to get `javascript:` or raw HTML wrong. The folder
 * reader and the tree are the console's too, for the same reason.
 *
 * The `.zip` is not read here. A browser has no `zlib`, and the server already
 * has one bounded reader for it, so the bytes go to `update_skill` as base64 —
 * through the host, never through the model.
 */
import { renderMarkdown, splitFrontmatter } from '../../admin/src/markdown.js'
import { carriesScripts, fileTree, folderFiles, orderPaths, type TreeNode } from '../../admin/src/skillfiles.js'

import { call, clear, connect, el, fileControl, mount, status } from './shared.js'

/** What `get_skill` answers: one file of one skill, and what the skill is. */
interface SkillFile {
  readonly skill: string
  readonly level: 'default' | 'installation' | 'organization' | 'layer'
  readonly name: string
  readonly description: string
  readonly version: number | null
  readonly has_scripts: boolean
  readonly by_agent?: boolean
  readonly writable?: boolean
  readonly paths: readonly string[]
  readonly path: string
  readonly content: string
}

/** What `list_skills` answers, as the store names the fields. */
interface Entry {
  readonly level: 'default' | 'installation' | 'organization' | 'layer'
  readonly layerSlug: string | null
  readonly name: string
  readonly description: string
  readonly version: number | null
  readonly hasScripts: boolean
}
interface Listing {
  readonly base: Entry
  readonly layers: readonly Entry[]
  readonly next_cursor: string | null
}

/**
 * The view's own rules, beside the shared vocabulary: a tree, a viewer, and
 * the console's `.md` treatment, which that module's markup expects. Tokens
 * only — `lint:tokens` is the console's, and this stylesheet answers to the
 * same rule by construction.
 */
const SKILL_STYLE = `
  .head { margin: 0 0 4px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 10px; }
  .head h2 { font-family: var(--n-font-display); font-size: 16px; margin: 0; }
  .tag { font-family: var(--n-font-mono); font-size: 10.5px; letter-spacing: 0.06em; text-transform: uppercase; padding: 1px 6px; border-radius: var(--n-radius); border: 1px solid var(--n-border-color); color: var(--n-text-muted); white-space: nowrap; }
  .tag.agent { border-color: var(--n-accent); color: var(--n-text); }
  .tag.scripts { border-color: var(--n-warn); color: var(--n-text); }
  .lede { margin: 0 0 12px; color: var(--n-text-muted); font-size: 13.5px; }
  .note { margin: 0 0 12px; padding: 8px 12px; border-left: 3px solid var(--n-warn); background: var(--n-surface-sunk); border-radius: var(--n-radius); font-size: 13px; }
  .skill { display: grid; grid-template-columns: minmax(9em, 13em) minmax(0, 1fr); gap: 12px; align-items: start; }
  @media (max-width: 520px) { .skill { grid-template-columns: minmax(0, 1fr); } }
  .tree { margin: 0; padding: 8px; list-style: none; border: 1px solid var(--n-border-color); border-radius: var(--n-radius); background: var(--n-surface-sunk); }
  .tree ul { list-style: none; margin: 0; padding-left: 14px; }
  .tree li { margin: 0; }
  .tree .dir { font-family: var(--n-font-mono); font-size: 12px; color: var(--n-text-faint); padding: 4px 6px 2px; }
  .tree button { display: block; width: 100%; min-height: 30px; text-align: left; font-family: var(--n-font-mono); font-size: 12.5px; padding: 4px 6px; border: 0; border-radius: var(--n-radius); background: transparent; color: var(--n-text); cursor: pointer; overflow-wrap: anywhere; touch-action: manipulation; }
  .tree button[aria-current=true] { background: var(--n-surface); box-shadow: inset 2px 0 0 var(--n-accent); }
  .viewer { min-width: 0; border: 1px solid var(--n-border-color); border-radius: var(--n-radius); background: var(--n-bg); }
  .viewer-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--n-border-color); }
  .viewer-bar code { color: var(--n-text-muted); }
  .seg { display: inline-flex; border: 1px solid var(--n-border-color); border-radius: var(--n-radius); overflow: hidden; }
  .seg button { height: 30px; padding: 0 10px; border: 0; background: var(--n-surface); color: var(--n-text-muted); font: inherit; font-size: 13px; cursor: pointer; touch-action: manipulation; }
  .seg button[aria-pressed=true] { background: var(--n-surface-sunk); color: var(--n-text); font-weight: 600; }
  .viewer-body { padding: 12px 14px; overflow-x: auto; }
  .viewer-body pre.source { margin: 0; font-family: var(--n-font-mono); font-size: 12.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .md h3, .md h4, .md h5, .md h6 { font-family: var(--n-font-display); margin: 14px 0 6px; }
  .md h3:first-child { margin-top: 0; }
  .md p, .md ul, .md ol, .md blockquote, .md pre, .md .md-table { margin: 0 0 10px; }
  .md ul, .md ol { padding-left: 22px; }
  .md pre { background: var(--n-surface-sunk); border-radius: var(--n-radius); padding: 8px 10px; overflow-x: auto; }
  /* Inline code in prose wraps where words do. The shared rule breaks a
     code span anywhere, which is right for an id in a table cell and wrong
     here: the first render split leave-policy after its first letter. */
  .md code { word-break: normal; overflow-wrap: break-word; }
  .md pre code { word-break: normal; white-space: pre; }
  .md blockquote { border-left: 3px solid var(--n-rule); padding-left: 10px; color: var(--n-text-muted); }
  .md a { color: var(--n-accent); }
  .md table { border-collapse: collapse; }
  .md th, .md td { border: 1px solid var(--n-border-color); padding: 4px 8px; text-align: left; }
  .replace { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--n-rule); }
  .replace h3 { font-family: var(--n-font-display); font-size: 14px; margin: 0 0 8px; }
  .plain { list-style: none; padding: 0; margin: 8px 0; font-size: 13px; }
  .plain li { margin: 0 0 2px; }
`

async function main(): Promise<void> {
  const style = el('style')
  style.textContent = SKILL_STYLE
  document.head.append(style)
  const root = mount('Skill')
  const app = await connect('nacre-skill')

  const view = el('div')
  root.append(view)

  app.ontoolresult = (result) => {
    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (result.isError === true) {
      status(root, text, 'error')
      return
    }
    try {
      const value = JSON.parse(text) as Partial<SkillFile> & Partial<Listing>
      if (typeof value.content === 'string') void showSkill(value as SkillFile)
      else if (value.base !== undefined) showList(value as Listing)
      else status(root, 'The result could not be read.', 'error')
    } catch {
      status(root, 'The result could not be read.', 'error')
    }
  }

  /** The catalog, each row opening its skill through the host. */
  function showList(listing: Listing): void {
    clear(view)
    const entries = [listing.base, ...listing.layers]
    const body = el('tbody')
    for (const entry of entries) {
      const which = entry.level === 'layer' && entry.layerSlug !== null ? entry.layerSlug : 'base'
      const open = el('button', { type: 'button', class: 'btn' }, 'Open')
      open.addEventListener('click', () => {
        void (async () => {
          open.setAttribute('disabled', '')
          const answer = await call(app, 'get_skill', { skill: which })
          open.removeAttribute('disabled')
          if (!answer.ok) {
            status(root, answer.message, 'error')
            return
          }
          await showSkill(answer.value as SkillFile)
        })()
      })
      body.append(
        el(
          'tr',
          {},
          el('td', {}, entry.name, ...(entry.description === '' ? [] : [el('span', { class: 'sub' }, entry.description)])),
          el('td', {}, entry.level === 'layer' ? el('code', { class: 'slug' }, entry.layerSlug ?? '') : levelName(entry.level)),
          el('td', { class: 'num' }, entry.version === null ? '—' : `v${String(entry.version)}`),
          el('td', {}, open),
        ),
      )
    }
    view.append(
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          { class: 'table' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Skill'), el('th', {}, 'Applies to'), el('th', { class: 'num' }, 'Version'), el('th', {}, ''))),
          body,
        ),
      ),
    )
    status(root, `${String(entries.length)} skill${entries.length === 1 ? '' : 's'} you may read${listing.next_cursor === null ? '.' : ' — more in list_skills.'}`)
  }

  /** One skill: the tree, the viewer, and the load where this caller may write. */
  async function showSkill(first: SkillFile): Promise<void> {
    clear(view)
    const files = new Map<string, string>([[first.path, first.content]])
    const paths = new Set(first.paths)
    let current = first.path
    let mode: 'rendered' | 'source' = 'rendered'

    const tags = [
      el('span', { class: 'tag' }, first.level === 'layer' ? `layer ${first.skill}` : levelName(first.level)),
      ...(first.version === null ? [] : [el('span', { class: 'tag' }, `v${String(first.version)}`)]),
      ...(first.by_agent === true ? [el('span', { class: 'tag agent' }, 'written by an agent')] : []),
      ...(first.has_scripts ? [el('span', { class: 'tag scripts' }, 'scripts')] : []),
    ]
    view.append(el('div', { class: 'head' }, el('h2', {}, first.name || 'Skill'), ...tags))
    if (first.description !== '') view.append(el('p', { class: 'lede' }, first.description))
    if (first.has_scripts) {
      view.append(
        el('p', { class: 'note' }, 'Files under scripts/ run on the agent’s side, and only with your approval — never here.'),
      )
    }

    const tree = el('ul', { class: 'tree' })
    const bar = el('div', { class: 'viewer-bar' })
    const body = el('div', { class: 'viewer-body' })
    view.append(el('div', { class: 'skill' }, tree, el('div', { class: 'viewer' }, bar, body)))

    const open = async (path: string): Promise<void> => {
      if (!files.has(path)) {
        const answer = await call(app, 'get_skill', { skill: first.skill, path })
        if (!answer.ok) {
          status(root, answer.message, 'error')
          return
        }
        files.set(path, (answer.value as SkillFile).content)
      }
      current = path
      draw()
    }

    const drawTree = (nodes: readonly TreeNode[], into: HTMLElement): void => {
      for (const node of nodes) {
        if (node.kind === 'dir') {
          const list = el('ul')
          drawTree(node.children, list)
          into.append(el('li', {}, el('div', { class: 'dir' }, `${node.name}/`), list))
        } else {
          const button = el('button', { type: 'button', 'aria-current': String(node.path === current) }, node.name)
          button.addEventListener('click', () => void open(node.path))
          into.append(el('li', {}, button))
        }
      }
    }

    const draw = (): void => {
      clear(tree)
      drawTree(fileTree(orderPaths([...paths])), tree)
      clear(bar)
      clear(body)
      const text = files.get(current) ?? ''
      const markdown = current.toLowerCase().endsWith('.md')
      const seg = el('span', { class: 'seg' })
      for (const [value, label] of [['rendered', 'Rendered'], ['source', 'Source']] as const) {
        const b = el('button', { type: 'button', 'aria-pressed': String(mode === value) }, label)
        b.addEventListener('click', () => {
          mode = value
          draw()
        })
        seg.append(b)
      }
      bar.append(el('code', {}, current), ...(markdown ? [seg] : []))
      body.append(
        markdown && mode === 'rendered'
          ? renderMarkdown(splitFrontmatter(text).body, { files: paths, open: (path) => void open(path) })
          : el('pre', { class: 'source' }, text),
      )
    }
    draw()

    if (first.writable === true && first.level === 'layer') view.append(replaceSection(first))
    status(root, '')
  }

  /**
   * Loading a new version, shown before it is written. A folder is read here
   * by the console's own reader; a `.zip` goes to the server whole.
   */
  function replaceSection(skill: SkillFile): HTMLElement {
    const section = el('section', { class: 'replace' }, el('h3', {}, 'Replace this skill'))
    const folderInput = el('input', { type: 'file', webkitdirectory: '', multiple: '' })
    const zipInput = el('input', { type: 'file', accept: '.zip,application/zip' })
    const preview = el('div')
    section.append(
      el('div', { class: 'row' }, fileControl(folderInput, 'Load a folder'), fileControl(zipInput, 'Load a .zip')),
      preview,
    )

    const offer = (summary: HTMLElement, send: Record<string, unknown>): void => {
      clear(preview)
      const write = el('button', { type: 'button', class: 'btn btn-primary' }, `Write as version ${String((skill.version ?? 0) + 1)}`)
      write.addEventListener('click', () => {
        void (async () => {
          write.setAttribute('disabled', '')
          const answer = await call(app, 'update_skill', { skill: skill.skill, based_on: skill.version ?? 0, ...send })
          write.removeAttribute('disabled')
          if (!answer.ok) {
            status(root, answer.message, 'error')
            return
          }
          const written = answer.value as { version: number; cleared: boolean }
          const fresh = await call(app, 'get_skill', { skill: skill.skill })
          if (fresh.ok) await showSkill(fresh.value as SkillFile)
          status(root, written.cleared ? 'The skill was cleared.' : `Written as version ${String(written.version)}.`)
        })()
      })
      preview.append(summary, el('div', { class: 'row' }, write))
    }

    folderInput.addEventListener('change', () => {
      void (async () => {
        const picked = await Promise.all(
          [...(folderInput.files ?? [])].map(async (f) => ({ path: f.webkitRelativePath || f.name, text: await f.text() })),
        )
        const folder = folderFiles(picked)
        const names = orderPaths(Object.keys(folder.files))
        if (!names.includes('SKILL.md')) {
          clear(preview)
          status(root, 'That folder has no SKILL.md at its top, so it is not a skill.', 'error')
          return
        }
        const summary = el(
          'div',
          {},
          el('ul', { class: 'plain' }, ...names.map((n) => el('li', {}, el('code', {}, n)))),
          ...(folder.skipped.length === 0
            ? []
            : [el('p', { class: 'lede' }, `Left out: ${folder.skipped.map((s) => `${s.path} (${s.why})`).join(', ')}.`)]),
          ...(carriesScripts(names) ? [el('p', { class: 'note' }, 'This version carries scripts.')] : []),
        )
        offer(summary, { files: folder.files })
      })()
    })

    zipInput.addEventListener('change', () => {
      void (async () => {
        const file = zipInput.files?.[0]
        if (file === undefined) return
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        offer(
          el('p', { class: 'lede' }, `${file.name} — read by the server, which refuses anything that is not a skill and says why.`),
          { zip_base64: btoa(binary) },
        )
      })()
    })

    return section
  }
}

function levelName(level: Entry['level']): string {
  return level === 'default' ? 'the default' : level === 'installation' ? 'the installation' : 'the organization'
}

void main()
