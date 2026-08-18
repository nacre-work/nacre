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
 * `addInitScript` and `page.evaluate` serialise their callbacks and run them
 * *in the page*, so the browser globals inside those callbacks are real there
 * and absent here. Declared rather than disabled, so a genuine typo in this
 * file is still caught.
 */
/* global sessionStorage, document */
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
/*
 * `NACRE_PLAYWRIGHT` names the module, and it exists because a bare specifier
 * cannot be pointed anywhere.
 *
 * An ESM `import` resolves from the importing file's directory upward. It does
 * **not** consult `NODE_PATH` — that is a CommonJS mechanism — so a job that
 * installs playwright into a directory of its own and sets `NODE_PATH` gets
 * this file's own refusal, which is what the `console` job did on the pull
 * request that added it.
 *
 * The paragraph above already said so, and the first version of that job used
 * `NODE_PATH` anyway; it looked right locally because an earlier `npx` run had
 * left playwright in this repository's `node_modules`, so the bare import
 * resolved and the environment variable was doing nothing. A check verified
 * under a condition the runner does not have is a check verified against
 * nothing.
 */
const specifier = process.env.NACRE_PLAYWRIGHT ?? 'playwright'
let chromium
try {
  ;({ chromium } = await import(specifier))
} catch {
  console.error(
    '::error::playwright is not installed. It is not a dependency of this repository on purpose ' +
      '— see the note at the top of this file for how to run it. Installing it elsewhere and ' +
      'setting NODE_PATH does not work: this is an ESM import. Set NACRE_PLAYWRIGHT to the ' +
      "module's own path instead, for example …/node_modules/playwright/index.mjs.",
  )
  process.exit(1)
}

const BUNDLE = 'packages/admin/dist'
const OUT = 'docs/assets/admin'

if (!existsSync(join(BUNDLE, 'index.html'))) {
  console.error(`::error::${BUNDLE} is not built — run \`pnpm --filter @nacre.work/admin build\` first`)
  process.exit(1)
}

/*
 * And built *since* the sources it is built from.
 *
 * A bundle that exists is not a bundle that is current, and this script cannot
 * tell by looking at a screen: a stale `dist` renders perfectly and photographs
 * the console as it was. That is not hypothetical — a `pnpm build` that failed
 * on a type error left the previous bundle in place, this pass ran against it,
 * and it reported every screen rendering with no page errors while none of the
 * changed code was in the page at all. "Run the artifact, not the source that
 * produces it" is the rule; the corollary is that the artifact has to be the
 * one the source produces *now*.
 *
 * Newest source against newest output, which is coarse and is enough: the
 * failure being guarded against is a whole build that did not happen.
 */
const newest = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .reduce((latest, e) => Math.max(latest, statSync(join(e.parentPath, e.name)).mtimeMs), 0)

