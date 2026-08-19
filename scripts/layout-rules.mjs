/**
 * The four geometry rules the console is held to, as a module two repositories
 * import.
 *
 * These lived inside `screenshots.mjs` until the commercial console needed
 * them. `nacre-enterprise` ships four screens that the *core's* `dom.ts`,
 * `pick.ts` and `admin.css` draw — the whole reason the console has an
 * extension seam rather than a second console — and every layout defect those
 * screens have had was found by building the image and looking at it: a label
 * sitting over the next column's control, a checkbox flush against the label
 * under it, a picker squeezed to `pick a organ` at 390. The rules that catch
 * exactly those were in this repository and reachable only from here.
 *
 * Writing a second copy over there is the defect this architecture exists to
 * avoid, at the largest scale it is available in: **across a boundary where no
 * check can see both sides.** So they move here, the other repository fetches
 * this file at the version its image is built `FROM` — the technique
 * `check-console-contract.mjs` already uses for `extensions.ts` — and there is
 * one statement of what a control owes the thing above it.
 *
 * ## What a rule is
 *
 * `async (page, name, failures) => void`. The sink is an argument and not a
 * module-level array, which is what makes this importable at all: two callers
 * report differently, and a rule that closes over one of them has chosen.
 *
 * Nothing here imports playwright. A rule only ever calls `page.evaluate`, so
 * the caller supplies the browser and this file stays a text file the other
 * repository can fetch and import without installing anything of ours.
 *
 * ## Why `RULES` exists
 *
 * A caller that lists the rules is a caller that forgets the fifth. This
 * repository has written that sentence about six different properties, so the
 * export that matters is the array: a rule added here reaches both consoles on
 * the day it is written, with no edit in a repository this one cannot see.
 */

/*
 * `page.evaluate` serialises its callback and runs it *in the page*, so the
 * browser globals inside those callbacks are real there and absent here.
 * Declared rather than disabled, so a genuine typo in this file is still
 * caught — the same note `screenshots.mjs` carries, and the reason this file
 * needs its own copy is that it is now a file.
 */
/* global document, NodeFilter, getComputedStyle */

/**
 * A dialog whose action you cannot reach is a dialog you cannot finish.
 *
 * `controlHeadroom` beside this asks whether a control has room *above* it.
 * This asks the other question, which no reading of the stylesheet answers: is
 * the thing that completes the dialog on the screen at all.
 *
 * It became worth asking when the enrolment dialog grew a QR code. That dialog
 * now carries a picture, a secret, a link and a field before its Confirm
 * button, and a `<dialog>` scrolls only because the user-agent stylesheet says
 * `overflow: auto` — a `max-height` or an `overflow` written here would take it
 * away, and the visible result is a button nobody can press with nothing in a
 * log. The property is asserted rather than assumed, which is the difference
 * between knowing the browser does it and believing it.
 *
 * The question is asked of the **scrolled** dialog, because "fits on the
 * screen" is not the property. A tall dialog that scrolls is fine; one that
 * neither fits nor scrolls is not, and only scrolling to the end tells them
 * apart. Restored afterwards, or every dialog would be photographed at its
 * bottom.
 *
 * **And whether it scrolls is a second question, because the first one could
 * not fail.** The initial version set `scrollTop` and measured — and
 * `overflow: hidden` still honours a *programmatic* scroll, so restoring that
 * rule on `.dialog` left every button comfortably inside the viewport and the
 * check green. What it had measured was a scroll no thumb and no wheel can
 * perform. That is the narrow-projection defect this repository names three
 * times, produced here inside a check written the same hour. So the computed
 * `overflow-y` is asked of any dialog that overflows at all: `auto` or
 * `scroll`, and anything else is a dialog whose end nobody can reach.
 */
