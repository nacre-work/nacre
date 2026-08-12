#!/usr/bin/env node
/**
 * Every workspace package's manifest reaches the image.
 *
 * `docker/Dockerfile` copies the manifests one line at a time, before the
 * sources, so that a source-only change reuses the dependency layer. That is
 * worth having and it is a list — which means it is a list that does not get
 * the next entry.
 *
 * It did not get `packages/cli`. Inside the image pnpm then saw seven workspace
 * projects instead of eight, installed nothing for the eighth, and `pnpm build`
 * failed on `Cannot find module '@nacre.work/sdk'` — a package that is right
 * there in the tree. Nothing local could see it: on a developer's machine and
 * in every other CI job the workspace is complete, so `pnpm build`, `typecheck`
 * and both suites passed while the image could not be built at all.
 *
 * That is the shape this repository keeps finding, arriving through a
 * Dockerfile: a property that has to hold in N places with nothing that knows
 * N. So the answer is not the seventh COPY line — it is the thing that counts
 * them.
 *
 * Deliberately a check rather than a glob copy of every manifest at once, which
 * does not do what it looks like: Docker flattens the matches into the
 * destination directory, so all eight manifests would land on top of each other
 * as one file. The list has to stay a list; it just has to be a checked one.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DOCKERFILE = 'docker/Dockerfile'
const PACKAGES = 'packages'

const workspace = readdirSync(PACKAGES).filter((entry) => {
  const path = join(PACKAGES, entry)
  return statSync(path).isDirectory() && existsPackageJson(path)
})

function existsPackageJson(dir) {
  try {
    return statSync(join(dir, 'package.json')).isFile()
  } catch {
    return false
  }
}

const dockerfile = readFileSync(DOCKERFILE, 'utf8')

// The line that installs. Everything asserted below is about what reaches the
// image *before* it, since that is what decides which projects pnpm sees.
const install = dockerfile.indexOf('pnpm install')
if (install === -1) {
  console.error(`::error file=${DOCKERFILE}::no install step; this check compared nothing`)
  process.exit(1)
}
const beforeInstall = dockerfile.slice(0, install)

let failed = false
for (const name of workspace) {
  if (beforeInstall.includes(`packages/${name}/package.json`)) continue
  console.error(
    `::error file=${DOCKERFILE}::packages/${name}/package.json is never copied, so pnpm ` +
      `inside the image sees ${workspace.length - 1} workspace projects instead of ` +
      `${workspace.length}. The package gets no node_modules and the build fails on an ` +
      'import of something that is in the tree — which no other job can reproduce, ' +
      'because everywhere else the workspace is whole.',
  )
  failed = true
}

// And the other direction, which fails later and reads as nonsense: a COPY of a
// manifest that no longer exists stops the build with "file not found" naming a
// path somebody deleted on purpose.
for (const [, name] of beforeInstall.matchAll(/packages\/([a-z0-9-]+)\/package\.json/g)) {
  if (workspace.includes(name)) continue
  console.error(`::error file=${DOCKERFILE}::copies packages/${name}/package.json, which does not exist`)
  failed = true
}

if (failed) process.exit(1)

console.log(`${DOCKERFILE}: all ${workspace.length} workspace manifest(s) reach the image`)
