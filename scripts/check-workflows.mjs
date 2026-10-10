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
 * That half asks only for "at least one workflow", and the paragraph here used
 * to argue the weaker thing was right: `lint:upgrading` was called genuinely
 * release-only, because "there is no version being tagged on a pull request".
 * **That reasoning was wrong and it cost a release.** The check reads the
 * version out of `package.json`, and the pull request that bumps it is where
 * the version changes — so on a release pull request it has everything it needs
 * and would have refused there, and on an ordinary one it asks about the current
 * version, whose section exists. Instead it ran only after the merge, `main`
 * carried a version that could not ship, and the fix was a second pull request.
 * The fourth section below is that rule stated properly, and this one is left
 * as the weaker floor it always was.
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

// ─── The release runs exactly what a pull request runs ────────────────────

// The rule was already written down, in a comment inside the release job:
// "A release that ran a smaller suite than a pull request would be the one
// artifact nobody can take back, tested least." It was true of the two suites
// the comment was about and false in nine other places — `lint:config`,
// `lint:password`, `lint:endpoint-errors` and six more ran on every pull
// request and not at release.
//
// The other direction is worse and is what produced this check. `lint:upgrading`
// ran **only** at release, so a release pull request passed every check it had
// and then failed after the merge, with `main` carrying a version that could not
// ship and the fix being a second pull request. That is the same shape the
// enterprise repository already names for its module count, arriving here.
//
// So: symmetric, and computed rather than listed. A rule stated only in a
// comment is the signal it wants to be a check — this repository's own words,
// and the third time that has been the finding.
const RELEASE = 'release.yml'

/**
 * Every `pnpm lint:*` a workflow file runs.
 *
 * Scoped to the checks and deliberately not to the suites, because the suites
 * decompose and this rule would be wrong about them rather than about the
 * tree: the ACL job runs `test:acl:group` once per named group and the release
 * runs `test:acl` whole, which is the same tests through a different door. A
 * check that reports twelve problems and no drift is one that stops being
 * read — that already happened once here, to the mirror check next door.
 */
function gates(file) {
  const text = readFileSync(join(DIR, file), 'utf8')
  const found = new Set()
  for (const match of text.matchAll(/run:\s*pnpm\s+(?:run\s+)?(lint:[\w:.-]+)/g)) found.add(match[1])
  return found
}

if (!files.includes(RELEASE)) {
  console.error(
    `::error::${DIR}/${RELEASE} is gone. This check compares what a release runs against what a ` +
      'pull request runs, and with no release workflow it compares nothing. Rename the constant ' +
      'here if the file moved.',
  )
  failed = true
} else {
  const released = gates(RELEASE)
  const requested = new Set(
    files
      .filter((file) => file !== RELEASE && /^\s{2}pull_request:/m.test(readFileSync(join(DIR, file), 'utf8')))
      .flatMap((file) => [...gates(file)]),
  )

  for (const name of [...requested].sort()) {
    if (released.has(name)) continue
    console.error(
      `::error file=${DIR}/${RELEASE}::every pull request runs \`pnpm ${name}\` and the release ` +
        'does not. The release is the artifact nobody can take back, so it must not be the one ' +
        'tested least — add the step to the publish job.',
    )
    failed = true
  }

  for (const name of [...released].sort()) {
    if (requested.has(name)) continue
    console.error(
      `::error file=${DIR}/${RELEASE}::\`pnpm ${name}\` runs at release and on no pull request, ` +
        'so the only way to fail it is after a merge — on a commit that is already the release. ' +
        'Add it to a workflow that runs on pull_request.',
    )
    failed = true
  }

  if (!failed) {
    console.log(`${RELEASE}: runs the same ${String(released.size)} pnpm gate(s) a pull request does`)
  }
}

// ─── Every job that runs the suite has the same fixtures ──────────────────

// A gate is only as good as what it is pointed at.
//
// A live case that refuses to skip when `CI` is set — the object-storage cases
// do, because a check that cannot check must not report green — needs its
// service wherever that suite runs. Adding it to one job leaves the others
// failing, and the worst of those is the one on the commit that is already the
// release.
//
// **Per job and not per file**, which is the granularity the first version of
// this rule got wrong: two jobs in one workflow can run different projects and
// legitimately need different services, and a file-level union asks the wrong
// one for a fixture it has no case for. The set of jobs is discovered — whoever
// runs the suite — and the fixtures are compared by **name**, because a port or
// a URL differs between jobs for good reasons and the question here is only
// whether the fixture is there at all.

