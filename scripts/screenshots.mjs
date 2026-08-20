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
import { extname, join, resolve } from 'node:path'

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
/**
 * The geometry rules, which `nacre-enterprise` fetches at the version its image
 * is built `FROM`. They left this file so there is one statement of them rather
 * than two across a boundary no check can see both sides of — see that file's
 * header.
 */
import { RULES } from './layout-rules.mjs'

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
 *
 * **What counts as source is discovered, not listed**, and that is the second
 * version. The first read `packages/admin/src` and nothing else — so a change
 * to `packages/admin/public/admin.css` was invisible to it, and the stylesheet
 * is where every layout defect this script exists to find actually lives. Found
 * by falling into it: a rule added to `.dialog` to prove the new check could
 * fail changed nothing, because `dist/` still carried the old stylesheet and
 * the guard had nothing to say. A check that knows about one of two inputs is
 * the shape this repository keeps naming, arriving inside the guard written
 * against it.
 *
 * The sourcemap is what knows. esbuild records every file it bundled, so the
 * SDK's own sources — which are compiled into this bundle and are equally
 * capable of being stale — are covered without being named. `public/` is the
 * other half and is copied rather than bundled, so it appears in no map and is
 * walked.
 */
const newest = (dir) =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .reduce((latest, e) => Math.max(latest, statSync(join(e.parentPath, e.name)).mtimeMs), 0)

/** Every file the bundle was built from, out of the bundle's own sourcemap. */
function bundledSources() {
  const map = join(BUNDLE, 'app.js.map')
  if (!existsSync(map)) {
    // Refused rather than skipped. With no map there is no way to know what
    // this bundle was built from, and a guard that quietly covers nothing is
    // worse than none — it is read as "the bundle is current".
    console.error(
      `::error::${map} is missing, so there is no way to tell which sources this bundle ` +
        'was built from. Run `pnpm build` before rendering.',
    )
    process.exit(1)
  }
  const { sources } = JSON.parse(readFileSync(map, 'utf8'))
  return sources.map((s) => resolve(BUNDLE, s)).filter((s) => existsSync(s))
}

