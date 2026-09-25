#!/usr/bin/env node
/**
 * The access log's action names come from one list, and every place that
 * names one agrees with it.
 *
 * ## What went wrong without it
 *
 * The action is a free string at every writer, so nothing related the names
 * recorded to the names anything else expected. Three places had drifted:
 *
 * - `PostgresAuditReader.DOCUMENT_ACCESS`, the deny-list that keeps a
 *   `platform_admin` from being shown who read what, named `document.get`,
 *   `document.read` and `chunk.read`. Nothing records any of them. The REST
 *   route and the MCP tool record a document fetch as `get_document`, so every
 *   fetch was on a platform administrator's log — rule 2 failing through the
 *   journal that exists to prove it held.
 * - The console's Action box offered `grant.issue` as its example. The handler
 *   records `issue_grant`, and an exact-match filter on the example was an
 *   empty log.
 * - The screenshot fixture carried `grant.issue`, `document.read` and
 *   `document.ingest` — a picture of a log no server writes.
 *
 * ## What this holds
 *
 * 1. `packages/core/audit-actions.ts` and the SDK's copy are the same entries,
 *    line for line. The copy exists because the console and the CLI cannot
 *    import the core; a copy is only safe while something compares it.
 * 2. Every literal `action:` a writer records — `packages/api`, `packages/mcp`,
 *    `packages/worker`, `packages/core`, tests excluded — is in the catalogue.
 * 3. Every catalogue entry is recorded somewhere. The `admin.<method>` entries
 *    are recorded by one template literal, so they count as recorded while that
 *    template exists and are refused if it goes.
 * 4. The reader's document-access list is the catalogue's, not a list of its
 *    own — the derivation is what closes the first defect above.
 * 5. The console's access log offers the catalogue, and the screenshot
 *    fixtures record only names in it.
 *
 * Refuses outright if it finds no catalogue or no writers: a check with nothing
 * to hold must not report green.
 *
 * It reads source as text. An action built at run time from a variable other
 * than the two shapes named here is invisible to it; the error boundary's
 * path-as-action is the one such writer, and it is deliberately not
 * catalogued (see the core file's header).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

const CORE = 'packages/core/audit-actions.ts'
const SDK = 'packages/sdk/src/audit-actions.ts'
const READER = 'packages/api/src/adapters.ts'
const CONSOLE = 'packages/admin/src/views/audit.ts'
const FIXTURES = 'scripts/screenshots.mjs'
const WRITERS = ['packages/api/src', 'packages/mcp/src', 'packages/worker/src', 'packages/core']

const problems = []

const ENTRY = /^\s*\{ name: '([^']+)', documentAccess: (true|false), summary: .+ \},$/
function catalogue(path) {
  return read(path)
    .split('\n')
    .filter((line) => ENTRY.test(line))
    .map((line) => ({ line: line.trim(), name: ENTRY.exec(line)[1] }))
}

const core = catalogue(CORE)
const sdk = catalogue(SDK)
if (core.length === 0) problems.push(`${CORE}: no catalogue entries found — has the one-entry-per-line shape changed?`)
if (sdk.length === 0) problems.push(`${SDK}: no catalogue entries found — has the one-entry-per-line shape changed?`)

// 1. The copy is the list.
const longest = Math.max(core.length, sdk.length)
for (let i = 0; i < longest; i += 1) {
  if (core[i]?.line !== sdk[i]?.line) {
    problems.push(
      `${SDK} disagrees with ${CORE} at entry ${String(i + 1)}:\n    core: ${core[i]?.line ?? '(none)'}\n    sdk:  ${sdk[i]?.line ?? '(none)'}`,
    )
    break
  }
}

const names = new Set()
for (const { name } of core) {
  if (names.has(name)) problems.push(`${CORE}: '${name}' is listed twice`)
  names.add(name)
}

// 2 and 3. Writers.
function sources(dir) {
  const out = []
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(join(root, path)).isDirectory()) out.push(...sources(path))
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.test.ts')) out.push(path)
  }
  return out
}

const LITERAL = /\baction:\s*(['"])([^'"]+)\1/g
const ADMIN_TEMPLATE = /\baction:\s*`admin\.\$\{/
const recorded = new Map()
let adminTemplate = false
for (const dir of WRITERS) {
  for (const file of sources(dir)) {
    if (file === CORE) continue
    const text = read(file)
    for (const match of text.matchAll(LITERAL)) {
      const at = `${file}:${String(text.slice(0, match.index).split('\n').length)}`
      if (!recorded.has(match[2])) recorded.set(match[2], at)
    }
    if (ADMIN_TEMPLATE.test(text)) adminTemplate = true
  }
}
if (recorded.size === 0) problems.push(`no literal \`action:\` found under ${WRITERS.join(', ')} — the check has lost its subject`)

for (const [name, at] of recorded) {
  if (!names.has(name)) {
    problems.push(`${at} records '${name}', which is not in ${CORE}. Add it there (and to ${SDK}), and decide documentAccess.`)
  }
}
for (const name of names) {
  if (name.startsWith('admin.')) {
    if (!adminTemplate) problems.push(`${CORE} lists '${name}', and nothing records \`admin.\${method}\` any more`)
    continue
  }
  if (!recorded.has(name)) problems.push(`${CORE} lists '${name}', and no writer records it. Remove it, or it is a name the console offers that matches nothing.`)
}

// 4. The reader derives.
if (!/private static readonly DOCUMENT_ACCESS = DOCUMENT_ACCESS_ACTIONS\b/.test(read(READER))) {
  problems.push(`${READER}: PostgresAuditReader.DOCUMENT_ACCESS must be DOCUMENT_ACCESS_ACTIONS from the core, not a list of its own`)
}

// 5. The console offers the list, and the pictures agree with it.
if (!/\bAUDIT_ACTIONS\b/.test(read(CONSOLE))) {
  problems.push(`${CONSOLE}: the Action filter no longer offers AUDIT_ACTIONS`)
}
const fixtureText = read(FIXTURES)
let fixtures = 0
for (const match of fixtureText.matchAll(LITERAL)) {
  fixtures += 1
  if (!names.has(match[2])) {
    const line = fixtureText.slice(0, match.index).split('\n').length
    problems.push(`${FIXTURES}:${String(line)} photographs action '${match[2]}', which no server records`)
  }
}
if (fixtures === 0) problems.push(`${FIXTURES}: no audit fixture actions found — the access log is photographed with none?`)

if (problems.length > 0) {
  for (const p of problems) console.error(`::error::${p}`)
  process.exit(1)
}
console.log(
  `audit actions: ${String(names.size)} in the catalogue, the SDK copy identical, ` +
    `${String(recorded.size)} recorded by name across ${WRITERS.length} packages, ` +
    `${String(fixtures)} fixture records checked (${relative(root, join(root, CORE))})`,
)
