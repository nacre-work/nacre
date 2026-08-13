#!/usr/bin/env node
/**
 * Every audit event names what it was about.
 *
 * `docs/audit.md` is normative and says so — "every event carries `surface` …
 * and a `target` naming what it was about" — and the schema builds a
 * `gin (target)` index on exactly that, so it is the field an investigation
 * searches. `detail` is the other half: measurements and reasons, the
 * `query_hash`, the `latency_ms`, why a refusal was a refusal.
 *
 * **Twenty-three of thirty-five call sites wrote only `detail`.** Every
 * document path filled `target`; every administrative one — `create_user`,
 * `disable_user`, `reset_password`, `create_group`, `add_group_member`,
 * `create_service_account`, `revoke_service_account`, `issue_grant` — put the
 * object in `detail` and left `target` empty. So the log recorded *that* an
 * administrator reset a password and never *whose*, in the field built to
 * answer that, and the index covered none of it.
 *
 * Found by reading the log through `nacre audit` against a running API, which
 * is the only way it could be found: each handler is individually correct, the
 * column has a default, and an empty object is not an error at any layer.
 *
 * The shape is the usual one — a property that has to hold at N call sites with
 * nothing that knows N — so this is the repair rather than the twenty-three
 * edits. A `target` that is present and empty is the same defect with extra
 * steps, so `{}` is refused too.
 */
import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'

const FILES = globSync('packages/*/src/**/*.ts', { exclude: (p) => p.includes('__tests__') })

let failed = false
let checked = 0

for (const file of FILES) {
  const source = readFileSync(file, 'utf8')
  const lines = source.split('\n')

  for (const [index, line] of lines.entries()) {
    if (!/audit\.write\(\{/.test(line)) continue

    // The object literal, by brace depth. A regex over the whole call would
    // have to know about nested objects, and `detail` has them.
    let depth = 0
    const block = []
    for (let i = index; i < lines.length; i += 1) {
      const at = lines[i]
      block.push(at)
      depth += (at.match(/\{/g) ?? []).length - (at.match(/\}/g) ?? []).length
      if (depth <= 0 && i > index) break
    }

    checked += 1
    const text = block.join('\n')
    const action = /action: '([^']+)'/.exec(text)?.[1] ?? 'an event'
    const target = /target: (\{[^}]*\}|\{)/.exec(text)

    if (target === null) {
      console.error(
        `::error file=${file},line=${index + 1}::${action} writes no \`target\`. ` +
          'docs/audit.md says every event names what it was about, and the schema indexes ' +
          'that field — an event without one is invisible to the question the log exists for.',
      )
      failed = true
      continue
    }

    if (target[1] === '{}') {
      console.error(
        `::error file=${file},line=${index + 1}::${action} writes an empty \`target\`. ` +
          'Present and empty is the same defect as absent: name the object.',
      )
      failed = true
    }
  }
}

if (checked === 0) {
  console.error('::error::no audit.write call sites found at all; this check compared nothing')
  failed = true
}

if (!failed) console.log(`${String(checked)} audit event(s), every one naming its target`)
process.exit(failed ? 1 : 0)
