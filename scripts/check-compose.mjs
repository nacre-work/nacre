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

const EXPECTED = {
  minimal: ['api', 'mcp', 'migrate', 'parser', 'postgres', 'qdrant', 'redis', 'worker'],
  full: ['api', 'embedder', 'mcp', 'migrate', 'minio', 'parser', 'postgres', 'qdrant', 'redis', 'reranker', 'worker'],
  airgapped: ['api', 'embedder', 'keycloak', 'mcp', 'migrate', 'parser', 'postgres', 'qdrant', 'redis', 'reranker', 'worker'],
}

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

process.exit(failed ? 1 : 0)
