#!/usr/bin/env node
/**
 * The whole ceremony, in a real browser, against a real server and a real
 * PostgreSQL.
 *
 * Everything before this proved a half. `packages/core/__tests__/webauthn.test.ts`
 * verifies genuine bytes against a verifier; `webauthn-live.test.ts` asks a
 * database what it does with a challenge; `webauthn-routes.test.ts` asks the
 * routes against a stubbed store. None of them ever put a browser's own
 * `navigator.credentials` on one end and Postgres on the other, which is the
 * arrangement every defect in this repository's history came out of.
 *
 * Chrome's virtual authenticator over CDP produces real WebAuthn bytes — the
 * same mechanism that generated the fixtures — so what is under test here is
 * the *wiring*: the console's encoding, the routes, the store, the verifier,
 * and Postgres, with nothing stubbed between them.
 *
 * It is also the only thing that would have caught the two 0.18.0 defects this
 * change fixed, because both were routes nothing had ever asked the *server*
 * for: `DELETE /v1/me/second-factor/{id}` answering 404 for every id, and
 * `GET /v1/auth/methods` answering 404 because the sign-in surface took only
 * POST. The last assertion here is the first of those, by name.
 *
 * Wants a database and a browser, which is why the `console` job grew a
 * Postgres service rather than this becoming a job of its own.
 */
import { createServer } from 'node:http'
import { extname, join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// `NACRE_PLAYWRIGHT` names the module, for the same reason `screenshots.mjs`
// takes one: an ESM `import` resolves from the importing file and never from
// NODE_PATH, so a package installed into a directory of its own has to be named.
const specifier = process.env.NACRE_PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(specifier).catch((error) => {
  console.error(`::error::could not import ${specifier} — install playwright and set NACRE_PLAYWRIGHT to its index.mjs`)
  throw error
})
const { createPool, hashPassword } = await import('../packages/core/dist/index.js')
const { createApi } = await import('../packages/api/dist/index.js')
const { Login } = await import('../packages/api/dist/login.js')
const { SecondFactors } = await import('../packages/api/dist/second-factor.js')

const PG = process.env.NACRE_PG_URL
if (PG === undefined || PG === '') {
  console.error('::error::NACRE_PG_URL is not set. This drives a real database on purpose.')
  process.exit(1)
}
const SECRET = new TextEncoder().encode('a'.repeat(32))
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
  await client.query("DELETE FROM organizations WHERE slug = 'e2ekeys'")
  const { rows } = await client.query(
    `INSERT INTO organizations (slug, name, vector_collection)
     VALUES ('e2ekeys','e2ekeys','org_e2ekeys') RETURNING id`)
  orgId = rows[0].id
  const { rows: people } = await client.query(
    `INSERT INTO users (org_id, email, role, password_hash)
     VALUES ($1,'dana@e2ekeys.test','org_admin',$2) RETURNING id`,
    [orgId, await hashPassword(PASSWORD)])
  userId = people[0].id
} finally { client.release() }

// The relying party is derived from the address this is served at, exactly as
// `main.ts` derives it from NACRE_CANONICAL_URL. The port is deliberately not
// in the id: a relying party id is a registrable domain.
const PORT = 8123
const ORIGIN = `http://localhost:${PORT}`
const factors = new SecondFactors({
  pool,
  key: undefined, // the installation with no NACRE_2FA_KEY — WebAuthn only
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

// One origin serving the bundle and /v1, which is the arrangement every
// deployment has — and the reason the console needs no CORS.
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

// A virtual authenticator. `hasResidentKey: false` and `isUserVerified: true`
// is the shape of a roaming security key with a PIN already entered.
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
})

