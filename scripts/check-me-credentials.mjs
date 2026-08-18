#!/usr/bin/env node
/**
 * Every `/v1/me` route that touches a credential asks whether this principal
 * holds its own.
 *
 * Three classes must not: a **service account**, which is a key with nobody to
 * carry an authenticator; a **delegation**, which is a third party acting for
 * somebody and was not approved to change how they sign in; and a **shared
 * account**, a credential more than one person holds — a published demo login
 * — where there is no "the person" and the first holder to enrol a factor locks
 * out every other one *permanently*, because an administrator deliberately
 * cannot remove somebody's second factor.
 *
 * That was live on a public stand. The two demo logins printed on the front
 * door could each enrol a factor and change their own password, which is the
 * password on the page.
 *
 * Two things already hold it structurally — a trigger on `user_second_factors`
 * and a refusal inside `Login.changePassword` — so a route that forgets is a
 * `500` rather than a lockout. This is about the third thing: answering the
 * `404` a caller can read, on every route of that surface rather than the two
 * that exist today. A property that has to hold in N places with nothing that
 * knows N is this repository's most repeated defect.
 *
 * It **discovers** the routes rather than listing them, so the next one is
 * covered on the day it is written, and refuses outright if it finds none —
 * a check with nothing to hold must not report green.
 *
 * ## And the other half: whatever publishes a credential marks it
 *
 * The routes being right is worth nothing if the account was never marked. The
 * `demo` profile is this repository's own publisher — `docker/demo/seed.sh`
 * prints logins for anybody to use — so every account it creates has to carry
 * `--shared`. One written today and a third one added next year are the same
 * requirement, and only a check knows that.
 */
import { readFileSync } from 'node:fs'

const FILE = 'packages/api/src/server.ts'
const PREDICATE = 'holdsOwnCredentials'

/**
 * A `/v1/me` path that is about a credential.
 *
 * `/v1/me` itself is excluded by name: it reports who the caller is, and it
 * *answers* the predicate rather than being gated on it. Anything else under
 * `/v1/me/` is a credential surface until somebody adds one that is not, and
 * that person should be made to say so here.
 */
const IDENTITY_ONLY = new Set(["'/v1/me'"])

const source = readFileSync(FILE, 'utf8')

// The route blocks, as the dispatcher writes them: a comparison or a prefix
// test against a `/v1/me…` literal that opens a block.
const routes = [...source.matchAll(/instance (?:===|\.startsWith\()\s*('\/v1\/me[^']*')/g)].map(
  (m) => ({ literal: m[1], at: m.index ?? 0 }),
)

const credential = routes.filter((r) => !IDENTITY_ONLY.has(r.literal))
const paths = [...new Set(credential.map((r) => r.literal))]

if (paths.length === 0) {
  console.error(
    `::error::${FILE} has no /v1/me credential route. This check has nothing to hold, which ` +
      'means either the surface moved or the pattern stopped matching it — and a check that ' +
      'cannot check must not report green.',
  )
  process.exit(1)
}

/*
 * A route "asks" when the predicate is called within its block.
 *
 * Bounded by the next route comparison rather than by brace counting, which is
 * what a hand-written parser gets wrong on a file this size: the question is
 * only ever "between this route's test and the next one".
 */
const starts = routes.map((r) => r.at).sort((a, b) => a - b)
const problems = []
for (const literal of paths) {
  const asks = credential
    .filter((r) => r.literal === literal)
    .some((r) => {
      const next = starts.find((s) => s > r.at) ?? source.length
      return source.slice(r.at, next).includes(PREDICATE)
    })
  if (!asks) problems.push(literal)
}

if (problems.length > 0) {
  console.error(
    `::error::${problems.join(', ')} under /v1/me touches a credential and never asks ` +
      `${PREDICATE}(). A service account, a delegation and a shared account must all get a 404 ` +
      'there — a shared credential whose holder can enrol a second factor locks out every other ' +
      'holder, and no administrator can undo it.',
  )
  process.exit(1)
}

/*
 * Every account the demo seed creates is published, so every one is shared.
 *
 * Matched on the command rather than on a count: a third identity added to that
 * loop, or beside it, is the case this exists for, and a check that knew there
 * were two would pass the day there are three.
 */
const SEED = 'docker/demo/seed.sh'
const seed = readFileSync(SEED, 'utf8')
const creates = [...seed.matchAll(/\$CLI users create[^\n]*/g)].map((m) => m[0])

if (creates.length === 0) {
  console.error(
    `::error::${SEED} creates no user. This half of the check has nothing to hold — either the ` +
      'seed stopped publishing logins, in which case say so here, or the command it uses changed.',
  )
  process.exit(1)
}

const unmarked = creates.filter((line) => !line.includes('--shared'))
if (unmarked.length > 0) {
  console.error(
    `::error::${SEED} creates an account without --shared: ${unmarked.join(' | ')}. Its password ` +
      'is printed for anybody to use, so the first visitor to enrol a second factor on it locks ' +
      'out every other one — and no administrator can undo that.',
  )
  process.exit(1)
}

/*
 * "call site" and not "account": that loop runs once per identity, so counting
 * the lines and calling them accounts is a number that reads as a fact and is
 * not one. The check is right either way — every call site carries the flag, so
 * every account it makes does — but a summary somebody reads has to say what it
 * counted.
 */
console.log(
  `${paths.length} /v1/me credential route(s) — ${paths.join(', ')} — each ask ${PREDICATE}(), ` +
    `and all ${creates.length} \`users create\` call site(s) in ${SEED} pass --shared.`,
)
