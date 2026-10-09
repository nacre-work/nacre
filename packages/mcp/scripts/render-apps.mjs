#!/usr/bin/env node
/* global window, document, getComputedStyle -- evaluated in the page, not in Node */
/**
 * Render the MCP App views in a real browser, inside a real host bridge.
 *
 * A view's job is to look right and to work inside a host's iframe, and both
 * are a browser's business: a stub of `postMessage` agrees with whatever it was
 * written to. So the host here is the extension's own `AppBridge`, bundled for
 * the page; the view is the built HTML the package ships, loaded as the
 * iframe's document; and the tool calls a view makes through the host are
 * answered from fixtures. Nothing reaches a server.
 *
 * Each view at 600 and 390, light and dark. The CLAUDE.md note about the
 * layers view's More button says "the render harness presses More twice" —
 * the harness that sentence described was never committed, so the property it
 * checked was held by nobody. It is here now, and asserted: two presses, and
 * the button's computed display, because `hidden` losing to `.btn` is exactly
 * what made it append the first page again.
 *
 *   node packages/mcp/scripts/render-apps.mjs [--out dir]
 *
 * `NACRE_PLAYWRIGHT` names the playwright module, as for the console's
 * screenshots. Exits non-zero on any page error or failed assertion.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const outAt = process.argv.indexOf('--out')
const out = outAt === -1 ? `${tmpdir()}/nacre-app-shots` : process.argv[outAt + 1]
mkdirSync(out, { recursive: true })

const { chromium } = await import(process.env.NACRE_PLAYWRIGHT ?? 'playwright')

// The host half: an AppBridge with no MCP client, answering tool calls from
// the page's fixtures, and delivering the tool's input and then its result
// once the view says it is initialized — the order the protocol requires.
const host = await esbuild.build({
  stdin: {
    contents: `
      import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
      window.startHost = async (html, theme, input, result) => {
        const frame = document.querySelector('iframe')
        const bridge = new AppBridge(null, { name: 'render', version: '0' }, { serverTools: {} }, { hostContext: { theme } })
        bridge.oncalltool = async (params) => window.__call(params.name, params.arguments ?? {})
        bridge.oninitialized = () => {
          bridge.sendToolInput({ arguments: input })
          bridge.sendToolResult(result)
        }
        await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow))
        frame.srcdoc = html
      }
    `,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
})
const hostScript = host.outputFiles[0].text

const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

/** A fixture answer that is a refusal rather than a value. */
class Refusal {
  constructor(message) {
    this.message = message
  }
}

const PROPOSED = {
  proposed: 'Give the person dana@example.com read on the layer handbook.',
  details: [
    { label: 'person', value: 'dana@example.com' },
    { label: 'layer', value: 'handbook' },
    { label: 'permission', value: 'read' },
  ],
  status: 'Waiting for the person to apply it. Nothing has changed.',
  expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
  how_it_is_applied: 'The person applies or cancels it in the panel shown with this result.',
}
const withProposal = (value) => ({
  ...text(value),
  _meta: { 'nacre/proposal': { id: '3f1c2b9e-5d7a-4e21-9c84-0a6b2f1d7e55', expires_at: value.expires_at } },
})

const SKILL_MD = `---
name: handbook
description: How the handbook is kept — one page per policy, named by topic.
---

# Handbook

Every policy is **one document**, named by its topic: \`leave-policy\`, \`expenses\`.

- Tag each with \`owner\` and \`reviewed\`.
- Before adding one, search for it: a second page on one policy is the mistake this layer is set up against.

See [the naming reference](reference/naming.md) for the full list.

> Never store a salary here; that belongs in \`hr-private\`.
`
const SKILL_FILES = {
  'SKILL.md': SKILL_MD,
  'reference/naming.md': '# Naming\n\nTopic first, then the year when a policy is versioned by year: `travel-2026`.\n',
  'reference/owners.md': '# Owners\n\n| Topic | Owner |\n|---|---|\n| leave | people-ops |\n| expenses | finance |\n',
  'scripts/check-names.py': 'import sys\n\nfor line in sys.stdin:\n    print(line.strip().lower())\n',
}

const LAYER_ROWS = (from, n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `l${String(from + i)}`,
    slug: `layer-${String(from + i)}`,
    name: `Layer ${String(from + i)}`,
    description: i % 3 === 0 ? 'Policies, handbooks and the things people look up twice a year.' : '',
    documentCount: 10 + i,
  }))

