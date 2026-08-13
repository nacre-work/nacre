#!/usr/bin/env node
/**
 * Is there a release to make, and which packages still need publishing?
 *
 * The release used to fire on a `v*` tag, which made shipping depend on someone
 * pushing a tag at the right commit. The first time it ran, the tag landed on a
 * commit whose publish step could not authenticate, and the only way forward
 * was a person moving the tag by hand. A release should be a consequence of
 * what is on main, not of what someone remembered to do.
 *
 * So the manifests decide. The version in `packages/*` names something the
 * registry does not have, or it does not, and that is the whole question. The
 * tag is written afterwards, by CI, once the publish has actually succeeded —
 * a tag that can outlive a failed publish is the state this replaced.
 *
 * Answering per package rather than per release is what makes a half-finished
 * run recoverable: if core published and mcp did not, the next run publishes
 * mcp and leaves core alone. `--pending` is that list.
 *
 * **And per artefact, for the same reason and learned the same way.** A release
 * is four things — the packages, the tag, the GitHub release and the container
 * images — and every one of them used to be gated on the npm answer alone. So
 * when 0.16.0 published all five packages and GitHub answered `500` to the tag
 * push, the run failed with the registry already updated, and no re-run could
 * ever finish it: the next `decide` found nothing pending, said `publish=false`,
 * and skipped the tag, the release and every image. A version on npm that the
 * chart's `appVersion` names, with no image behind it.
 *
 * The npm half was already recoverable and the rest was not, which is the whole
 * of this change: each artefact is asked about separately, and a run does what
 * is missing.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

import { agreedVersion, publishable } from './publishable.mjs'

const REGISTRY = 'https://registry.npmjs.org'
const ATTEMPTS = 3

/** Built and pushed by the release, and named by the chart's `appVersion`. */
const IMAGES = ['nacre', 'nacre-web', 'nacre-parser', 'nacre-embedding-adapter']
const OWNER = 'nacre-work'

const pendingOnly = process.argv.slice(2).includes('--pending')
const say = (message) => process.stderr.write(`${message}\n`)

/**
 * What the registry holds for one package.
 *
 * A 404 means the package has never been published, which is a real answer. Any
 * other failure is not: reading a transport error as "nothing to release" would
 * skip a release quietly and report success, and a release that silently does
 * not happen looks exactly like one that had nothing to do.
 */
async function versionsOf(name) {
  const url = `${REGISTRY}/${name.replace('/', '%2f')}`
  let last
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (response.status === 404) return new Set()
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      const body = await response.json()
      return new Set(Object.keys(body.versions ?? {}))
    } catch (cause) {
      last = cause
      if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
  throw new Error(`cannot read ${url} after ${ATTEMPTS} attempts: ${String(last)}`, { cause: last })
}

/**
 * Whether the tag exists, asked of the remote rather than of the checkout.
 *
 * `actions/checkout` fetches one commit and no tags, so a local `git tag`
 * would answer "missing" every time and re-tag on every run.
 *
 * `ls-remote` and not the REST API, for a reason that is about this check
 * rather than about GitHub: the API needs a token, and a check whose only
 * working configuration is inside CI is one nobody can run before shipping it.
 * This one answers the same from a laptop.
 */
function tagExists(version) {
  const run = spawnSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/v${version}`], {
    encoding: 'utf8',
  })
  if (run.status !== 0) {
    throw new Error(`cannot read the remote's tags: ${run.stderr.trim() || `git exited ${run.status}`}`)
  }
  return run.stdout.trim() !== ''
}

/**
 * Whether an image tag is on ghcr, by the registry API and anonymously.
 *
 * These images are public — a self-hoster pulls them without an account, which
 * is the point — so the anonymous token endpoint answers. A `401` would mean the
 * package went private and is a real failure rather than "missing".
 */
async function imageExists(image, version) {
  const scope = `repository:${OWNER}/${image}:pull`
  const auth = await fetch(`https://ghcr.io/token?scope=${encodeURIComponent(scope)}&service=ghcr.io`)
  if (!auth.ok) throw new Error(`cannot get a ghcr token for ${image}: ${auth.status} ${auth.statusText}`)
  const { token } = await auth.json()

  const response = await fetch(`https://ghcr.io/v2/${OWNER}/${image}/manifests/${version}`, {
    method: 'HEAD',
    headers: {
      authorization: `Bearer ${token}`,
      // The multi-arch list, which is what this release pushes.
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json',
    },
  })
  if (response.status === 404) return false
  if (!response.ok) {
    throw new Error(`cannot read ghcr.io/${OWNER}/${image}:${version}: ${response.status} ${response.statusText}`)
  }
  return true
}

const packages = publishable()
const agreed = agreedVersion(packages)
if (agreed.errors !== undefined) {
  for (const error of agreed.errors) say(`::error::${error}`)
  process.exit(1)
}
const { version } = agreed

const pending = []
for (const pkg of packages) {
  const versions = await versionsOf(pkg.name)
  if (versions.has(version)) say(`${pkg.name}@${version} is already on the registry`)
  else {
    say(`${pkg.name}@${version} is not on the registry`)
    pending.push(pkg.name)
  }
}

if (pendingOnly) {
  console.log(pending.join('\n'))
  process.exit(0)
}

// A failure to read either of these is a failure, not a "no". Treating a
// transport error as "already there" would skip the artefact and report a
// finished release; treating it as "missing" would rebuild and overwrite one
// that shipped. Neither is an answer, so there is no third branch.
const tagged = tagExists(version)
const built = []
for (const image of IMAGES) {
  if (await imageExists(image, version)) say(`ghcr.io/${OWNER}/${image}:${version} is already pushed`)
  else {
    say(`ghcr.io/${OWNER}/${image}:${version} is not pushed`)
    built.push(image)
  }
}

say(`v${version} is ${tagged ? 'already tagged' : 'not tagged'}`)

const nothing = pending.length === 0 && tagged && built.length === 0
say(
  nothing
    ? `nothing to release: ${version} is on the registry, tagged, and every image is pushed`
    : `releasing ${version}:${pending.length > 0 ? ` npm ${pending.join(', ')};` : ''}` +
      `${tagged ? '' : ' the tag and the release;'}${built.length > 0 ? ` images ${built.join(', ')}` : ''}`,
)

const outputs = {
  version,
  // Kept as `publish` because the npm job's name and every reference to it read
  // that way; what changed is that it no longer decides the other three.
  publish: pending.length > 0,
  tag: !tagged,
  images: built.length > 0,
}

const output = process.env.GITHUB_OUTPUT
const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`)
if (output !== undefined) appendFileSync(output, `${lines.join('\n')}\n`)
else for (const line of lines) console.log(line)
