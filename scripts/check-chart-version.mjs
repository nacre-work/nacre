#!/usr/bin/env node
/**
 * The chart's `version` and `appVersion` are the release's.
 *
 * `appVersion` is what every image tag in the chart resolves to when a value
 * does not pin one, so it decides what `helm install` on defaults pulls. It
 * drifted three core releases behind once, while the chart lived in a
 * repository of its own and the templates went on being written for newer
 * images: the console Deployment set `NACRE_MCP_UPSTREAM`, and the image
 * `appVersion` named predates that variable, so it was set and dropped and
 * through that chart's ingress both MCP and `/oauth/authorize` answered 404.
 *
 * The other repository could only ask GitHub for the latest release on a clock.
 * Here the answer is in the tree: every workspace manifest carries the version
 * a release publishes, and both chart lines have to equal it. A release that
 * bumps the manifests and not the chart fails on its own pull request, which is
 * the one moment it is cheap to fix.
 *
 * `version` moves too, rather than counting chart changes separately. The chart
 * is released by the same workflow that publishes the images it names, so a
 * separate number would be a second answer to "which release is this" with
 * nothing that knows there are two.
 */
import { readdirSync, readFileSync } from 'node:fs'

const CHART = 'deploy/helm/nacre/Chart.yaml'

let failed = false
const fail = (message, file = CHART) => {
  console.error(`::error file=${file}::${message}`)
  failed = true
}

const chart = readFileSync(CHART, 'utf8')
// A line match rather than a YAML parse: the keys are top level and hand
// written, and a parser would be a dependency for two strings.
const line = (key) => chart.match(new RegExp(`^${key}:\\s*"?([^"\\s#]+)"?`, 'm'))?.[1]

const manifests = readdirSync('packages')
  .map((name) => `packages/${name}/package.json`)
  .filter((path) => {
    try {
      readFileSync(path)
      return true
    } catch {
      return false
    }
  })
  .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, 'utf8')) }))
  .filter(({ manifest }) => manifest.private !== true)

if (manifests.length === 0) {
  console.error('::error::no publishable package under packages/, so this check compared nothing.')
  process.exit(1)
}

const versions = new Set(manifests.map(({ manifest }) => manifest.version))
if (versions.size !== 1) {
  fail(
    `the publishable packages disagree about the release: ${manifests
      .map(({ path, manifest }) => `${path} ${manifest.version}`)
      .join(', ')}`,
    'package.json',
  )
}
const release = manifests[0].manifest.version

for (const key of ['version', 'appVersion']) {
  const value = line(key)
  if (value === undefined) fail(`${CHART} has no ${key}`)
  else if (value !== release) {
    fail(
      `${CHART} says ${key} ${value} and the packages say ${release}. Every image tag the chart ` +
        `does not pin resolves to appVersion, so this would install a release the templates were ` +
        `not written for. Set both to "${release}" in the same change that moves the manifests.`,
    )
  }
}

if (failed) process.exit(1)
console.log(`${CHART}: version and appVersion are ${release}, the release ${manifests.length} publishable package(s) carry`)
