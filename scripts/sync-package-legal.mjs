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
 * Runs as `prepack` so it cannot be forgotten, and as its own lint so CI fails
 * on a stale copy rather than discovering it in a published artifact.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PACKAGES = ['core', 'api', 'mcp', 'sdk']
const FILES = ['LICENSE', 'NOTICE']
const check = process.argv.includes('--check')

let stale = 0
for (const pkg of PACKAGES) {
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
