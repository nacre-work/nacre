#!/usr/bin/env node
/**
 * Somebody a policy will not sign in until they enrol, in a real browser,
 * against a real server and a real PostgreSQL.
 *
 * A **real registered gate**, not a stubbed response. `withLoadingModuleForTests`
 * opens the registry and a gate goes in that answers `enrol` for an account with
 * no factor — which is what the commercial module will do, and is the only part
 * of this arrangement that is not the shipping product. Everything between the
 * password field and the console is the real thing: the core's `issue`, the
 * enrolment challenge, the narrow door, the SDK, and the console's own screen.
 *
 * This is the check that says the wiring works, and nothing else could. The
 * unit suites prove the gate, the door and the SDK **separately** — each against
 * a stub of the next — and mocks agree with whatever they were written to. The
 * defect this exists against is the one that shape produces: a screen that
 * cannot act on an answer the server gives, which is the failure
 * `GET /v1/auth/methods` exists to prevent, arriving from the other side.
 *
 * Wants a database and a browser, so it runs in the `console` job beside
 * `webauthn-e2e.mjs`, which already pays for both.
 */
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const specifier = process.env.NACRE_PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(specifier).catch((error) => {
  console.error(`::error::could not import ${specifier} — install playwright and set NACRE_PLAYWRIGHT to its index.mjs`)
  throw error
})
const { createPool, hashPassword, registerSignInGate, withLoadingModuleForTests, resetExtensionsForTests } =
  await import('../packages/core/dist/index.js')
const { createApi } = await import('../packages/api/dist/index.js')
const { Login } = await import('../packages/api/dist/login.js')
const { SecondFactors } = await import('../packages/api/dist/second-factor.js')
const { totpCode, totpStep } = await import('../packages/core/dist/totp.js')

const PG = process.env.NACRE_PG_URL
if (PG === undefined || PG === '') {
  console.error('::error::NACRE_PG_URL is not set. This drives a real database on purpose.')
  process.exit(1)
}

const SECRET = new TextEncoder().encode('a'.repeat(32))
const SEAL = Buffer.alloc(32, 7)
const BUNDLE = fileURLToPath(new URL('../packages/admin/dist', import.meta.url))
const PASSWORD = 'a properly long password'
const problems = []
const say = (ok, what) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`)
  if (!ok) problems.push(what)
}

const pool = createPool({ connectionString: PG })
const client = await pool.connect()
let orgId, userId
try {
  await client.query("DELETE FROM organizations WHERE slug = 'e2egate'")
  const { rows } = await client.query(
    `INSERT INTO organizations (slug, name, vector_collection)
     VALUES ('e2egate','e2egate','org_e2egate') RETURNING id`)
  orgId = rows[0].id
  const { rows: people } = await client.query(
    `INSERT INTO users (org_id, email, role, password_hash)
     VALUES ($1,'gil@e2egate.test','org_admin',$2) RETURNING id`,
    [orgId, await hashPassword(PASSWORD)])
  userId = people[0].id
} finally { client.release() }

const PORT = 8124
const ORIGIN = `http://localhost:${PORT}`

/*
 * The policy, as a module would register it.
 *
 * `enrolled` is the input it turns on, which is why the core carries that field
 * separately from "what was proved on this request": this gate has to admit the
 * request that *completes* an enrolment, and a renewal proves no factor while
 * the account may hold one.
 */
resetExtensionsForTests()
withLoadingModuleForTests('enterprise-policy', () => {
  registerSignInGate({
    name: 'second-factor-required',
    check: async (context) =>
      context.enrolled
        ? { kind: 'admit' }
        : { kind: 'enrol', reason: 'Acme requires everybody to use a second factor.' },
  })
})

