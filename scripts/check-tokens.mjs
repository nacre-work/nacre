#!/usr/bin/env node
/**
 * No colour is invented in the admin UI. Every one resolves to a brand token.
 *
 * ## Why this file exists
 *
 * `admin.css` has said, in its own header since it was written, "Nothing here
 * invents a hex value, and `lint:tokens` fails the build if one appears."
 * There was no `lint:tokens`. It is named in that sentence and nowhere else —
 * not in `package.json`, not in a workflow, not in `scripts/`.
 *
 * The property happened to hold, which is what made it invisible: the
 * stylesheet had zero hex literals when this was written, so the sentence read
 * as true and the gate it promised was never missed. That is the same shape as
 * a variable validated at startup and read by nothing, and as a cache written
 * and tested and called by no request path — declared, believed, enforced by
 * nothing. A claim that a check exists is worse than a comment asking for one,
 * because a reader stops looking.
 *
 * ## The rule
 *
 * A colour in the admin UI's own stylesheet is a `var(--n-…)`. The palette
 * lives in `public/brand/`, which is a mirror of the brand repository and the
 * one place a hex value belongs — that directory is skipped, and the mirror is
 * held byte-for-byte by the brand repository's own `check-mirrors.mjs` rather
 * than by anything here.
 *
 * `currentColor`, `transparent` and `color-mix(…)` over tokens are all fine:
 * none of them names a colour, which is the thing being kept out.
 *
 * ## What it cannot see
 *
 * A named CSS colour — `red`, `rebeccapurple` — is not a hex literal and is not
 * caught. Neither is a token spelled correctly and used wrongly. This holds the
 * one mistake the sentence was about; it is not a design review.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'packages/admin/public')

/** Every stylesheet the admin UI ships except the brand mirror. */
function stylesheets(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    // The mirror is where the palette is defined, so it is the one place a hex
    // value is correct. It is checked against the brand repository, not here.
    if (entry === 'brand') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...stylesheets(path))
    else if (entry.endsWith('.css')) out.push(path)
  }
  return out
}

const files = stylesheets(publicDir)

if (files.length === 0) {
  console.error(
    '::error::found no stylesheet under packages/admin/public outside brand/. This check ' +
      'exists to hold them; with none to read it must not report green.',
  )
  process.exit(1)
}

const problems = []
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  // Comments are prose and may quote a colour while explaining why not to use
  // one. The declarations are what ships.
  const declarations = text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  const lines = declarations.split('\n')
  lines.forEach((line, index) => {
    for (const hit of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      problems.push(
        `${relative(root, file)}:${String(index + 1)} names the colour \`${hit[0]}\`. ` +
          'Every colour in the admin UI resolves to a brand token — `var(--n-…)` — so the ' +
          'palette has one definition and a mirror can be compared against it. If this needs ' +
          'a colour the tokens do not have, it is a change to the brand repository first.',
      )
    }
  })
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} invented colour(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(files.length)} admin stylesheet(s) read, every colour a brand token.\n`,
)
