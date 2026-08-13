#!/usr/bin/env node
/**
 * What the release is about to push to npm has to be installable — and, once it
 * arrives, has to say what it is.
 *
 * Four ways it was not installable, none of which a build or a test would
 * notice, because every consumer in this repository resolves workspace packages
 * from source:
 *
 * 1. A published package depending on a private one. `@nacre.work/mcp` is
 *    public and `docs/quickstart.md` tells people to run `npx @nacre.work/mcp`
 *    — and it depended on `@nacre.work/api`, which was `private: true` and
 *    would never reach the registry. The install fails on resolution, before
 *    anything of ours runs.
 * 2. A `bin` with no shebang. npm marks it executable; the kernel still needs
 *    the interpreter line, and without it the command fails with a syntax
 *    error from the shell.
 * 3. Version 0.0.0, published by a tag that was never applied to anything. The
 *    release no longer fires on a tag — it fires on the version in these
 *    manifests naming something the registry does not have — so the check that
 *    used to compare a tag to a manifest is now the one below.
 * 4. Packages disagreeing about the version. They ship together and reference
 *    each other by exact version, so one left behind publishes a tree that
 *    resolves to two different cores.
 *
 * And one way it was unreadable, which is not an install failure and is the
 * only defect on this list a *buyer* sees. **A package page is its README.**
 * npm renders it as the whole body of the page and falls back to the one-line
 * `description` when there is nothing else — so four of the five packages
 * published a title and one sentence, and the storefront for a security product
 * was a stub. Metadata was complete throughout; nothing was missing in the
 * manifest, which is why nothing complained.
 *
 * `--list` prints the publishable names and nothing else, `--version` prints
 * the version they agree on. Diagnostics go to stderr either way, so stdout
 * stays consumable.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGES, agreedVersion, manifests, publishable } from './publishable.mjs'

/**
 * The document that says what gets published, and what a new name costs.
 *
 * Held against the manifests rather than left to be remembered, because the
 * thing it documents is invisible until it goes wrong: trusted publishing is
 * configured per package on npmjs.com, the very first publish of a new name is
 * therefore the one the pipeline cannot do, and it fails **after** the merge
 * with a `404` that reads as "no such package".
 *
 * `@nacre.work/cli` was added and nobody knew that until the release was
 * already the commit on main. A note would have been read by whoever wrote it;
 * this is read by whoever adds the next one.
 */
const RELEASING = 'docs/releasing.md'
const RELEASE_WORKFLOW = '.github/workflows/release.yml'

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const versionOnly = args.includes('--version')

let failed = false

const all = manifests()
const packages = publishable(all)
const names = new Set(packages.map((p) => p.name))

const releasing = readFileSync(RELEASING, 'utf8')

/**
 * The manual first publish packs with pnpm, the same as the pipeline.
 *
 * A workspace dependency is written `workspace:*` and **`pnpm pack` is what
 * rewrites it into a concrete version**. npm does not understand the protocol
 * and publishes the manifest as written, so a bare `npm publish` from a package
 * directory uploads a tarball nobody can install — and nothing fails while it
 * happens. The tarball uploads, the page renders, the version appears, and
 * every `npm install` and `npx` afterwards dies on resolution.
 *
 * `@nacre.work/cli@0.14.3` is on the registry with `"workspace:*"` for exactly
 * this reason, published from a version of that document which gave the bare
 * command. The correct procedure was already written down — in a comment above
 * the pipeline's two commands, where it did not travel. This is the check that
 * makes the two agree, which is what the comment should have been.
 */
