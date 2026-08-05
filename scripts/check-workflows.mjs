#!/usr/bin/env node
/**
 * Every workflow that gates a pull request can be asked for by hand.
 *
 * `ci.yml` carries the reason in its own comment: `pull_request` was the only
 * way to ask for a run, and that leaves no recourse when Actions stops
 * scheduling them — no failed run to re-run, nothing queued to wait for, and an
 * empty commit as the only lever. A required check needs a way to be started.
 *
 * That was learned once and applied to three of the four workflows here. The
 * fourth was `cla` — the *required* one — and it was found on a day Actions
 * scheduled nothing, when the only workflows that could be started were the ones
 * already fixed. The sibling repository's single workflow had the same hole, for
 * the same reason: the rule lived in a comment, and a comment does not travel.
 *
 * So this is the rule as a check. It is deliberately small and deliberately
 * mechanical, because the failure it prevents is not subtle — it is somebody
 * writing a new workflow next year and reading three files that have the trigger
 * without noticing it is load-bearing.
 *
 * A workflow with no `pull_request` trigger is out of scope: it gates nothing,
 * so there is nothing to be unable to ask for.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = '.github/workflows'

let failed = false
let checked = 0

let files
try {
  files = readdirSync(DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
} catch {
  console.error(`::error::${DIR} is missing; this check cannot run`)
  process.exit(1)
}

// An empty directory passes vacuously, which is the shape of check this
// repository refuses elsewhere. Say so rather than reporting success.
if (files.length === 0) {
  console.error(`::error::${DIR} has no workflows; that is not a pass`)
  process.exit(1)
}

for (const file of files) {
  // Read as text rather than parsing YAML: the `on:` key is famously coerced to
  // the boolean `true` by YAML 1.1 loaders, and a dependency-free check that
  // greps for two trigger names is both sufficient here and impossible to get
  // subtly wrong.
  const source = readFileSync(join(DIR, file), 'utf8')
  const gatesPullRequests = /^\s{2}pull_request:/m.test(source)
  if (!gatesPullRequests) continue

  checked += 1
  if (!/^\s{2}workflow_dispatch:/m.test(source)) {
    console.error(
      `::error file=${DIR}/${file}::${file} runs on pull_request and has no workflow_dispatch. ` +
        'When Actions stops scheduling pull_request runs there is no way to ask for this check, ' +
        'and an empty commit becomes the only lever. Add `workflow_dispatch:` to `on:`.',
    )
    failed = true
    continue
  }

  console.log(`${file}: gates pull requests, and can be started by hand`)
}

if (checked === 0) {
  console.error(`::error::no workflow in ${DIR} runs on pull_request; nothing gates a change here`)
  failed = true
}

process.exit(failed ? 1 : 0)