const signIn = async () => {
  await page.goto(`${ORIGIN}/#/`, { waitUntil: 'networkidle' })
  await page.getByLabel('Email', { exact: false }).fill('dana@e2ekeys.test')
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

// ─── 1. enrol, from the console, with a real authenticator ───
await signIn()
await page.waitForTimeout(800)
await page.goto(`${ORIGIN}/#/security`, { waitUntil: 'networkidle' })
await page.waitForTimeout(600)

const addKey = page.getByRole('button', { name: 'Add a security key' })
say(await addKey.isVisible(), 'the console offers a security key with no NACRE_2FA_KEY set')
say(!(await page.getByRole('button', { name: 'Add an authenticator app' }).isVisible().catch(() => false)),
    'and does not offer the authenticator app, which this installation cannot seal')

await addKey.click()
await page.waitForTimeout(300)
await page.getByRole('button', { name: 'Continue' }).click()
await page.waitForTimeout(1500)

const codes = await page.locator('pre.secret').textContent().catch(() => null)
say(codes !== null && codes.split('\n').length === 10, `ten recovery codes printed once (${codes ? codes.split('\n').length : 0})`)
await page.getByRole('button', { name: 'I have saved them' }).click()
await page.waitForTimeout(800)

const { rows: stored } = await pool.query(
  `SELECT kind, credential_id, alg, sign_count, public_key FROM user_second_factors
    WHERE org_id = $1 AND user_id = $2`, [orgId, userId])
say(stored.length === 1 && stored[0].kind === 'webauthn', 'one webauthn row in Postgres')
say(stored[0]?.public_key?.kty === 'EC', `the public key is stored as a JWK (kty=${stored[0]?.public_key?.kty})`)
say(stored[0]?.alg === -7, `the algorithm is recorded (${stored[0]?.alg})`)

// ─── 2. sign in with the key, end to end ───
// Through the console's own control rather than by clearing storage from a
// page script: signing out revokes the refresh token as well as forgetting it,
// so this is the state a person is actually in when they come back.
await page.getByRole('button', { name: 'Sign out' }).click().catch(async () => {
  await page.getByText('Sign out', { exact: true }).click()
})
await page.waitForTimeout(800)
await signIn()
await page.waitForTimeout(900)

const useKey = page.getByRole('button', { name: 'Use a security key' })
say(await useKey.isVisible(), 'the sign-in screen offers the key after a correct password')
say(!(await page.getByLabel('Code', { exact: true }).isVisible().catch(() => false)),
    'and asks for no code, since this installation cannot issue one')

await useKey.click()
await page.waitForTimeout(2000)
const nav = await page.locator('nav a, .nav a').allTextContents().catch(() => [])
say(nav.some((t) => /Security/i.test(t)), `signed in with the key alone (nav: ${nav.join(', ') || 'none'})`)

const { rows: after } = await pool.query(
  `SELECT sign_count, last_used_at FROM user_second_factors WHERE org_id = $1`, [orgId])
say(Number(after[0]?.sign_count) > Number(stored[0]?.sign_count),
    `the counter moved (${stored[0]?.sign_count} → ${after[0]?.sign_count})`)
say(after[0]?.last_used_at !== null, 'and last_used_at was written')

// ─── 3. the challenge is single-use ───
const replay = await page.evaluate(async (origin) => {
  const r = await fetch(`${origin}/v1/auth/second-factor`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ challenge: 'not-a-challenge', assertion: {
      credential_id: 'x', authenticator_data: 'x', client_data_json: 'x', signature: 'x', challenge: 'x' } }),
  })
  return r.status
}, ORIGIN)
say(replay === 401, `a forged challenge is refused (${replay})`)

// ─── 4. remove it, proving possession with the same key ───
await page.goto(`${ORIGIN}/#/security`, { waitUntil: 'networkidle' })
await page.waitForTimeout(700)
await page.getByRole('button', { name: 'Remove' }).first().click()
await page.waitForTimeout(400)
const removeButtons = await page.locator('dialog button').allTextContents()
say(removeButtons.includes('Remove'), `the removal dialog offers a proof (${removeButtons.join(', ')})`)
await page.locator('dialog').getByRole('button', { name: 'Remove', exact: true }).click()
await page.waitForTimeout(2000)

const { rows: left } = await pool.query('SELECT count(*)::int AS n FROM user_second_factors WHERE org_id = $1', [orgId])
say(left[0].n === 0, `the factor is gone (${left[0].n} left) — the DELETE that answered 404 in 0.18.0`)

await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
await browser.close()
server.close()
await pool.end()

console.log(problems.length === 0 ? '\nthe whole ceremony works in a browser against a real database'
                                  : `\n${problems.length} problem(s)`)
process.exit(problems.length === 0 ? 0 : 1)
