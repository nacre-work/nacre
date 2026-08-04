#!/usr/bin/env node
/**
 * The admin UI's screenshots in docs/, regenerated from the built bundle.
 *
 * A screenshot in documentation goes stale silently: the screen changes, the
 * image does not, and the page starts lying more convincingly than its prose
 * does. So these are not taken by hand — this renders the real bundle from
 * `packages/admin/dist` in a real browser and writes the files the quickstart
 * embeds. When a view changes, running this again is the whole update.
 *
 * ## Why the data is invented
 *
 * The API is stubbed rather than run. Two reasons, and the second is the one
 * that decides it:
 *
 * - No Postgres, Qdrant, Redis or embedder is needed to photograph a screen,
 *   so the pictures can be regenerated anywhere, including from a laptop with
 *   nothing running.
 * - `docs/` is public. Screenshots taken against somebody's real installation
 *   carry their email, their organization id and their key prefixes into a
 *   public repository, one commit at a time. Fixtures cannot leak what they
 *   never had.
 *
 * The fixtures are the same shapes the SDK parses, so a response shape that
 * changed underneath the UI shows up here as an empty screen rather than as a
 * pretty picture of nothing.
 */
/*
 * `addInitScript` serialises its callback and runs it *in the page*, so the
 * browser globals inside those two callbacks are real there and absent here.
 * Declared rather than disabled, so a genuine typo in this file is still caught.
 */
/* global sessionStorage */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/**
 * Playwright is deliberately not a dependency of this workspace.
 *
 * Screenshots are regenerated when a view changes, which is rare, by whoever
 * changed it — so making every contributor's `pnpm install` carry a browser
 * driver for it would be the wrong trade. Install it for the run:
 *
 *   pnpm dlx playwright@1 install chromium   # once, if you have no browser
 *   pnpm dlx --package=playwright@1 node scripts/screenshots.mjs
 */
let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error(
    '::error::playwright is not installed. It is not a dependency of this repository on purpose ' +
      '— see the note at the top of this file for how to run it.',
  )
  process.exit(1)
}

const BUNDLE = 'packages/admin/dist'
const OUT = 'docs/assets/admin'

if (!existsSync(join(BUNDLE, 'index.html'))) {
  console.error(`::error::${BUNDLE} is not built — run \`pnpm --filter @nacre.work/admin build\` first`)
  process.exit(1)
}

const WORKSPACE = '9f1c0f5a-2b7d-4c31-9a44-6c2f0e5b8d10'
const LAYER = '3a6b1e28-77c4-4f0d-8b19-2d5e9a03c7f1'
const ACCOUNT = 'c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55'
const DOC = 'e77a3c10-9d42-4b86-8f51-0a4c7e93b2d6'

/** Everything the five views ask for, in the shapes the SDK parses. */
const FIXTURES = {
  // Polled by the header to show whether the API is reachable.
  'GET /v1/health': { status: 'ok' },
  'GET /v1/workspaces': {
    items: [{ id: WORKSPACE, slug: 'default', name: 'Default', layer_count: 2 }],
    next_cursor: null,
  },
  'GET /v1/layers': {
    items: [
      { id: LAYER, slug: 'handbook', name: 'Handbook', workspace_id: WORKSPACE,
        description: 'Onboarding and policy', document_count: 12 },
      { id: '5c2f8a41-0e63-4d29-b7a8-9f14e6b30c72', slug: 'contracts', name: 'Contracts',
        workspace_id: WORKSPACE, description: 'Signed agreements', document_count: 34 },
    ],
    next_cursor: null,
  },
  'GET /v1/grants': {
    items: [
      { id: '7b3e5d92-4a18-4c60-8e27-3f9d1a6b0c48', principal_type: 'service_account',
        principal_id: ACCOUNT, scope_type: 'layer', scope_id: LAYER,
        permission: 'read', effect: 'allow', source: 'api' },
      { id: '2d8f4a71-6c95-4b03-9a1e-5e7b2c0d0f39',
        principal_type: 'group', principal_id: '8e1a7c34-2b09-4d56-af73-6c0e5b9d2a41',
        scope_type: 'workspace', scope_id: WORKSPACE,
        permission: 'read', effect: 'allow', source: 'api' },
    ],
    next_cursor: null,
  },
  'GET /v1/service-accounts': {
    items: [
      { id: ACCOUNT, name: 'support-agent', key_prefix: 'nacre_sk_7Qd2Xm4P',
        created_at: '2026-03-02T09:14:00.000Z', last_used_at: '2026-03-11T16:40:00.000Z',
        revoked_at: null },
      { id: 'a93c7e15-8d40-4b62-9f81-2c6a4e0b7d93', name: 'nightly-indexer',
        key_prefix: 'nacre_sk_Lp9Vt1Ka', created_at: '2026-02-18T11:02:00.000Z',
        last_used_at: null, revoked_at: null },
    ],
    next_cursor: null,
  },
  'GET /v1/users': {
    items: [
      { id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90', email: 'dana@example.com', role: 'org_admin',
        created_at: '2026-01-12T08:30:00.000Z', disabled_at: null, has_password: true },
      { id: '4f2c8e61-7a95-4d13-9b60-2e8a5c0f7b34', email: 'sam@example.com', role: 'member',
        created_at: '2026-02-03T14:05:00.000Z', disabled_at: null, has_password: true },
      { id: '9d7b3f04-6c28-4a51-8e93-1b5f0a2c6d78', email: 'alex@example.com', role: 'member',
        created_at: '2026-02-20T10:11:00.000Z', disabled_at: '2026-03-08T09:00:00.000Z',
        has_password: true },
    ],
    next_cursor: null,
  },
  'GET /v1/groups': {
    items: [
      { id: '8e1a7c34-2b09-4d56-af73-6c0e5b9d2a41', name: 'legal',
        created_at: '2026-01-12T08:31:00.000Z', member_count: 2 },
      { id: '3c9f5b28-4d71-4e06-b28a-7f1c0e6d9a53', name: 'engineering',
        created_at: '2026-01-19T12:44:00.000Z', member_count: 5 },
    ],
    next_cursor: null,
  },
  'POST /v1/search': {
    items: [
      { chunk_id: '1f4d8b03-5a29-4e71-9c86-7b2e0d5a3f19', doc_id: DOC, layer: 'handbook',
        title: 'Onboarding', score: 0.82,
        text: 'New engineers get repository access on their first day. Ask your manager to file the request; it is approved automatically for anyone in the engineering group.' },
      { chunk_id: '6c9a2e57-3b81-4d05-8f24-1a7e9c6b0d38', doc_id: '4b8e1a63-9c07-4f52-ad31-7e0b5c2f9a64',
        layer: 'handbook', title: 'Equipment', score: 0.61,
        text: 'A laptop is issued on the first day and stays with you between teams. Replacements go through the same request form.' },
    ],
  },
}

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  const file = join(BUNDLE, path === '/' ? 'index.html' : path)
  const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.map': 'application/json', '.woff2': 'font/woff2' }
  if (!existsSync(file)) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

