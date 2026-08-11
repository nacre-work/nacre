#!/usr/bin/env node
/**
 * Validate docker-compose.yml and pin what each profile contains.
 *
 * Compose accepts an unknown profile name silently and gives you the
 * unprofiled services, so `--profile minimial` starts a working stack and
 * nobody notices the typo. Asserting the exact service list per profile is what
 * turns that into a failure.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPECTED = {
  minimal: ['api', 'mcp', 'migrate', 'parser', 'postgres', 'qdrant', 'redis', 'web', 'worker'],
  full: ['api', 'embedder', 'mcp', 'migrate', 'minio', 'minio-init', 'parser', 'postgres', 'qdrant', 'redis', 'reranker', 'web', 'worker'],
  airgapped: ['api', 'embedder', 'keycloak', 'mcp', 'migrate', 'parser', 'postgres', 'qdrant', 'redis', 'reranker', 'web', 'worker'],
  hosted: ['api', 'embedding-adapter', 'mcp', 'migrate', 'parser', 'postgres', 'qdrant', 'redis', 'web', 'worker'],
}

/**
 * The one service that talks to somebody else's API, and the profile that
 * forbids talking to anyone.
 *
 * `airgapped`'s rule is no outbound connection at all — telemetry, update
 * checks and model downloads included. The embedding adapter's whole job is an
 * outbound connection, so the rule is kept by the service being **absent** from
 * that profile rather than switched off inside it. A service that is not there
 * cannot connect to anything; a runtime check on a URL is a check that has to
 * be right, and this repository has twice found one that was not.
 *
 * It is out of `minimal` and `full` too, and that is the same statement made
 * about consent rather than about airgapping: routing a model to a hosted
 * vendor means the text of an installation's documents leaves it, and nobody
 * should get that by typing the name of a profile that means "the typical
 * install".
 */
const ADAPTER = 'embedding-adapter'
const NO_ADAPTER = ['minimal', 'full', 'airgapped']

let failed = false

for (const [profile, expected] of Object.entries(EXPECTED)) {
  const run = spawnSync('docker', ['compose', '--profile', profile, 'config', '--services'], {
    encoding: 'utf8',
  })

  if (run.status !== 0) {
    console.error(`::error::profile ${profile} does not resolve:\n${run.stderr}`)
    failed = true
    continue
  }

  const actual = run.stdout.trim().split('\n').map((s) => s.trim()).filter(Boolean).sort()
  const want = [...expected].sort()

  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    console.error(`::error::profile ${profile}\n  expected: ${want.join(' ')}\n  actual:   ${actual.join(' ')}`)
    failed = true
    continue
  }

  console.log(`${profile}: ${actual.join(' ')}`)
}

// minimal must stay runnable on a laptop: no GPU, and nothing that has to pull
// a model before it can answer.
const minimal = EXPECTED.minimal
for (const heavy of ['embedder', 'reranker']) {
  if (minimal.includes(heavy)) {
    console.error(`::error::${heavy} is in minimal; that profile must run without a GPU`)
    failed = true
  }
}

// MinIO is AGPLv3. Keeping it out of the default path is a licensing decision,
// not a packaging preference — see docs/licensing.md.
if (minimal.includes('minio')) {
  console.error('::error::minio is AGPLv3 and must not be on the default path')
  failed = true
}

// The structural half of "off unless configured". Asserted against EXPECTED
// rather than only against the rendered profiles, so moving the adapter into a
// profile fails here even if somebody updates the list to match.
for (const profile of NO_ADAPTER) {
  if (EXPECTED[profile].includes(ADAPTER)) {
    console.error(
      `::error::${ADAPTER} is in ${profile}. Routing a model to a hosted vendor means the text ` +
        'of an installation\'s documents leaves it, so it belongs to the `hosted` profile and to ' +
        'no other — and `airgapped` keeps its rule by the service being absent rather than ' +
        'switched off, because a service that is not there cannot connect to anything.',
    )
    failed = true
  }
}
if (!EXPECTED.hosted.includes(ADAPTER)) {
  console.error(`::error::${ADAPTER} is in no profile, so this check now asserts nothing`)
  failed = true
} else if (!failed) {
  console.log(`${ADAPTER}: only in hosted, so airgapped stays airgapped by construction`)
}

