#!/usr/bin/env node
/**
 * No screen asks a person to type an id.
 *
 * Five dialogs did — a workspace, a grant's principal, a grant's scope, a group
 * member, a provider — and four of them put a picker *beside* the field rather
 * than instead of it, on the argument that the list can be empty and pasting an
 * id has to keep working.
 *
 * Nobody knows a uuid. A person who has one copied it out of the picker
 * directly above, which means the picker already had the answer; a person who
 * does not is being invited to type something they cannot get right, and the
 * failure arrives as the `404` invariant 4 owes an unreachable object —
 * indistinguishable, by design, from a broken screen. So the field belongs
 * where there is no list to read, and nowhere else.
 *
 * `pick.ts` is where that judgement lives and is therefore the one file allowed
 * to build the field. Everything else asks it.
 *
 * Deliberately a source check and not a test, on the same reasoning as
 * `check-admin-gate.mjs`: what is asserted is that a *shape* does not appear,
 * and a test can only assert about the dialogs somebody wrote one for — which
 * is exactly the gap this closes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'packages/admin/src'

/** Where the field is legitimately built, and where the reasoning lives. */
const DEFINES = ['packages/admin/src/pick.ts']

/**
 * The one field left, and the reason is not about this screen.
 *
 * `embedding_providers` has no listing endpoint at all — the schema has offered
 * per-organization providers since migration 0001 and the API gives no route to
 * enumerate them, so the migration panel cannot offer a picker because there is
 * nothing to ask. That is the same shape `GET /v1/workspaces` closed: the model
 * offers something the product gives no route to, and the route people find
 * instead is `psql`.
 *
 * Written down here rather than left to a comment in the view, and checked in
 * both directions — an exemption that stops matching is reported, so this list
 * cannot outlive the endpoint that removes its reason. nacre#122.
 */
const EXEMPT = [
  { file: 'packages/admin/src/views/migrate.ts', text: "placeholder: 'provider id (uuid)'" },
]

/**
 * A text input whose placeholder promises an id.
 *
 * Matched on the placeholder rather than on the variable name, because the
 * placeholder is the part a person reads — it is the promise being made, and a
 * field called `scopeId` holding a slug would be fine.
 */
const ASKS_FOR_AN_ID = /placeholder:\s*(['"`])[^'"`]*\b(id|uuid)\b[^'"`]*\1/gi

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path)
  }
}
walk(ROOT)

let failed = false
let scanned = 0

for (const file of files) {
  if (DEFINES.includes(file)) continue
  scanned += 1
  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, i) => {
    // A comment explaining the rule is not a use of it.
    if (/^\s*(\/\/|\*)/.test(line)) return
    for (const match of line.matchAll(ASKS_FOR_AN_ID)) {
      const excused = EXEMPT.find((e) => e.file === file && line.includes(e.text))
      if (excused !== undefined) {
        excused.seen = true
        continue
      }
      console.error(
        `::error file=${file},line=${i + 1}::${match[0].trim()} — a screen asks for an id. ` +
          'Nobody knows a uuid, and a wrong one comes back as the 404 that means "no such thing ' +
          'or not yours". Use `picker()` from pick.ts, which shows a field only where the list ' +
          'could not be read.',
      )
      failed = true
    }
  })
}

if (scanned === 0) {
  console.error(`::error::no view found under ${ROOT}; this check scanned nothing`)
  process.exit(1)
}

// The definition site has to keep existing, or this check silently becomes a
// ban on a control with nothing offering the alternative.
for (const file of DEFINES) {
  if (!files.includes(file)) {
    console.error(`::error::${file} is gone, so this check now forbids a field with no replacement`)
    failed = true
  }
}

// An exemption that no longer matches has outlived its reason, and leaving it
// makes the next person believe a field is still excused when it is not.
for (const e of EXEMPT) {
  if (e.seen === true) {
    console.log(`exempt: ${e.file} — ${e.text}`)
    continue
  }
  console.error(
    `::error::${e.file} no longer contains ${e.text}, so its exemption in this check is stale. ` +
      'Remove it.',
  )
  failed = true
}

if (!failed) console.log(`${scanned} views, ${EXEMPT.length} field(s) excused by name, none else asking for an id`)
process.exit(failed ? 1 : 0)
