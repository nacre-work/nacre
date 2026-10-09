#!/usr/bin/env node
/**
 * The refusal that guards `modules` names the open image, and it has to be the
 * same string `values.yaml` defaults to.
 *
 * `NACRE_MODULES` names packages the process imports at startup. The core's
 * contract is that a module which cannot be imported is a startup failure —
 * deliberately, since starting without one is silently a different product — so
 * naming a commercial module on the open image is a guaranteed
 * CrashLoopBackOff, arriving as an import error that says nothing about
 * modules or about licensing.
 *
 * A chart cannot look inside an image. What it can see is the one combination
 * that is certainly wrong: modules named while the repository is still the
 * default it ships. `_helpers.tpl` refuses on exactly that, by comparing
 * against a literal.
 *
 * **A literal is a second copy, and this is the check that keeps it one.** If
 * `image.repository` moves in `values.yaml` and not in the template, nothing
 * breaks and nothing fails — the comparison simply stops matching, the refusal
 * stops firing, and the next operator who names a module gets the
 * CrashLoopBackOff this was written to prevent. A guard that silently stops
 * guarding is the failure this repository keeps finding, so it gets a check
 * rather than a comment.
 *
 * Deliberately not solved by threading the default through a named template:
 * `values.yaml` cannot reference one, so the default would still be written
 * twice and the second copy would be the one nobody reads.
 */

import { readFileSync } from 'node:fs'

const VALUES = 'deploy/helm/nacre/values.yaml'
const HELPERS = 'deploy/helm/nacre/templates/_helpers.tpl'

let failed = false

/** `image.repository` as values.yaml defaults it. */
function defaultRepository() {
  const lines = readFileSync(VALUES, 'utf8').split('\n')
  const start = lines.findIndex((line) => /^image:\s*$/.test(line))
  if (start === -1) return undefined
  for (const line of lines.slice(start + 1)) {
    // The block ends at the next top-level key.
    if (/^\S/.test(line)) break
    const found = /^\s+repository:\s*(\S+)\s*$/.exec(line)
    if (found) return found[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

const repository = defaultRepository()
if (repository === undefined) {
  console.error(
    `::error file=${VALUES}::no image.repository default found. It is what the modules refusal ` +
      'compares against, so this check has nothing to hold the template to — it did not pass, ' +
      'it stopped being able to look.',
  )
  process.exit(1)
}

const helpers = readFileSync(HELPERS, 'utf8')

// The guard itself, and the string it compares against.
const guard = /\{\{-\s*if and \.Values\.modules \(eq \.Values\.image\.repository "([^"]+)"\)\s*-\}\}/.exec(
  helpers,
)

if (guard === null) {
  console.error(
    `::error file=${HELPERS}::the refusal guarding \`modules\` is gone. Naming a commercial ` +
      'module on the open image is a CrashLoopBackOff whose error mentions neither modules nor ' +
      'licensing, and this refusal is what turns it into a `helm install` error. Restore it, or ' +
      'delete this check in the same commit and say why.',
  )
  process.exit(1)
}

if (guard[1] !== repository) {
  console.error(
    `::error file=${HELPERS}::the modules refusal compares against \`${guard[1]}\` and ` +
      `${VALUES} defaults image.repository to \`${repository}\`. They no longer match, so the ` +
      'refusal cannot fire on a default install — it does not fail, it stops guarding, which is ' +
      'the shape this check exists for.',
  )
  failed = true
}

if (!failed) {
  console.log(`${HELPERS}: the modules refusal names the image ${VALUES} defaults to (${repository})`)
}
process.exit(failed ? 1 : 0)
