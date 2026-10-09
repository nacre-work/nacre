import { h } from './dom.js'

/**
 * A skill's Markdown, drawn as text.
 *
 * A skill is written by whoever may write its level — on a layer, somebody
 * holding `admin` there, or an agent they connected — and it is read here by
 * an organization administrator. That is the stored-script shape `dom.ts`'s
 * header is about, so nothing in this file goes near `innerHTML`: the text is
 * parsed into a small tree, and the tree is built with `h`, which sets text
 * through `textContent`. Raw HTML in a skill is shown as the characters it is.
 *
 * By hand rather than a dependency, on the argument this package already makes
 * for having one: a Markdown library is the largest thing that could be added
 * here, and the subset a skill uses — headings, paragraphs, lists, fenced code,
 * quotes, tables, emphasis and links — is small. What it does not support it
 * shows as written, which is never wrong, only plainer.
 *
 * Links are the one judgement. `http:`, `https:` and `mailto:` become anchors
 * that open elsewhere and carry no referrer; a link to a file the skill itself
 * carries — `[forms](FORMS.md)`, which is how a skill points at its own
 * reference files — opens that file in the viewer; anything else, `javascript:`
 * included, is its text and nothing more.
 *
 * The parser is pure and is what `__tests__/markdown.test.ts` asks; the
 * renderer is a walk over its output.
 */

export type Inline =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'code'; readonly text: string }
  | { readonly kind: 'strong'; readonly children: readonly Inline[] }
  | { readonly kind: 'em'; readonly children: readonly Inline[] }
  | { readonly kind: 'link'; readonly href: string; readonly children: readonly Inline[] }

export type Block =
  | { readonly kind: 'heading'; readonly level: number; readonly inline: readonly Inline[] }
  | { readonly kind: 'paragraph'; readonly inline: readonly Inline[] }
  | { readonly kind: 'code'; readonly lang: string; readonly text: string }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly (readonly Inline[])[] }
  | { readonly kind: 'quote'; readonly inline: readonly Inline[] }
  | { readonly kind: 'rule' }
  | { readonly kind: 'table'; readonly head: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] }

/** The frontmatter and the body, split the way `SKILL.md` is read. */
export function splitFrontmatter(text: string): { readonly front: Readonly<Record<string, string>>; readonly body: string } {
  const normalized = text.replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
  if (match === null) return { front: {}, body: normalized }
  const front: Record<string, string> = {}
  for (const line of (match[1] ?? '').split('\n')) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (pair === null) continue
    front[pair[1] as string] = (pair[2] ?? '').replace(/^(['"])(.*)\1$/, '$2').trim()
  }
  return { front, body: normalized.slice(match[0].length) }
}

const FENCE = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/

const cells = (line: string): string[] => {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((c) => c.trim())
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  const paragraphEnds = (line: string): boolean =>
    line.trim() === '' ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    QUOTE.test(line)

  while (i < lines.length) {
    const line = lines[i] as string

    if (line.trim() === '') {
      i += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[2] as string
      const body: string[] = []
      i += 1
      // An unclosed fence runs to the end, as every renderer reads one.
      while (i < lines.length && !(lines[i] as string).trim().startsWith(marker)) {
        body.push(lines[i] as string)
        i += 1
      }
      i += 1
      blocks.push({ kind: 'code', lang: fence[3] ?? '', text: body.join('\n') })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: 'heading', level: (heading[1] as string).length, inline: parseInline(heading[2] ?? '') })
      i += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1] as string)) {
      const head = cells(line).map(parseInline)
      const rows: (readonly Inline[])[][] = []
      i += 2
      while (i < lines.length && (lines[i] as string).includes('|') && (lines[i] as string).trim() !== '') {
        rows.push(cells(lines[i] as string).map(parseInline))
        i += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i] as string)) {
        body.push((QUOTE.exec(lines[i] as string) as RegExpExecArray)[1] ?? '')
        i += 1
      }
      blocks.push({ kind: 'quote', inline: parseInline(body.join(' ').trim()) })
      continue
    }

    const ordered = NUMBERED.test(line)
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? NUMBERED : BULLET
      const items: string[] = []
      while (i < lines.length) {
        const current = lines[i] as string
        const item = marker.exec(current)
        if (item !== null) {
          items.push(item[1] ?? '')
        } else if (current.trim() !== '' && /^\s{2,}/.test(current) && items.length > 0) {
          // A continuation, or a nested item: kept as text of the item above
          // rather than dropped, which is plainer and never loses a word.
          items[items.length - 1] += ` ${current.trim()}`
        } else {
          break
        }
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items: items.map(parseInline) })
      continue
    }

    const body: string[] = [line.trim()]
    i += 1
    while (i < lines.length && !paragraphEnds(lines[i] as string)) {
      body.push((lines[i] as string).trim())
      i += 1
    }
    blocks.push({ kind: 'paragraph', inline: parseInline(body.join(' ')) })
  }

  return blocks
}

