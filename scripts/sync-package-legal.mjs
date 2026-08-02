/**
 * Copy LICENSE and NOTICE into every publishable package.
 *
 * Apache 2.0 asks for both in anything you redistribute — §4(a) for the licence
 * and §4(d) for the NOTICE — and `docs/licensing.md` tells redistributors to
 * keep them. npm only picks those files up from a package's own root, so a
 * workspace that keeps one copy at the repository root ships neither: all four
 * published tarballs contained `README.md`, `dist/` and `package.json` and
 * nothing else.
 *
 * Copies rather than symlinks, because `npm pack` follows a symlink out of the
 * package directory and drops it.
 *
 * `--check` is a lint, and it is what enforces this: it runs on every pull
 * request and again in the release, so a missing copy fails the change that
 * caused it. It is deliberately not a `prepack` hook — a hook would write the
 * files during packing, which turns a licensing requirement into a side effect
 * of the release and hides the omission from the pull request that made it.
 * The header used to claim it ran as `prepack`. Nothing in this repository
 * declared one.
 *
 * Which packages need them comes from `publishable.mjs`, not from a list here.
 * A list here goes stale silently the moment a package changes side, and the
 * way it goes stale is that a newly public package ships with no LICENSE and no
 * NOTICE — which Apache 2.0 §4(a) and §4(d) do not permit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { publishable } from './publishable.mjs'

const FILES = ['LICENSE', 'NOTICE']
const check = process.argv.includes('--check')

let stale = 0
for (const { dir: pkg } of publishable()) {
  for (const file of FILES) {
    const source = readFileSync(file, 'utf8')
    const target = join('packages', pkg, file)
    const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined

    if (current === source) continue
    if (check) {
      console.error(`::error::packages/${pkg}/${file} is ${current === undefined ? 'missing' : 'stale'}`)
      stale++
      continue
    }
    writeFileSync(target, source)
    console.log(`wrote packages/${pkg}/${file}`)
  }
}

if (stale > 0) {
  console.error(`\n${stale} file(s) out of date. Run: pnpm sync:legal`)
  process.exit(1)
}
console.log(check ? 'LICENSE and NOTICE present in every publishable package' : 'done')
