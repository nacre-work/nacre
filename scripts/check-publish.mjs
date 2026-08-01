#!/usr/bin/env node
/**
 * What the release workflow is about to push to npm has to be installable.
 *
 * Three ways it was not, none of which a build or a test would notice, because
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
 * 3. Version 0.0.0. The release workflow fires on a `v*` tag and publishes
 *    whatever is in the manifests, so every tag published 0.0.0 — the first
 *    succeeding and every one after it failing on "cannot publish over an
 *    existing version", which reads as a registry problem rather than as the
 *    tag never having been applied to anything.
 *
 * Run with a tag to check 3 as well: `node scripts/check-publish.mjs v0.2.0`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = 'packages'
const tag = process.argv[2]

let failed = false
const manifests = new Map()

for (const name of readdirSync(PACKAGES)) {
  const path = join(PACKAGES, name, 'package.json')
  if (!existsSync(path)) continue
  manifests.set(name, { path, json: JSON.parse(readFileSync(path, 'utf8')) })
}

const published = new Set(
  [...manifests.values()].filter(({ json }) => json.private !== true).map(({ json }) => json.name),
)

for (const [dir, { path, json }] of manifests) {
  if (json.private === true) continue

  for (const [dependency, range] of Object.entries(json.dependencies ?? {})) {
    if (!dependency.startsWith('@nacre.work/')) continue
    if (published.has(dependency)) continue
    console.error(
      `::error file=${path}::${json.name} is published and depends on ${dependency} ` +
        `(${range}), which is not. \`npm i ${json.name}\` fails on resolution.`,
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

  if (tag !== undefined) {
    const expected = tag.replace(/^v/, '')
    if (json.version !== expected) {
      console.error(
        `::error file=${path}::${json.name} is at ${json.version} and the tag says ${expected}. ` +
          'The workflow publishes what the manifest holds, so this tag would publish the wrong ' +
          'version — or republish one that already exists and fail as though the registry were down.',
      )
      failed = true
    }
  }
}

if (!failed) {
  const names = [...published].sort().join(', ')
  console.log(`publishable: ${names}${tag === undefined ? '' : ` — all at ${tag.replace(/^v/, '')}`}`)
}

process.exit(failed ? 1 : 0)
