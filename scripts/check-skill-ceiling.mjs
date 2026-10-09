/**
 * `skill` in a delegation's ceiling is read in one file and nowhere else.
 *
 * The consent screen's "edit this layer's skill" box stores `skill` in a
 * layer's ceiling, and docs/skills.md says it is read by **one function**:
 *
 * ```
 * may_write_layer_skill(auth, L) =
 *     resolve(person, admin) reaches L
 *   ∧ (auth is not a delegation  ∨  'admin' ∈ ceiling(L)  ∨  'skill' ∈ ceiling(L))
 * ```
 *
 * That sentence is the whole of why `skill` confers nothing else. It is not a
 * `Permission`, `resolve` never sees it, and the only code that gives it a
 * meaning is `packages/api/src/skill-ceiling.ts`. A second reader — a handler
 * that decides `permissions.includes('skill')` is close enough to `admin` to
 * let something through — is a value that grants something in a place nobody
 * reviewed for it, and nothing at run time would notice: every existing case
 * would still pass, because every existing case is about the reader that is
 * supposed to exist.
 *
 * So this refuses the *shape* of a reader anywhere else in the server's
 * sources: a membership test against `'skill'`, an equality against it, a
 * `case 'skill':`. Deliberately a source check and not a test, for the reason
 * `check-admin-gate.mjs` gives: a test can only assert about the call sites
 * somebody remembered to write one for.
 *
 * ## What it deliberately does not refuse
 *
 * A **`.kind` discriminant**. `checkSkill` answers `{ kind: 'skill', … }` or a
 * refusal, so `check.kind === 'skill'` means "this folder parsed as a skill" —
 * the same word naming a different thing. Exempted by that shape, not by file,
 * so a ceiling reader spelled as a `.kind` comparison would be a strange enough
 * thing to write that a reviewer would ask about it anyway.
 *
 * **Tests**, which compare against `'skill'` to assert what the one reader
 * does, and **the console**, which writes the value into a consent and reads
 * `admin` — never `skill` — off a layer to decide where to offer the box.
 * Neither is an authorization decision.
 *
 * ## And it refuses an empty answer
 *
 * If the one reader stops reading, or stops being called, this has nothing to
 * hold — and a check with nothing to hold must not report green. So it
 * requires that `skill-ceiling.ts` still reads the value and that the skills
 * adapter still asks it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The server's sources: everything that makes an authorization decision. */
const ROOTS = ['packages/api/src', 'packages/mcp/src', 'packages/worker/src', 'packages/core']

/** The one file that may give `skill` a meaning. */
const READER = 'packages/api/src/skill-ceiling.ts'

/** The adapter that must keep asking it — `may_write_layer_skill`'s other half lives there. */
const CALLER = 'packages/api/src/skills.ts'

const SKILL = `['"]skill['"]`
const SHAPES = [
  // Set membership: how a ceiling is read.
  new RegExp(`\\.(includes|has|indexOf|lastIndexOf)\\(\\s*${SKILL}\\s*\\)`, 'g'),
  // An equality, in either order. The operand is captured so a `.kind`
  // discriminant can be told apart from a ceiling value.
  new RegExp(`([\\w$.\\]\\)]+)\\s*[!=]==?\\s*${SKILL}`, 'g'),
  new RegExp(`${SKILL}\\s*[!=]==?\\s*([\\w$.\\[\\(]+)`, 'g'),
  new RegExp(`\\bcase\\s+${SKILL}\\s*:`, 'g'),
]

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.(ts|mjs|js)$/.test(path) && !path.endsWith('.d.ts') && !/\.test\.(ts|mjs|js)$/.test(path)) {
      files.push(path)
    }
  }
}
for (const root of ROOTS) walk(root)

if (!files.includes(READER)) {
  console.error(
    `::error::${READER} is not there, so nothing reads \`skill\` in a delegation's ceiling — ` +
      'or it moved and this check holds nothing. Point READER at the one reader.',
  )
  process.exit(1)
}

/** Every reader-shaped use of `'skill'` in a file, comments left out. */
const readersIn = (file) => {
  const out = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // A comment explaining the rule is not a use of it, and the rule is
      // stated in prose in several files on purpose.
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
      for (const shape of SHAPES) {
        for (const match of line.matchAll(shape)) {
          const operand = match[1] ?? ''
          if (/\.kind$/.test(operand)) continue
          out.push(`${file}:${i + 1}  ${match[0].trim()}`)
        }
      }
    })
  return out
}

const elsewhere = files.filter((f) => f !== READER).flatMap(readersIn)
if (elsewhere.length > 0) {
  console.error(
    `::error::${elsewhere.length} place(s) read \`skill\` out of a delegation's ceiling outside ${READER}. ` +
      "It is not a permission and confers exactly one thing — writing a layer's skill where the person " +
      'holds admin — and only that file says so. Ask skillCeilingAdmits, skillCeilingLayers or ' +
      'ceilingOffers instead. See docs/skills.md, "Who writes what".',
  )
  for (const line of elsewhere) console.error(`  ${line}`)
  process.exit(1)
}

if (readersIn(READER).length === 0) {
  console.error(
    `::error::${READER} no longer reads \`skill\` at all, so the value a consent stores means ` +
      'nothing — and this check has nothing left to hold. If the box is gone, so is this check.',
  )
  process.exit(1)
}

const asked = (readFileSync(CALLER, 'utf8').match(/\bskillCeilingAdmits\(/g) ?? []).length
if (asked === 0) {
  console.error(
    `::error::${CALLER} no longer asks skillCeilingAdmits, so may_write_layer_skill has lost its ` +
      'ceiling clause — a delegation would write a skill wherever its person holds admin, whatever ' +
      'the person approved.',
  )
  process.exit(1)
}

console.log(`skill ceiling: one reader (${READER}), asked by ${CALLER}; ${files.length} files hold no other`)
