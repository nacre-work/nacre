import { describe, expect, it } from 'vitest'

import { linkTarget, parseInline, parseMarkdown, splitFrontmatter } from '../markdown.js'
import { carriesScripts, fileTree, folderFiles, orderPaths, writtenBy, type TreeNode } from '../skillfiles.js'

/**
 * The pure halves of the skill screens: how a skill's Markdown is read, and
 * what a picked folder becomes.
 *
 * The DOM half is photographed by `scripts/screenshots.mjs`. What is asked here
 * is what a picture cannot show — that raw HTML stays text, that a
 * `javascript:` link is never an anchor, and that a folder loaded through the
 * browser loses its own name and nothing else.
 */

describe('splitFrontmatter', () => {
  it('reads the name and description and returns the body after them', () => {
    const { front, body } = splitFrontmatter('---\nname: handbook\ndescription: "What the handbook holds."\n---\n\n# Handbook\n')
    expect(front).toEqual({ name: 'handbook', description: 'What the handbook holds.' })
    expect(body).toBe('\n# Handbook\n')
  })

  it('leaves a file without frontmatter whole', () => {
    expect(splitFrontmatter('# Title\n\ntext')).toEqual({ front: {}, body: '# Title\n\ntext' })
  })

  it('reads Windows line endings the same way', () => {
    expect(splitFrontmatter('---\r\nname: a\r\n---\r\nbody').front).toEqual({ name: 'a' })
  })
})

describe('parseMarkdown', () => {
  it('reads the blocks a skill is written in', () => {
    const blocks = parseMarkdown([
      '# What belongs here',
      '',
      'One paragraph',
      'over two lines.',
      '',
      '- first',
      '- second',
      '  continued',
      '',
      '1. one',
      '2. two',
      '',
      '> quoted',
      '',
      '---',
      '',
      '```bash',
      'nacre search "x"',
      '```',
      '',
      '| key | meaning |',
      '| --- | --- |',
      '| `source` | where it came from |',
    ].join('\n'))
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'list', 'list', 'quote', 'rule', 'code', 'table'])
    expect(blocks[1]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'One paragraph over two lines.' }] })
    expect(blocks[2]).toMatchObject({ kind: 'list', ordered: false, items: [[{ text: 'first' }], [{ text: 'second continued' }]] })
    expect(blocks[3]).toMatchObject({ kind: 'list', ordered: true })
    expect(blocks[6]).toEqual({ kind: 'code', lang: 'bash', text: 'nacre search "x"' })
    expect(blocks[7]).toMatchObject({ kind: 'table', head: [[{ text: 'key' }], [{ text: 'meaning' }]] })
  })

  it('keeps raw HTML as the characters it is', () => {
    const blocks = parseMarkdown('<img src=x onerror=alert(1)> and <script>alert(1)</script>')
    expect(blocks).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'text', text: '<img src=x onerror=alert(1)> and <script>alert(1)</script>' }] },
    ])
  })

  it('runs an unclosed fence to the end rather than dropping it', () => {
    expect(parseMarkdown('```\nsecret: no')).toEqual([{ kind: 'code', lang: '', text: 'secret: no' }])
  })
})

