#!/usr/bin/env node
/**
 * Nothing on the registry carries the workspace protocol.
 *
 * A workspace dependency is written `"@nacre.work/sdk": "workspace:*"` and
 * `pnpm pack` is what rewrites it into a concrete version. npm does not
 * understand the protocol and does not try — it publishes the manifest as
 * written, and every `npm install` and `npx` of that version dies on
 * resolution. `@nacre.work/cli@0.14.3` is on the registry in exactly that
 * state, published by hand from a package directory.
 *
 * **The first version of this check packed each package and read the manifest
 * back out of the tarball, and it was theatre.** `pnpm pack` always rewrites,
 * so it could not fail — and a check that cannot fail must not report green.
 * What it would have proved is that pnpm works.
 *
 * The defect is not in packing. It is in publishing *without* packing, which
 * happens outside this repository entirely, so the only place the evidence
 * exists is the registry. This asks the registry.
 *
 * A version that is already **deprecated** is not a failure: deprecating is the
 * remedy for one that cannot be recalled, and a check that stayed red after the
 * remedy would be a check somebody switches off. So the path to green is the
 * action we want taken.
 */
import { publishable } from './publishable.mjs'

const REGISTRY = 'https://registry.npmjs.org'

const packages = publishable()
if (packages.length === 0) {
  console.error('::error::no publishable packages; this check compared nothing')
  process.exit(1)
}

let failed = false
let checked = 0

for (const { name } of packages) {
  let document
  try {
    const response = await fetch(`${REGISTRY}/${name.replace('/', '%2F')}`, {
      headers: { accept: 'application/json' },
    })
    // Never published is a real answer and not a problem — a package added in
    // this commit has not been released yet, by definition.
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    document = await response.json()
  } catch (cause) {
    // The same rule the rest of this repository applies to a check that cannot
    // reach what it checks: fail, rather than report green having asked nothing.
    console.error(`::error::could not read ${name} from the registry: ${cause.message}`)
    failed = true
    continue
  }

  for (const [version, manifest] of Object.entries(document.versions ?? {})) {
    checked += 1
    if (manifest.deprecated !== undefined) continue

    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        if (!String(range).startsWith('workspace:')) continue
        console.error(
          `::error::${name}@${version} is published with ${dependency} as "${range}". ` +
            'npm publishes the manifest as written, so that version cannot be installed by ' +
            'anybody. It was published without `pnpm pack`, which is what rewrites the ' +
            'protocol — see docs/releasing.md. Publish a fixed version and run ' +
            `\`npm deprecate ${name}@${version} "broken manifest, use <next>"\`, which is ` +
            'what turns this check green.',
        )
        failed = true
      }
    }
  }
}

if (failed) process.exit(1)

console.log(`${checked} published version(s) across ${packages.length} package(s): no workspace: protocol`)
