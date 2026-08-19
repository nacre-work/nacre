#!/usr/bin/env node
/**
 * The console's extension point, driven in a browser.
 *
 * `packages/admin/src/extensions.ts` is how a commercial image puts a screen in
 * this console: the open `web` image ships `extensions.js` registering nothing,
 * and `nacre-enterprise-web` is built `FROM` it with that file replaced. Every
 * part of that is a browser's business — a dynamic import of a same-origin URL
 * under `script-src 'self'`, a bundler that must *not* inline the file it is
 * meant to replace, and a nav that has to gain an item.
 *
 * So this is not a unit test, and could not be. A stub of `import()` agrees
 * with whatever it was written to; what is being asserted is that the shipped
 * bundle loads a file it has never seen and draws what that file returns.
 *
 * Four states, and three of them are ways to fail quietly:
 *
 * 1. **The shipped stub** — the community console, unchanged, and no banner.
 * 2. **A real extension** — its label in the nav, its screen rendered, and its
 *    `kit.request` reaching the API with the session's `authorization` header.
 * 3. **A contract this console does not speak** — said out loud. A console that
 *    silently drops the screens somebody paid for is the "hiding what the
 *    server allows" defect with no server involved, and it is the harder of the
 *    two to notice, because nothing is on the screen to be wrong about.
 * 4. **A hash that collides with a core route** — dropped. A module must not be
 *    able to replace Grants with a screen of its own.
 *
 * Run from the repository root, after `pnpm build`. Playwright is not a
 * dependency here for the reason `screenshots.mjs` states; `NACRE_PLAYWRIGHT`
 * names the module.
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/* global sessionStorage, document */

const specifier = process.env.NACRE_PLAYWRIGHT ?? 'playwright'
let chromium
try {
  ;({ chromium } = await import(specifier))
} catch {
  console.error(
    '::error::playwright is not installed. Set NACRE_PLAYWRIGHT to the module\'s own path, ' +
      'for example …/node_modules/playwright/index.mjs — see scripts/screenshots.mjs.',
  )
  process.exit(1)
}

const BUNDLE = 'packages/admin/dist'
if (!existsSync(join(BUNDLE, 'app.js'))) {
  console.error(`::error::${BUNDLE} is not built — run \`pnpm build\` first`)
  process.exit(1)
}

/*
 * The shipped stub has to be a file of its own in `dist/`, or the mechanism is
 * gone whatever the browser then does. Asserted before a browser starts,
 * because "bundled away" and "served but empty" look identical from the page:
 * both draw the community console with no banner, which is state 1 passing.
 */
if (!existsSync(join(BUNDLE, 'extensions.js'))) {
  console.error(
    `::error::${BUNDLE}/extensions.js is missing. It is the file an enterprise image replaces, ` +
      'so a build that bundles or drops it removes the extension point while every screen still ' +
      'renders.',
  )
  process.exit(1)
}

/** What each state serves as `/extensions.js`. `null` means the shipped stub. */
const SHIPPED = null

const REAL = `
export default function register(kit) {
  return {
    contract: kit.contract,
    views: [
      {
        hash: '#/organizations',
        label: 'Organizations',
        shows: (viewer) => viewer.platformAdmin,
        render: (root, viewer) => {
          kit.clear(root)
          root.append(kit.h('h1', {}, 'Organizations'))
          root.append(kit.h('p', { class: 'lede', id: 'who' },
            viewer.platformAdmin ? 'platform' : 'not platform'))
          void kit.request({ method: 'GET', path: '/v1/admin/organizations' }).then((body) => {
            root.append(kit.h('p', { id: 'answer' }, String(body.items.length)))
          }, (error) => {
            root.append(kit.h('p', { id: 'answer' }, kit.explain(error)))
          })
        },
      },
    ],
  }
}
`

const WRONG_CONTRACT = `
export default function register() {
  return { contract: 99, views: [] }
}
`

const COLLIDING = `
export default function register(kit) {
  return {
    contract: kit.contract,
    views: [
      {
        hash: '#/grants',
        label: 'Not grants',
        shows: () => true,
        render: (root) => { kit.clear(root); root.append(kit.h('h1', { id: 'hijacked' }, 'Hijacked')) },
      },
    ],
  }
}
`

/** Only what the console asks for while these states are being driven. */
const FIXTURES = {
  'GET /v1/health': { status: 'ok' },
  'GET /v1/me': {
    organization: 'acme',
    principal_type: 'user',
    principal_id: '9b3e5c71-24af-4d08-8e16-3f7c0a5b2d94',
    role: 'platform_admin',
    administers: false,
    holds_own_credentials: true,
  },
  'GET /v1/audit': { items: [], next_cursor: null },
  'GET /v1/layers': { items: [], next_cursor: null },
}

let served = SHIPPED
let authorization = null

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (path === '/extensions.js' && served !== SHIPPED) {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(served)
    return
  }
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

