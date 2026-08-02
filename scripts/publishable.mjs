/**
 * Which packages go to the registry, and at what version.
 *
 * One definition, imported by everything that needs it. The rule is
 * `private !== true` and nothing else, anywhere — the release decides what to
 * publish, the checks decide what to check, and both have to mean the same set.
 * Two copies of the rule disagree the moment a package changes side, and the
 * way they disagree is that a release ships something no check ever looked at.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const PACKAGES = 'packages'

/** Every manifest under packages/, publishable or not. Keyed by directory. */
export function manifests() {
  const found = new Map()
  for (const dir of readdirSync(PACKAGES)) {
    const path = join(PACKAGES, dir, 'package.json')
    if (!existsSync(path)) continue
    found.set(dir, { path, json: JSON.parse(readFileSync(path, 'utf8')) })
  }
  return found
}

/** The publishable ones, sorted by name so every consumer sees one order. */
export function publishable(all = manifests()) {
  return [...all]
    .filter(([, { json }]) => json.private !== true)
    .map(([dir, { path, json }]) => ({ dir, path, name: json.name, version: json.version, json }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The one version every publishable package is at.
 *
 * They have to agree, because the release publishes them together and a
 * consumer installing `@nacre.work/mcp` gets the `@nacre.work/core` its
 * manifest names. One package left behind at the previous version publishes a
 * tree that resolves to two different cores.
 *
 * Returns `{ version }` or `{ errors }` — the caller decides how to report,
 * because one of them is writing GitHub annotations and one is not.
 */
export function agreedVersion(packages = publishable()) {
  if (packages.length === 0) {
    return { errors: ['no publishable packages under packages/'] }
  }

  const errors = []
  for (const pkg of packages) {
    if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(pkg.version)) {
      errors.push(`${pkg.name} has no usable version (${JSON.stringify(pkg.version)})`)
    }
  }
  if (errors.length > 0) return { errors }

  const versions = [...new Set(packages.map((p) => p.version))]
  if (versions.length > 1) {
    return {
      errors: [
        'publishable packages disagree about the version: ' +
          packages.map((p) => `${p.name}@${p.version}`).join(', '),
      ],
    }
  }

  return { version: versions[0] }
}