export async function dialogActionsReachable(page, name, failures) {
  const problems = await page.evaluate(() => {
    const found = []
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      const actions = [...dialog.querySelectorAll('.dialog-actions button')]
      if (actions.length === 0) continue

      const overflows = dialog.scrollHeight > dialog.clientHeight + 1
      const overflow = globalThis.getComputedStyle(dialog).overflowY
      if (overflows && overflow !== 'auto' && overflow !== 'scroll') {
        found.push({
          why: `it is ${dialog.scrollHeight}px of content in a ${dialog.clientHeight}px box ` +
            `with overflow-y: ${overflow}, so nothing below the fold can be reached`,
        })
      }

      const was = dialog.scrollTop
      dialog.scrollTop = dialog.scrollHeight
      for (const action of actions) {
        const box = action.getBoundingClientRect()
        if (box.bottom <= globalThis.innerHeight + 0.5 && box.top >= -0.5) continue
        found.push({
          why: `its "${action.textContent.trim().slice(0, 32)}" button ends at ` +
            `${Math.round(box.bottom)}px in a ${globalThis.innerHeight}px viewport with the ` +
            'dialog scrolled to its end',
        })
      }
      dialog.scrollTop = was
    }
    return found
  })

  for (const problem of problems) {
    failures.push(`${name}: this dialog cannot be finished — ${problem.why}`)
  }
}

/**
 * A control flush against whatever is above it is a control you miss.
 *
 * `lint:admin-layout` reads the stylesheet and this is **geometry**, which
 * needs a browser — and this script already opens one on every screen. The
 * instance that made it worth writing: the recovery link sat at **zero pixels**
 * under the Sign in button, because `.hint` carries no top margin and
 * `.btn-block` only a small one, so a mis-tap on a full-width button lands on
 * "forgotten your password".
 *
 * The question is deliberately the general one — for every control, how far is
 * the nearest box that ends above it and overlaps it horizontally — rather than
 * control-against-control. The sibling repository learned that the narrow way
 * round: it compared controls to controls, and the next instance was a control
 * under a *paragraph*, which such a rule cannot see. An ancestor never
 * qualifies, since an ancestor's bottom is below its child's; what qualifies is
 * the heading, paragraph or row the control follows.
 *
 * Eight pixels, which is what the platforms ask for between targets.
 *
 * Scoped to the view and to any open dialog. The masthead is `position: sticky`
 * and overlaps whatever has scrolled under it, so measuring against it would
 * report a distance that is about scrolling rather than about layout.
 */
export const MIN_HEADROOM = 8

/**
 * A column's values are one size.
 *
 * A table is read **down**, so two cells in one column rendering their value at
 * different type sizes read as two different kinds of thing rather than as two
 * values of one. The access log's Result column shipped that way: `allow` at the
 * table's 15px sans, `deny` at 12px mono inside a chip, and `error` at 10px
 * uppercase inside a tag — three sizes for three values of one field, reported
 * by somebody looking at it.
 *
 * The question is per column and not per cell, because that is the comparison a
 * reader makes. What is compared is each cell's **largest** text size, which is
 * the value: a name with a small `sso` badge beside it is a value and an
 * annotation, and the annotation being smaller is the point of it.
 *
 * Empty cells and em-dashes are skipped — a cell with nothing in it has no size
 * to disagree about.
 */
