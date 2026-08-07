#!/usr/bin/env node
/**
 * One generated-password implementation, and one word list.
 *
 * There were two. A 60-word list beside `init` and a 28-word list beside the
 * user endpoints, each with its own copy of the same six-words-and-a-number
 * generator — so the same product minted credentials at two different
 * strengths depending on which door they came through: 41.9 bits from `init`,
 * 35.3 bits from `POST /v1/users`, which is the door an administrator uses to
 * onboard a colleague and to reset a password somebody lost.
 *
 * Neither number was written down correctly. The comment on the stronger one
 * said "roughly 70 bits".
 *
 * Nothing compared them, which is this repository's most repeated shape: a
 * property that has to hold in N places with nothing that knows N. Finding one
 * instance is not a licence to repair it — the repair is the thing that asks
 * all N, and this is it.
 *
 * Deliberately a source check rather than a test, on the same reasoning as
 * `check-admin-gate.mjs` and `check-collection-config.mjs`: what is asserted is
 * that a *shape* does not appear anywhere, and a test can only assert about the
 * generators somebody remembered to write one for — which is exactly the gap.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages/core', 'packages/api/src', 'packages/worker/src', 'packages/mcp/src', 'packages/admin/src']

/** Where the one implementation lives, and where the reasoning lives with it. */
const DEFINES = 'packages/core/passwords.ts'

/**
 * A word list, recognised by two words that appear in the real one.
 *
 * Matched on content rather than on a variable name: a second list called
 * `NOUNS` or `SYLLABLES` is the same defect, and the name is the part a person
 * choosing to write one would change. Two hits on one line is the signal —
 * these are ordinary English words and one of them in prose means nothing.
 */
const LOOKS_LIKE_A_WORD_LIST =
  /'(?:abalone|nacre|stratum|pelagic|aragonite|spindrift|obsidian|iridescent)'[^\n]*'(?:abalone|nacre|stratum|pelagic|aragonite|spindrift|obsidian|iridescent)'/

/** A second generator: six-ish words joined with hyphens and a number stuck on. */
const LOOKS_LIKE_THE_GENERATOR = /\.join\(\s*'-'\s*\)\}-\$\{/

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path)
  }
}
for (const root of ROOTS) walk(root)

let failed = false
let scanned = 0

for (const file of files) {
  if (file === DEFINES) continue
  scanned += 1
  const source = readFileSync(file, 'utf8')

  if (LOOKS_LIKE_A_WORD_LIST.test(source)) {
    console.error(
      `::error file=${file}::a second password word list. The strength of a generated ` +
        'password is a function of the list, so two lists are two strengths for one product ' +
        `— and that is how one door came to mint 35 bits and another 42. Use ` +
        `\`generatePassword\` from ${DEFINES}.`,
    )
    failed = true
  }

  if (LOOKS_LIKE_THE_GENERATOR.test(source)) {
    console.error(
      `::error file=${file}::a second password generator. Use \`generatePassword\` from ` +
        `${DEFINES}, which is the one place the entropy is computed rather than claimed.`,
    )
    failed = true
  }
}

if (scanned === 0) {
  console.error(`::error::no source found under ${ROOTS.join(', ')}; this check scanned nothing`)
  process.exit(1)
}

// The definition site has to keep existing, or this becomes a ban on a thing
// with nothing offering the alternative.
if (!files.includes(DEFINES)) {
  console.error(`::error::${DEFINES} is gone, so this check now forbids a generator with no replacement`)
  failed = true
}

if (!failed) console.log(`${scanned} file(s), one password generator and one word list`)
process.exit(failed ? 1 : 0)
