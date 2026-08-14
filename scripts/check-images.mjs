#!/usr/bin/env node
/**
 * Every Dockerfile is published, and every published image is checked.
 *
 * `docker/Dockerfile.embedding-adapter` was written, built by CI on both
 * architectures, and named by no release step — so the service existed, was
 * proved to compile, and had no artifact anybody could pull. `docker compose
 * --profile hosted` built it from source and hid that; a Kubernetes deployment
 * could not have it at all.
 *
 * The shape is the one this repository keeps re-deriving: a list that has to
 * agree in three places — the Dockerfiles on disk, the push steps, and the loop
 * that reads the manifest back — with nothing that knows it. Adding a fourth
 * image meant editing two of the three and noticing the third.
 *
 * Two directions, both in the safe one:
 *
 *   1. every `docker/Dockerfile*` is named by a push step, and
 *   2. every image a push step tags is named in the architecture check.
 *
 * The second matters because `platforms:` is a request. A build that quietly
 * produced one architecture is the defect the architecture check exists for,
 * and an image outside its loop is an image that check does not cover.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'

const RELEASE = '.github/workflows/release.yml'
const DOCKER = 'docker'

const workflow = readFileSync(RELEASE, 'utf8')

const dockerfiles = readdirSync(DOCKER).filter((f) => f.startsWith('Dockerfile'))
if (dockerfiles.length === 0) {
  console.error(`::error::no Dockerfile under ${DOCKER}/; this check compared nothing`)
  process.exit(1)
}

/**
 * `file: docker/Dockerfile.x` on a step that pushes.
 *
 * Anything but a literal `false` counts, because the push is conditional now —
 * `push: ${{ inputs.dry_run != true }}`, so a rehearsal does not ship four
 * images over the ones that are there. This matched `push:\s*true` and went red
 * on that change, which is the check doing its job on a literal it was written
 * against rather than on the property it is for: **an image nobody pushes at
 * all**. A step that never pushes says `false`, and that is what this refuses.
 */
const pushed = new Set(
  [...workflow.matchAll(/file:\s*(docker\/Dockerfile[^\s]*)[\s\S]{0,200}?push:\s*([^\n]+)/g)]
    .filter((m) => m[2]?.trim() !== 'false')
    .map((m) => m[1]),
)

/** The image names those steps tag. */
const tagged = new Set(
  [...workflow.matchAll(/ghcr\.io\/nacre-work\/([a-z0-9-]+):/g)].map((m) => m[1]),
)

/** The names the architecture loop walks. */
const checkedLine = /for image in ([a-z0-9\- ]+); do/.exec(workflow)
const checked = new Set((checkedLine?.[1] ?? '').trim().split(/\s+/).filter(Boolean))

let failed = false

for (const file of dockerfiles) {
  const path = `${DOCKER}/${file}`
  if (!pushed.has(path)) {
    console.error(
      `::error file=${path}::${path} is built by nothing that pushes. An image the release ` +
        'never publishes is a service only a `docker compose` that builds from source can ' +
        'have — which is what happened to the embedding adapter. Add a push step, or delete ' +
        'the Dockerfile.',
    )
    failed = true
  }
}

if (checked.size === 0) {
  console.error(`::error::${RELEASE} has no architecture loop to read; this check found nothing`)
  failed = true
}

for (const image of tagged) {
  if (!checked.has(image)) {
    console.error(
      `::error file=${RELEASE}::${image} is pushed and is not in the architecture check. ` +
        '`platforms:` is a request, so an image outside that loop is one nothing proves ' +
        'carries both architectures.',
    )
    failed = true
  }
}

/**
 * ─── Anything a Dockerfile copies from the context actually reaches it ───────
 *
 * A `COPY` from the context takes whatever survived `.dockerignore`, and it
 * takes it **successfully**: an excluded file leaves no error, no warning and a
 * smaller image. The failure arrives later, somewhere else, as a path that is
 * not there at runtime.
 *
 * Two files that have to agree with nothing between them, which is this
 * repository's most repeated shape.
 *
 * Written because the demo profile's corpus is nine markdown files and
 * `.dockerignore` excludes `*.md`, so it looked certain they were being
 * dropped. **They were not**, and that is worth recording: Docker matches these
 * patterns against the whole relative path with `*` not crossing `/`, so `*.md`
 * takes `README.md` at the context root and nothing under `docker/demo/corpus/`.
 * The negation added to "fix" it was removed again.
 *
 * The check stays, because the property is real even though that instance was
 * not — and it was proved by adding `docker/demo` to `.dockerignore` and
 * watching it fire, rather than by the case that prompted it.
 *
 * Only `COPY <context path>` is asked about: a `--from=` copy reads an earlier
 * stage, where `.dockerignore` has no say.
 */
const IGNORE = '.dockerignore'
const rules = readFileSync(IGNORE, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'))

/** Docker's own precedence: the last pattern that matches a path decides it. */
function excluded(path) {
  let verdict = false
  for (const rule of rules) {
    const negated = rule.startsWith('!')
    const pattern = negated ? rule.slice(1) : rule
    const expression = new RegExp(
      `^${pattern
        .replaceAll('.', '\\.')
        .replaceAll('**/', '(.*/)?')
        .replaceAll('**', '.*')
        .replaceAll(/(?<!\.)\*/g, '[^/]*')}(/.*)?$`,
    )
    if (expression.test(path)) verdict = !negated
  }
  return verdict
}

for (const file of dockerfiles) {
  const source = readFileSync(`${DOCKER}/${file}`, 'utf8')
  for (const [, target] of source.matchAll(/^COPY (?!--from)(?:--[a-z-]+=\S+ )*(\S+) /gm)) {
    if (target.startsWith('/') || !existsSync(target)) continue
    if (!excluded(target)) continue
    console.error(
      `::error file=${IGNORE}::${DOCKER}/${file} copies \`${target}\` from the build context and ` +
        `${IGNORE} excludes it. The build still succeeds — COPY takes whatever survived the ` +
        'filter — so this arrives later as a file missing at runtime.',
    )
    failed = true
  }
}

if (!failed) {
  console.log(
    `${dockerfiles.length} Dockerfile(s), ${tagged.size} image(s), all published and all checked ` +
      'for both architectures, and every context copy reaches the context',
  )
}
process.exit(failed ? 1 : 0)
