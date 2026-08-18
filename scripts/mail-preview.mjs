#!/usr/bin/env node
/**
 * Render every message this product sends, and ask a browser what it looks
 * like.
 *
 * ## Why a browser and not an assertion
 *
 * `packages/core/__tests__/mail.test.ts` beside this holds the string: both
 * parts carry the same sentences, a caller's text is escaped, a link is http.
 * What no string assertion answers is whether the markup *renders* — and the
 * first version of this feature shipped a defect that no string test would
 * have found from the outside: the brand's font stacks were spelled with double
 * quotes and interpolated into `style="…"`, which closes the attribute at the
 * first character of the family name and drops every declaration after it. The
 * HTML still parsed. Every paragraph simply lost its size, its leading and its
 * colour.
 *
 * So the question goes where a mail client's question goes: what does a
 * paragraph *compute* to. Chromium is not Outlook and nothing here pretends
 * otherwise — what it can say is that the markup is well-formed enough to
 * carry the brand, which is the half that was broken.
 *
 * ## It renders the real messages
 *
 * `everyMessage` is the product's own list, so this cannot drift from what
 * somebody receives. A preview that retyped its subjects would be a preview of
 * something nobody is sent — the fixture-written-to-match-the-code shape, one
 * surface along.
 *
 * ## Running it
 *
 *   pnpm build && node scripts/mail-preview.mjs
 *
 * Playwright is not a dependency of this repository, for the reason
 * `screenshots.mjs` states at length. Set `NACRE_PLAYWRIGHT` to the module's
 * own path. `--out` writes the HTML files somewhere to look at them.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* The browser side of `page.evaluate`, which is lexically here and runs
   somewhere else. Declared rather than listed as a global for these scripts:
   telling the linter a Node script may use `document` is telling it a mistake
   is fine. `screenshots.mjs` says the same thing at the top of itself. */
/* global document */

const specifier = process.env.NACRE_PLAYWRIGHT ?? 'playwright'
const { chromium } = await import(specifier).catch((error) => {
  console.error(
    '::error::playwright is not installed. It is not a dependency of this repository on ' +
      'purpose — set NACRE_PLAYWRIGHT to the module\'s own path, for example ' +
      `…/node_modules/playwright/index.mjs. (${String(error)})`,
  )
  process.exit(1)
})

const { everyMessage } = await import('../packages/api/dist/messages.js')

const outIndex = process.argv.indexOf('--out')
const OUT = outIndex === -1 ? undefined : process.argv[outIndex + 1]
const SHOTS = process.env.NACRE_MAIL_SHOTS

const messages = everyMessage('dana@example.com', 'https://nacre.example')
if (messages.length === 0) {
  console.error('::error::there are no messages to preview, so this check has nothing to hold')
  process.exit(1)
}

/** The brand values these must render as, read from the module that emits them. */
const INK = 'rgb(10, 16, 23)'
const ACCENT = 'rgb(23, 112, 107)'

const browser = await chromium.launch()
const failures = []

for (const [index, sent] of messages.entries()) {
  const name = sent.subject.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  const file = `${String(index + 1).padStart(2, '0')}-${name}`

  if (OUT !== undefined) {
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${file}.html`), sent.html)
    writeFileSync(join(OUT, `${file}.txt`), `${sent.subject}\n\n${sent.text}\n`)
  }

  // A phone's width, because that is where most mail is read and it is the
  // width a fixed 560px table would break at.
  const page = await browser.newPage({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 2 })
  page.on('pageerror', (error) => failures.push(`${file}: ${String(error)}`))
  await page.setContent(sent.html, { waitUntil: 'load' })

  const measured = await page.evaluate((subject) => {
    // Not "the first long cell", which the first version asked for and which
    // is the *heading* on four of the five — the harness failing in the shape
    // the product does. The subject is the one string this page carries twice,
    // so it is what tells the heading from a paragraph.
    const paragraph = [...document.querySelectorAll('td')].find(
      (td) =>
        td.children.length === 0 &&
        td.textContent.trim().length > 30 &&
        td.textContent.trim() !== subject,
    )
    const anchor = document.querySelector('a')
    const style = paragraph === undefined ? undefined : globalThis.getComputedStyle(paragraph)
    return {
      colour: style?.color,
      size: style?.fontSize,
      leading: style?.lineHeight,
      href: anchor?.getAttribute('href'),
      button: anchor === null ? undefined : globalThis.getComputedStyle(anchor).backgroundColor,
      // A table wider than the viewport is a message a phone scrolls sideways.
      overflow: document.documentElement.scrollWidth > globalThis.innerWidth + 1,
      background: globalThis.getComputedStyle(document.body).backgroundColor,
    }
  }, sent.subject)

  // The paragraph's own declarations, which is what the quoting defect ate.
  if (measured.colour !== INK) failures.push(`${file}: a paragraph is ${measured.colour}, not ${INK}`)
  if (measured.size !== '15.5px') failures.push(`${file}: a paragraph is ${measured.size}, not 15.5px`)
  // 15.5 × 1.55, which the brand calls `--n-leading-body`.
  if (measured.leading !== '24.025px') {
    failures.push(`${file}: a paragraph leads at ${measured.leading}, not 24.025px`)
  }
  if (measured.background !== 'rgb(241, 245, 246)') {
    failures.push(`${file}: the page is ${measured.background}, not the pearl background`)
  }
  if (measured.overflow) failures.push(`${file}: the message scrolls sideways at 390px`)
  if (measured.href !== undefined) {
    if (!measured.href.startsWith('https://')) failures.push(`${file}: its link is ${measured.href}`)
    if (measured.button !== ACCENT) {
      failures.push(`${file}: its button is ${measured.button}, not the accent ${ACCENT}`)
    }
  }

  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `${file}.png`), fullPage: true })
  }
  await page.close()
  console.log(`  ${sent.subject}`)
}

await browser.close()

for (const failure of failures) console.error(`::error::${failure}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s) in ${messages.length} messages`)
  process.exit(1)
}
console.log(`${messages.length} messages render in the brand at 390px`)