const factors = new SecondFactors({
  pool,
  key: SEAL,
  issuer: ORIGIN,
  relyingParty: { id: 'localhost', name: 'localhost', origins: [ORIGIN] },
})
const login = new Login({
  pool, key: SECRET, issuer: ORIGIN, audience: 'nacre',
  accessTokenTtl: 900, refreshTokenTtl: 86400, secondFactors: factors,
})
const api = createApi({
  verify: { key: SECRET, issuer: ORIGIN, audience: 'nacre' },
  documents: { read: async () => undefined },
  search: { search: async () => [] },
  ingest: { queue: async () => undefined, remove: async () => false },
  audit: { write: async () => undefined },
  login,
  secondFactors: factors,
})

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' }
const server = createServer((req, res) => {
  if (req.url.startsWith('/v1') || req.url.startsWith('/oauth') || req.url.startsWith('/.well-known')) {
    api.emit('request', req, res)
    return
  }
  const path = req.url.split('?')[0]
  const file = join(BUNDLE, path === '/' ? 'index.html' : path)
  if (!existsSync(file) || !file.startsWith(BUNDLE)) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(readFileSync(join(BUNDLE, 'index.html')))
    return
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await context.newPage()
page.on('pageerror', (e) => say(false, `page error: ${e.message}`))

// ─── 1. the password is right, and the answer is not a session ───
await page.goto(`${ORIGIN}/#/`, { waitUntil: 'networkidle' })
await page.getByLabel('Email', { exact: false }).fill('gil@e2egate.test')
await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForTimeout(900)

say(
  await page.getByRole('heading', { name: 'Add a second factor' }).isVisible().catch(() => false),
  'a correct password with no factor lands on the enrolment step, not on a refusal',
)
say(
  (await page.locator('body').innerText()).includes('Acme requires everybody to use a second factor.'),
  "the gate's own words are on the screen",
)
// The console is not open. A screen that adopted the challenge as a session
// would be here with no token and every call 401ing.
say(
  !(await page.getByRole('link', { name: 'Search' }).isVisible().catch(() => false)),
  'the console did not open on a challenge that is not a session',
)

// ─── 2. enrol an authenticator through the door ───
await page.getByRole('button', { name: 'Use an authenticator app' }).click()
await page.waitForTimeout(700)
const secret = (await page.locator('pre.secret').first().innerText()).trim()
say(secret.length > 10, 'the secret to put into an authenticator is shown as text')

await page.getByLabel('Code', { exact: true }).fill(totpCode(secret, totpStep(new Date())))
await page.getByRole('button', { name: 'Confirm' }).click()
await page.waitForTimeout(900)

// ─── 3. the codes are shown before the console opens ───
const afterConfirm = await page.locator('body').innerText()
say(
  afterConfirm.includes('Save these recovery codes'),
  'the recovery codes are shown before the console opens — they are printed once',
)
const codes = (await page.locator('pre.secret').first().innerText()).trim().split('\n').filter(Boolean)
say(codes.length === 10, `ten recovery codes, and there are ${codes.length}`)

// ─── 4. Continue opens the console, with no second sign-in ───
await page.getByRole('button', { name: 'Continue' }).click()
await page.waitForTimeout(900)
say(
  await page.getByRole('link', { name: 'Search' }).isVisible().catch(() => false),
  'confirming the factor was the end of the sign-in — the console opens with no second password',
)
// The key the console actually writes. Named rather than guessed: the first
// version of this line read `nacre.token` and reported a missing session on a
// console that had plainly opened, which is a check that would send somebody
// hunting for a defect in the product.
const stored = await page.evaluate(() => globalThis.sessionStorage.getItem('nacre.admin.token'))
const kept = await page.evaluate(() => globalThis.sessionStorage.getItem('nacre.admin.refresh'))
say(typeof stored === 'string' && stored.length > 20, 'a real access token was adopted from the confirm')
say(typeof kept === 'string' && kept.length > 20, 'and the refresh token with it, so the session survives fifteen minutes')

// ─── 5. and the row is in the database, sealed ───
const check = await pool.connect()
try {
  const { rows } = await check.query(
    `SELECT kind, confirmed_at FROM user_second_factors WHERE org_id = $1 AND user_id = $2`,
    [orgId, userId])
  say(rows.length === 1 && rows[0].kind === 'totp', 'one confirmed TOTP factor on the account')
  say(rows[0]?.confirmed_at !== null, 'it is confirmed, which is what the gate reads')
} finally { check.release() }

// ─── 6. signing in again is ordinary now ───
// Cleared and **reloaded**. The console is drawn from what was in storage when
// the page loaded, so clearing it without a reload leaves the signed-in screen
// up and the sign-in form nowhere — which is what timed this out the first time.
await page.evaluate(() => globalThis.sessionStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(400)
await page.getByLabel('Email', { exact: false }).fill('gil@e2egate.test')
await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
await page.getByRole('button', { name: 'Sign in' }).click()
await page.waitForTimeout(800)
say(
  await page.getByRole('heading', { name: 'Two-factor' }).isVisible().catch(() => false),
  'the next sign-in asks for the factor rather than for another enrolment',
)

await browser.close()
server.close()
await pool.end()

if (problems.length > 0) {
  console.error(`::error::${problems.length} problem(s): ${problems.join('; ')}`)
  process.exit(1)
}
console.log('\nthe sign-in gate, end to end: a password that is not a session, the enrolment step, the codes, and a console that opens without a second sign-in.')
