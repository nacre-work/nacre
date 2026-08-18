#!/usr/bin/env node
/**
 * Nothing under `/v1/users` writes a row it has not first asked the role of.
 *
 * `POST /v1/users` and `PATCH /v1/users/{id}` refused to *set* `platform_admin`
 * from the day they were written, on an argument that is right and complete:
 * this surface is scoped to one organization, that role spans all of them, so
 * issuing one here would be an escalation out of the scope doing the issuing.
 *
 * Neither looked at the role it was **replacing**. So an `org_admin` could take
 * a platform administrator who happened to live in their organization and
 * demote them, disable them, delete them, or reset their password — and the
 * last of those is not a demotion at all. It returns the plaintext, so it is a
 * takeover of the account that administers the installation, performed from an
 * endpoint scoped to one tenant.
 *
 * Four spellings of "act on this person", each of which had to remember, with
 * nothing that knew there were four. That is the shape this repository keeps
 * being bitten by, and the response is a check rather than four guards:
 * `PostgresUsers.onTargetUser` reads the row `FOR UPDATE`, refuses a
 * `platform_admin`, and hands the rest to its caller — and this refuses a write
 * that does not go through it.
 *
 * A source check rather than a test, on `check-admin-gate.mjs`'s reasoning: the
 * assertion is that a shape does *not* appear, and a test can only cover the
 * methods somebody remembered to write one for — which is the failure being
 * closed.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages/api/src', 'packages/mcp/src']
const GUARD = 'onTargetUser'

/** Modifying a row that already exists. An INSERT cannot target anybody. */
const WRITE = /\b(UPDATE\s+users\b|DELETE\s+FROM\s+users\b)/i

/**
 * Written exemptions, each with the reason, and each of which has to still
 * match something.
 *
 * A stale entry is a hole that looks like a decision, so this fails on one that
 * no longer applies rather than carrying it — the same rule the SDK's coverage
 * test applies to its two written reasons.
 */
const EXEMPT = [
  {
    file: 'packages/api/src/login.ts',
    // The whole quoted statement, so a clause added to it breaks the match
    // rather than being carried by it. An exemption should be re-argued when
    // the thing it exempts changes, and this is what forces that.
    match: /'UPDATE users SET password_hash = \$1 WHERE id = \$2'/,
    why:
      'the scrypt-parameter rehash of the account that has just proved it knows the password. ' +
      'The principal is acting on its own row inside `whileAuthenticating`, with no caller and ' +
      'no target — there is nobody to guard against, and refusing a platform administrator here ' +
      'would leave that one account pinned at whatever cost its password was first hashed at.',
  },
  {
    file: 'packages/api/src/login.ts',
    // The whole quoted statement, for the reason above. It is deliberately not
    // spelled the same as the rehash a few lines up: two writes matching one
    // exemption is a write nobody argued for, and this check refuses that.
    match: /'UPDATE users SET password_hash = \$3 WHERE org_id = \$1 AND id = \$2'/,
    why:
      'a person changing their own password, having just produced the current one. The row is the ' +
      "caller's own — `userId` comes from the verified token's subject and never from the request " +
      '— so the actor and the target are one principal and there is nobody to escalate over. ' +
      'Refusing a platform administrator here would mean the account that administers the ' +
      'installation is the one account that cannot change its own password, which is the opposite ' +
      'of what this guard is for.',
  },
  {
    file: 'packages/api/src/recovery.ts',
    // The whole quoted statement, for the reason above.
    match: /'UPDATE users SET password_hash = \$2 WHERE id = \$1'/,
    why:
      'redeeming a password reset link. The actor is the person themselves: the only way to reach ' +
      'this statement is to hold a single-use secret that was emailed to the address on that very ' +
      'row, so there is no caller separate from the target and nobody to escalate over. Refusing ' +
      'a platform administrator here would recreate the hole this whole endpoint closes — the ' +
      "account that administers the installation would be the one account that cannot recover " +
      'its own password except through `psql`. The row is addressed by the id the token resolved ' +
      'to and never by one a request named, which is what makes "its own" true rather than ' +
      'claimed.',
  },
]

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.includes('__tests__')) {
      files.push(path)
    }
  }
}
for (const root of ROOTS) walk(root)

let failed = false

/**
 * A class method, by this tree's formatting: two spaces of indentation and a
 * name. Sections rather than brace matching, because SQL lives in template
 * literals and a parenthesis inside one is not a parenthesis in the program.
 *
 * How many sections were found is reported, so a formatting change that defeats
 * the split shows up as a number rather than as a silent pass.
 */
