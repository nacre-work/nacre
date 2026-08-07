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
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
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

process.exit(failed ? 1 : 0)
