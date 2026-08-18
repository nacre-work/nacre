#!/usr/bin/env node
/**
 * Genuine WebAuthn fixtures, from Chrome's own virtual authenticator.
 *
 * `packages/core/__tests__/webauthn.test.ts` carries registration and assertion
 * blobs, and they are **not hand-encoded** — they came out of a real browser
 * driving `navigator.credentials.create()` and `.get()` against a virtual
 * authenticator over CDP. That is the rule `totp.ts` follows by using RFC
 * 6238's own vectors: a decoder checked against bytes this repository encoded
 * agrees with itself and with no authenticator anybody owns.
 *
 * Run by hand when the fixtures need regenerating, and paste the output in. The
 * suite itself needs no browser, which is what keeps `test:unit` fast and
 * dependency-free.
 *
 *   pnpm dlx playwright@1 install chromium
 *   NACRE_PLAYWRIGHT=…/node_modules/playwright/index.mjs node scripts/webauthn-fixtures.mjs
 *
 * `localhost` rather than an address, because WebAuthn refuses to run on one:
 * a virtual authenticator on `127.0.0.1` answers `SecurityError: This is an
 * invalid domain`, which is the browser enforcing the same secure-origin rule a
 * deployment meets.
 */
/*
 * `page.evaluate` serialises its callback and runs it *in the page*, so the
 * browser globals below are real there and absent here. Declared rather than
 * disabled, so a genuine typo in this file is still caught — the same note
 * `screenshots.mjs` carries for the same reason.
 */
/* global navigator, crypto, btoa, atob */
const { chromium } = await import(process.env.NACRE_PLAYWRIGHT ?? 'playwright')
import { createServer } from 'node:http'

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<!doctype html><title>fixtures</title><body>')
})
await new Promise((r) => server.listen(8099, '127.0.0.1', r))
const browser = await chromium.launch()
const context = await browser.newContext()
const page = await context.newPage()
await page.goto('http://localhost:8099/')
const cdp = await context.newCDPSession(page)
await cdp.send('WebAuthn.enable')

const out = {}
for (const [name, alg] of [['es256', -7], ['rs256', -257]]) {
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })
  const made = await page.evaluate(async (alg) => {
    const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const cred = await navigator.credentials.create({ publicKey: {
      challenge, rp: { name: 'Nacre', id: 'localhost' },
      user: { id: Uint8Array.from([9,9,9,9]), name: 'dana@example.test', displayName: 'Dana' },
      pubKeyCredParams: [{ type: 'public-key', alg }],
      authenticatorSelection: { userVerification: 'preferred' },
      attestation: 'none',
    }})
    return { id: cred.id, challenge: b64(challenge),
      attestationObject: b64(cred.response.attestationObject),
      clientDataJSON: b64(cred.response.clientDataJSON) }
  }, alg)
  const got = await page.evaluate(async (credId) => {
    const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')
    const un64 = (s) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0))
    const challenge = crypto.getRandomValues(new Uint8Array(32))
    const a = await navigator.credentials.get({ publicKey: {
      challenge, rpId: 'localhost',
      allowCredentials: [{ type: 'public-key', id: un64(credId) }],
      userVerification: 'preferred' }})
    return { challenge: b64(challenge),
      authenticatorData: b64(a.response.authenticatorData),
      clientDataJSON: b64(a.response.clientDataJSON),
      signature: b64(a.response.signature) }
  }, made.id)
  out[name] = { registration: made, assertion: got }
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
}
console.log(JSON.stringify(out, null, 2))
await browser.close()
server.close()
