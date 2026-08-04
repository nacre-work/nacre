#!/usr/bin/env node
/**
 * The version about to be released has a section in `docs/upgrading.md`.
 *
 * A release body is a list of pull request titles — `--generate-notes` produces
 * it and it is the right thing for a changelog. It is not what an operator
 * opens a release to find out, which is whether this version wants a new
 * variable, a new service, a backup first, or nothing at all. That answer lives
 * in `docs/upgrading.md`, and the only way it stays true is if a release cannot
 * happen without it.
 *
 * So this is the same shape as the SDK's coverage gate and the config drift
 * check: not a lint on prose, but a refusal to ship a version the operator
 * documentation has never heard of. The fix is a section — and "0.4.1 — nothing
 * to do" is a perfectly good section, because "nothing" is an answer somebody
 * needs and cannot infer from silence.
 *
 * Run with no arguments it checks the version in the manifests. `--version X`
 * overrides, for a dry run.
 */
import { readFileSync } from 'node:fs'

import { agreedVersion } from './publishable.mjs'

const UPGRADING = 'docs/upgrading.md'

function fail(message, hint) {
  console.error(`::error::${message}`)
  if (hint !== undefined) console.error(hint)
  process.exit(1)
}

const flag = process.argv.indexOf('--version')
let version
if (flag !== -1) {
  version = process.argv[flag + 1]
  if (version === undefined) fail('--version needs a value')
} else {
  const agreed = agreedVersion()
  if (agreed.errors !== undefined) fail(agreed.errors.join('; '))
  version = agreed.version
}

let doc
try {
  doc = readFileSync(UPGRADING, 'utf8')
} catch {
  fail(`${UPGRADING} is missing, and a release without it tells an operator nothing`)
}

/**
 * The headings, at the level the per-version notes use.
 *
 * Read by scanning rather than parsing, for the same reason the SDK's coverage
 * gate scans the OpenAPI document: there is no markdown dependency in this
 * workspace and this is not the place to introduce one.
 *
 * A section is `### {version}` optionally followed by an em-dash and a summary,
 * so `### 0.3.0 — breaking` counts and `### 0.3.0-rc.1` does not count as
 * `0.3.0`.
 */
const sections = []
for (const line of doc.split('\n')) {
  const heading = /^### (\S+)(?:\s+—.*)?$/.exec(line)
  if (heading?.[1] !== undefined) sections.push(heading[1])
}

if (sections.length === 0) {
  fail(
    `${UPGRADING} has no version sections at all`,
    'Expected headings of the form "### 0.4.0" or "### 0.4.0 — what changed".',
  )
}

if (!sections.includes(version)) {
  fail(
    `${UPGRADING} has no section for ${version}`,
    `Add "### ${version}" with what this release asks of an operator: a new ` +
      'environment variable, a new service, a migration worth scheduling, a ' +
      'reason to take a backup first — or "nothing to do", which is an answer ' +
      'somebody needs and cannot infer from an absent section.\n' +
      `Sections present: ${sections.join(', ')}`,
  )
}

console.log(`${UPGRADING}: ${version} documented (${sections.length} version section(s))`)