const built = newest(BUNDLE)
const written = newest('packages/admin/src')
if (written > built) {
  console.error(
    `::error::${BUNDLE} is older than packages/admin/src — rebuild before rendering, ` +
      'or this pass photographs the console as it was and reports success',
  )
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
  // What decides which navigation the console draws. There was no fixture for
  // it, so `me()` got the 500 an unstubbed call gets, `index.ts` caught it and
  // left the caller a member, and every admin-only route was hidden — a
  // request for `#/people` fell back to the first allowed view and the run
  // wrote a picture of Search over `people.png`.
  //
  // The recorded failure for the unstubbed call was right there and the run
  // crashed before printing it, so the wrong images were written anyway. The
  // ones committed here were never wrong — checked against `origin/main`,
  // where the three hashes differ — but nothing stopped a run from replacing
  // them, which is what `landed` below is for: an assertion that the picture
  // is of the screen it is named after.
  'GET /v1/me': {
    organization: 'acme',
    principal_type: 'user',
    principal_id: '7c1f0a92-3d84-4b57-a610-8e2d5f47c093',
    role: 'org_admin',
  },
  'GET /v1/workspaces': {
    // `permissions` is what `newLayerButton` reads to decide whether the caller
    // administers a workspace, and this fixture did not carry it — so the
    // button stayed disabled, and this script could not get past its third
    // image. It is the fixture-written-to-match-an-assumption defect: every
    // field here was one the screenshots happened to need, and the one the
    // code actually branches on was the one missing.
    items: [{ id: WORKSPACE, slug: 'default', name: 'Default', layer_count: 2, permissions: ['read', 'write', 'admin'] }],
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
  // What the sign-in screen asks before anybody has signed in: whether this
  // installation can send a recovery link. Unstubbed it got the 500 an
  // unstubbed call gets, and the link was left off the picture — the same shape
  // as the missing `/v1/me` fixture that once photographed the wrong screen,
  // arriving on the one screen that is rendered signed out.
  'GET /v1/auth/methods': { password_reset: true, second_factor_kinds: ['totp', 'webauthn'] },
  // The Security screen. Two panels — a password form and what is enrolled —
  // and the second is the only one an installation can be without.
  //
  // `kinds` is what the panel draws its buttons from, so the default fixture
  // is the installation offering both: a screen rendered against one kind
  // would photograph half the controls and say nothing about the other half.
  'GET /v1/me/second-factor': {
    items: [
      { id: 'f0a51c73-9b28-4e64-8d17-2a6c4f0b9e35', kind: 'totp', label: 'Phone',
        created_at: '2026-02-14T09:20:00.000Z', last_used_at: '2026-03-12T08:05:00.000Z' },
      { id: '5d3b8e17-6c04-4a92-b7e5-1f8a0c3d6b24', kind: 'webauthn', label: 'Yubikey',
        created_at: '2026-02-20T11:02:00.000Z', last_used_at: null },
    ],
    recovery_codes_left: 8,
    kinds: ['totp', 'webauthn'],
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
  'GET /v1/groups/8e1a7c34-2b09-4d56-af73-6c0e5b9d2a41/members': {
    items: [
      { type: 'user', id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90', label: 'dana@example.com' },
      { type: 'group', id: '3c9f5b28-4d71-4e06-b28a-7f1c0e6d9a53', label: 'engineering' },
    ],
    next_cursor: null,
  },
  // The one irreversible moment on the People screen, and the reason it gets a
  // picture: a password exists in this response and nowhere else, ever again.
  'POST /v1/users': {
    id: '6a4e2c98-3b17-4f50-9d82-0c7b5e1a4f26', email: 'kim@example.com', role: 'member',
    created_at: '2026-03-14T09:00:00.000Z', disabled_at: null, has_password: true,
    password: 'aragonite-tide-ledger-shoal-prism-keel-37',
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

/**
 * The summary, printed from an `exit` hook rather than only at the bottom.
 *
 * Everything below records into `failures` and then reports once at the end,
 * which works right up until something ends the run first — and two things do.
 * A shot that lands on the wrong screen throws, deliberately, because by the
 * time a summary prints the wrong picture is already on disk. And a `prepare`
 * that clicks a control which is not there times out. Either way the process
 * died with five recorded failures and printed none of them, so CI got no
 * annotation and the reason was in nobody's output — which is the same defect
 * as the one three lines further down complains about.
 *
 * `exit` fires for an uncaught throw as well as a clean return, so this is the
 * one place the report is guaranteed to run. The browser and the server are
 * released by the process ending; there is nothing to await here and an `exit`
 * handler could not await it anyway.
 */
let reported = false
const reportFailures = () => {
  if (reported) return
  reported = true
  for (const failure of failures) console.error(`::error::${failure}`)
}
process.on('exit', reportFailures)

/**
 * The instant every screen is rendered at.
 *
 * The fixtures carry absolute dates and the views render *relative* times, so
 * without this the images drift with the wall clock: two runs eleven minutes
 * apart differed because a `created_at` crossed 181 days, and `accounts.png`
 * and `people.png` therefore changed on every regeneration with no code change.
 * That is how a screenshot diff stops meaning anything — a real change arrives
 * in a commit that also rewrites two unrelated files, and nobody looks.
 *
 * The same reasoning as the pinned API base a few lines down, which was caught
 * the same way. After the newest fixture date, so every "N days ago" is a
 * positive number a reader recognises.
 */
const NOW = new Date('2026-03-15T09:00:00Z')

async function shot(name, { hash = '', signedIn = true, prepare, fixtures = {} } = {}) {
  // Short viewport plus `fullPage`, so each image is exactly as tall as its
  // screen rather than carrying a band of empty background.
  const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2 })
  page.on('pageerror', (error) => failures.push(`${name}: ${String(error)}`))

  // Before anything navigates, or the module has already read the clock.
  await page.clock.setFixedTime(NOW)

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
    // A number is a status, for the screens whose subject is a capability the
    // installation does not have. `404` is what every absent surface answers
    // here, so it is the one a picture of "not configured" needs.
    if (typeof body === 'number') {
      await route.fulfill({
        status: body,
        contentType: 'application/problem+json',
        body: JSON.stringify({ title: 'Not found', status: body, detail: 'Not found.' }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  })

  await page.goto(`${base}/${hash}`, { waitUntil: 'networkidle' })

  // The console hides the routes a member may not use and falls back to the
  // first one it will show, so asking for a screen you are not allowed to see
  // silently photographs a different screen, over the file named after the
  // one you asked for. Nothing said so.
  if (hash !== '') {
    // The **rendered** route, not `location.hash`. The router falls back to
    // the first screen the caller may use and deliberately leaves the address
    // alone — a member who follows a bookmark keeps their bookmark — so the
    // hash agrees with what was asked whatever got drawn. Asking the URL is a
    // check that can never fail, which is worse than no check. The nav marks
    // what it actually rendered.
    const landed = await page.evaluate(
      () => document.querySelector('.nav a.active')?.getAttribute('href') ?? '',
    )
    if (landed !== hash) {
      // Thrown rather than collected into `failures`, which every other
      // problem here is. The difference is that this one has already decided
      // what gets written: the run continues, `docs/` receives a picture of
      // the wrong screen, and the summary at the end arrives after the damage
      // — or never, because a later `prepare` clicks a control that is not
      // there and the timeout kills the process before anything is printed.
      // That is exactly what happened to a working tree here. The committed
      // images survived it, and only because nobody committed that run.
      throw new Error(
        `${name}: asked for ${hash} and the console showed ${landed || 'the default view'}. ` +
          'The admin console hides the routes the caller may not use and falls back to the ' +
          'first one it will show, so this would photograph a different screen. Check the ' +
          '`GET /v1/me` fixture — its `role` is what decides.',
      )
    }
  }

  if (prepare !== undefined) await prepare(page)
  await page.waitForTimeout(250)

  await controlHeadroom(page, name)

  const file = join(OUT, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`  ${file}`)
  await page.close()
}

/**
 * A control flush against whatever is above it is a control you miss.
 *
 * `lint:admin-layout` reads the stylesheet and this is **geometry**, which
 * needs a browser — and this script already opens one on every screen. The
 * instance that made it worth writing: the recovery link sat at **zero pixels**
 * under the Sign in button, because `.hint` carries no top margin and
 * `.btn-block` only a small one, so a mis-tap on a full-width button lands on
 * "forgotten your password".
 *
 * The question is deliberately the general one — for every control, how far is
 * the nearest box that ends above it and overlaps it horizontally — rather than
 * control-against-control. The sibling repository learned that the narrow way
 * round: it compared controls to controls, and the next instance was a control
 * under a *paragraph*, which such a rule cannot see. An ancestor never
 * qualifies, since an ancestor's bottom is below its child's; what qualifies is
 * the heading, paragraph or row the control follows.
 *
 * Eight pixels, which is what the platforms ask for between targets.
 *
 * Scoped to the view and to any open dialog. The masthead is `position: sticky`
 * and overlaps whatever has scrolled under it, so measuring against it would
 * report a distance that is about scrolling rather than about layout.
 */
const MIN_HEADROOM = 8

async function controlHeadroom(page, name) {
  const tight = await page.evaluate((min) => {
    const visible = (n) => n.getClientRects().length > 0
    /*
     * One root at a time, never across two.
     *
     * A dialog is a layer *over* the page, so a control in it is a few pixels
     * under whatever the page happened to have painted there — the first
     * version reported the New user dialog's Cancel button as five pixels under
     * the users table behind it, which is a fact about stacking and not about
     * layout. What a person sees is one surface at a time, and that is what this
     * measures.
     */
    const roots = [...document.querySelectorAll('dialog[open]')]
    if (roots.length === 0) roots.push(...document.querySelectorAll('.main, .signin'))
    const within = (selector) => roots.flatMap((r) => [...r.querySelectorAll(selector)]).filter(visible)

    const controls = within('button, select, input, textarea, a[href]')
    const boxes = within('*')
    const label = (n) => n.id || n.textContent.trim().slice(0, 32) || n.className || n.tagName.toLowerCase()
    const row = (n) => n.closest('tr')
    const field = (n) => n.closest('label, .field')

    const found = []
    for (const control of controls) {
      const c = control.getBoundingClientRect()
      let nearest = null
      for (const other of boxes) {
        if (other === control || other.contains(control) || control.contains(other)) continue

        /*
         * Three exclusions, and every one of them is an arrangement where being
         * close is the design rather than a defect. Without them this reported
         * thirty things across fourteen screens and named the one real defect
         * among them, which is a check nobody reads.
         *
         * A field's own label. `.field` is `label > span + input`, so the span
         * above the box *is* that box's name — four pixels is what a form looks
         * like, and eight would be a form with gaps in it.
         */
        if (field(control) !== null && field(control) === field(other)) continue
        /*
         * A different row of the same table. Row height is the table's business
         * and `lint:admin-layout` already governs it; the distance between one
         * row's action and the next row's is a property of density, not of
         * whether a control has room.
         */
        if (row(control) !== null && row(other) !== null && row(control) !== row(other)) continue

        const o = other.getBoundingClientRect()
        // Ends above it, and shares some horizontal extent with it. The half
        // pixel is for a border that rounds the other way.
        if (o.bottom > c.top + 0.5) continue
        if (o.right < c.left + 0.5 || o.left > c.right - 0.5) continue
        /*
         * Beside it rather than above it. An inline box on the same line — the
         * text a copy control sits next to — ends a pixel or two above the
         * control's top because the two are baseline-aligned, and reading that
         * as "no headroom" is reading a line box as a stack. What says they are
         * stacked is that the box above spans a real part of the control's
         * width, so a 30px icon beside a sentence does not qualify and a
         * paragraph over a button does.
         */
        const shared = Math.min(o.right, c.right) - Math.max(o.left, c.left)
        if (shared < Math.min(c.width, o.width) * 0.5) continue

        const gap = c.top - o.bottom
        if (nearest === null || gap < nearest.gap) {
          nearest = { gap: Math.round(gap), above: label(other) }
        }
      }
      if (nearest !== null && nearest.gap < min) found.push({ below: label(control), ...nearest })
    }
    return found
  }, MIN_HEADROOM)

  for (const t of tight) {
    failures.push(
      `${name}: "${t.below}" sits ${String(t.gap)}px under "${t.above}". A control needs ` +
        `${String(MIN_HEADROOM)}px of headroom from whatever is above it — flush against it, the ` +
        'thing you meant to press is the thing you miss. This is geometry, so `lint:admin-layout` ' +
        'cannot see it; the margin that is missing is on one of the two.',
    )
  }
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
await shot('new-user', {
  hash: '#/people',
  prepare: async (page) => {
    await page.getByRole('button', { name: 'New user' }).click()
    await page.waitForTimeout(150)
  },
})
// The step somebody can click past without noticing, which is why it is its own
// screen in the product and its own picture here.
await shot('new-user-password', {
  hash: '#/people',
  prepare: async (page) => {
    await page.getByRole('button', { name: 'New user' }).click()
    await page.getByPlaceholder('dana@example.com').fill('kim@example.com')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.waitForTimeout(250)
  },
})
await shot('group-members', {
  hash: '#/people',
  prepare: async (page) => {
    await page.getByRole('row', { name: /legal/ }).getByRole('button', { name: 'Members' }).click()
    await page.waitForTimeout(250)
  },
})
// Deleting a layer asks for the slug rather than for a click: a grant
// re-issues, and a layer's documents do not come back.
await shot('delete-layer', {
  hash: '#/layers',
  prepare: async (page) => {
    await page.getByRole('row', { name: /handbook/ }).getByRole('button', { name: 'Delete' }).click()
    await page.waitForTimeout(150)
  },
})
await shot('accounts', { hash: '#/accounts' })
await shot('security', { hash: '#/security' })
// The installation with no key, which is the default and what most self-hosters
// see. The password panel has to survive it: the whole view used to return
// early here, so a message about TOTP would have hidden a control that works.
await shot('security-no-key', {
  hash: '#/security',
  fixtures: { 'GET /v1/me/second-factor': 404 },
})
// And the installation that offers the *stronger* kind and not the weaker one,
// which is every deployment with no `NACRE_2FA_KEY` since 0.19.0 — WebAuthn
// needs no key to seal anything. The panel has to draw one button and not two,
// and the note about a secure context belongs here rather than on a pressed
// control, because a browser served over http has no `navigator.credentials`
// at all and this pass runs on one.
await shot('security-keys-only', {
  hash: '#/security',
  fixtures: {
    'GET /v1/me/second-factor': {
      items: [
        { id: '5d3b8e17-6c04-4a92-b7e5-1f8a0c3d6b24', kind: 'webauthn', label: 'Yubikey',
          created_at: '2026-02-20T11:02:00.000Z', last_used_at: '2026-03-14T07:41:00.000Z' },
      ],
      recovery_codes_left: 10,
      kinds: ['webauthn'],
    },
  },
})

await browser.close()
server.close()

if (failures.length > 0) {
  reportFailures()
  process.exit(1)
}
console.log('every screen rendered with no page errors and no missing fixture')