/** Split a workflow into its jobs, without a YAML parser. */
function jobsOf(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^jobs:\s*$/.test(line))
  if (start === -1) return []
  const found = []
  let current
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([\w-]+):\s*$/.exec(line)
    if (header !== null) {
      current = { name: header[1], lines: [] }
      found.push(current)
      continue
    }
    current?.lines.push(line)
  }
  return found.map(({ name, lines: body }) => ({ name, text: body.join('\n') }))
}

/** Whether a job runs the unit project, however it spells it. */
function runsTheSuite(text) {
  return /pnpm\s+(?:run\s+)?test(?::unit)?(?:\s|$)/m.test(text) || /flake-hunt\.mjs/.test(text)
}

/** Every `NACRE_*` a stretch of YAML sets. */
function fixtures(text) {
  return new Set([...text.matchAll(/^\s*(NACRE_[A-Z0-9_]+):/gm)].map((m) => m[1]))
}

const suiteJobs = files.flatMap((file) => {
  const text = readFileSync(join(DIR, file), 'utf8')
  // Anything above `jobs:` is workflow-level `env:`, which every job inherits.
  const preamble = text.slice(0, text.search(/^jobs:\s*$/m) + 1)
  return jobsOf(text)
    .filter((job) => runsTheSuite(job.text))
    .map((job) => ({
      where: `${file}:${job.name}`,
      set: new Set([...fixtures(preamble), ...fixtures(job.text)]),
    }))
})

if (suiteJobs.length === 0) {
  console.error(
    `::error::no job in ${DIR} runs the suite. This check reads that set, so an empty read is a ` +
      'failure and never a pass — correct the pattern here if the command moved.',
  )
  failed = true
} else {
  const everywhere = new Set(suiteJobs.flatMap(({ set }) => [...set]))
  for (const name of [...everywhere].sort()) {
    const missing = suiteJobs.filter(({ set }) => !set.has(name)).map(({ where }) => where)
    if (missing.length === 0) continue
    console.error(
      `::error::${name} is set by ${String(suiteJobs.length - missing.length)} of the ` +
        `${String(suiteJobs.length)} job(s) that run the suite, and not by ${missing.join(', ')}. ` +
        'The suite is the same one, so a fixture only some of them have is a case that runs in ' +
        'one job and fails in the next.',
    )
    failed = true
  }
  if (!failed) {
    console.log(
      `${String(suiteJobs.length)} job(s) run the suite, with the same ` +
        `${String(everywhere.size)} fixture(s)`,
    )
  }
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

// ─── apt is never on a gate's critical path ───────────────────────────────

/**
 * `playwright install --with-deps`, refused wherever a workflow runs it.
 *
 * That flag shells out to apt, and apt is the one thing in these workflows that
 * can **hang** rather than fail: a mirror it has no opinion about stops
 * answering and `apt-get update` sits there. It did so four times in one day,
 * twice on consecutive re-runs of the same commit, with `Ign: http://azure
 * .archive.ubuntu.com/…` as the last thing in the log.
 *
 * Bounding it with `timeout` was the first repair and it was half of one — it
 * turned a job sitting until the six-hour limit into a job failing in eight
 * minutes and asking a person to press the button again, which moves the cost
 * rather than removing it.
 *
 * The deps are already on the image, which ships Google Chrome, and Playwright's
 * Chromium wants the same shared libraries; being wrong about that fails in
 * seconds with the missing `.so` named, which is a failure somebody can act on.
 *
 * A check rather than the edit, because it was in **three** places across two
 * repositories and nothing knew there were three — and the two that were not
 * this one carried no timeout at all, one of them in a deploy workflow.
 */
const WITH_DEPS = /playwright[^\n]*\binstall\b[^\n]*--with-deps|--with-deps[^\n]*\bchromium\b/

for (const file of files) {
  const lines = readFileSync(join(DIR, file), 'utf8').split('\n')
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('#')) return
    if (!WITH_DEPS.test(line)) return
    console.error(
      `::error file=${DIR}/${file},line=${index + 1}::${file} runs \`playwright install ` +
        '--with-deps`, which shells out to apt. apt is the one step in these workflows that can ' +
        'hang rather than fail, and it did so four times in one day on an unreachable mirror — a ' +
        'gate that needs a human to press re-run is a gate that stops being read. Drop the flag: ' +
        'this runner image ships Chrome, so the shared libraries are already there, and a missing ' +
        'one surfaces in seconds as a launch error naming it.',
    )
    failed = true
  })
}

// ─── A service pulled from Docker Hub signs in ────────────────────────────