export async function columnValuesAgree(page, name, failures) {
  const wrong = await page.evaluate(() => {
    const found = []
    const roots = [...document.querySelectorAll('dialog[open]')]
    if (roots.length === 0) roots.push(...document.querySelectorAll('.main, .signin'))

    for (const table of roots.flatMap((r) => [...r.querySelectorAll('table')])) {
      const rows = [...table.querySelectorAll('tbody tr')]
      if (rows.length < 2) continue
      const columns = Math.max(...rows.map((r) => r.cells.length))

      for (let i = 0; i < columns; i += 1) {
        const sizes = new Map()
        for (const row of rows) {
          const cell = row.cells[i]
          if (cell === undefined) continue
          const text = (cell.textContent ?? '').trim()
          if (text === '' || text === '\u2014') continue

          // The largest size any text in this cell renders at — the value,
          // rather than a badge annotating it.
          let biggest = 0
          const walk = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
          for (let node = walk.nextNode(); node !== null; node = walk.nextNode()) {
            if ((node.textContent ?? '').trim() === '') continue
            const parent = node.parentElement
            if (parent === null) continue
            const size = Number.parseFloat(getComputedStyle(parent).fontSize)
            if (size > biggest) biggest = size
          }
          if (biggest === 0) continue
          const key = biggest.toFixed(1)
          if (!sizes.has(key)) sizes.set(key, text.slice(0, 24))
        }

        if (sizes.size > 1) {
          const header = table.querySelectorAll('thead th')[i]?.textContent?.trim()
          found.push({
            column: header === undefined || header === '' ? `column ${String(i + 1)}` : header,
            sizes: [...sizes].map(([size, sample]) => `${sample} at ${size}px`),
          })
        }
      }
    }
    return found
  })

  for (const problem of wrong) {
    failures.push(
      `${name}: the "${problem.column}" column renders its values at more than one size — ` +
        `${problem.sizes.join(', ')}. A table is read down, so two sizes in one column read as ` +
        'two kinds of thing rather than as two values of one field.',
    )
  }
}

/**
 * Pills in one column are one width.
 *
 * A chip is a box, and three boxes of three widths down a column read as the
 * values meaning different amounts of something — when all that differs is how
 * many letters each happens to have. The fix is a width taken from the longest
 * value in the set, which is a decision about the set; this asks the browser
 * whether that actually came out, because the width is a `ch` value in a
 * stylesheet and the thing it has to cover is a word in a TypeScript file, with
 * nothing between them.
 *
 * So a status added later that is longer than the width fails here rather than
 * shipping as one pill wider than its neighbours.
 *
 * Only chips are compared, and only against each other: a column mixing a chip
 * with plain text is a different question, and `columnValuesAgree` above is the
 * one that asks it.
 */
export async function columnChipsAgree(page, name, failures) {
  const wrong = await page.evaluate(() => {
    const found = []
    const roots = [...document.querySelectorAll('dialog[open]')]
    if (roots.length === 0) roots.push(...document.querySelectorAll('.main, .signin'))

    for (const table of roots.flatMap((r) => [...r.querySelectorAll('table')])) {
      const rows = [...table.querySelectorAll('tbody tr')]
      if (rows.length < 2) continue
      const columns = Math.max(...rows.map((r) => r.cells.length))

      for (let i = 0; i < columns; i += 1) {
        const widths = new Map()
        for (const row of rows) {
          const cell = row.cells[i]
          if (cell === undefined) continue
          // One chip per cell is what these columns hold; a cell carrying two
          // is a list, and a list is not this rule's subject.
          const chips = cell.querySelectorAll('.chip')
          if (chips.length !== 1) continue
          const chip = chips[0]
          const width = chip.getBoundingClientRect().width
          if (width === 0) continue
          const key = width.toFixed(1)
          if (!widths.has(key)) widths.set(key, (chip.textContent ?? '').trim())
        }

        if (widths.size > 1) {
          const header = table.querySelectorAll('thead th')[i]?.textContent?.trim()
          found.push({
            column: header === undefined || header === '' ? `column ${String(i + 1)}` : header,
            widths: [...widths].map(([width, sample]) => `${sample} at ${width}px`),
          })
        }
      }
    }
    return found
  })

  for (const problem of wrong) {
    failures.push(
      `${name}: the "${problem.column}" column draws its pills at more than one width — ` +
        `${problem.widths.join(', ')}. One width for the set, taken from the longest value: a ` +
        'ragged edge reads as the values meaning different amounts of something.',
    )
  }
}