/**
 * The MCP transport must reach a client with **no** pinned canonical URL.
 *
 * Unset, it builds its RFC 9728 document from the `Host` each client used,
 * which is what the identifier is meant to match. Pinned to `localhost` it
 * refuses every client that is not on the server's own machine — and the
 * refusal happens before a token is sent, so it reads as a broken server.
 *
 * This is a check rather than a comment because a comment is what it was.
 * `docker-compose.yml` explains at length why the `mcp` service sets no
 * `NACRE_MCP_CANONICAL_URL`, and `.env.example` set one — which reaches the
 * container regardless, since `env_file: .env` is on the shared anchor. The
 * service block was right, the stack was not, and nothing compared them.
 *
 * Rendered with `.env.example` **as `.env`**, because that is the file a person
 * copies and `env_file:` names `.env` literally. Reading either file alone is
 * exactly the mistake being guarded.
 *
 * In a scratch project directory rather than this one, so a developer's own
 * `.env` is neither read nor overwritten. `COMPOSE_ENV_FILES` is the wrong
 * lever and was the first attempt: it redirects interpolation and leaves
 * `env_file:` pointing at `.env`, so the check passed against a file that
 * reintroduced the variable. Verified the other way round — this version
 * reports the failure when it is put back.
 */
const scratch = mkdtempSync(join(tmpdir(), 'nacre-compose-'))
copyFileSync('.env.example', join(scratch, '.env'))
const rendered = spawnSync(
  'docker',
  ['compose', '--project-directory', scratch, '-f', 'docker-compose.yml', '--profile', 'minimal', 'config'],
  { encoding: 'utf8' },
)
rmSync(scratch, { recursive: true, force: true })

if (rendered.status !== 0) {
  console.error(`::error::compose config does not render against .env.example:\n${rendered.stderr}`)
  failed = true
} else if (/^\s+NACRE_MCP_CANONICAL_URL:/m.test(rendered.stdout)) {
  console.error(
    '::error::.env.example seeds NACRE_MCP_CANONICAL_URL, so it reaches the mcp container ' +
      'through env_file and pins the RFC 9728 identifier. Every client not on the server ' +
      'refuses it. Leave it commented out.',
  )
  failed = true
} else {
  console.log('mcp: no pinned canonical URL, so the discovery document follows the request')
}

/**
 * ─── Every compose file named as one to load exists ──────────────────────────
 *
 * Deleting `docker-compose.apple-silicon.yml` is what this is here for. The
 * overlay was named by `docker-compose.yml`, by three documents and by
 * `.env.example`, which carried a commented `COMPOSE_FILE=…` for a person to
 * uncomment on a Mac. Four of those five were updated. The fifth was a comment,
 * so nothing rendered it and nothing here could see it — and the operator who
 * followed it got `no such file` from Compose before anything started.
 *
 * Matched on the two places a filename is an *instruction* rather than prose:
 * a `COMPOSE_FILE=` value and a `-f` argument. Every document in this
 * repository is free to name the file in a sentence about what used to be
 * true — `docs/upgrading.md` is a changelog and has to.
 *
 * `docker-compose.override.yml` is the one name allowed to be absent. It is
 * Compose's own convention for a file the operator writes and this repository
 * deliberately does not ship, and `docs/config.md` names it in exactly that
 * sentence.
 */
const OPERATORS_OWN = 'docker-compose.override.yml'
const NAMED = /(?:COMPOSE_FILE=|-f[ =])([A-Za-z0-9._/:-]*docker-compose[A-Za-z0-9._-]*\.ya?ml[A-Za-z0-9._/:-]*)/g

