#!/usr/bin/env node
/**
 * The demo seed survives a failed ingest, and a re-run finishes it.
 *
 * ## The defect this exists against
 *
 * `docker/demo/seed.sh` created three accounts with generated passwords, loaded
 * the corpus, and *then* recorded the passwords. Under `set -e` a failed
 * `ingest` — a cold embedder still pulling its model is the ordinary way to get
 * one — killed the script between the two. The accounts existed, their
 * passwords existed nowhere, and the only recovery was `down -v`: three new
 * credentials, and on a public stand a front page that had to be re-read by
 * everyone.
 *
 * The comment that used to sit at the write is what makes this worth a check
 * rather than an edit. It explained that the write came before the *print*
 * "because a crash between the two would lose the only copy of three
 * passwords" — the small gap, reasoned about and closed, while the much larger
 * one beside it, the entire corpus ingest, was left open. A guard on the narrow
 * gap and none on the wide one is not something a reader notices.
 *
 * ## Why a harness rather than a test
 *
 * There is nothing to unit-test. The property is an *ordering* inside a shell
 * script and the thing that goes wrong is a failure arriving between two lines,
 * so the real script is run — four times, against a stub CLI and a stub API.
 * That is the technique the sibling repository uses to drive its provisioning
 * script, for the reason its author gave: `sh -n` proves syntax, and syntax is
 * not behaviour.
 *
 * What this deliberately does **not** claim is that the demo profile works.
 * That is the `demo` CI job, against a real embedder and a real corpus. This
 * asks the one question that job cannot: what is left behind when the ingest
 * inside it fails.
 *
 * ## What the script under test is
 *
 * A copy, with **two** substitutions: the two absolute paths the seed invokes
 * (`/app/packages/cli/dist/main.js` and `/app/packages/api/dist/init.js`) point
 * at the stubs. Everything else — every branch, every ordering, every `set -e`
 * — is the shipped file byte for byte.
 *
 * A rewritten script is only worth trusting if the rewrite is checked, so both
 * substitutions must apply. A rename in the seed makes this fail by name rather
 * than quietly leaving the stubs uncalled and every assertion passing against a
 * script that did nothing.
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEED = join(root, 'docker', 'demo', 'seed.sh')

const problems = []
const note = (line) => problems.push(line)

/** What the stub `init` prints, in the shape the seed parses out of it. */
const ADMIN_PASSWORD = 'reef-lustre-tide-keel-prism-shoal-42'
const TOKEN = 'stub.token.value'

const CLI_PATH = '/app/packages/cli/dist/main.js'
const INIT_PATH = '/app/packages/api/dist/init.js'

const CLI_STUB = `import { appendFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(process.env.STUB_LOG, args.join(' ') + '\\n')
if (args[0] === 'ingest' && process.env.STUB_INGEST_FAILS === '1') {
  process.stderr.write('embedder refused: connection refused\\n')
  process.exit(1)
}
if (args[0] === 'users' && args[1] === 'create') {
  const email = args[2]
  process.stdout.write(JSON.stringify({
    id: 'id-' + email.split('@')[0],
    email,
    password: 'coral-drift-lagoon-mantle-wharf-reef-' + String(email.length),
  }))
}
`

const INIT_STUB = `import { appendFileSync } from 'node:fs'
appendFileSync(process.env.STUB_LOG, 'init ' + process.argv.slice(2).join(' ') + '\\n')
process.stdout.write([
  'Organization created.',
  '',
  '  ${ADMIN_PASSWORD}',
  '',
  '  export NACRE_TOKEN=${TOKEN}',
  '',
].join('\\n'))
`

const work = mkdtempSync(join(tmpdir(), 'nacre-seed-'))
const corpusDir = join(work, 'corpus')
for (const layer of ['handbook', 'engineering', 'contracts']) {
  mkdirSync(join(corpusDir, layer), { recursive: true })
  writeFileSync(join(corpusDir, layer, 'a.md'), '# a\n\ntext\n')
}
writeFileSync(join(work, 'cli.mjs'), CLI_STUB)
writeFileSync(join(work, 'init.mjs'), INIT_STUB)

