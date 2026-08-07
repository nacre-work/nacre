#!/usr/bin/env node
/**
 * Every collection this system creates goes through `collectionConfig`.
 *
 * That function existed and **one** of the three `createCollection` calls used
 * it. The reindex copy and the slot-adding copy each spelled the same object
 * out inline — `vectors`, `sparse_vectors`, `optimizers_config`,
 * `on_disk_payload` — so "the collection layout, in one place" was true of the
 * name and of a third of the collections.
 *
 * It became visible when shard count and replication factor were added, since
 * those are **fixed at creation**: a field added to the one place would have
 * reached an organization's first collection and neither of the copies, so a
 * cluster's second collection would silently be shaped like a single node's,
 * and the only repair is copying every point again.
 *
 * The shape is the one this repository keeps re-deriving: a property that has
 * to hold in N places, with nothing that knows N. So the repair is not three
 * edits — it is this.
 *
 * Deliberately a source check rather than a test. What is asserted is that a
 * *call shape* does not appear, and a test can only assert about the creations
 * somebody remembered to write one for.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages/core', 'packages/api/src', 'packages/worker/src', 'packages/mcp/src']

const files = []
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    // A fixture building a collection is not this system creating one for a
    // deployment: it is asserting about a shape it chose, and forcing it
    // through the production builder would make the test agree with whatever
    // that builder does — which is the thing under test.
    if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path)
    else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) files.push(path)
  }
}
for (const root of ROOTS) walk(root)

let failed = false
let checked = 0

for (const file of files) {
  const source = readFileSync(file, 'utf8')
  let from = 0
  for (;;) {
    const at = source.indexOf('createCollection(', from)
    if (at === -1) break
    from = at + 1

    // A comment naming the call is not a call. Several of these files explain
    // in prose why the collection cannot be altered in place.
    const lineStart = source.lastIndexOf('\n', at) + 1
    const line = source.slice(lineStart, source.indexOf('\n', at))
    if (/^\s*(\/\/|\*)/.test(line)) continue
    // `createPayloadIndex` and friends do not end in this name; the guard is
    // against a method whose name merely contains it.
    if (/[A-Za-z]/.test(source[at - 1] ?? '') && !source.slice(0, at).endsWith('.')) continue

    checked += 1

    // The arguments, to the matching close paren. Balanced rather than greedy:
    // the config is an object literal full of braces and commas.
    let depth = 0
    let end = at + 'createCollection('.length - 1
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1
      else if (source[end] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    const args = source.slice(at, end + 1)
    if (args.includes('collectionConfig(')) continue

    const lineNo = source.slice(0, at).split('\n').length
    console.error(
      `::error file=${file},line=${lineNo}::a collection is created without collectionConfig(). ` +
        'Shard count and replication factor are fixed at creation, so a collection built ' +
        'from an inline literal is shaped differently from every other one and can only be ' +
        'reshaped by copying every point. Build the config with collectionConfig().',
    )
    failed = true
  }
}

// Zero calls means this stopped looking at the code that creates collections —
// a rename, a move, a root removed from the list above. Silence is not a pass.
if (checked === 0) {
  console.error(`::error::no createCollection call found under ${ROOTS.join(', ')}; this check compared nothing`)
  process.exit(1)
}

if (!failed) console.log(`${checked} collection creation(s), all through collectionConfig()`)
process.exit(failed ? 1 : 0)
