#!/usr/bin/env node
/**
 * Every workflow that gates a pull request can be asked for by hand, and every
 * check this repository has written is actually run by one.
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
 *
 * The second half is the same rule one level up, and it was added because this
 * repository had walked into it: `lint:admin-gate` — a check written precisely
 * to close a "holds in N places, nothing knows N" hole — was in `package.json`
 * and in no workflow at all. A check nobody runs is worse than an absent one,
 * because the reason it was written gets recorded as handled.
 *
 * Deliberately "at least one workflow" rather than "a workflow that gates a
 * pull request". Some checks are genuinely release-only — `lint:upgrading` asks
 * whether `docs/upgrading.md` has a section for the version being tagged, and
 * there is no version being tagged on a pull request. Requiring the stronger
 * thing would be a rule people work around by weakening it.
 * The third is the same rule again, arriving from a different direction: CI
 * must not edit a configuration file in place. The e2e job configured its
 * embedder with `sed -i 's#^NACRE_DEFAULT_EMBEDDING_ENDPOINT=.*#…#' .env`, and
 * the day `.env.example` turned that line into three commented choices the
 * pattern stopped matching anything. A substitution that matches nothing exits
 * 0, so the job carried on and `init` refused an unconfigured embedder several
 * steps later — the failure was real, loud and in the wrong place. Append the
 * lines instead, or put the substitution in a script that fails when its
 * pattern is absent.
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

  // A `branches:` filter on `pull_request` needs `edited` in `types:`.
  //
  // Retargeting a pull request is an `edited` event and nothing else — no
  // `opened`, no `synchronize`, no push — so a filtered workflow that lists
  // only the three default types never runs for a pull request that arrived at
  // its branch by being moved there. That is the ordinary end of a stack: each
  // one is opened against its parent, filtered out, and retargeted to main when
  // the parent merges. The gate is then not red, it is *absent*, which is the
  // state a required check exists to make impossible.
  //
  // Unfiltered workflows are out of scope: they run whatever the base is, so
  // the head SHA has already been checked by the time the base moves.
  const scoped = /^\s{4}branches:/m.test(source)
  const types = /^\s{4}types:\s*(\[.*\]|.*)$/m.exec(source)
  if (scoped && !(types !== null && types[1].includes('edited'))) {
    console.error(
      `::error file=${DIR}/${file}::${file} filters pull_request on \`branches:\` and does not ` +
        'list `edited` in `types:`. Changing a pull request\'s base fires `edited` and nothing ' +
        'else, so one retargeted onto that branch is never checked at all — the gate goes ' +
        'missing rather than failing. Add `types: [opened, synchronize, reopened, edited]`.',
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

// ─── Every check is run by something ──────────────────────────────────────

const every = files.map((file) => readFileSync(join(DIR, file), 'utf8')).join('\n')
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const checks = Object.keys(manifest.scripts ?? {}).filter((name) => name.startsWith('lint:'))

if (checks.length === 0) {
  console.error('::error file=package.json::no lint:* script in package.json; that is not a pass')
  failed = true
}

for (const name of checks) {
  // The command as a workflow writes it. Bounded at the end so `lint:config`
  // does not match a step running `lint:config-something-else`.
  if (new RegExp(`pnpm ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'm').test(every)) {
    continue
  }
  console.error(
    `::error file=package.json::${name} is defined and no workflow runs it. ` +
      'A check that never runs records its own reason as handled — wire it into a workflow, ' +
      'or delete it and say why in the commit.',
  )
  failed = true
}

// ─── No in-place edit of a file a workflow did not write ──────────────────

// `sed -i` and friends. Matched on the flag rather than on the file being
// edited, because the file is the part that varies and the silence is the part
// that does not: every one of these exits 0 having changed nothing.
const IN_PLACE = /(?:^|[\s|;&(])(?:sed\s+(?:-[^\s-]*i|--in-place)|perl\s+-[^\s]*i)/

for (const file of files) {
  const lines = readFileSync(join(DIR, file), 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    if (!IN_PLACE.test(line)) return
    console.error(
      `::error file=${DIR}/${file},line=${index + 1}::${file} edits a file in place. ` +
        'A substitution whose pattern matches nothing exits 0, so the job carries on with the ' +
        'edit silently unapplied and fails somewhere else. Append the lines the job needs, or ' +
        'move the substitution into a script that fails when its pattern is absent.',
    )
    failed = true
  })
}

process.exit(failed ? 1 : 0)
