#!/usr/bin/env node
/**
 * Bundle the admin UI into a directory nginx can hand out.
 *
 * esbuild, and only because a browser cannot resolve `@nacre.work/sdk` from a
 * bare specifier. There is no framework, no CSS pipeline, and no transform
 * beyond bundling and minification — the output is one ES module and one
 * stylesheet, which is what makes this shippable as static files rather than as
 * an application to deploy.
 *
 * The stylesheet is copied rather than processed. It reads the brand tokens at
 * runtime through custom properties, so anything that resolved them at build
 * time would freeze the palette into the bundle and break the point of having
 * one file downstream of the brand repository.
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = `${root}dist`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

// public/ first, so a stale app.js from a previous run cannot survive.
cpSync(`${root}public`, out, { recursive: true })

const result = await esbuild.build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${out}/app.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  // The SDK is bundled in rather than left external: this is a static
  // directory, not a package, and a bare import would not resolve in a browser.
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)
console.log(`admin: dist/ built, ${(bytes / 1024).toFixed(1)} kB of JavaScript`)