/** Find the closing delimiter, skipping over a code span on the way. */
function closing(text: string, from: number, delimiter: string): number {
  let j = from
  while (j < text.length) {
    if (text[j] === '`') {
      const end = text.indexOf('`', j + 1)
      if (end === -1) return -1
      j = end + 1
      continue
    }
    if (text.startsWith(delimiter, j)) return j
    j += 1
  }
  return -1
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let buffer = ''
  const flush = (): void => {
    if (buffer !== '') out.push({ kind: 'text', text: buffer })
    buffer = ''
  }

  let i = 0
  while (i < text.length) {
    const c = text[i] as string

    if (c === '\\' && i + 1 < text.length && /[\\`*_[\]()#|>-]/.test(text[i + 1] as string)) {
      buffer += text[i + 1]
      i += 2
      continue
    }

    if (c === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        flush()
        out.push({ kind: 'code', text: text.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }

    if (c === '[') {
      const close = closing(text, i + 1, ']')
      if (close > i && text[close + 1] === '(') {
        const end = text.indexOf(')', close + 2)
        if (end > close) {
          flush()
          const href = text.slice(close + 2, end).trim().split(/\s+/)[0] ?? ''
          out.push({ kind: 'link', href, children: parseInline(text.slice(i + 1, close)) })
          i = end + 1
          continue
        }
      }
    }

    if ((c === '*' || c === '_') && text[i + 1] === c) {
      const end = closing(text, i + 2, c + c)
      if (end > i + 2) {
        flush()
        out.push({ kind: 'strong', children: parseInline(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // `_` inside a word is a word: snake_case and NACRE_S3_ENDPOINT are not
    // emphasis, and a skill is exactly where those are written.
    const wordBefore = i > 0 && /\w/.test(text[i - 1] as string)
    if ((c === '*' || (c === '_' && !wordBefore)) && text[i + 1] !== undefined && text[i + 1] !== ' ') {
      const end = closing(text, i + 1, c)
      const after = text[end + 1]
      if (end > i + 1 && text[end - 1] !== ' ' && !(c === '_' && after !== undefined && /\w/.test(after))) {
        flush()
        out.push({ kind: 'em', children: parseInline(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    buffer += c
    i += 1
  }
  flush()
  return out
}

/** What a link becomes: an anchor elsewhere, a file in this skill, or text. */
export function linkTarget(href: string, files: ReadonlySet<string>): { readonly kind: 'external' | 'file' | 'none'; readonly to: string } {
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', to: href }
  const path = href.replace(/^\.\//, '').split('#')[0] ?? ''
  if (files.has(path)) return { kind: 'file', to: path }
  return { kind: 'none', to: href }
}

export interface RenderOptions {
  /** The paths the skill carries, so a link to one can open it here. */
  readonly files: ReadonlySet<string>
  readonly open: (path: string) => void
}

function inlineNodes(inline: readonly Inline[], options: RenderOptions): Node[] {
  return inline.map((node): Node => {
    switch (node.kind) {
      case 'text':
        return document.createTextNode(node.text)
      case 'code':
        return h('code', {}, node.text)
      case 'strong':
        return h('strong', {}, ...inlineNodes(node.children, options))
      case 'em':
        return h('em', {}, ...inlineNodes(node.children, options))
      case 'link': {
        const target = linkTarget(node.href, options.files)
        const children = inlineNodes(node.children, options)
        if (target.kind === 'external') {
          return h('a', { href: target.to, target: '_blank', rel: 'noopener noreferrer' }, ...children)
        }
        if (target.kind === 'file') {
          return h('a', {
            href: '#',
            onclick: (e: Event) => {
              e.preventDefault()
              options.open(target.to)
            },
          }, ...children)
        }
        return h('span', {}, ...children)
      }
    }
  })
}

export function renderMarkdown(text: string, options: RenderOptions): HTMLElement {
  const root = h('div', { class: 'md' })
  for (const block of parseMarkdown(text)) {
    switch (block.kind) {
      case 'heading': {
        // One step down, so a skill's own `#` does not compete with the
        // screen's heading — and never below h6.
        const tag = `h${String(Math.min(6, block.level + 2))}` as 'h3'
        root.append(h(tag, {}, ...inlineNodes(block.inline, options)))
        break
      }
      case 'paragraph':
        root.append(h('p', {}, ...inlineNodes(block.inline, options)))
        break
      case 'code':
        root.append(h('pre', {}, h('code', {}, block.text)))
        break
      case 'list': {
        const list = h(block.ordered ? 'ol' : 'ul', {})
        for (const item of block.items) list.append(h('li', {}, ...inlineNodes(item, options)))
        root.append(list)
        break
      }
      case 'quote':
        root.append(h('blockquote', {}, ...inlineNodes(block.inline, options)))
        break
      case 'rule':
        root.append(h('hr', {}))
        break
      case 'table':
        root.append(
          h('div', { class: 'md-table' },
            h('table', {},
              h('thead', {}, h('tr', {}, ...block.head.map((c) => h('th', {}, ...inlineNodes(c, options))))),
              h('tbody', {}, ...block.rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, ...inlineNodes(c, options)))))),
            ),
          ),
        )
        break
    }
  }
  return root
}