/** The seed, with the two program paths pointed at the stubs. */
function scriptUnderTest() {
  const original = readFileSync(SEED, 'utf8')
  let rewritten = original
  for (const [from, to] of [
    [CLI_PATH, join(work, 'cli.mjs')],
    [INIT_PATH, join(work, 'init.mjs')],
  ]) {
    if (!rewritten.includes(from)) {
      note(
        `docker/demo/seed.sh no longer invokes ${from}. This harness rewrites exactly that ` +
          'path to reach a stub, so it would run the real command or none at all and every ' +
          'assertion below would pass having tested nothing. Point the substitution at ' +
          'whatever it invokes now.',
      )
      return undefined
    }
    rewritten = rewritten.split(from).join(to)
  }
  const path = join(work, 'seed-under-test.sh')
  writeFileSync(path, rewritten)
  return path
}

/**
 * A stub API, in a **process of its own**, and that is not an arrangement.
 *
 * The first version served it from this process with `createServer` and ran the
 * seed with `execFileSync`, which blocks the event loop — so the child asked
 * `/v1/ready` and nothing was ever going to answer it. Every run failed with
 * `waiting for the API to be ready`, which is the harness *accusing the script*
 * of a fault that was entirely its own. That is the shape this repository has
 * recorded twice: a smoke test that never sent its document and then failed
 * blaming the product, and a stand check that read a page it could not parse
 * and reported the deployment down.
 *
 * `/v1/ready` so the seed starts, and `/v1/auth/login` because the seed's own
 * probe signs in to prove the saved state still describes a live organization —
 * it refuses a wrong password, so the "the database and this volume have come
 * apart" branch stays reachable rather than being stubbed away.
 */
const API_STUB = `import { createServer } from 'node:http'
createServer((req, res) => {
  let body = ''
  req.on('data', (d) => { body += d }).on('end', () => {
    if (req.url === '/v1/ready') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    if (req.url === '/v1/auth/login') {
      let ok = false
      try {
        ok = JSON.parse(body || '{}').password === ${JSON.stringify(ADMIN_PASSWORD)}
      } catch {
        ok = false
      }
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
      res.end(JSON.stringify(ok ? { access_token: 'stub.access.token' } : { title: 'no' }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
}).listen(0, '127.0.0.1', function () { process.stdout.write('port ' + this.address().port + '\\n') })
`

