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

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const versionOnly = args.includes('--version')

let failed = false

const all = manifests()
const packages = publishable(all)
const names = new Set(packages.map((p) => p.name))

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
