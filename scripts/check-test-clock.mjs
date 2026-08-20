#!/usr/bin/env node
/**
 * A test that reads the wall clock is a test that can disagree with itself.
 *
 * **This exists because it cost a release.** `second-factor-live.test.ts` called
 * `totpStep()` six times across one case — once to confirm a code, once to sign
 * in, once to replay — and a TOTP step is thirty seconds while the case takes
 * two. So roughly one run in fifteen crossed a boundary between the second read
 * and the third, computed a code for a step that had never been spent, and
 * watched the server correctly accept it. The assertion said "a spent code is
 * refused"; what it asked was "these three clock reads landed in the same
 * window".
 *
 * It was green on the pull request and red on the merge that **was** the
 * release: nothing published, nothing tagged, four images unbuilt.
 *
 * ## What this checks, and what it deliberately does not
 *
 * The subject is **discovered, not listed**: every export whose instant defaults
 * to `new Date()`. There is one today and naming it would make this a check
 * about `totpStep` rather than about the property, so the next helper written
 * that way is covered on the day it exists rather than on the day somebody
 * remembers this file.
 *
 * Inside a test, such a function must be called with an explicit instant. A
 * default that reads the clock is right for production — a caller who has no
 * opinion about the time means now — and wrong in a test, where two calls are
 * two different times and the assertion is usually about them being one.
 *
 * It does **not** ban `new Date()` or `Date.now()` in tests, and that restraint
 * is the point. Twenty of the twenty-five clock reads in this suite are an
 * expiry sixty seconds out used within milliseconds, or a `Date.now()` making a
 * unique name — flagging those would be a check reporting twenty things and
 * naming none of them, which is the shape this repository keeps deleting. The
 * hazard is a *window* narrow enough for a test to cross, and no static rule can
 * see the ratio between a window and a duration. `scripts/flake-hunt.mjs` is
 * what covers that, by running the suite until something falls over.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const problems = []

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const files = walk('packages')
const sources = files.filter((f) => !f.includes('__tests__'))
const tests = files.filter((f) => f.includes('__tests__') && f.endsWith('.test.ts'))

/*
 * Anything exported as `(at: Date = new Date())`. The parameter's name is not
 * assumed — `at`, `now` and `when` are all somebody's word for the same thing.
 */
const clocked = new Set()
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(
    /export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)\s*=?\s*\(?\s*\w+\s*:\s*Date\s*=\s*new Date\(\)/g,
  )) {
    clocked.add(match[1])
  }
}

// A check with nothing to hold must not report green.
if (clocked.size === 0) {
  console.error(
    '::error::no export takes an instant defaulting to `new Date()`. Either the shape changed and ' +
      'this check now covers nothing, or the pattern is gone and this file should be too — ' +
      'either way it must not pass having looked for something that is not there.',
  )
  process.exit(1)
}

for (const file of tests) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  for (const name of clocked) {
    // `name()` with nothing between the brackets — and `name(new Date())` and
    // `name(Date.now())`, which are the same wall-clock read spelled to get
    // past a check that only refused the empty parens. The property is that
    // the instant is a value pinned outside the call, and an inline
    // constructor is not one: two such calls are still two times. A comment
    // mentioning any of these is prose, and prose is how the first version of
    // another check here passed on the documentation of a rule instead of the
    // rule — so the line has to be code, which for these files means not
    // starting with `*` or `//`.
    const bare = new RegExp(`\\b${name}\\(\\s*(new\\s+Date\\(\\s*\\)|Date\\.now\\(\\s*\\))?\\s*\\)`)
    lines.forEach((line, index) => {
      const code = line.trim()
      if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return
      if (!bare.test(line)) return
      problems.push(
        `${file}:${String(index + 1)}: \`${name}()\` reads the wall clock. In a test it takes an ` +
          'explicit instant, because two calls are two times and the assertion is usually about ' +
          'them being one — this is what failed the 0.19.0 release.',
      )
    })
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}

console.log(
  `${String(tests.length)} test file(s), and none calls any of ` +
    `${[...clocked].map((n) => `\`${n}()\``).join(', ')} without saying when.`,
)