const METHOD = /^ {2}(?:private\s+|public\s+|protected\s+)?(?:async\s+)?[a-zA-Z][A-Za-z0-9_]*\s*[(<]/

/** Split into method-sized pieces. Anything before the first method is one. */
function split(source) {
  const pieces = [[]]
  for (const line of source.split('\n')) {
    if (METHOD.test(line)) pieces.push([])
    pieces[pieces.length - 1].push(line)
  }
  return pieces
}

let sections = 0
let writes = 0
/** The guard's own body, found while walking, and asserted on at the end. */
let guardBody

for (const file of files) {
  const source = readFileSync(file, 'utf8')

  const pieces = split(source)
  // Not `${GUARD}(` — it is generic, so its declaration reads `onTargetUser<T>(`.
  const guard = pieces.find((piece) => new RegExp(`async ${GUARD}\\s*[(<]`).test(piece[0] ?? ''))
  if (guard !== undefined) guardBody = guard.join('\n')

  if (!WRITE.test(source)) continue
  sections += pieces.length
  const exemptions = EXEMPT.filter((rule) => rule.file === file)

  for (const piece of pieces) {
    const text = piece.join('\n')
    if (!WRITE.test(text)) continue
    writes += 1
    if (text.includes(GUARD)) continue
    if (exemptions.some((rule) => rule.match.test(text))) continue

    const header = (piece[0] ?? '').trim()
    console.error(
      `::error file=${file}::\`${header.slice(0, 60)}\` writes an existing \`users\` row without ` +
        `\`${GUARD}\`. That helper is what refuses a platform_admin — a role scoped to the whole ` +
        'installation must not be demoted, disabled, deleted or have its password reset through ' +
        'an endpoint scoped to one organization. Route the write through it, or add a written ' +
        'exemption to this check saying why there is no target to guard.',
    )
    failed = true
  }
}

if (sections === 0) {
  console.error(
    `::error::no method boundary found in ${String(files.length)} file(s); this check compared ` +
      'nothing. The split above depends on this tree\'s formatting, so a change to it has to ' +
      'change this too rather than quietly passing.',
  )
  failed = true
}

if (writes === 0) {
  console.error(
    '::error::no write to an existing `users` row anywhere, which cannot be right — this check ' +
      'would pass just as well with the whole user surface deleted.',
  )
  failed = true
}

/**
 * Every exemption still applies, and each covers **exactly one** write.
 *
 * Both halves are holes, in opposite directions. A rule that matches nothing
 * has gone stale, and an exemption nobody can see the subject of reads as a
 * decision rather than as the leftover it is — the same rule the SDK's coverage
 * test applies to its two written reasons.
 *
 * A rule matching *two* is the one this grew a second exemption to close. The
 * exemptions are keyed by file, so a second method in the same file writing the
 * same statement text is waved through by an argument written about the first
 * one — and the argument is the whole of what an exemption is. Two writes with
 * one reason between them is a write nobody argued for.
 */
for (const rule of EXEMPT) {
  const source = files.includes(rule.file) ? readFileSync(rule.file, 'utf8') : ''
  const matched = split(source).filter((piece) => rule.match.test(piece.join('\n'))).length

  if (matched === 1) continue
  if (matched === 0) {
    console.error(
      `::error file=${rule.file}::the written exemption in this check no longer matches anything. ` +
        `It said: ${rule.why} Delete it, or point it at what replaced the statement — an exemption ` +
        'nobody can see the subject of reads as a decision and is a hole.',
    )
  } else {
    console.error(
      `::error file=${rule.file}::this written exemption covers ${String(matched)} writes and was ` +
        `argued for one. It said: ${rule.why} Give the new one its own entry and its own reason, ` +
        'or route it through the guard — an argument about one statement is not an argument about ' +
        'the next one that happens to be spelled the same.',
    )
  }
  failed = true
}

/**
 * And the guard itself still refuses.
 *
 * Read from the guard's **own body** and not from the file, which is how the
 * first version of this passed while the comparison was commented out to see it
 * fail: `principals.ts` names `'platform_admin'` in `UserView` and in half a
 * dozen sentences of prose, so a whole-file search for the string is satisfied
 * by the documentation of the rule rather than by the rule. Comments are
 * stripped for the same reason.
 *
 * Routing every write through a helper that admits everybody is worse than
 * having no helper at all, because everything above goes on reporting green.
 */
const guardCode = (guardBody ?? '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n')

if (guardBody === undefined || !/===\s*'platform_admin'/.test(guardCode)) {
  console.error(
    `::error::\`${GUARD}\` is not defined, or its body no longer compares a role against ` +
      "'platform_admin'. Every write above routes through it, so a helper that admits everybody " +
      'is worse than no helper at all — nothing else in this check would notice.',
  )
  failed = true
}

if (!failed) {
  console.log(
    `${String(writes)} write(s) to an existing users row across ${String(sections)} section(s), ` +
      `every one through ${GUARD} or a written exemption`,
  )
}
process.exit(failed ? 1 : 0)