const built = newest(BUNDLE)
const inputs = [...bundledSources(), 'packages/admin/public']
const stale = inputs.filter((input) =>
  (statSync(input).isDirectory() ? newest(input) : statSync(input).mtimeMs) > built,
)
if (stale.length > 0) {
  console.error(
    `::error::${BUNDLE} is older than ${stale[0]}${stale.length > 1 ? ` and ${stale.length - 1} other input(s)` : ''}` +
      ' — rebuild before rendering, or this pass photographs the console as it was and ' +
      'reports success',
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
    principal_id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90',
    role: 'org_admin',
    // Both of what the server actually sends — admin-surface.test.ts pins the
    // key set. Without them every default shot rendered through the SDK's
    // legacy fallback (`role === 'org_admin'`), so a fixture no server sends
    // was proving the derivation the field exists to replace. The direction
    // where the two disagree — an org_admin whose ceiling-bounded delegation
    // answers administers: false — is pinned in the SDK's own client.test.ts,
    // where it belongs: no screenshot can separate them when they agree.
    administers: true,
    holds_own_credentials: true,
  },
  /*
   * The access log. Two roles read two different logs and the server decides
   * which, so these records are what an `org_admin` sees: administrative
   * actions *and* who read what, which is the question docs/audit.md opens on.
   *
   * `occurred_at` is absolute, like every other fixture date here, because the
   * clock is frozen — a relative time computed from the wall clock is how two
   * runs eleven minutes apart produced different images with no code change.
   */
  // `label` is what the server actually writes: every event builder assembles
  // it as `${type}:${id}`, so it is never a name. This fixture said
  // `dana@example.com` — a value no server sends — and that is what let the
  // Actor column render a whole uuid over a shortened one on a running stand
  // while this picture looked correct. The ids are the ones `GET /v1/users` and
  // `GET /v1/service-accounts` below actually list, so the column resolves here
  // the way it resolves for an operator.
  'GET /v1/audit': {
    items: [
      {
        id: '10492',
        occurred_at: '2026-03-15T08:52:14.203Z',
        actor: { type: 'user', id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90', label: 'user:0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90' },
        surface: 'rest',
        client: null,
        action: 'grant.issue',
        target: { grant_id: '4f8b2d61-95ce-4a07-b3d2-1e6a8c05f7b4', scope: 'layer:handbook' },
        result: 'allow',
        detail: {},
        request_id: 'req_7f2c9a',
      },
      {
        id: '10491',
        occurred_at: '2026-03-15T08:41:02.884Z',
        actor: { type: 'service_account', id: 'c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55', label: 'service_account:c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55' },
        surface: 'mcp',
        client: 'claude-desktop',
        action: 'document.read',
        target: { doc_id: 'e77a3c10-9d42-4b86-8f51-0a4c7e93b2d6' },
        result: 'allow',
        detail: {},
        request_id: 'req_2b81de',
      },
      // An `error` beside the `allow` and the `deny`, so all three values of
      // the Result column are on the screen — and therefore all three under the
      // check that they render at one size. A fixture with two of three values
      // is a column whose third size nothing measures.
      {
        id: '10490b',
        occurred_at: '2026-03-15T08:40:11.402Z',
        actor: { type: 'user', id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90', label: 'user:0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90' },
        surface: 'rest',
        client: null,
        action: 'document.ingest',
        target: { layer: 'handbook' },
        result: 'error',
        detail: {},
        request_id: 'req_2b81df',
      },
      {
        id: '10490',
        occurred_at: '2026-03-15T08:39:47.115Z',
        actor: { type: 'service_account', id: 'c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55', label: 'service_account:c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55' },
        surface: 'mcp',
        client: 'claude-desktop',
        action: 'search',
        target: { layer: 'contracts' },
        result: 'deny',
        detail: {},
        request_id: 'req_2b81dd',
      },
      {
        id: '10489',
        occurred_at: '2026-03-14T17:03:20.010Z',
        actor: { type: 'user', id: '0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90', label: 'user:0b5d9a72-1e46-4c38-8a05-3f7c2e6b1d90' },
        surface: 'rest',
        client: null,
        action: 'audit.read',
        target: {},
        result: 'allow',
        detail: {},
        request_id: 'req_91c0ab',
      },
    ],
    next_cursor: null,
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
      // `write` beside the `read`, and the two are different lengths — so the
      // Permission column has a width to agree about. A fixture carrying one
      // value is a column whose pills nothing compares, which is the same gap
      // the Result column had while its `error` row was missing.
      { id: '2d8f4a71-6c95-4b03-9a1e-5e7b2c0d0f39',
        principal_type: 'group', principal_id: '8e1a7c34-2b09-4d56-af73-6c0e5b9d2a41',
        scope_type: 'workspace', scope_id: WORKSPACE,
        permission: 'write', effect: 'allow', source: 'api' },
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
      // A credential several people hold, so the `shared` tag is in the picture
      // rather than being a thing only the code knows about. It is the one row
      // here whose person cannot enrol a second factor.
      { id: '2a6e1c58-3b90-4f27-a4d1-7c8b0e5f9a43', email: 'kiosk@example.com', role: 'member',
        created_at: '2026-03-01T09:00:00.000Z', disabled_at: null, has_password: true,
        shared: true },
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

  // Every rule, from the module that knows how many there are. Named calls
  // here would be a second list, and the fifth rule would reach one console
  // and not the other — which is the whole reason those moved out.
  for (const rule of RULES) await rule(page, name, failures)

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
// The enrolment dialog, which had no picture and was the one screen a defect
// was reported from: the secret sat in a box with nothing to press, and the
// setup link was truncated to 48 characters with the rest in a `title` — a
// tooltip a phone does not have, on the one string somebody opens *on their
// phone*. Both are controls now, so both belong in a shot.
await shot('add-authenticator', {
  hash: '#/security',
  fixtures: {
    'POST /v1/me/second-factor': {
      id: '2f6a1c94-7b30-4d85-a1e2-9c4f0b7d3a68',
      secret: 'UVGOBGZUXKFMVIMNET65LHE3ERGYVCYP',
      otpauth_url:
        'otpauth://totp/https%3A%2F%2Fplayground.nacre.work:dana%40example.com' +
        '?secret=UVGOBGZUXKFMVIMNET65LHE3ERGYVCYP&issuer=https%3A%2F%2Fplayground.nacre.work',
    },
  },
  prepare: async (page) => {
    await page.getByRole('button', { name: 'Add an authenticator app' }).click()
    // Continue, because the secret is on the *second* step and the first
    // version of this shot photographed a name field — the screen it was added
    // to show was one press away and not in the picture.
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.waitForTimeout(300)
  },
})
await shot('audit', { hash: '#/audit' })
/*
 * The log narrowed to one actor.
 *
 * There is no field to type an id into — `check-id-fields.mjs` forbids one and
 * the log is the strongest case for that rule, since every actor worth
 * filtering on is already on the screen. So the interaction is a press, and a
 * press is exactly the thing a static picture of the default view cannot show
 * works. The fixture is what a filtered response actually is — the two records
 * belonging to that actor — rather than the full list under a chip saying it
 * was narrowed, which would photograph the filter not being applied.
 */
await shot('audit-actor', {
  hash: '#/audit',
  fixtures: {
    'GET /v1/audit': {
      items: FIXTURES['GET /v1/audit'].items.filter(
        (record) => record.actor.id === 'c41d90b6-58a2-4e77-9f30-1b8e6a2d4c55',
      ),
      next_cursor: null,
    },
  },
  prepare: async (page) => {
    await page.getByRole('button', { name: /support-agent/u }).first().click()
    await page.waitForTimeout(150)
  },
})
// A platform administrator signing into a tenant's console.
//
// `administers(auth)` in the API is `org_admin` and nothing else — a
// `platform_admin` administers the *installation*, not this organization — so
// every administrative screen answers `404` to one. This shot is what says
// whether the console knows that, and it is deliberately taken with the
// administrative fixtures still in place: the question is what the nav offers,
// not what the screens would show.
await shot('platform-admin', {
  hash: '#/search',
  fixtures: {
    'GET /v1/me': {
      organization: 'acme',
      principal_type: 'user',
      principal_id: '9b3e5c71-24af-4d08-8e16-3f7c0a5b2d94',
      role: 'platform_admin',
      // The server's own answer, and the whole point: `administers(auth)` is
      // `org_admin` and nothing else, so a fixture that omitted this would be
      // one written to match a derivation rather than a response.
      administers: false,
      holds_own_credentials: true,
    },
  },
})
/*
 * The other log, which is a different log rather than the same one shorter.
 *
 * `/v1/audit` sets `administrativeOnly` from the *role* and never from the
 * request, so a platform administrator is not shown which documents were read —
 * that is the access the permission model spends its whole effort denying, and
 * the journal proving they did not have it must not be the way around it. The
 * fixture is therefore the administrative records alone, which is what the
 * server would send.
 *
 * Photographed because the screen's job here is to *say* which log is on the
 * page: an empty document-read column looks exactly like an organization where
 * nobody read anything, and only one of those is true.
 */
await shot('audit-platform-admin', {
  hash: '#/audit',
  fixtures: {
    'GET /v1/me': {
      organization: 'acme',
      principal_type: 'user',
      principal_id: '9b3e5c71-24af-4d08-8e16-3f7c0a5b2d94',
      role: 'platform_admin',
      administers: false,
      holds_own_credentials: true,
    },
    // The three listings this role is genuinely refused, so the Actor column is
    // photographed doing what it does for a platform administrator rather than
    // what it does for an `org_admin`. Without these the picture resolves every
    // name — which is the shape of untruth that put a uuid on a running stand
    // while this file's own audit shot looked correct.
    'GET /v1/users': 404,
    'GET /v1/groups': 404,
    'GET /v1/service-accounts': 404,
    'GET /v1/audit': {
      items: FIXTURES['GET /v1/audit'].items.filter((record) => record.action !== 'document.read'),
      next_cursor: null,
    },
  },
})
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