export async function controlHeadroom(page, name, failures) {
  const tight = await page.evaluate((min) => {
    const visible = (n) => n.getClientRects().length > 0
    /*
     * One root at a time, never across two.
     *
     * A dialog is a layer *over* the page, so a control in it is a few pixels
     * under whatever the page happened to have painted there — the first
     * version reported the New user dialog's Cancel button as five pixels under
     * the users table behind it, which is a fact about stacking and not about
     * layout. What a person sees is one surface at a time, and that is what this
     * measures.
     */
    const roots = [...document.querySelectorAll('dialog[open]')]
    if (roots.length === 0) roots.push(...document.querySelectorAll('.main, .signin'))
    const within = (selector) => roots.flatMap((r) => [...r.querySelectorAll(selector)]).filter(visible)

    const controls = within('button, select, input, textarea, a[href]')
    const boxes = within('*')
    const label = (n) => n.id || n.textContent.trim().slice(0, 32) || n.className || n.tagName.toLowerCase()
    const row = (n) => n.closest('tr')
    const field = (n) => n.closest('label, .field')

    const found = []
    for (const control of controls) {
      const c = control.getBoundingClientRect()
      let nearest = null
      for (const other of boxes) {
        if (other === control || other.contains(control) || control.contains(other)) continue

        /*
         * Three exclusions, and every one of them is an arrangement where being
         * close is the design rather than a defect. Without them this reported
         * thirty things across fourteen screens and named the one real defect
         * among them, which is a check nobody reads.
         *
         * A field's own label. `.field` is `label > span + input`, so the span
         * above the box *is* that box's name — four pixels is what a form looks
         * like, and eight would be a form with gaps in it.
         */
        if (field(control) !== null && field(control) === field(other)) continue
        /*
         * A different row of the same table. Row height is the table's business
         * and `lint:admin-layout` already governs it; the distance between one
         * row's action and the next row's is a property of density, not of
         * whether a control has room.
         */
        if (row(control) !== null && row(other) !== null && row(control) !== row(other)) continue

        const o = other.getBoundingClientRect()
        // Ends above it, and shares some horizontal extent with it. The half
        // pixel is for a border that rounds the other way.
        if (o.bottom > c.top + 0.5) continue
        if (o.right < c.left + 0.5 || o.left > c.right - 0.5) continue
        /*
         * Beside it rather than above it. An inline box on the same line — the
         * text a copy control sits next to — ends a pixel or two above the
         * control's top because the two are baseline-aligned, and reading that
         * as "no headroom" is reading a line box as a stack. What says they are
         * stacked is that the box above spans a real part of the control's
         * width, so a 30px icon beside a sentence does not qualify and a
         * paragraph over a button does.
         */
        const shared = Math.min(o.right, c.right) - Math.max(o.left, c.left)
        if (shared < Math.min(c.width, o.width) * 0.5) continue

        const gap = c.top - o.bottom
        if (nearest === null || gap < nearest.gap) {
          nearest = { gap: Math.round(gap), above: label(other) }
        }
      }
      if (nearest !== null && nearest.gap < min) found.push({ below: label(control), ...nearest })
    }
    return found
  }, MIN_HEADROOM)

  for (const t of tight) {
    failures.push(
      `${name}: "${t.below}" sits ${String(t.gap)}px under "${t.above}". A control needs ` +
        `${String(MIN_HEADROOM)}px of headroom from whatever is above it — flush against it, the ` +
        'thing you meant to press is the thing you miss. This is geometry, so `lint:admin-layout` ' +
        'cannot see it; the margin that is missing is on one of the two.',
    )
  }
}

/**
 * Every rule, so a caller cannot run three of four.
 *
 * The order is the order `shot` called them in, and it is not load-bearing —
 * each reports independently. What is load-bearing is that this array is the
 * only list: `screenshots.mjs` iterates it, and so does the other repository's
 * pass, so neither has a count of its own to go stale.
 */
export const RULES = [
  controlHeadroom,
  dialogActionsReachable,
  columnValuesAgree,
  columnChipsAgree,
]