describe('parseInline', () => {
  it('reads code, emphasis and links', () => {
    expect(parseInline('Use `get_skill` **first**, then *read* [the guide](https://nacre.work).')).toEqual([
      { kind: 'text', text: 'Use ' },
      { kind: 'code', text: 'get_skill' },
      { kind: 'text', text: ' ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'first' }] },
      { kind: 'text', text: ', then ' },
      { kind: 'em', children: [{ kind: 'text', text: 'read' }] },
      { kind: 'text', text: ' ' },
      { kind: 'link', href: 'https://nacre.work', children: [{ kind: 'text', text: 'the guide' }] },
      { kind: 'text', text: '.' },
    ])
  })

  it('does not read an underscore inside a word as emphasis', () => {
    // A skill is where NACRE_S3_ENDPOINT and snake_case keys are written.
    expect(parseInline('set NACRE_S3_ENDPOINT and source_url')).toEqual([
      { kind: 'text', text: 'set NACRE_S3_ENDPOINT and source_url' },
    ])
  })

  it('does not read emphasis inside a code span', () => {
    expect(parseInline('`a*b*c`')).toEqual([{ kind: 'code', text: 'a*b*c' }])
  })
})

describe('linkTarget', () => {
  const files = new Set(['SKILL.md', 'FORMS.md', 'reference/keys.md'])

  it('opens http, https and mailto elsewhere', () => {
    expect(linkTarget('https://nacre.work', files).kind).toBe('external')
    expect(linkTarget('mailto:ops@example.com', files).kind).toBe('external')
  })

  it('opens a file the skill carries in the viewer', () => {
    expect(linkTarget('FORMS.md', files)).toEqual({ kind: 'file', to: 'FORMS.md' })
    expect(linkTarget('./reference/keys.md#top', files)).toEqual({ kind: 'file', to: 'reference/keys.md' })
  })

  it('never makes an anchor of anything else', () => {
    // A skill is written by whoever may write its level and read here by an
    // administrator: the stored-script shape, through a link.
    expect(linkTarget('javascript:alert(1)', files).kind).toBe('none')
    expect(linkTarget('JaVaScRiPt:alert(1)', files).kind).toBe('none')
    expect(linkTarget('data:text/html,<script>', files).kind).toBe('none')
    expect(linkTarget('missing.md', files).kind).toBe('none')
  })
})

describe('folderFiles', () => {
  it('drops the folder name a browser puts first', () => {
    const folder = folderFiles([
      { path: 'handbook/SKILL.md', text: '---\nname: handbook\n---\nbody' },
      { path: 'handbook/reference/keys.md', text: 'keys' },
    ])
    expect(Object.keys(folder.files).sort()).toEqual(['SKILL.md', 'reference/keys.md'])
    expect(folder.skipped).toEqual([])
  })

  it('leaves out hidden files and binary ones, and says so', () => {
    const folder = folderFiles([
      { path: 'handbook/SKILL.md', text: 'x' },
      { path: 'handbook/.DS_Store', text: 'Bud1' },
      { path: 'handbook/.git/config', text: '[core]' },
      { path: 'handbook/logo.png', text: '\u0000PNG' },
    ])
    expect(Object.keys(folder.files)).toEqual(['SKILL.md'])
    expect(folder.skipped).toEqual([
      { path: '.DS_Store', why: 'hidden' },
      { path: '.git/config', why: 'hidden' },
      { path: 'logo.png', why: 'not text' },
    ])
  })

  it('keeps a single file picked without a folder', () => {
    expect(Object.keys(folderFiles([{ path: 'SKILL.md', text: 'x' }]).files)).toEqual(['SKILL.md'])
  })
})

describe('the rest', () => {
  it('names scripts by where they live', () => {
    expect(carriesScripts(['SKILL.md', 'scripts/run.sh'])).toBe(true)
    expect(carriesScripts(['SKILL.md', 'reference/scripts.md'])).toBe(false)
  })

  it('puts SKILL.md first', () => {
    expect(orderPaths(['b.md', 'SKILL.md', 'a.md'])).toEqual(['SKILL.md', 'a.md', 'b.md'])
  })

  it('names a writer, and falls back to the kind rather than the uuid', () => {
    const names = new Map([['u1', 'dana@example.com']])
    expect(writtenBy('user:u1', names)).toBe('dana@example.com')
    expect(writtenBy('user:unknown', names)).toBe('a person')
    expect(writtenBy('service_account:sa', names)).toBe('a service account')
  })
})

describe('fileTree', () => {
  it('nests files under their folders, files before folders, SKILL.md first', () => {
    const tree = fileTree([
      'scripts/check-tags.sh',
      'reference/teams/finance.md',
      'TAGS.md',
      'reference/tags.md',
      'SKILL.md',
      'reference/teams/engineering.md',
    ])
    const shape = (nodes: readonly TreeNode[]): unknown[] =>
      nodes.map((n) => (n.kind === 'file' ? n.path : { [n.path]: shape(n.children) }))
    expect(shape(tree)).toEqual([
      'SKILL.md',
      'TAGS.md',
      { reference: ['reference/tags.md', { 'reference/teams': ['reference/teams/engineering.md', 'reference/teams/finance.md'] }] },
      { scripts: ['scripts/check-tags.sh'] },
    ])
  })

  it('keeps a file name apart from its folder', () => {
    const [dir] = fileTree(['reference/README.md'])
    expect(dir).toMatchObject({ kind: 'dir', name: 'reference', children: [{ kind: 'file', name: 'README.md', path: 'reference/README.md' }] })
  })
})
