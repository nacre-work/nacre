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
 */
import { appendFileSync } from 'node:fs'

import { agreedVersion, publishable } from './publishable.mjs'

const REGISTRY = 'https://registry.npmjs.org'
const ATTEMPTS = 3

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

say(
  pending.length === 0
    ? `nothing to release: every publishable package is on the registry at ${version}`
    : `releasing ${version}: ${pending.join(', ')}`,
)

const output = process.env.GITHUB_OUTPUT
if (output !== undefined) {
  appendFileSync(output, `version=${version}\npublish=${pending.length > 0}\n`)
} else {
  console.log(`version=${version}`)
  console.log(`publish=${pending.length > 0}`)
}