// An anonymous pull from Docker Hub counts against a limit shared by every job
// on the runner's address, and it is refused with `toomanyrequests` before a
// step runs. The commercial modules' 0.10.16 release failed that way three
// times in a row on `postgres:17-alpine`, and a re-run cannot help — the limit
// is not the repository's. This repository pulls three images from there in
// four workflows.
//
// So every service container whose image names no registry — which is what
// Docker Hub looks like — carries `credentials` from the repository's
// `DOCKER_USER` and `DOCKER_PAT`. Three service blocks with the same image and
// nothing that knew there were three is the shape this file exists for, so it
// is asked of every block rather than of the ones that failed.

/** Every service container in a job: its name, image and whether it signs in. */
function servicesOf(text) {
  const lines = text.split('\n')
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(\s*)services:\s*$/.exec(lines[i])
    if (open === null) continue
    const indent = open[1].length
    let current
    for (const line of lines.slice(i + 1)) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const depth = line.length - line.trimStart().length
      if (depth <= indent) break
      const header = depth === indent + 2 ? /^\s*([\w-]+):\s*$/.exec(line) : null
      if (header !== null) {
        current = { name: header[1], lines: [] }
        found.push(current)
        continue
      }
      current?.lines.push(line)
    }
  }
  return found.map(({ name, lines: body }) => {
    const text = body.join('\n')
    return {
      name,
      image: /^\s*image:\s*(\S+)/m.exec(text)?.[1],
      signsIn:
        /^\s*username:\s*\$\{\{\s*secrets\.DOCKER_USER\s*\}\}\s*$/m.test(text) &&
        /^\s*password:\s*\$\{\{\s*secrets\.DOCKER_PAT\s*\}\}\s*$/m.test(text),
    }
  })
}

/** Docker Hub is where an image reference with no registry host resolves. */
const onDockerHub = (image) => {
  const first = image.split('/')[0]
  return !image.includes('/') || !(first.includes('.') || first.includes(':') || first === 'localhost')
}

let services = 0
for (const file of files) {
  const text = readFileSync(join(DIR, file), 'utf8')
  for (const job of jobsOf(text)) {
    for (const service of servicesOf(job.text)) {
      services += 1
      if (service.image === undefined) {
        console.error(
          `::error file=${DIR}/${file}::${job.name}.services.${service.name} has no image this check can read. ` +
            'Correct the pattern here rather than letting the service go unasked.',
        )
        failed = true
        continue
      }
      if (onDockerHub(service.image) && !service.signsIn) {
        console.error(
          `::error file=${DIR}/${file}::${job.name}.services.${service.name} pulls ${service.image} from Docker Hub ` +
            'anonymously. Add credentials with username ${{ secrets.DOCKER_USER }} and password ' +
            '${{ secrets.DOCKER_PAT }}, or the job fails on the rate limit before a step runs.',
        )
        failed = true
      }
    }
  }
}
if (services > 0) console.log(`${String(services)} service container(s), each signed in or not on Docker Hub`)

/**
 * ─── What a workflow's token may do, and whose code it runs ──────────────────
 *
 * **Every workflow says what its token may do.** One that does not gets the
 * repository's default, which an organization can set to write, so the same
 * file is read-only in one place and can push in another, depending on a
 * setting nobody reads in a pull request. Two of five said nothing.
 *
 * **An action outside `actions/` is pinned to a commit.** A tag is a pointer
 * its owner can move, and these run in jobs that hold registry credentials and
 * push the images a deployment pulls. The version stays beside the SHA as a
 * comment, so a reader still sees which release it is. GitHub's own `actions/`
 * are left on their major tags, which is what they publish for. A local action
 * (`./…`) is this repository's own code.
 */
let pinned = 0
for (const file of files) {
  const text = readFileSync(join(DIR, file), 'utf8')
  if (!/^permissions:/m.test(text)) {
    console.error(`::error file=${DIR}/${file}::declares no top-level permissions, so its token is whatever the repository's default is.`)
    failed = true
  }
  for (const m of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const ref = m[1]
    if (ref.startsWith('./') || ref.startsWith('actions/') || ref.startsWith('docker://')) continue
    pinned += 1
    if (!/@[0-9a-f]{40}$/.test(ref)) {
      console.error(
        `::error file=${DIR}/${file}::${ref} is referenced by a tag its owner can move. Pin it to the commit, ` +
          'with the version in a comment beside it.',
      )
      failed = true
    }
  }
}
if (pinned === 0) {
  console.error('::error::no third-party action found in any workflow; the pinning rule has nothing to hold, which is not a pass.')
  failed = true
} else if (!failed) {
  console.log(`${String(pinned)} third-party action reference(s), each pinned to a commit; every workflow declares its permissions`)
}

process.exit(failed ? 1 : 0)
