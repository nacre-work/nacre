#!/usr/bin/env node
/**
 * Every `SECURITY DEFINER` function ends its `search_path` with `pg_temp`.
 *
 * ## The defect this exists for
 *
 * `SET search_path = pg_catalog, public` reads as "only these two schemas" and
 * is not. PostgreSQL searches the session's temporary schema **first** when
 * `pg_temp` is not listed — ahead of `pg_catalog` — so omitting it is the
 * opposite of excluding it. Naming it last is the documented way to put it
 * behind everything else.
 *
 * Two functions shipped that way, in the two migrations whose whole subject was
 * closing temp-schema shadowing. A third, written later, got it right. Nothing
 * compared them, which is this repository's first paragraph: a property that
 * has to hold in N places with nothing that knows N. So the repair is this
 * rather than the two `ALTER`s in 0034.
 *
 * ## How it reads the tree
 *
 * Forward-only migrations mean the answer for a function is its **last**
 * setting, not its first: 0003 creates `bump_groups_version` with no pin, 0010
 * pins it wrongly, and 0034 corrects it. So every `CREATE … FUNCTION` and every
 * `ALTER FUNCTION … SET search_path` is collected in file order and the final
 * one per function decides. Checking the first would fail a correctly repaired
 * tree; checking any would pass a tree that had regressed.
 *
 * A definer function with **no** `search_path` at all is also a failure, and
 * deliberately so: unpinned means the caller supplies the path, which is the
 * stronger version of the same hole.
 *
 * A run that finds no definer function refuses. A check with nothing to hold
 * must not report green.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../packages/core/migrations/', import.meta.url))

/** Strip comments, or a rule quoted in one is read as a statement. */
function sql(text) {
  return text.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** `prune_audit_events(retention_days integer, …)` → `prune_audit_events`. */
function nameOf(signature) {
  const match = /^\s*([a-z_][a-z0-9_]*)/i.exec(signature)
  return match?.[1]?.toLowerCase()
}

const files = readdirSync(DIR)
  .filter((name) => name.endsWith('.sql'))
  .sort()

/** function name → { file, pinned: string | undefined } , last write wins. */
const definers = new Map()
const problems = []

for (const file of files) {
  const text = sql(readFileSync(`${DIR}${file}`, 'utf8'))

  // A definition: everything from CREATE FUNCTION to the body delimiter, which
  // is where every clause including SET lives.
  for (const match of text.matchAll(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\s\S]*?)\bAS\s*\$/gi,
  )) {
    const head = match[1] ?? ''
    if (!/SECURITY\s+DEFINER/i.test(head)) continue
    const name = nameOf(head)
    if (name === undefined) continue
    const pin = /SET\s+search_path\s*=\s*([^\n;]+)/i.exec(head)
    definers.set(name, { file, pinned: pin?.[1]?.trim() })
  }

  // A function can *become* a definer later. `bump_groups_version` is created
  // in 0003 with no such clause and altered into one in 0003's own tail, which
  // is how the first version of this check reported two subjects where the
  // tree has three — and the one it could not see is one of the two 0034
  // repairs. A check that silently covers less than it looks like is the shape
  // this repository keeps deleting, so `ALTER … SECURITY DEFINER` enrols a
  // function here exactly as a `CREATE` does.
  for (const match of text.matchAll(
    /ALTER\s+FUNCTION\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)([^;]*)/gi,
  )) {
    const name = match[1]?.toLowerCase()
    const clauses = match[3] ?? ''
    if (name === undefined) continue

    if (/SECURITY\s+DEFINER/i.test(clauses) && !definers.has(name)) {
      definers.set(name, { file, pinned: undefined })
    }
    // A pin is only a subject for a function that is a definer. An ordinary
    // function's search_path is a performance decision, not a boundary.
    if (!definers.has(name)) continue

    const pin = /SET\s+search_path\s*=\s*([^\n;]+)/i.exec(clauses)
    if (pin?.[1] !== undefined) definers.set(name, { file, pinned: pin[1].trim() })
  }
}

for (const [name, { file, pinned }] of definers) {
  if (pinned === undefined) {
    problems.push(
      `${name}: SECURITY DEFINER with no search_path (${file}). ` +
        'An unpinned definer takes the caller\'s path, which is the shadowing hole in full.',
    )
    continue
  }
  const last = pinned
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .at(-1)
  if (last !== 'pg_temp') {
    problems.push(
      `${name}: search_path = ${pinned} (${file}). ` +
        'pg_temp is searched FIRST when it is not listed, so this does not exclude it — ' +
        'name it last.',
    )
  }
}

if (definers.size === 0) {
  console.error(
    'check-definer-search-path: no SECURITY DEFINER function found in packages/core/migrations. ' +
      'A check with nothing to hold must not report green.',
  )
  process.exit(1)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `check-definer-search-path: ${problems.length} of ${definers.size} definer function(s) ` +
      'can be shadowed by a temp table.',
  )
  process.exit(1)
}

console.log(
  `check-definer-search-path: ${definers.size} SECURITY DEFINER function(s), each ending its ` +
    'search_path with pg_temp.',
)
