#!/usr/bin/env node
/**
 * The colours in an email are the brand's, and an email cannot ask.
 *
 * ## Why this file exists
 *
 * Everything else this product draws resolves a custom property: the console's
 * stylesheet says `var(--n-accent)` and `lint:tokens` refuses a hex literal
 * anywhere in it. A mail client resolves nothing — no stylesheet, no custom
 * properties, in several clients not even a `<style>` block — so
 * `packages/core/mail.ts` has to write the values out. That is the one place in
 * this repository where a colour is a literal, and a literal is exactly what
 * goes stale.
 *
 * The failure is quiet and slow: the brand moves a stratum, the console follows
 * it through the mirror on the next sync, and the product's mail keeps sending
 * last year's teal to every person who forgets a password. Nothing renders
 * wrongly and nothing fails.
 *
 * ## What it compares
 *
 * Each entry in `PALETTE` documents the token it came from, in its own doc
 * comment. This reads those pairs and resolves each token out of
 * `packages/admin/public/brand/tokens.css` — the mirror the console ships,
 * which the brand repository's own `check-mirrors.mjs` holds byte-for-byte
 * against the source of truth. So the chain is: brand → mirror → this check →
 * the mail.
 *
 * One level of `var()` is followed, because the theme rows are written that way
 * (`--n-accent: var(--n-strata-2-dense)`). Deeper would be a resolver, and a
 * palette entry that needs one is a palette entry worth naming directly.
 *
 * ## What it cannot see
 *
 * A token named correctly and used in the wrong place. This holds the value
 * against the name it claims; whether that name is the right one for a caution
 * rule is a design review, and this is not one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAIL = 'packages/core/mail.ts'
const TOKENS = 'packages/admin/public/brand/tokens.css'

const source = readFileSync(join(root, MAIL), 'utf8')
const tokens = readFileSync(join(root, TOKENS), 'utf8')

/** The `PALETTE` object literal, and nothing else in the file. */
const block = /const PALETTE = \{(.*?)\n\} as const/su.exec(source)
if (block === null) {
  console.error(
    `::error::${MAIL} has no \`const PALETTE = { … } as const\` for this check to hold. ` +
      'If the palette moved, move this check with it — a check that cannot find its ' +
      'subject must not report green.',
  )
  process.exit(1)
}

/**
 * Every `name: '#HEX'` in that block, with the token from the doc comment above
 * it. Read in one pass so a comment can never be attributed to the entry after
 * the one it was written for.
 */
const entries = []
let pendingToken
for (const line of block[1].split('\n')) {
  const named = /--(n-[a-z0-9-]+)/u.exec(line)
  if (named !== null) pendingToken = named[1]
  const value = /^\s*([a-zA-Z]+):\s*'(#[0-9a-fA-F]{3,8})'/u.exec(line)
  if (value === null) continue
  entries.push({ key: value[1], hex: value[2], token: pendingToken })
  pendingToken = undefined
}

if (entries.length === 0) {
  console.error(
    `::error::${MAIL}'s PALETTE has no colours in it, so this check has nothing to hold.`,
  )
  process.exit(1)
}

/** Every `--n-…: value` in the mirror, last definition winning. */
const declared = new Map()
for (const [, name, value] of tokens.matchAll(/--(n-[a-z0-9-]+)\s*:\s*([^;}]+)/gu)) {
  declared.set(name, value.trim())
}

/** One level of `var(--x)`, which is how the theme rows are written. */
function resolve(name) {
  const value = declared.get(name)
  if (value === undefined) return undefined
  const indirect = /^var\(\s*--(n-[a-z0-9-]+)\s*\)$/u.exec(value)
  return indirect === null ? value : declared.get(indirect[1])
}

const problems = []
for (const entry of entries) {
  if (entry.token === undefined) {
    problems.push(
      `${entry.key}: ${entry.hex} names no token. Every colour here is the brand's, so say ` +
        'which one in the comment above it — that is what makes it checkable.',
    )
    continue
  }
  const actual = resolve(entry.token)
  if (actual === undefined) {
    problems.push(`${entry.key}: --${entry.token} is not defined in ${TOKENS}`)
    continue
  }
  if (actual.toLowerCase() !== entry.hex.toLowerCase()) {
    problems.push(
      `${entry.key}: --${entry.token} is ${actual} in ${TOKENS} and ${entry.hex} in ${MAIL}`,
    )
  }
}

for (const problem of problems) console.error(`::error::${problem}`)
if (problems.length > 0) {
  console.error(
    `\n${problems.length} colour(s) in the product's mail disagree with the brand. Mail ` +
      'cannot resolve a custom property, so these are literals and this is the only thing ' +
      'holding them.',
  )
  process.exit(1)
}

console.log(`${entries.length} colours in ${MAIL}, all matching their token in ${TOKENS}`)