/** One scenario per picture: the tool that opened the view, its result, and what the view may call. */
const SCENARIOS = [
  {
    view: 'skill',
    name: 'skill',
    input: { skill: 'handbook' },
    result: text({
      skill: 'handbook',
      level: 'layer',
      name: 'handbook',
      description: 'How the handbook is kept — one page per policy, named by topic.',
      version: 4,
      has_scripts: true,
      by_agent: true,
      writable: true,
      paths: Object.keys(SKILL_FILES),
      path: 'SKILL.md',
      content: SKILL_MD,
    }),
    calls: {
      get_skill: (args) => ({ skill: 'handbook', level: 'layer', name: 'handbook', description: '', version: 4, has_scripts: true, paths: Object.keys(SKILL_FILES), path: args.path ?? 'SKILL.md', content: SKILL_FILES[args.path ?? 'SKILL.md'] }),
    },
    check: async (frame) => {
      const files = await frame.locator('.tree button').count()
      if (files !== 4) throw new Error(`the tree shows ${String(files)} files, expected 4`)
      if ((await frame.locator('.md h3').first().textContent()) !== 'Handbook') throw new Error('SKILL.md is not rendered')
      if ((await frame.locator('.replace').count()) !== 1) throw new Error('a writable skill offers no load')
      // A file opened from the tree is fetched through the host and shown.
      await frame.locator('.tree button', { hasText: 'naming.md' }).click()
      await frame.locator('.viewer-bar code', { hasText: 'reference/naming.md' }).waitFor()
      await frame.locator('.tree button', { hasText: 'SKILL.md' }).click()
      await frame.locator('.viewer-bar code', { hasText: 'SKILL.md' }).waitFor()
    },
  },
  {
    view: 'skill',
    name: 'skill-read-only',
    input: { skill: 'base' },
    result: text({
      skill: 'base',
      level: 'organization',
      name: 'acme',
      description: 'How Acme keeps its index.',
      version: 2,
      has_scripts: false,
      writable: false,
      paths: ['SKILL.md'],
      path: 'SKILL.md',
      content: '---\nname: acme\ndescription: How Acme keeps its index.\n---\n\n# Acme\n\nSearch before you write. A contract number is its own `external_id`.\n',
    }),
    calls: {},
    check: async (frame) => {
      if ((await frame.locator('.replace').count()) !== 0) throw new Error('a skill this caller may not write offers a load')
    },
  },
  {
    view: 'skill',
    name: 'skills-list',
    input: {},
    result: text({
      base: { level: 'organization', layerSlug: null, name: 'acme', description: 'How Acme keeps its index.', version: 2, hasScripts: false },
      layers: [
        { level: 'layer', layerSlug: 'handbook', name: 'handbook', description: 'One page per policy, named by topic.', version: 4, hasScripts: true },
        { level: 'layer', layerSlug: 'contracts', name: 'contracts', description: 'Signed PDFs, one per counterparty.', version: 1, hasScripts: false },
      ],
      next_cursor: null,
    }),
    calls: {},
    check: async (frame) => {
      const rows = await frame.locator('tbody tr').count()
      if (rows !== 3) throw new Error(`the list shows ${String(rows)} skills, expected 3`)
    },
  },
  {
    view: 'change',
    name: 'change',
    input: { person: 'dana@example.com', layer: 'handbook', permission: 'read' },
    result: withProposal(PROPOSED),
    calls: {
      apply_proposal: (args) => {
        if (args.proposal !== '3f1c2b9e-5d7a-4e21-9c84-0a6b2f1d7e55') throw new Error(`applied ${String(args.proposal)}, not the proposal in _meta`)
        return { applied: true, result: { grant_id: 'g1' } }
      },
    },
    check: async (frame) => {
      if ((await frame.locator('.facts dt').count()) !== 3) throw new Error('the panel does not show the three facts')
      if (!(await frame.locator('.when').textContent())?.includes('expires in')) throw new Error('the panel does not say when it expires')
      await frame.locator('button', { hasText: 'Apply' }).click()
      await frame.locator('.status', { hasText: 'Applied.' }).waitFor()
      const display = await frame.locator('button', { hasText: 'Apply' }).evaluate((b) => getComputedStyle(b).display)
      if (display !== 'none') throw new Error(`Apply is still displayed (${display}) after applying`)
    },
  },
  {
    view: 'change',
    name: 'change-refused',
    input: { person: 'dana@example.com', layer: 'handbook', permission: 'read' },
    result: withProposal(PROPOSED),
    calls: {
      apply_proposal: () => new Refusal('That scope is not one you may administer, or it no longer exists.'),
    },
    check: async (frame) => {
      await frame.locator('button', { hasText: 'Apply' }).click()
      await frame.locator('.status[data-kind=error]', { hasText: 'may administer' }).waitFor()
    },
  },
  {
    view: 'change',
    name: 'change-no-panel-id',
    input: {},
    result: text(PROPOSED),
    calls: {},
    check: async (frame) => {
      // A host that drops _meta: the panel must not offer a button it cannot honour.
      if ((await frame.locator('button', { hasText: 'Apply' }).evaluate((b) => getComputedStyle(b).display)) !== 'none') {
        throw new Error('Apply is offered with no proposal to apply')
      }
      if (!(await frame.locator('.status').textContent())?.includes('Proposals screen')) throw new Error('the panel does not say where the proposal waits')
    },
  },
  {
    view: 'layers',
    name: 'layers',
    input: {},
    result: text({ layers: LAYER_ROWS(1, 8), next_cursor: 'c1' }),
    calls: {
      list_layers: (args) => (args.cursor === 'c1' ? { layers: LAYER_ROWS(9, 8), next_cursor: null } : { layers: LAYER_ROWS(1, 8), next_cursor: 'c1' }),
    },
    check: async (frame) => {
      const more = frame.locator('button', { hasText: 'More' })
      await more.click()
      await frame.locator('tbody tr').nth(15).waitFor()
      const display = await more.evaluate((b) => getComputedStyle(b).display)
      if (display !== 'none') throw new Error(`More is still displayed (${display}) with no next page`)
      await more.click({ force: true }).catch(() => undefined)
      const rows = await frame.locator('tbody tr').count()
      if (rows !== 16) throw new Error(`pressing More twice left ${String(rows)} rows, expected 16`)
    },
  },
]