// Every fenced block that publishes has to pack first. Matched on the *code*
// and not on the page, because the first version of this check asked whether
// the document mentioned `pnpm pack` anywhere — and the prose explaining why it
// matters satisfied that while the command above it was still wrong. A check
// that stays green over the defect it names is worse than no check.
const blocks = [...releasing.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
const publishing = blocks.filter((block) => /npm publish/.test(block))

if (publishing.length === 0) {
  console.error(`::error file=${RELEASING}::no publish command at all; this check compared nothing`)
  failed = true
}

for (const block of publishing) {
  if (/pnpm[\s\S]*?\bpack\b/.test(block)) continue
  console.error(
    `::error file=${RELEASING}::a publish command that does not pack with pnpm first. ` +
      '`pnpm pack` is what rewrites `workspace:*` into a concrete version; npm publishes ' +
      'the manifest as written and every install then fails on resolution.',
  )
  failed = true
}

if (!readFileSync(RELEASE_WORKFLOW, 'utf8').includes('pack')) {
  console.error(
    `::error file=${RELEASE_WORKFLOW}::the release stopped packing with pnpm, and ` +
      `${RELEASING} still says it does`,
  )
  failed = true
}
for (const { name, path } of packages) {
  if (releasing.includes(`\`${name}\``)) continue
  console.error(
    `::error file=${path}::${name} is published and ${RELEASING} does not list it. ` +
      'That document carries the four things a new publishable package needs, and the ' +
      'fourth — configuring trusted publishing for the name, by hand, before merging — ' +
      'is the one the pipeline cannot do for you.',
  )
  failed = true
}

// And the other direction, which is the half that goes stale silently: a
// package that became `private` stays in the table describing what npm holds.
for (const [, { json }] of all) {
  if (json.private !== true) continue
  if (!releasing.includes(`\`${json.name}\``)) continue
  if (/not published/.test(releasing.split(`\`${json.name}\``)[1]?.slice(0, 200) ?? '')) continue
  console.error(
    `::error::${json.name} is private and ${RELEASING} lists it as published`,
  )
  failed = true
}

for (const { dir, path, name, json } of packages) {
  for (const [dependency, range] of Object.entries(json.dependencies ?? {})) {
    if (!dependency.startsWith('@nacre.work/')) continue
    if (names.has(dependency)) continue
    console.error(
      `::error file=${path}::${name} is published and depends on ${dependency} ` +
        `(${range}), which is not. \`npm i ${name}\` fails on resolution.`,
    )
    failed = true
  }

  for (const [command, target] of Object.entries(json.bin ?? {})) {
    const file = join(PACKAGES, dir, target)
    if (!existsSync(file)) {
      console.error(`::error file=${path}::bin ${command} points at ${target}, which is not built`)
      failed = true
      continue
    }
    if (!readFileSync(file, 'utf8').startsWith('#!')) {
      console.error(
        `::error file=${file}::bin ${command} has no shebang. npm makes it executable; ` +
          'the kernel still needs the interpreter line.',
      )
      failed = true
    }
  }
}

/**
 * The page a package arrives as.
 *
 * npm always packs `README.md` whatever `files` says, so this is never about
 * whether it ships — it is about whether it says anything. The registry page
 * for a library nobody can evaluate is a page nobody installs from, and the
 * four stubs this check was written against had been on the registry for every
 * release the project has cut.
 *
 * Four properties, and each is a way a page goes quietly useless:
 *
 * - **Substance.** A heading and one sentence is what npm already shows from
 *   `description`; a README that adds nothing to the manifest is a README that
 *   is not there. The floor is deliberately low — this catches a stub, not a
 *   short page.
 * - **The site and the documentation, by absolute URL.** Somebody landing on
 *   npmjs.com has no other route to either.
 * - **No relative links.** This is the npm-specific one and the reason the rule
 *   cannot be "write a good README": a relative link is correct in the
 *   repository, renders on npmjs.com against *npmjs.com*, and 404s there. It is
 *   right where it is written and broken where it is read.
 * - **The licence**, because the thing being decided on that page is whether to
 *   depend on it.
 */
const README_MIN_LINES = 20
const SITE = 'https://nacre.work'
const DOCS = 'https://github.com/nacre-work/nacre'
// `[text](target)` where the target is neither absolute nor an anchor. Image
// syntax is the same shape with a leading `!` and has the same defect.
const RELATIVE_LINK = /!?\[[^\]]*\]\((?!https?:\/\/|#|mailto:)([^)]+)\)/g

for (const { dir, path, name } of packages) {
  const readmePath = join(PACKAGES, dir, 'README.md')
  if (!existsSync(readmePath)) {
    console.error(
      `::error file=${path}::${name} is published and has no README.md. npm renders it as ` +
        'the whole package page.',
    )
    failed = true
    continue
  }

  const readme = readFileSync(readmePath, 'utf8')
  const substance = readme.split('\n').filter((line) => line.trim() !== '').length

  if (substance < README_MIN_LINES) {
    console.error(
      `::error file=${readmePath}::${name}'s README is ${substance} lines and says no more ` +
        `than \`description\` already does. npm shows this as the package page; ${README_MIN_LINES} ` +
        'is the floor for "somebody could decide from it".',
    )
    failed = true
  }

  for (const [what, url] of [
    ['the site', SITE],
    ['the documentation', DOCS],
  ]) {
    if (readme.includes(url)) continue
    console.error(
      `::error file=${readmePath}::${name}'s README does not link ${what} (${url}). ` +
        'A reader on npmjs.com has no other route to it.',
    )
    failed = true
  }

  if (!/Apache[ -]2\.0/.test(readme)) {
    console.error(
      `::error file=${readmePath}::${name}'s README does not name the licence, which is ` +
        'the question being answered on that page.',
    )
    failed = true
  }

  for (const [, target] of readme.matchAll(RELATIVE_LINK)) {
    console.error(
      `::error file=${readmePath}::${name}'s README links \`${target}\` relatively. npm ` +
        'resolves that against npmjs.com, where it 404s — correct in the repository and ' +
        'broken where it is read. Use an absolute URL.',
    )
    failed = true
  }
}

/**
 * How many things adding a publishable package costs, held against the list.
 *
 * The number is prose in two files — `docs/releasing.md` states it above the
 * list and `CLAUDE.md` repeats it to point at that list — and this check going
 * in is what moved it from four to five. Both copies had to change; only `grep`
 * knew there were two, which is the one defect shape here with no mechanism
 * behind it. This is the mechanism for this instance of it.
 *
 * Cheap to state and it fails on the real mistake: adding a sixth item and
 * leaving either sentence saying five.
 *
 * Anchored on "publishable package" rather than matching the numeral anywhere,
 * which is how the first version of this failed: `CLAUDE.md` says "Two things
 * there were found by looking at a screenshot" hundreds of lines earlier, and a
 * bare search for a spelled number before "things" read that one. It reported a
 * mismatch that was not there — a check wrong in the direction that at least
 * announces itself.
 */
const COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight']
const items = [...releasing.matchAll(/^\d+\. \*\*/gm)].length
const spelled = COUNTS[items]

for (const file of [RELEASING, 'CLAUDE.md']) {
  const text = readFileSync(file, 'utf8')
  const claimed = new RegExp(
    `publishable package[\\s\\S]{0,120}?\\b(${COUNTS.join('|')})\\b things`,
    'i',
  ).exec(text)
  if (claimed === null) {
    console.error(
      `::error file=${file}::the count of what adding a publishable package costs is gone ` +
        'from this file; it is the sentence that sends somebody to the list.',
    )
    failed = true
    continue
  }
  if (claimed[1].toLowerCase() === spelled) continue
  console.error(
    `::error file=${file}::says "${claimed[1]} things" and ${RELEASING} lists ${items}. ` +
      'The last of them is configuring trusted publishing by hand, which fails after the ' +
      'merge — an undercount is how it gets skipped.',
  )
  failed = true
}

const agreed = agreedVersion(packages)
if (agreed.errors !== undefined) {
  for (const error of agreed.errors) console.error(`::error::${error}`)
  failed = true
}

if (!failed) {
  const sorted = packages.map((p) => p.name)
  if (listOnly) console.log(sorted.join('\n'))
  else if (versionOnly) console.log(agreed.version)
  else console.log(`publishable: ${sorted.join(', ')} — all at ${agreed.version}`)
}

process.exit(failed ? 1 : 0)
