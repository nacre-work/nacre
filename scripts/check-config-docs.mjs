#!/usr/bin/env node
/**
 * The configuration reference must not fall behind the code that reads it, or
 * the development file that seeds it.
 *
 * This is the most-repeated defect in this repository's history: a variable
 * validated at startup and read by nothing, or read by the code and documented
 * nowhere. `docs/config.md` is the contract a self-hoster deploys against, so a
 * variable the code consults but the document omits is invisible to the one
 * person who most needs it — and one that sits in `.env.example` but not in the
 * reference is the same gap a step earlier.
 *
 * Two subset checks, both in the safe direction:
 *
 *   1. every NACRE_ variable the core actually READS is documented, and
 *   2. every NACRE_ variable in `.env.example` is documented.
 *
 * The reverse — documented but unread — is deliberately NOT asserted: the
 * reference legitimately carries variables nothing in this repository reads (the
 * commercial modules' NACRE_SSO_, NACRE_EMA_ and NACRE_AUDIT_SIEM_ families, and
 * variables named only to say they are refused or gone).
 * Asserting that direction would be a wall of false positives, and a check that
 * cries wolf gets switched off.
 *
 * **The sidecars are readers too**, and were not held to this until a second one
 * existed. The check knew about TypeScript and the parser is Python, so
 * `NACRE_PARSER_ALLOW_PRIVATE_URLS` — which decides whether an authenticated
 * tenant can point that service at the cloud metadata endpoint — was read by a
 * shipped container and documented nowhere. Nothing was wrong with the rule;
 * the check simply could not see half the code it applied to, which is this
 * repository's own shape one level up: a property that has to hold in N places
 * with something that knows only some of them.
 *
 * Extraction is precise rather than a bare grep for the prefix: a variable is
 * "read" only where it is the operand of an env access — `r.method('NACRE_X')`
 * through the Reader, or `env.NACRE_X` / `process.env.NACRE_X` directly. A
 * NACRE_ name inside a refusal message is not a read and does not count, which
 * is why those messages do not trip this.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// The files that read the process environment. Config is centralized in
// config.ts; these two entry points reach for one variable each before it is
// built (the migrator needs the DSN to connect, the STDIO transport its service
// key), and both are listed so the check sees every read. A new direct reader
// belongs here — but it also belongs in config.ts, which is the actual rule.
const READERS = [
  'packages/core/config.ts',
  'packages/core/migrate-main.ts',
  'packages/mcp/src/stdio-main.ts',
]

// The sidecars, discovered rather than listed: a third one added and not named
// here is exactly the gap this half of the check exists to close, and a list is
// the thing that does not get the entry.
const SIDECARS = 'services'
const pythonUnder = (dir) => {
  const found = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__pycache__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) found.push(...pythonUnder(path))
    else if (path.endsWith('.py') && !path.endsWith('test_app.py')) found.push(path)
  }
  return found
}

const DOCS = 'docs/config.md'
const ENV_EXAMPLE = '.env.example'

/** NACRE_ names that appear as the operand of an env access in `source`. */
function readsIn(source) {
  const found = new Set()
  // Reader calls: r.required('NACRE_X'), r.oneOf('NACRE_X', ...), etc.
  for (const m of source.matchAll(/\br\.[a-zA-Z]+\(\s*'(NACRE_[A-Z0-9_]+)'/g)) found.add(m[1])
  // Direct access: env.NACRE_X, process.env.NACRE_X, env['NACRE_X'].
  for (const m of source.matchAll(/(?:process\.)?env(?:\.|\[')(NACRE_[A-Z0-9_]+)/g)) found.add(m[1])
  return found
}

/**
 * The same question asked of Python, and asked more loosely on purpose.
 *
 * On the TypeScript side a variable counts only where it is the operand of an
 * env access, because `config.ts` names variables in refusal messages that are
 * about being refused. The sidecars have no such messages, and matching only
 * `os.environ.get("NACRE_X")` would have exempted the whole of the embedding
 * adapter: its names live in a vendor table and are read through a helper, so
 * the literal and the access are in different functions by design.
 *
 * A `NACRE_` name written anywhere in a sidecar's source is therefore a name an
 * operator can be asked to set, and being asked to set something the reference
 * does not explain is the defect this whole file exists for. Over-matching a
 * name that appears only in a comment costs a documentation entry for a
 * variable that exists; under-matching costs the check.
 */
function pythonReadsIn(source) {
  return namesIn(source)
}

/** Every NACRE_ name mentioned anywhere in `source` (the documentation side). */
function namesIn(source) {
  return new Set([...source.matchAll(/NACRE_[A-Z0-9_]+/g)].map((m) => m[0]))
}

const documented = namesIn(readFileSync(DOCS, 'utf8'))

let failed = false

const read = new Set()
for (const file of READERS) {
  for (const name of readsIn(readFileSync(file, 'utf8'))) read.add(name)
}

const undocumentedReads = [...read].filter((v) => !documented.has(v)).sort()
if (undocumentedReads.length > 0) {
  console.error(
    `::error::${undocumentedReads.length} variable(s) read by the core but not in ${DOCS}: ` +
      `${undocumentedReads.join(', ')}. A variable the code consults and the reference omits is ` +
      'invisible to whoever deploys this. Document it, or stop reading it.',
  )
  failed = true
} else {
  console.log(`${DOCS}: documents all ${read.size} variable(s) the core reads`)
}

const sidecarFiles = pythonUnder(SIDECARS)
if (sidecarFiles.length === 0) {
  console.error(`::error::no Python found under ${SIDECARS}/; this half of the check compared nothing`)
  failed = true
}

const sidecarRead = new Set()
for (const file of sidecarFiles) {
  for (const name of pythonReadsIn(readFileSync(file, 'utf8'))) sidecarRead.add(name)
}

const undocumentedSidecar = [...sidecarRead].filter((v) => !documented.has(v)).sort()
if (undocumentedSidecar.length > 0) {
  console.error(
    `::error::${undocumentedSidecar.length} variable(s) read by a sidecar but not in ${DOCS}: ` +
      `${undocumentedSidecar.join(', ')}. A sidecar ships in the same stack as the core and its ` +
      'configuration is the operator\'s too. Document it, or stop reading it.',
  )
  failed = true
} else {
  console.log(
    `${DOCS}: documents all ${sidecarRead.size} variable(s) the sidecars read ` +
      `(${sidecarFiles.length} file(s))`,
  )
}

const seeded = namesIn(readFileSync(ENV_EXAMPLE, 'utf8'))
const undocumentedSeeds = [...seeded].filter((v) => !documented.has(v)).sort()
if (undocumentedSeeds.length > 0) {
  console.error(
    `::error::${undocumentedSeeds.length} variable(s) in ${ENV_EXAMPLE} but not in ${DOCS}: ` +
      `${undocumentedSeeds.join(', ')}. The development file seeds a value the reference never ` +
      'explains. Document it, or drop it from the example.',
  )
  failed = true
} else {
  console.log(`${ENV_EXAMPLE}: every seeded variable is documented`)
}

process.exit(failed ? 1 : 0)