const tracked = spawnSync('git', ['ls-files'], { encoding: 'utf8' })
if (tracked.status !== 0) {
  console.error(`::error::git ls-files failed, so this check cannot run:\n${tracked.stderr}`)
  failed = true
} else {
  let named = 0
  let missing = 0
  for (const file of tracked.stdout.split('\n').filter(Boolean)) {
    if (/\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|zip)$/i.test(file)) continue
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [, value] of source.matchAll(NAMED)) {
      // `COMPOSE_FILE` is a path list, and its separator is what makes this
      // worth splitting rather than testing whole.
      for (const path of value.split(':')) {
        if (!path.includes('docker-compose')) continue
        named += 1
        if (existsSync(path) || path === OPERATORS_OWN) continue
        missing += 1
        console.error(
          `::error file=${file}::${file} names ${path} as a compose file to load, and this ` +
            'repository does not have it. Compose exits on a file it cannot open, before it ' +
            'starts anything — remove the reference or restore the file.',
        )
        failed = true
      }
    }
  }
  if (named === 0) {
    console.error('::error::no compose file is named anywhere; this check ran against nothing')
    failed = true
  } else if (missing === 0) {
    console.log(`compose files named as ones to load: ${String(named)}, all present`)
  }
}

/**
 * ─── The release-image overlay covers every service the base builds ──────────
 *
 * `docker-compose.images.yml` exists so somebody can run Nacre without building
 * it: the base file builds every service from this checkout, a release
 * publishes four images that pull anonymously, and until the overlay the only
 * consumer of those images was the Helm chart.
 *
 * An overlay is a second list, and a second list of services drifts. Compose
 * merges rather than replaces, so a service the base builds and the overlay
 * omits keeps its `build:` and is **built** — on a command whose whole promise
 * is that nothing is built. It does not fail; it takes four minutes and works,
 * which is how nobody notices for a release or two.
 *
 * Seven services and four images, with nothing that knows either number. So the
 * overlay is held against the base rather than reviewed: every service carrying
 * `build:`, directly or through the shared anchor, has to be named here.
 */

{
  const BASE = 'docker-compose.yml'
  const OVERLAY = 'docker-compose.images.yml'

  if (!existsSync(OVERLAY)) {
    console.error(
      `::error::${OVERLAY} is gone. It is what lets the published images be run without a ` +
        'build, and the quickstart names it. Restore it, or remove this section in the same ' +
        'commit and say where the no-build path went.',
    )
    failed = true
  } else {
    const base = readFileSync(BASE, 'utf8')
    const overlay = readFileSync(OVERLAY, 'utf8')

    // Services under `services:`, and whether each is built — either by its own
    // `build:` or by taking the shared anchor that carries one.
    const built = []
    let inServices = false
    let service
    for (const line of base.split('\n')) {
      if (/^services:\s*$/.test(line)) { inServices = true; continue }
      if (inServices && /^\S/.test(line)) inServices = false
      if (!inServices) continue
      const named = /^ {2}([a-z0-9-]+):\s*$/.exec(line)
      if (named !== null) service = named[1]
      if (service === undefined) continue
      if (/^ {4}build:/.test(line) || /<<:\s*\*app\b/.test(line)) {
        if (!built.includes(service)) built.push(service)
      }
    }

    if (built.length === 0) {
      console.error(
        `::error file=${BASE}::no service in ${BASE} is built from source, so this check ` +
          'compared nothing. If that is now true, the overlay has no reason to exist.',
      )
      failed = true
    }

    for (const name of built) {
      const declared = new RegExp(`^ {2}${name}:\\s*\\n(?: {4}.*\\n)*? {4}image:`, 'm').test(overlay)
      if (declared) continue
      console.error(
        `::error file=${OVERLAY}::${BASE} builds \`${name}\` and ${OVERLAY} names no image for ` +
          'it. Compose merges, so that service keeps its `build:` and gets built by the command ' +
          'that exists not to build anything — slowly, successfully, and silently.',
      )
      failed = true
    }

    if (!failed) {
      console.log(`${OVERLAY}: an image for all ${String(built.length)} service(s) ${BASE} builds`)
    }
  }
}

process.exit(failed ? 1 : 0)