const executablePath = process.env.NACRE_CHROMIUM
const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
const problems = []

let fetchedExtensions = false

async function open(hash = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  page.on('pageerror', (error) => problems.push(`page error: ${String(error)}`))
  /*
   * Whether the page went and got the file at all.
   *
   * The first version of this asked `dist/app.js` whether it contained the
   * stub's body, spelled the way the source spells it — and the build minifies,
   * so that string is never in the output and the assertion could not fail. The
   * narrow projection this repository keeps naming, produced inside the check
   * written against it, and it was believed for one run because the build that
   * was supposed to reproduce the defect had failed silently and left the
   * previous bundle in place.
   *
   * What actually matters is a fact about the browser rather than about a file:
   * an inlined import fetches nothing, and then the file an enterprise image
   * replaces is not the file this console reads.
   */
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/extensions.js') fetchedExtensions = true
  })
  await page.addInitScript(() => {
    sessionStorage.setItem('nacre.admin.base', 'http://localhost:8080')
    sessionStorage.setItem('nacre.admin.token', 'stub-token')
  })
  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const key = `${request.method()} ${new URL(request.url()).pathname}`
    // The header is the assertion, not decoration: an extension reaching for
    // `globalThis.fetch` would send none, and every call it made would 401 on a
    // real deployment while passing against a stub that does not look.
    if (key === 'GET /v1/admin/organizations') {
      authorization = request.headers().authorization ?? null
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] }),
      })
      return
    }
    const body = FIXTURES[key]
    await route.fulfill({
      status: body === undefined ? 404 : 200,
      contentType: body === undefined ? 'application/problem+json' : 'application/json',
      body: JSON.stringify(body ?? { title: 'Not found', status: 404, detail: 'Not found.' }),
    })
  })
  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' })
  // The extension file is imported after the first paint on purpose — see
  // `start()` — so the nav settles a turn later than the page does.
  await page.waitForTimeout(250)
  return page
}

const navLabels = (page) =>
  page.evaluate(() => [...document.querySelectorAll('.nav a')].map((a) => a.textContent))

const bannerText = (page) =>
  page.evaluate(() => document.getElementById('extensions')?.textContent ?? null)

// ── 1. the shipped stub ───────────────────────────────────────────────────
served = SHIPPED
{
  const page = await open()
  const labels = await navLabels(page)
  if (labels.includes('Organizations')) {
    problems.push('the shipped stub put a screen in the nav; it must register nothing')
  }
  const banner = await bannerText(page)
  if (banner !== null) problems.push(`the shipped stub raised a banner: ${banner}`)
  if (!fetchedExtensions) {
    problems.push(
      'the console never requested /extensions.js, so the bundler inlined it — the file an ' +
        'enterprise image replaces is then not the file this console reads',
    )
  }
  await page.close()
}

// ── 2. a real extension ───────────────────────────────────────────────────
served = REAL
{
  const page = await open('#/organizations')
  const labels = await navLabels(page)
  if (!labels.includes('Organizations')) {
    problems.push(`an extension's view is not in the nav: ${JSON.stringify(labels)}`)
  }
  if ((await bannerText(page)) !== null) problems.push('a valid extension raised a banner')

  const heading = await page.evaluate(() => document.querySelector('.main h1')?.textContent ?? '')
  if (heading !== 'Organizations') problems.push(`the extension's view did not render: "${heading}"`)

  // `shows` is handed the same viewer the core routes get, from the server's
  // own answer rather than from a role comparison in here.
  const who = await page.evaluate(() => document.getElementById('who')?.textContent ?? '')
  if (who !== 'platform') problems.push(`the extension was handed the wrong viewer: "${who}"`)

  await page.waitForTimeout(250)
  const answer = await page.evaluate(() => document.getElementById('answer')?.textContent ?? '')
  if (answer !== '2') problems.push(`kit.request did not reach the API: "${answer}"`)
  if (authorization !== 'Bearer stub-token') {
    problems.push(`kit.request sent no session: ${String(authorization)}`)
  }
  await page.close()
}

// ── 3. a contract this console does not speak ─────────────────────────────
served = WRONG_CONTRACT
{
  const page = await open()
  const banner = await bannerText(page)
  if (banner === null || !banner.includes('99')) {
    problems.push(`a wrong contract was swallowed rather than said: ${String(banner)}`)
  }
  await page.close()
}

// ── 4. a hash that collides with a core route ─────────────────────────────
served = COLLIDING
{
  const page = await open('#/grants')
  const labels = await navLabels(page)
  if (labels.includes('Not grants')) problems.push('an extension shadowed a core route in the nav')
  const hijacked = await page.evaluate(() => document.getElementById('hijacked') !== null)
  if (hijacked) problems.push('an extension rendered over a core route')
  await page.close()
}

await browser.close()
server.close()

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::console extensions: ${problem}`)
  process.exit(1)
}
console.log('console extensions: the stub registers nothing, a real one draws, a wrong contract says so, a collision is dropped')
