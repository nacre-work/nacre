#!/usr/bin/env node
/**
 * One rule for what an email address is.
 *
 * ## The defect
 *
 * There were two. `POST /v1/users` required a token with an `@` and a dot after
 * it; `init` required an `@` and nothing else. So
 * `nacre-init --email admin@localhost` created an organization whose
 * administrator holds an address the product refuses for anybody else — the
 * first colleague added at that domain fails with a `400`, and the
 * administrator who cannot understand why is looking at their own account,
 * which was accepted.
 *
 * Invisible on a real deployment, where the domain has a dot. Found by running
 * the demo stand with a host that does not.
 *
 * What makes it worth a check rather than a fix is where the second rule was:
 * one line below a comment stating the principle it broke — *"The same rule
 * `provisionOrganization` applies, asked here only to turn it into a usage
 * message. The function refuses regardless, which is what keeps this from being
 * the copy that drifts."* True of the slug on the line above, false of the
 * email on the line below, and nothing asked.
 *
 * ## The rule
 *
 * `looksLikeEmail` lives in `packages/core/provision.ts`, beside the slug rule
 * it is the sibling of, because `provisionOrganization` writes the first
 * `users` row of every organization and was the one writer that did not ask.
 * Everything else imports it.
 *
 * So: exactly one definition, and no hand-rolled second opinion anywhere that
 * decides whether a string is an address.
 *
 * ## What it cannot see
 *
 * A rule spelled some way this does not recognise — a helper called something
 * else, a check written as a database constraint. It holds the two shapes that
 * have actually appeared here: a regular expression tested against a value that
 * is called an email, and `includes('@')`. Stated rather than implied, because
 * a check that overclaims is the failure this repository keeps writing checks
 * about.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...sources(path))
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(path)
  }
  return out
}

const files = ['packages/core', 'packages/api/src', 'packages/mcp/src', 'packages/cli/src', 'packages/sdk/src']
  .flatMap((dir) => {
    try {
      return sources(join(root, dir))
    } catch {
      return []
    }
  })

const DEFINITION = /export function looksLikeEmail\b/
// A second opinion: `@` asked about by hand, or a pattern with an `@` in it
// tested against something called an address.
const BY_HAND = /\.includes\(\s*'@'\s*\)|\.indexOf\(\s*'@'\s*\)/
const OWN_PATTERN = /\/\^?\[[^\]]*\][^/\n]*@[^/\n]*\/\s*\.test\(/

const definitions = []
const problems = []

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const source = text
    .replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (b) => ' '.repeat(b.length))

  if (DEFINITION.test(source)) definitions.push(relative(root, file))

  source.split('\n').forEach((line, index) => {
    if (!BY_HAND.test(line) && !OWN_PATTERN.test(line)) return
    // The definition itself is the one place a pattern belongs.
    if (DEFINITION.test(source) && OWN_PATTERN.test(line)) return
    if (!/email|address/i.test(line)) return
    problems.push(
      `${relative(root, file)}:${String(index + 1)} decides whether a string is an email ` +
        'address by itself. There is one rule — `looksLikeEmail`, in ' +
        '`packages/core/provision.ts` — and a second one is how `init` came to accept an ' +
        'address that `POST /v1/users` refuses. Import it.',
    )
  })
}

if (definitions.length === 0) {
  console.error(
    '::error::found no `looksLikeEmail` definition. This check exists to hold it to one; with ' +
      'none to find it must not report green — either it was renamed, in which case this ' +
      'should follow it, or the rule is gone and so should this be.',
  )
  process.exit(1)
}

if (definitions.length > 1) {
  problems.push(
    `\`looksLikeEmail\` is defined in ${String(definitions.length)} places — ` +
      `${definitions.join(', ')}. Two definitions of one rule is the defect this check exists ` +
      'for, arriving under the right name.',
  )
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} problem(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `one email rule, in ${definitions[0]}, and no second opinion in ${String(files.length)} file(s).\n`,
)
