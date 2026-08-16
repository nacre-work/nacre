#!/usr/bin/env node
/**
 * Three layout rules the admin console has to keep, each of which was broken in
 * a way no test could see and only a browser at two widths could.
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
 * ## 3. A value that is one thing does not wrap
 *
 * "204 days ago" is three words and one value, and a table cell will break it
 * across three lines. Measured in Chromium at 390: a People row carrying that
 * string was 89px while the rows beside it, reading "7 days ago" and "1 day
 * ago", were 66px — and all three are 58px with the rule. The action column had
 * already been fixed for the same reason, which is what makes this the second
 * instance rather than the first, and `agoCell` is where the property lives now
 * rather than in five call sites that each had to remember.
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
 * a browser's answer. What this holds is the three specific mistakes that have
 * already been made here, so they cannot be made again silently.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'packages/admin/public/admin.css')
const VIEWS = join(root, 'packages/admin/src/views')
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

/**
 * Every edge-aligned container zeroes that edge on **all** its children.
 *
 * This is the rule that actually holds the property, and the first version of
 * this check did not have it. It looked for a rule whose *selector* carried a
 * non-zero margin under the container — which catches `.row > .field {
 * margin-bottom: 12px }`, the spelling the fix removed, and not the state the
 * file was one deletion away from: the margin lives on a bare `.field`, and
 * only the cancellation kept it off. Deleting one line restored the crooked
 * buttons and this check stayed green. A check that goes green on the defect it
 * was written for is worse than no check.
 *
 * Naming the class in the cancellation has the same hole one step later: the
 * next child class with a margin reintroduces it with nothing failing. `> *`
 * has no such gap, so that is what is required.
 */
for (const container of aligned) {
  const reset = all.some(
    (rule) =>
      rule.selector
        .split(',')
        .map((s) => s.trim())
        .includes(`${container.selector} > *`) &&
      declaration(rule.body, container.edge) !== null &&
      !nonZero(declaration(rule.body, container.edge)),
  )
  if (!reset) {
    problems.push(
      `\`${container.selector}\` aligns on \`${container.align}\` and has no ` +
        `\`${container.selector} > * { ${container.edge}: 0 }\`. That alignment is on margin ` +
        'boxes, so any child carrying a margin on that edge sits that far off every sibling ' +
        'that does not — the crooked-button defect. Reset it for every child rather than for ' +
        'the classes that happen to be in there today.',
    )
  }

  for (const rule of all) {
    for (const selector of rule.selector.split(',').map((s) => s.trim())) {
      // A descendant rule can out-specify the `> *` reset: `.row .pick`
      // (0,2,0) beats `.row > *` (0,1,0). So the reset is necessary and this
      // is what makes it sufficient.
      if (!selector.startsWith(container.selector + ' ')) continue
      const value = declaration(rule.body, container.edge)
      if (nonZero(value)) {
        problems.push(
          `\`${selector}\` sets \`${container.edge}: ${value}\` inside \`${container.selector}\`, ` +
            `which aligns on \`${container.align}\`, and out-specifies the \`> *\` reset. That ` +
            `aligns margin boxes, so this child's control ends ${value} above every sibling ` +
            'carrying no such margin — the crooked-button defect. Put the spacing on the ' +
            'container instead.',
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

// ── 3. a value that is one thing does not wrap ────────────────────────────
//
// "204 days ago" is three words and one value, and a table cell will break it
// across three lines. Measured in Chromium at 390: a People row carrying that
// string was 89px while the rows beside it, reading "7 days ago" and "1 day
// ago", were 66px — and every one of them is 58px with the rule. The action
// column had already been fixed for the same reason on `.right`, which is what
// makes this the second instance rather than the first.
//
// `ago()` is rendered into a `<td>` in three views and five places, so the
// property had to be remembered five times with nothing that knew there were
// five. `agoCell` is where it is written now, and this asks two things: that
// the class it writes actually nowraps, and that no view builds such a cell by
// hand.
const AGO_CELL = '.table td.ago'
const agoRule = all.find((r) =>
  r.selector.split(',').map((x) => x.trim()).includes(AGO_CELL),
)
if (agoRule === undefined) {
  problems.push(
    `admin.css has no \`${AGO_CELL}\` rule. \`agoCell\` writes that class on every relative time ` +
      'in a table and this check holds it; with no rule to read it must not report green.',
  )
} else if (declaration(agoRule.body, 'white-space') !== 'nowrap') {
  problems.push(
    `\`${AGO_CELL}\` does not say \`white-space: nowrap\`. A relative time is three words and one ` +
      'value, and without it the oldest row in every table is a third taller than the rest.',
  )
}

// And the other half: a cell built by hand rather than through the helper.
const views = readdirSync(VIEWS).filter((name) => name.endsWith('.ts'))
if (views.length === 0) {
  problems.push(
    'no view sources under packages/admin/src/views — this half of the check reads them, and ' +
      'with none to read it is asking nothing.',
  )
}
for (const view of views) {
  const source = readFileSync(join(VIEWS, view), 'utf8')
  source.split('\n').forEach((line, index) => {
    if (!/h\(\s*'td'[\s\S]{0,80}?\bago\(/.test(line)) return
    problems.push(
      `packages/admin/src/views/${view}:${String(index + 1)} builds a relative-time cell by hand. ` +
        '`agoCell` is the one that carries the class which stops "204 days ago" wrapping to three ' +
        'lines — five call sites had to remember before it existed.',
    )
  })
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`::error::${problem}\n`)
  // Not "in admin.css": rule 3 reads the views too, and a footer naming one
  // file for a problem in another sends the reader to the wrong place.
  process.stderr.write(`\n${String(problems.length)} problem(s) in the admin console's layout.\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(all.length)} rules read: ${String(aligned.length)} edge-aligned flex container(s) ` +
    `whose children carry no margin on that edge, ${String(revealed.length)} hover-revealed ` +
    `control(s) each behind a hover media query, and ${AGO_CELL} nowrapping every relative ` +
    `time across ${String(views.length)} view(s), none of which builds one by hand.\n`,
)