const browser = await chromium.launch(process.env.NACRE_CHROMIUM ? { executablePath: process.env.NACRE_CHROMIUM } : {})
const problems = []
try {
  for (const scenario of SCENARIOS) {
    const html = readFileSync(`${root}apps/build/${scenario.view}.html`, 'utf8')
    for (const theme of ['light', 'dark']) {
      for (const width of [600, 390]) {
        const label = `${scenario.name}-${String(width)}-${theme}`
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme })
        page.on('pageerror', (error) => problems.push(`${label}: page error ${String(error)}`))
        await page.exposeFunction('__call', (name, args) => {
          const answer = scenario.calls[name]
          if (answer === undefined) return { content: [{ type: 'text', text: `no fixture for ${name}` }], isError: true }
          const value = answer(args)
          if (value instanceof Refusal) return { content: [{ type: 'text', text: value.message }], isError: true }
          return text(value)
        })
        await page.setContent(
          `<!doctype html><html><head><style>html,body{margin:0;background:${theme === 'dark' ? '#111' : '#fff'}}iframe{border:0;width:100%;height:880px;display:block}</style></head><body><iframe sandbox="allow-scripts allow-same-origin"></iframe><script>${hostScript}</script></body></html>`,
        )
        await page.evaluate(([h, t, i, r]) => window.startHost(h, t, i, r), [html, theme, scenario.input, scenario.result])
        const frame = page.frameLocator('iframe')
        await frame.locator('main').waitFor()
        await page.waitForTimeout(400)
        if (theme === 'light' && width === 600) {
          try {
            await scenario.check(frame)
          } catch (error) {
            problems.push(`${label}: ${String(error instanceof Error ? error.message : error)}`)
          }
        }
        const height = await page.frameLocator('iframe').locator('body').evaluate((b) => b.scrollHeight)
        await page.setViewportSize({ width, height: Math.min(Math.max(height + 20, 300), 2400) })
        await page.evaluate((h) => { document.querySelector('iframe').style.height = `${String(h)}px` }, Math.min(Math.max(height, 280), 2380))
        await page.screenshot({ path: `${out}/${label}.png`, fullPage: true })
        await page.close()
      }
    }
  }
} finally {
  await browser.close()
}

for (const problem of problems) console.error(`::error::${problem}`)
console.log(`${String(SCENARIOS.length * 4)} renders in ${out}`)
process.exit(problems.length === 0 ? 0 : 1)
