#!/usr/bin/env node
/**
 * Two layout rules the admin stylesheet has to keep, each of which was broken
 * in a way no test could see and only a browser at two widths could.
 *
 * ## 1. A flex row aligned on an edge has children with no margin on that edge
 *
 * `align-items: flex-end` aligns **margin** boxes, not border boxes. `.row`
 * used it while `.row > .field` carried `margin-bottom: 12px` and a bare
 * `<button>` in the same row carried none — so every row mixing the two hung
 * the button exactly 12px below the control it stands beside. Measured in
 * Chromium at 1440 and at 390: the selects ended at y=569 and the Add button
 * at y=581. Three rows are that shape and all three looked crooked.
 *
 * Nothing could have caught it. Both rules are individually correct, the class
 * check passes because every class is defined, and eslint does not read CSS.
 * It is visible only as a picture, which is how it was reported.
 *
 * ## 2. A control revealed on hover is revealed some other way where there is
 *    no hover
 *
 * `.idcopy .btn` was `opacity: 0` with `tr:hover` bringing it back. A phone
 * reports `hover: none` and `pointer: coarse` — confirmed by asking a browser
 * rather than by assuming — so the control was invisible with no gesture that
 * revealed it, and the id it copies is truncated on screen by `shortId`. Every
 * id on those screens was unreachable on the device half of them are read on.
 *
 * The repair is a media query, and the check is that the pattern always carries
 * one, because the pattern is idiomatic and the next person to write it will
 * write it the same way.
 *
 * ## What this cannot see
 *
 * Said plainly, because a check that overclaims is the failure this repository
 * keeps writing checks about.
 *
 * It reads declarations, not renderings. A margin arriving from a shorthand it
 * does not expand, a value from a custom property, or a third rule overriding
 * one of these two is outside what it can follow — and no static reader can
 * tell whether a control is *big enough* or a row *looks* straight. Those stay
 * a browser's answer. What this holds is the two specific mistakes that have
 * already been made here, so they cannot be made again silently.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'packages/admin/public/admin.css')
const css = readFileSync(file, 'utf8')

const problems = []

/**
 * Every rule in the file, with the media query it sits inside.
 *
 * The stylesheet is hand-written and flat — rules, and one level of `@media` —
 * so this does not need a parser. If that ever stops being true this returns
 * fewer rules than there are, which would make the check quieter rather than
 * wrong; the count is printed so that is visible.
 */
function rules(text) {
  const source = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  const stack = []
  let prelude = ''

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]
    if (c === '{') {
      const head = prelude.trim()
      prelude = ''
      if (head.startsWith('@')) {
        stack.push(head)
      } else {
        // A rule. Its body runs to the matching close brace, and a rule body
        // contains no nested braces in this stylesheet.
        const end = source.indexOf('}', i)
        out.push({ selector: head, body: source.slice(i + 1, end), media: stack.join(' ') })
        i = end
      }
      continue
    }
    if (c === '}') {
      stack.pop()
      prelude = ''
      continue
    }
    prelude += c
  }
  return out
}

const all = rules(css)

const declaration = (body, property) => {
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i').exec(body)
  return found ? found[1].trim() : null
}
const nonZero = (value) => value !== null && !/^0(?:[a-z%]*)?$/i.test(value)

// ── 1. edge-aligned flex containers ───────────────────────────────────────
const EDGE = { 'flex-end': 'margin-bottom', 'flex-start': 'margin-top' }
const aligned = []
for (const rule of all) {
  if (declaration(rule.body, 'display') !== 'flex') continue
  const align = declaration(rule.body, 'align-items')
  if (align === null || !(align in EDGE)) continue
  for (const selector of rule.selector.split(',').map((s) => s.trim())) {
    aligned.push({ selector, edge: EDGE[align], align })
  }
}

if (aligned.length === 0) {
  console.error(
    '::error::found no `display: flex` rule with `align-items: flex-end` or `flex-start` in ' +
      'admin.css. This check exists to hold their children; if the pattern is gone, say so ' +
      'here rather than leaving a check that passes having looked at nothing.',
  )
  process.exit(1)
}

for (const container of aligned) {
  for (const rule of all) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      // A child or descendant of the aligned container: `.row > .field`,
      // `.row .field`. Not the container itself.
      if (!selector.startsWith(container.selector + ' ')) continue
      const value = declaration(rule.body, container.edge)
      if (nonZero(value)) {
        problems.push(
          `\`${selector}\` sets \`${container.edge}: ${value}\` inside \`${container.selector}\`, ` +
            `which aligns on \`${container.align}\`. That aligns margin boxes, so this child's ` +
            `control ends ${value} above every sibling in the row that carries no such margin — ` +
            'the crooked-button defect. Put the spacing on the row instead.',
        )
      }
    }
  }
}

// ── 2. hover-revealed controls ────────────────────────────────────────────
const hidden = all.filter((r) => declaration(r.body, 'opacity') === '0')
const revealed = all.filter(
  (r) => r.selector.includes(':hover') && nonZero(declaration(r.body, 'opacity')),
)

for (const rule of revealed) {
  if (/\(\s*hover\s*:\s*hover\s*\)/.test(rule.media)) continue
  problems.push(
    `\`${rule.selector}\` brings a control back from \`opacity: 0\` on hover and does not sit ` +
      'inside an `@media (hover: hover)` block. A phone reports `hover: none`, so on a phone ' +
      'that control is invisible with no gesture that reveals it.',
  )
}

// The other half of the same rule: hiding without a matching reveal.
for (const rule of hidden) {
  if (/\(\s*hover\s*:\s*hover\s*\)/.test(rule.media)) continue
  const hasReveal = revealed.some((r) => r.selector.includes(rule.selector.split(/[\s,]/)[0]))
  if (hasReveal) {
    problems.push(
      `\`${rule.selector}\` is \`opacity: 0\` outside an \`@media (hover: hover)\` block and is ` +
        'brought back by a `:hover` rule. Where there is no hover it never comes back.',
    )
  }
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} problem(s) in ${file}.\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(all.length)} rules read: ${String(aligned.length)} edge-aligned flex container(s) ` +
    `whose children carry no margin on that edge, and ${String(revealed.length)} hover-revealed ` +
    'control(s), each behind a hover media query.\n',
)
