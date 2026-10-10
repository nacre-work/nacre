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

/** A fixture answer carrying `_meta` — what a write hands a panel and the model is not shown. */
class WithMeta {
  constructor(value, meta) {
    this.value = value
    this.meta = meta
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
const PROPOSED_SKILL = {
  proposed:
    "Write the layer handbook's skill as version 4: 2 files, including scripts. Read every file below before applying it — every later agent there follows it.",
  details: [
    { label: 'skill', value: "the layer handbook's skill" },
    { label: 'version', value: '3 → 4' },
    { label: 'note', value: 'Written by an agent, and marked as such in the history.' },
    { label: 'scripts', value: "1 file under scripts/, which an agent would run on its side with the person's approval." },
    { label: 'SKILL.md', value: '---\nname: handbook\ndescription: How documents in the handbook layer are named, tagged and updated.\n---\n\n# Handbook\n\nSearch the handbook before answering a policy question, and quote the section you used.\n\n- One document per policy, named after it: `leave-policy`, `expenses`.\n- Tag every document with `owner` and `reviewed`.\n- When a policy changes, update its document in place; never add a second copy.\n', text: true },
    { label: 'scripts/unreviewed.sh', value: '#!/bin/sh\n# Lists handbook documents not reviewed this year.\nnacre search --layer handbook --filter reviewed=2025\n', text: true },
  ],
  status: 'Waiting for the person to apply it. Nothing has changed.',
  expires_at: new Date(Date.now() + 9 * 60_000).toISOString(),
  how_it_is_applied: 'The person applies or cancels it in the panel shown with this result.',
}
const withProposal = (value) => ({
  ...text(value),
  _meta: { 'nacre/proposal': { id: '3f1c2b9e-5d7a-4e21-9c84-0a6b2f1d7e55', key: 'k7Qm2pXv9aLr4TnB8sWc1dYe6fGh3jKu5oZi0xNq_Rw', expires_at: value.expires_at } },
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

const ACTORS = {
  dana: { type: 'user', id: 'a1b2c3d4-0000-4000-8000-000000000001', name: 'dana@example.com' },
  ingest: { type: 'service_account', id: 'a1b2c3d4-0000-4000-8000-000000000002', name: 'nightly-ingest' },
  system: { type: 'system', id: null, name: null },
}
const EVENT = (actor, action, result, minutesAgo, connection = null) => ({
  at: new Date(Date.UTC(2026, 9, 9, 12, 0) - minutesAgo * 60_000).toISOString(),
  actor,
  action,
  result,
  surface: actor.type === 'system' ? 'system' : 'mcp',
  connection,
  target: {},
  detail: {},
})
const AUDIT_WINDOW = { from: '2026-10-02T12:00:00.000Z', to: '2026-10-09T12:00:00.000Z' }
const AUDIT_ALL = [
  EVENT(ACTORS.dana, 'search', 'allow', 4, 'connection:c1'),
  EVENT(ACTORS.ingest, 'ingest_document', 'allow', 9),
  EVENT(ACTORS.dana, 'get_document', 'deny', 15, 'connection:c1'),
  EVENT(ACTORS.system, 'proposal.expired', 'allow', 22),
]
const AUDIT_MORE = [EVENT(ACTORS.ingest, 'ingest_document', 'error', 40)]

const CONNECTIONS = (revoked) => ({
  notice: 'Names were written by people.',
  connections: [
    {
      id: 'c1',
      application: 'Claude',
      administrative: false,
      acts_as: { person: 'dana@example.com' },
      approved_by: 'dana@example.com',
      approver_disabled: false,
      ceiling: ['read'],
      layers: 'every layer the person reaches',
      created_at: '2026-10-01T09:00:00.000Z',
      last_refreshed_at: '2026-10-09T11:40:00.000Z',
      revoked,
    },
    {
      id: 'c2',
      application: 'Claude',
      administrative: true,
      acts_as: { person: 'lee@example.com' },
      approved_by: 'lee@example.com',
      approver_disabled: false,
      ceiling: ['read', 'admin'],
      layers: 'every layer the person reaches',
      created_at: '2026-10-05T09:00:00.000Z',
      last_refreshed_at: '2026-10-09T10:00:00.000Z',
      revoked: false,
    },
    {
      id: 'c3',
      application: 'Ingest bot',
      administrative: false,
      acts_as: { service_account: 'nightly-ingest' },
      approved_by: 'lee@example.com',
      ceiling: ['write'],
      layers: [{ layer: 'handbook' }, { layer: 'scratch', ceiling: ['write'] }],
      created_at: '2026-09-01T09:00:00.000Z',
      last_refreshed_at: null,
      revoked: true,
    },
  ],
})
const PANEL_META = { 'nacre/proposal': { id: '4a1c2b9e-5d7a-4e21-9c84-0a6b2f1d7e66', key: 'q8Rm3pXv0aLr5TnB9sWc2dYe7fGh4jKu6oZi1xNq_Sx', expires_at: new Date(Date.now() + 9 * 60_000).toISOString() } }
const applyFromPanel = (args) => {
  if (args.proposal !== '4a1c2b9e-5d7a-4e21-9c84-0a6b2f1d7e66' || args.key !== 'q8Rm3pXv0aLr5TnB9sWc2dYe7fGh4jKu6oZi1xNq_Sx') {
    throw new Error('the panel did not apply with the proposal and key it was handed')
  }
  return { applied: true, result: {} }
}

// The grants panel: the core's list_grants by a layer, and a module's
// document listing in the same shape. `_meta['nacre/panel']` is what the core
// attaches — the read to ask again and the writes the form may offer.
const GRANT_ROWS = [
  { id: 'gr1', principal: { type: 'group', id: 'g1', name: 'engineering' }, scope: { type: 'layer', id: 'l1', name: 'handbook' }, permission: 'read', effect: 'allow', source: 'console' },
  { id: 'gr2', principal: { type: 'user', id: ACTORS.dana.id, name: 'dana@example.com' }, scope: { type: 'layer', id: 'l1', name: 'handbook' }, permission: 'write', effect: 'allow', source: 'console' },
  { id: 'gr3', principal: { type: 'service_account', id: 'sa1', name: 'nightly-ingest' }, scope: { type: 'layer', id: 'l1', name: 'handbook' }, permission: 'write', effect: 'allow', source: 'api' },
]
const GRANTS = (added) => ({
  notice: 'Names were written by people.',
  grants: added
    ? [...GRANT_ROWS, { id: 'gr4', principal: { type: 'user', id: 'u-lee', name: 'lee@example.com' }, scope: { type: 'layer', id: 'l1', name: 'handbook' }, permission: 'read', effect: 'allow', source: 'mcp' }]
    : GRANT_ROWS,
  next_cursor: null,
})
const GRANTS_PANEL = { 'nacre/panel': { tool: 'list_grants', offers: [{ tool: 'issue_grant', label: 'Give access', document: 'none', fixed: { layer: 'handbook' } }] } }
const DOC_GRANTS = (denied) => ({
  layer: 'handbook',
  grants: [
    { id: 'dg1', principal: { type: 'user', id: 'u-priya', name: 'priya@example.com' }, scope: { type: 'document', id: 'd1', name: 'Salary bands 2026' }, permission: 'read', effect: 'allow' },
    { id: 'dg2', principal: { type: 'group', id: 'g2', name: 'contractors' }, scope: { type: 'layer', id: 'l1', name: 'handbook' }, permission: 'write', effect: 'deny' },
    ...(denied
      ? [{ id: 'dg3', principal: { type: 'group', id: 'g2', name: 'contractors' }, scope: { type: 'document', id: 'd1', name: 'Salary bands 2026' }, permission: 'read', effect: 'deny' }]
      : []),
  ],
})
const DOC_PANEL = {
  'nacre/panel': {
    tool: 'list_document_grants',
    offers: [
      { tool: 'issue_document_grant', label: 'Give access to a document', document: 'required', fixed: { layer: 'handbook' } },
      { tool: 'issue_deny', label: 'Deny', document: 'optional', fixed: { layer: 'handbook' } },
    ],
  },
}

const ACCESS = {
  notice: 'Names were written by people.',
  principal: { type: 'user', id: ACTORS.dana.id, name: 'dana@example.com', role: 'member' },
  groups: [{ id: 'g1', name: 'engineering' }],
  read: { every_layer: false, layers: ['handbook', 'engineering'], documents_denied_inside_them: 2 },
  write: { every_layer: false, layers: ['scratch'] },
  admin: { every_layer: false, layers: [] },
  deciding_grants: [
    { through: 'group engineering', scope: { type: 'layer', id: 'l1', name: 'engineering' }, permission: 'read', effect: 'allow' },
    { through: 'directly', scope: { type: 'layer', id: 'l2', name: 'handbook' }, permission: 'read', effect: 'allow' },
    { through: 'directly', scope: { type: 'layer', id: 'l3', name: 'scratch' }, permission: 'write', effect: 'allow' },
    { through: 'group contractors', scope: { type: 'document', id: 'd9', name: 'salary-bands' }, permission: 'read', effect: 'deny' },
  ],
}
const ACCESS_ADMIN = {
  notice: '',
  principal: { type: 'user', id: 'u2', name: 'lee@example.com', role: 'org_admin' },
  note: 'An organization administrator reaches every layer by role, whatever the grants say.',
  groups: [],
  read: { every_layer: true },
  write: { every_layer: true },
  admin: { every_layer: true },
  deciding_grants: [],
}

const LAYER_STATUS = {
  notice: 'Titles were written by people.',
  layer: { id: 'l2', slug: 'handbook', name: 'Handbook', description: 'Policies and the things people look up twice a year.', workspace: 'company', model: 'bge-m3', vector: 'bge-m3' },
  documents: { indexed: 412, pending: 3, failed: 2 },
  failures: [
    { id: 'd1', external_id: 'travel-2026', title: 'Travel policy 2026', reason: 'quota', recovers_by_itself: false, detail: 'the organization is at its document limit', attempts: 1, failed_at: '2026-10-09 11:52:00.000+00' },
    { id: 'd2', external_id: 'expenses', title: 'Expenses', reason: 'unavailable', recovers_by_itself: true, detail: 'the embedding service did not answer', attempts: 3, failed_at: '2026-10-09 11:40:00.000+00' },
  ],
  reindex: { status: 'running', phase: 'embedding', current_vector: 'bge-small', shadow_vector: 'bge-m3', done: 280, total: 412, failed: 0, progress: 0.68, error: null, check: null },
  reference_queries: 3,
}

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
        // The key is what makes the press the panel's: without it the server
        // answers as if the proposal were not there.
        if (args.key !== 'k7Qm2pXv9aLr4TnB8sWc1dYe6fGh3jKu5oZi0xNq_Rw') throw new Error('the panel did not present the key it was handed')
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
    // A skill is shown whole: the person reads the instructions every later
    // agent will follow, not a list of their paths.
    view: 'change',
    name: 'change-skill',
    input: { layer: 'handbook', files: {} },
    result: withProposal(PROPOSED_SKILL),
    calls: {},
    check: async (frame) => {
      if ((await frame.locator('.facts dt.path').count()) !== 2) throw new Error('the panel does not head each file')
      const text = frame.locator('.facts dd.text').first()
      if (!(await text.textContent())?.includes('never add a second copy')) throw new Error("the panel does not show SKILL.md's text")
      const space = await text.evaluate((d) => getComputedStyle(d).whiteSpace)
      if (space !== 'pre-wrap') throw new Error(`a file's text loses its line breaks (white-space: ${space})`)
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
  {
    view: 'audit',
    name: 'audit',
    input: {},
    result: text({ notice: '', window: AUDIT_WINDOW, events: AUDIT_ALL, next_cursor: 'p2' }),
    calls: {
      query_audit: (args) =>
        args.cursor === 'p2'
          ? { notice: '', window: AUDIT_WINDOW, events: AUDIT_MORE, next_cursor: null }
          : args.actor === ACTORS.dana.id
            ? { notice: '', window: AUDIT_WINDOW, events: AUDIT_ALL.filter((e) => e.actor.id === ACTORS.dana.id), next_cursor: null }
            : { notice: '', window: AUDIT_WINDOW, events: AUDIT_ALL, next_cursor: 'p2' },
    },
    check: async (frame) => {
      if ((await frame.locator('tbody tr').count()) !== 4) throw new Error('the log does not show its four rows')
      if ((await frame.locator('td .chip-deny').count()) !== 1) throw new Error('the deny is not a deny chip')
      // The system actor has no id and is not offered as a filter.
      if ((await frame.locator('button.narrow').count()) !== 3) throw new Error('every actor with an id should narrow, and only those')
      await frame.locator('button.narrow', { hasText: 'dana@example.com' }).first().click()
      await frame.locator('.facts-line', { hasText: 'only dana@example.com' }).waitFor()
      if ((await frame.locator('tbody tr').count()) !== 2) throw new Error('pressing an actor did not narrow to their two rows')
      await frame.locator('button', { hasText: 'Everyone' }).click()
      await frame.locator('tbody tr').nth(3).waitFor()
      await frame.locator('button', { hasText: 'More' }).click()
      await frame.locator('tbody tr').nth(4).waitFor()
      if ((await frame.locator('button', { hasText: 'More' }).evaluate((b) => getComputedStyle(b).display)) !== 'none') throw new Error('More is still offered with no next page')
    },
  },
  {
    view: 'connections',
    name: 'connections',
    input: {},
    result: text(CONNECTIONS(false)),
    calls: {
      revoke_connection: (args) => {
        if (args.connection !== 'c1') throw new Error(`proposed revoking ${String(args.connection)}, not the row pressed`)
        return new WithMeta({ proposed: "End Claude's connection, acting as dana@example.com. It stops on its next request.", details: [] }, PANEL_META)
      },
      apply_proposal: applyFromPanel,
      list_connections: () => CONNECTIONS(true),
    },
    check: async (frame) => {
      if ((await frame.locator('tbody tr').count()) !== 3) throw new Error('the panel does not list the three connections')
      if ((await frame.locator('button', { hasText: 'Revoke' }).count()) !== 2) throw new Error('a revoked connection is offered a Revoke')
      await frame.locator('button', { hasText: 'Revoke' }).first().click()
      await frame.locator('.confirm .what', { hasText: "End Claude's connection" }).waitFor()
      // Nothing is revoked until Apply.
      if ((await frame.locator('td .chip-deny', { hasText: 'revoked' }).count()) !== 1) throw new Error('a proposal changed the listing before Apply')
      await frame.locator('.confirm button', { hasText: 'Apply' }).click()
      await frame.locator('.confirm', { hasText: 'Applied.' }).waitFor()
      await frame.locator('td .chip-deny', { hasText: 'revoked' }).nth(1).waitFor()
    },
  },
  {
    view: 'connections',
    name: 'connections-no-meta',
    input: {},
    result: text(CONNECTIONS(false)),
    calls: {
      revoke_connection: () => ({ proposed: "End Claude's connection, acting as dana@example.com.", details: [] }),
    },
    check: async (frame) => {
      // A host that drops `_meta`: the panel must not offer a button it cannot honour.
      await frame.locator('button', { hasText: 'Revoke' }).first().click()
      await frame.locator('.confirm', { hasText: 'Proposals screen' }).waitFor()
      if ((await frame.locator('.confirm button', { hasText: 'Apply' }).count()) !== 0) throw new Error('Apply is offered with no key to apply with')
    },
  },
  {
    view: 'access',
    name: 'access',
    input: { person: 'dana@example.com' },
    result: text(ACCESS),
    calls: { effective_access: (args) => (args.person === 'lee@example.com' ? ACCESS_ADMIN : ACCESS) },
    check: async (frame) => {
      if ((await frame.locator('table').first().locator('tbody tr').count()) !== 3) throw new Error('the matrix does not have a row per layer')
      // Rule 6: write without read is one chip on its row, not a ladder.
      const scratch = frame.locator('table').first().locator('tbody tr', { hasText: 'scratch' })
      if ((await scratch.locator('.chip-write').count()) !== 1 || (await scratch.locator('.chip-read').count()) !== 0) throw new Error('scratch should show write and not read')
      if ((await frame.locator('.chip-deny').count()) !== 1) throw new Error('the deny grant is not a deny chip')
    },
  },
  {
    // The same panel after asking about somebody else from it: a second
    // scenario rather than a press at the end of the first, so the matrix
    // above — rule 6's one-chip row and the deny — is what gets photographed.
    view: 'access',
    name: 'access-someone-else',
    input: { person: 'dana@example.com' },
    result: text(ACCESS),
    calls: { effective_access: (args) => (args.person === 'lee@example.com' ? ACCESS_ADMIN : ACCESS) },
    check: async (frame) => {
      await frame.locator('input.input').fill('lee@example.com')
      await frame.locator('button', { hasText: 'Show' }).click()
      await frame.locator('td', { hasText: 'Every layer' }).waitFor()
    },
  },
  {
    view: 'layer',
    name: 'layer',
    input: { layer: 'handbook' },
    result: text(LAYER_STATUS),
    check: async (frame) => {
      if ((await frame.locator('.stat').count()) !== 3) throw new Error('the three counts are not shown')
      if ((await frame.locator('progress').count()) !== 1) throw new Error('the reindex has no progress bar')
      // Read-only: retrying is a write on the layer, which this surface's
      // connection does not hold. Each failure says whether it comes back.
      if ((await frame.locator('button').count()) !== 0) throw new Error('the layer panel offers something to press')
      if ((await frame.locator('.sub', { hasText: 'will not recover by itself' }).count()) !== 1) throw new Error('the permanent failure does not say so')
      if ((await frame.locator('.sub', { hasText: 'retried by itself' }).count()) !== 1) throw new Error('the transient failure does not say so')
    },
  },
  {
    view: 'grants',
    name: 'grants',
    input: { layer: 'handbook' },
    result: { ...text(GRANTS(false)), _meta: GRANTS_PANEL },
    calls: {
      issue_grant: (args) => {
        if (args.layer !== 'handbook' || args.person !== 'lee@example.com' || args.permission !== 'read' || 'document' in args) {
          throw new Error(`the form proposed ${JSON.stringify(args)}, not lee read on handbook`)
        }
        return new WithMeta({ proposed: 'Give the person lee@example.com read on the layer handbook.', details: [] }, PANEL_META)
      },
      apply_proposal: applyFromPanel,
      list_grants: (args) => {
        if (args.layer !== 'handbook') throw new Error('the panel did not ask the same read again')
        return GRANTS(true)
      },
    },
    check: async (frame) => {
      if ((await frame.locator('tbody tr').count()) !== 3) throw new Error('the panel does not list the three grants')
      if ((await frame.locator('button', { hasText: 'Revoke' }).count()) !== 3) throw new Error('a grant has no Revoke')
      if (!(await frame.locator('label', { hasText: 'Document' }).isHidden())) throw new Error('a form with no document offer asks for one')
      await frame.locator('input.input').first().fill('lee@example.com')
      await frame.locator('button', { hasText: 'Give access' }).click()
      await frame.locator('.confirm .what', { hasText: 'lee@example.com' }).waitFor()
      // Nothing is granted until Apply.
      if ((await frame.locator('tbody tr').count()) !== 3) throw new Error('a proposal changed the listing before Apply')
      await frame.locator('.confirm button', { hasText: 'Apply' }).click()
      await frame.locator('td', { hasText: 'lee@example.com' }).waitFor()
    },
  },
  {
    view: 'grants',
    name: 'grants-documents',
    input: { layer: 'handbook' },
    result: { ...text(DOC_GRANTS(false)), _meta: DOC_PANEL },
    calls: {
      issue_deny: (args) => {
        if (args.layer !== 'handbook' || args.group !== 'contractors' || args.document !== 'Salary bands 2026' || args.permission !== 'read') {
          throw new Error(`the form proposed ${JSON.stringify(args)}, not the deny it was filled in with`)
        }
        return new WithMeta({ proposed: 'Deny the group contractors read on the document "Salary bands 2026" in the layer handbook.', details: [] }, PANEL_META)
      },
      apply_proposal: applyFromPanel,
      list_document_grants: () => DOC_GRANTS(true),
    },
    check: async (frame) => {
      if ((await frame.locator('tbody tr').count()) !== 2) throw new Error('the panel does not list the module\'s two rows')
      if ((await frame.locator('.chip-deny').count()) !== 1) throw new Error('the layer deny is not a deny chip')
      // A document is required for one offer and optional for the other.
      await frame.locator('input.input').first().fill('contractors')
      await frame.locator('select').first().selectOption('group')
      await frame.locator('button', { hasText: 'Give access to a document' }).click()
      await frame.locator('.status', { hasText: 'needs a document' }).waitFor()
      await frame.locator('input.input').nth(1).fill('Salary bands 2026')
      await frame.locator('button', { hasText: /^Deny$/ }).click()
      await frame.locator('.confirm .what', { hasText: 'Salary bands 2026' }).waitFor()
      await frame.locator('.confirm button', { hasText: 'Apply' }).click()
      await frame.locator('.confirm', { hasText: 'Applied.' }).waitFor()
      await frame.locator('tbody tr').nth(2).waitFor()
      if ((await frame.locator('.chip-deny').count()) !== 2) throw new Error('the applied deny is not listed')
    },
  },
  {
    // Listed by a person, there is no scope to fix, so nothing to offer.
    view: 'grants',
    name: 'grants-by-person',
    input: { person: 'dana@example.com' },
    result: { ...text({ notice: 'Names were written by people.', grants: [GRANT_ROWS[1]], next_cursor: null }), _meta: { 'nacre/panel': { tool: 'list_grants', offers: [] } } },
    calls: {},
    check: async (frame) => {
      if ((await frame.locator('tbody tr').count()) !== 1) throw new Error('the grant is not listed')
      if (!(await frame.locator('h2', { hasText: 'Change access' }).isHidden())) throw new Error('a panel with nothing to offer shows a form')
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
          if (value instanceof WithMeta) return { ...text(value.value), _meta: value.meta }
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