mkdirSync(OUT, { recursive: true })

// Playwright's bundled revision and the one installed here need not match, so
// the path is explicit when the environment names one.
const executablePath = process.env.NACRE_CHROMIUM
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })

const failures = []

async function shot(name, { hash = '', signedIn = true, prepare, fixtures = {} } = {}) {
  // Short viewport plus `fullPage`, so each image is exactly as tall as its
  // screen rather than carrying a band of empty background.
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 })
  page.on('pageerror', (error) => failures.push(`${name}: ${String(error)}`))

  // The base is pinned to the address the quickstart uses, on every screen and
  // not only the signed-in ones. Left unset it defaults to `location.origin`,
  // which is this script's static server on whatever port the OS handed out —
  // so the sign-in form's API field and the header would each read a different
  // number every run, and every regeneration would rewrite every file. Caught
  // by rendering twice and comparing.
  await page.addInitScript(() => {
    sessionStorage.setItem('nacre.admin.base', 'http://localhost:8080')
  })

  if (signedIn) {
    // Every response is stubbed, so the token's contents never matter — only
    // that one is present.
    await page.addInitScript(() => {
      sessionStorage.setItem('nacre.admin.token', 'stub-token-for-screenshots')
    })
  }

  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const key = `${request.method()} ${new URL(request.url()).pathname}`
    // Per-shot overrides, for the screens that are worth photographing in a
    // state the default fixtures do not have — an empty one, most of all.
    const body = key in fixtures ? fixtures[key] : FIXTURES[key]
    if (body === undefined) {
      // Loud rather than an empty screen: an unstubbed call means the UI asks
      // for something this file does not know about, and the picture would be
      // of a view that failed to load.
      failures.push(`${name}: no fixture for ${key}`)
      await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' })
  if (prepare !== undefined) await prepare(page)
  await page.waitForTimeout(250)

  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`  ${file}`)
  await page.close()
}

console.log(`rendering ${BUNDLE} into ${OUT}/`)

await shot('sign-in', { signedIn: false })

// What a fresh installation actually shows, which is where a first-time
// reader is and which no screenshot covered — the state somebody said they
// would never have guessed their way out of.
await shot('layers-empty', {
  hash: '#/layers',
  fixtures: { 'GET /v1/layers': { items: [], next_cursor: null } },
})

await shot('layers', { hash: '#/layers' })
await shot('new-layer', {
  hash: '#/layers',
  prepare: async (page) => {
    await page.getByRole('button', { name: 'New layer' }).click()
    await page.waitForTimeout(150)
  },
})
await shot('search', {
  hash: '#/search',
  prepare: async (page) => {
    await page.getByPlaceholder('What can this token find?').fill('when do new hires get access')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.waitForTimeout(400)
  },
})
await shot('grants', { hash: '#/grants' })
await shot('people', { hash: '#/people' })
await shot('accounts', { hash: '#/accounts' })

await browser.close()
server.close()

if (failures.length > 0) {
  for (const failure of failures) console.error(`::error::${failure}`)
  process.exit(1)
}
console.log('every screen rendered with no page errors and no missing fixture')
