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

console.log(`no role-name gates in ${files.length} file(s); ${uses} use(s) of administers()`)
