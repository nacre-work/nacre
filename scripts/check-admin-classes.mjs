#!/usr/bin/env node
/**
 * Every class the admin UI puts on an element is one the stylesheet defines.
 *
 * The consent screen shipped using `.choice` and `.field-group` — six elements
 * across one file — and neither existed in `admin.css`. Nothing failed. A
 * `<label>` with no rule is `display: inline`, so the permission checkboxes ran
 * together across the line instead of stacking, and the two `<p class="hint">`
 * elements that were standing in for group labels rendered as loose sentence
 * fragments: "It may" on its own line, "In these layers" on another.
 *
 * That is the fourth defect on this screen found by looking at a screenshot,
 * and it is the only one of the four a machine could have found first. A class
 * name is a contract between two files with nothing between them: TypeScript
 * sees a string, CSS sees a selector, and a typo or an unwritten rule is
 * invisible to the compiler, to eslint, and to every test — the page still
 * renders, just wrongly.
 *
 * So: the set of classes emitted by `packages/admin/src` must be a subset of
 * the classes `public/admin.css` defines.
 *
 * ## What it cannot see
 *
 * Stated rather than hidden, because a check that overclaims is the failure
 * this repository keeps writing checks about.
 *
 * A fully computed class — `` `status ${ok ? 'up' : 'down'}` `` — has a literal
 * head (`status`, checked) and a tail this does not evaluate. Where the
 * interpolation is a *suffix* of a literal stem, as in `` `chip chip-${…}` ``,
 * the stem is checked as a prefix: some `.chip-…` rule must exist. Where the
 * whole token is an interpolation, there is nothing to assert and it is
 * skipped.
 *
 * It also does not check the other direction. An unused rule in a stylesheet is
 * dead weight; an undefined class is a broken screen, and only the second is
 * worth failing a build over.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = 'packages/admin/src'
const STYLESHEET = 'packages/admin/public/admin.css'

/** Classes that live in `index.html` rather than in a view. */
const FROM_HTML = 'packages/admin/public/index.html'

// ─── What the stylesheet defines ──────────────────────────────────────────

let css
try {
  css = readFileSync(STYLESHEET, 'utf8')
} catch {
  console.error(`::error::${STYLESHEET} is missing; this check cannot run`)
  process.exit(1)
}

// Comments first: a selector inside one is not a rule, and this repository has
// several blocks of commented-out CSS explaining what was tried.
const declared = new Set()
for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([A-Za-z][\w-]*)/g)) {
  declared.add(match[1])
}

if (declared.size === 0) {
  console.error(`::error file=${STYLESHEET}::no class selector found; that is not a pass`)
  process.exit(1)
}

// ─── What the views emit ──────────────────────────────────────────────────

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path)
  }
}
walk(SOURCE)
files.push(FROM_HTML)

/**
 * The three ways a class reaches an element here.
 *
 * `h(tag, { class: … })` is the overwhelming majority; `className =` is how the
 * message line and the status dot are re-set; `classList` is not used today and
 * is matched anyway, because the point of this check is the case nobody
 * remembered.
 */
const SITES = [
  /\bclass:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g,
  /\bclassName\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g,
  /\bclassList\.(?:add|remove|toggle)\(\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g,
  // index.html, which is not TypeScript.
  /\bclass=(["'])([^"']*)\1/g,
]

/**
 * Split a class attribute into tokens, treating `${…}` as one opaque character.
 *
 * Splitting on whitespace first is wrong and was wrong when this was written:
 * `${effect === 'deny' ? 'deny' : permission}` contains four spaces, so a plain
 * split reported `===` and `?` as undefined classes. The interpolation is
 * collapsed to a marker, and what survives is the literal text around it.
 */
const HOLE = '\u0000'

const tokenize = (raw) => {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '$' && raw[i + 1] === '{') {
      let depth = 1
      i += 2
      while (i < raw.length && depth > 0) {
        if (raw[i] === '{') depth += 1
        else if (raw[i] === '}') depth -= 1
        i += 1
      }
      i -= 1
      out += HOLE
      continue
    }
    out += raw[i]
  }
  return out.split(/\s+/).filter(Boolean)
}

let failed = false
let emitted = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')

  for (const pattern of SITES) {
    for (const match of source.matchAll(pattern)) {
      const line = source.slice(0, match.index).split('\n').length
      // A comment describing a class is not a use of one. Several of these
      // files explain in prose which class does what.
      if (/^\s*(\/\/|\*)/.test(lines[line - 1] ?? '')) continue

      for (const token of tokenize(match[2])) {
        const interpolation = token.indexOf(HOLE)
        if (interpolation === 0) continue // nothing literal to assert on

        emitted += 1
        if (interpolation === -1) {
          if (declared.has(token)) continue
          console.error(
            `::error file=${file},line=${line}::class "${token}" is not defined in ` +
              `${STYLESHEET}. An element with no rule still renders — a label is inline, ` +
              'a group has no gap — so nothing fails and the screen is wrong.',
          )
          failed = true
          continue
        }

        const stem = token.slice(0, interpolation)
        if ([...declared].some((name) => name.startsWith(stem))) continue
        console.error(
          `::error file=${file},line=${line}::no class in ${STYLESHEET} starts with "${stem}", ` +
            `so every value of "${token}" names a rule that does not exist.`,
        )
        failed = true
      }
    }
  }
}

if (emitted === 0) {
  console.error(`::error::no class found in ${SOURCE}; this check compared nothing`)
  process.exit(1)
}

if (!failed) console.log(`${emitted} class uses, all defined in ${STYLESHEET}`)
process.exit(failed ? 1 : 0)
