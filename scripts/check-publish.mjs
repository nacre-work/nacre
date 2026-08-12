#!/usr/bin/env node
/**
 * What the release is about to push to npm has to be installable.
 *
 * Four ways it was not, none of which a build or a test would notice, because
 * every consumer in this repository resolves workspace packages from source:
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