/** Start it, and wait for the port it chose rather than guessing one. */
function stubApi() {
  writeFileSync(join(work, 'api.mjs'), API_STUB)
  const child = spawn(process.execPath, [join(work, 'api.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    const failed = setTimeout(() => reject(new Error('the stub API never printed a port')), 10_000)
    let seen = ''
    child.stdout.on('data', (d) => {
      seen += String(d)
      const match = /port (\d+)/u.exec(seen)
      if (match === null) return
      clearTimeout(failed)
      resolve({ child, port: Number(match[1]) })
    })
  })
}

let runs = 0

/** Run the script under test. Returns `{ code, out, calls }`. */
function run(script, { state, port, ingestFails }) {
  const log = join(work, `calls-${String(runs)}.log`)
  runs += 1
  writeFileSync(log, '')
  let code = 0
  let out
  try {
    out = execFileSync('sh', [script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // A seed that hangs is a CI job that burns its whole budget and then says
      // "cancelled", which reads as an infrastructure problem. The wait loop it
      // contains is 120 tries of two seconds, so anything past a minute here is
      // this harness failing to answer rather than the script being slow.
      timeout: 60_000,
      env: {
        ...process.env,
        NACRE_API_URL: `http://127.0.0.1:${String(port)}`,
        DEMO_STATE: state,
        DEMO_CORPUS: corpusDir,
        STUB_LOG: log,
        STUB_INGEST_FAILS: ingestFails === true ? '1' : '0',
      },
    })
  } catch (error) {
    code = error.status ?? 1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  return { code, out, calls }
}

const script = scriptUnderTest()
const api = script === undefined ? undefined : await stubApi()
const port = api === undefined ? 0 : api.port

if (script !== undefined) {
  const state = join(work, 'state')
  mkdirSync(state, { recursive: true })
  const saved = join(state, 'credentials.txt')
  const proof = join(state, 'admin-password')
  const indexed = join(state, 'corpus-indexed')
  const ingests = (calls) => calls.filter((c) => c.startsWith('ingest ')).length
  const creates = (calls) => calls.filter((c) => c.startsWith('users create')).length
  const inits = (calls) => calls.filter((c) => c.startsWith('init ')).length

  // ── 1. fresh, and the ingest fails ─────────────────────────────────────────
  //
  // The state this whole change is about. The accounts exist by now, so the
  // credentials have to be on disk before anything can fail.
  const first = run(script, { state, port, ingestFails: true })
  if (first.code === 0) note('a seed whose every ingest failed exited 0')
  if (!existsSync(saved)) {
    note(
      'the ingest failed and no credentials were recorded — which is the defect this ' +
        'exists against: three accounts exist and their passwords are nowhere.',
    )
  }
  if (!existsSync(proof)) note('the ingest failed and the administrator password was not saved')
  if (existsSync(indexed)) note('the corpus marker was written even though every ingest failed')
  if (inits(first.calls) !== 1) note(`a fresh seed called init ${String(inits(first.calls))} times`)
  if (creates(first.calls) !== 2) {
    note(`a fresh seed created ${String(creates(first.calls))} people, not 2`)
  }

  // ── 2. re-run, and the ingest works ────────────────────────────────────────
  //
  // Resumes. Nothing is created a second time — a second `init` would print a
  // password it did not set, and a second `users create` would issue passwords
  // that disagree with the ones already printed.
  const second = run(script, { state, port, ingestFails: false })
  if (second.code !== 0) note(`the resume run exited ${String(second.code)}:\n${second.out}`)
  if (!existsSync(indexed)) note('the resume run loaded the corpus and wrote no marker')
  if (inits(second.calls) !== 0) note('the resume run created the organization a second time')
  if (creates(second.calls) !== 0) note('the resume run created the people a second time')
  if (ingests(second.calls) !== 3) {
    note(`the resume run ingested ${String(ingests(second.calls))} layers, not 3`)
  }
  if (!second.out.includes('the corpus is in')) {
    note('the resume run did not say the corpus went in')
  }

  // ── 3. re-run, with nothing left to do ─────────────────────────────────────
  const third = run(script, { state, port, ingestFails: false })
  if (third.code !== 0) note(`the already-seeded run exited ${String(third.code)}`)
  if (third.calls.length !== 0) {
    note(`the already-seeded run called ${third.calls.join(', ')} and should call nothing`)
  }
  if (!third.out.includes('already seeded')) note('the already-seeded run did not say so')

  // ── 4. fresh, and everything works ─────────────────────────────────────────
  const clean = join(work, 'state-clean')
  mkdirSync(clean, { recursive: true })
  const fourth = run(script, { state: clean, port, ingestFails: false })
  if (fourth.code !== 0) note(`the ordinary path exited ${String(fourth.code)}:\n${fourth.out}`)
  for (const [name, file] of [
    ['credentials.txt', join(clean, 'credentials.txt')],
    ['admin-password', join(clean, 'admin-password')],
    ['corpus-indexed', join(clean, 'corpus-indexed')],
  ]) {
    if (!existsSync(file)) note(`the ordinary path left no ${name}`)
  }
  if (ingests(fourth.calls) !== 3) {
    note(`the ordinary path ingested ${String(ingests(fourth.calls))} layers, not 3`)
  }
  // The two published logins have to be marked shared, or the first visitor to
  // enrol a second factor locks out every other one permanently.
  if (fourth.calls.filter((c) => c.includes('--shared')).length !== 2) {
    note('the two demo people were not created with --shared')
  }
}

if (api !== undefined) api.child.kill()
rmSync(work, { recursive: true, force: true })

for (const problem of problems) console.error(`::error::${problem}`)
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) driving docker/demo/seed.sh`)
  process.exit(1)
}
console.log('docker/demo/seed.sh: fresh, failed, resumed and already-seeded all behave')
