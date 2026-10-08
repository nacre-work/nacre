#!/usr/bin/env node
/**
 * Bundle the three MCP App views into single HTML files.
 *
 * A view is served by `resources/read` and rendered by a host in a sandboxed
 * iframe whose CSP admits no script from anywhere unless the resource names
 * an origin — so the page has to carry its script inline, and the script has
 * to carry `@modelcontextprotocol/ext-apps` inside it. esbuild does the one
 * thing needed: resolve the bare imports and write one file per view. No
 * framework, no CSS pipeline; the stylesheet is a string in `shared.ts`.
 *
 * Output goes to `apps/build/`, which is where `factory.ts` reads from — both
 * as `src/factory.ts` under the test runner and as `dist/factory.js` in the
 * published package, because the path is resolved relative to the module and
 * both sit one directory below the package root.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}apps/build`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const views = readdirSync(`${root}apps`).filter((f) => f.endsWith('.ts') && f !== 'shared.ts')
if (views.length === 0) throw new Error('no views under apps/; this build wrote nothing')

for (const view of views) {
  const name = view.replace(/\.ts$/, '')
  const result = await esbuild.build({
    entryPoints: [`${root}apps/${view}`],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    minify: true,
    legalComments: 'none',
  })
  const script = result.outputFiles[0].text
  // `</script` inside the bundle would end the element early; esbuild emits
  // none, and the check is cheaper than the surprise.
  if (script.includes('</script')) throw new Error(`${view}: the bundle contains "</script"`)
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nacre — ${name}</title>
</head>
<body>
<script>${script}</script>
</body>
</html>
`
  writeFileSync(`${out}/${name}.html`, html)
  console.log(`apps: ${name}.html, ${(html.length / 1024).toFixed(1)} kB`)
}
