/**
 * No handler compares a caller's role to a role name.
 *
 * `auth.role === 'org_admin'` was the gate on nine handlers — minting a user, a
 * group, a service account, reading the access log, issuing a grant, listing
 * and ending connections. Every one of them was correct until a delegation
 * could carry a permission ceiling, and then every one of them was the same
 * defect: a read-only delegation of an administrator could still mint a
 * credential, and the credential it minted had no ceiling at all.
 *
 * The repair is not nine repairs. `administers(auth)` asks both facts — what
 * the principal is, and what this token may exercise — and this refuses the
 * comparison it replaced, so the tenth handler cannot be written the old way.
 *
 * Deliberately a source check rather than a test. What is being asserted is
 * that a *shape* does not appear, and a test can only assert about the handlers
 * somebody remembered to write one for — which is the failure this exists to
 * close.
 *
 * ## And the console walked straight past it
 *
 * `packages/admin/src` has been in the roots below since this was written, and
 * the console still shipped the defect: it decided what to offer with
 * `me.role === 'org_admin' || me.role === 'platform_admin'`. The pattern above
 * is bound to `auth.` — correctly, for the reason stated at it — and the
 * console's caller is called `me`, so the one instance this check covers a
 * browser for was the one spelling it could not see.
 *
 * Widening the pattern to any `.role ===` is the obvious repair and is wrong:
 * the People screen legitimately compares `user.role` to render a row and
 * `role.value` to read a `<select>`, and a check that flags those is a check
 * people work around. And the console still reads `me.role` on purpose, to
 * decide which *sentence* to show — `administers: false` cannot tell a member
 * from a platform administrator.
 *
 * So the second question is asked of the one thing that matters: **what
 * `isAdmin` is assigned from.** That is the value the nav filters on, there is
 * exactly one assignment of it, and it has to come from the server's own
 * answer. Reading the assignment rather than the file is the technique
 * `check-platform-admin-target.mjs` had to learn — a whole-file search there
 * was satisfied by the prose describing the rule instead of the rule.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages/api/src', 'packages/mcp/src', 'packages/admin/src']

/** Where `administers` and its companion are defined, and may say the words. */
const DEFINES = ['packages/api/src/auth.ts']

/**
 * A caller's role compared against a role name.
 *
 * Bound to `auth.` on purpose. `users.role` is a column and a request body
 * carries a role to *set* — `fields.role !== 'member'` is validating a value,
 * not gating a request, and refusing that too would make this check something
 * people work around.
 */
const GATE = /\bauth\.role\s*[=!]==\s*['"](org_admin|platform_admin)['"]/g

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path)
  }
}
for (const root of ROOTS) walk(root)

const found = []
for (const file of files) {
  if (DEFINES.includes(file)) continue
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')
  lines.forEach((line, i) => {
    // A comment explaining the rule is not a use of it. The rule itself is
    // stated in prose in several places on purpose.
    if (/^\s*(\/\/|\*)/.test(line)) return
    for (const match of line.matchAll(GATE)) {
      found.push(`${file}:${i + 1}  ${match[0].trim()}`)
    }
  })
}

if (found.length > 0) {
  console.error(
    `::error::${found.length} handler(s) gate on a role name directly. Use ` +
      `administers(auth) or administersTenants(auth) from packages/api/src/auth.ts — ` +
      `a delegation carries a permission ceiling, and a raw comparison ignores it.`,
  )
  for (const line of found) console.error(`  ${line}`)
  process.exit(1)
}

// Not "zero matches" but "the replacements are actually used". A check that
// passes on a tree where nobody administers anything is a check that would pass
// after the gates were deleted.
const uses = files
  .filter((f) => !DEFINES.includes(f))
  .reduce((n, f) => n + (readFileSync(f, 'utf8').match(/\badministers(Tenants)?\(/g) ?? []).length, 0)

if (uses === 0) {
  console.error('::error::no handler asks administers(auth) at all, which cannot be right.')
  process.exit(1)
}

/**
 * The console's nav is filtered on `isAdmin`, and `isAdmin` comes from the
 * server.
 *
 * `GET /v1/me` reports `administers` — the same predicate every gated handler
 * calls — precisely so a browser does not have to derive it. Deriving it is what
 * offered a platform administrator Grants, People and Service accounts, all
 * three of which answer `404` to that role.
 */
const CONSOLE = 'packages/admin/src/index.ts'
const assignments = readFileSync(CONSOLE, 'utf8')
  .split('\n')
  .map((line, i) => ({ line, at: i + 1 }))
  .filter(({ line }) => /^\s*(let |const )?isAdmin\s*=/.test(line) && !/^\s*(\/\/|\*)/.test(line))
  // The declaration's own `= false` is the conservative default, not a source
  // of truth: the nav is drawn as a member until the answer arrives.
  .filter(({ line }) => !/isAdmin\s*=\s*false\s*$/.test(line.trim()))

if (assignments.length === 0) {
  console.error(
    `::error::${CONSOLE} assigns nothing to \`isAdmin\` any more, so this check holds ` +
      'nothing. Either the nav filters on something else — in which case point this at it — ' +
      'or the gate is gone and so should this be.',
  )
  process.exit(1)
}

const derived = assignments.filter(({ line }) => !line.includes('.administers'))
if (derived.length > 0) {
  console.error(
    `::error::${CONSOLE} derives \`isAdmin\` rather than reading it from GET /v1/me. ` +
      '`administers` is the server\'s own predicate; a role comparison here is what offered ' +
      'a platform_admin three screens that answer 404, because that role administers the ' +
      'installation and not this organization.',
  )
  for (const { line, at } of derived) console.error(`  ${CONSOLE}:${at}  ${line.trim()}`)
  process.exit(1)
}

console.log(
  `no role-name gates in ${files.length} file(s); ${uses} use(s) of administers(); ` +
    `the console reads isAdmin from the server in ${assignments.length} place(s)`,
)
