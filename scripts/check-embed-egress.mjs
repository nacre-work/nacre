#!/usr/bin/env node
/**
 * Every fetch to a model endpoint refuses redirects.
 *
 * The egress guard on `POST /v1/embedding-providers` stops a tenant *naming* an
 * internal host. It does not, by itself, stop the worker or the search path
 * *following a redirect* into one at fetch time — a create-time-validated
 * public endpoint answering `302 Location: http://169.254.169.254/…`. Closing
 * that means `redirect: 'error'` on the fetch, and there are three of them —
 * ingest (worker), search (HttpEmbedder), rerank (HttpReranker). Three places
 * with nothing that knows there are three is this repository's most repeated
 * defect, so the repair is a check rather than three edits.
 *
 * A model-endpoint fetch is recognised structurally: its URL is the result of
 * `endpointUrl(...)`, the one helper that builds a request against an
 * operator- or tenant-configured base. So the rule is: a `const X =
 * endpointUrl(...)` followed by `fetch(X, { … })` requires `redirect: 'error'`
 * in that options object. A new model client that forgets it fails here.
 *
 * Refuses if it finds no such fetch, because a check with nothing to hold must
 * not report green.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOTS = ['../packages/worker/src', '../packages/api/src'].map((r) =>
  fileURLToPath(new URL(r, import.meta.url)),
)

function sources(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
    const full = `${dir}/${name}`
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (name.endsWith('.ts')) out.push(full)
  }
  return out
}

const problems = []
let checked = 0

for (const root of ROOTS) {
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8')

    // The variables a model-endpoint URL is bound to: `const at = endpointUrl(…)`.
    const bound = new Set()
    for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*endpointUrl\(/g)) {
      bound.add(m[1])
    }
    if (bound.size === 0) continue

    // Each `fetch(<var>, { … })` whose var is one of those must carry
    // redirect: 'error'. The options object holds nested braces (headers,
    // AbortSignal), so the span is found by matching braces rather than by a
    // non-greedy regex, which would stop at the first inner `}`.
    for (const m of text.matchAll(/\bfetch\(\s*([A-Za-z_$][\w$]*)\s*,\s*\{/g)) {
      const name = m[1]
      if (!bound.has(name)) continue
      const open = m.index + m[0].length - 1 // the position of the `{`
      let depth = 0
      let end = open
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') {
          depth -= 1
          if (depth === 0) {
            end = i
            break
          }
        }
      }
      const options = text.slice(open, end + 1)
      checked += 1
      if (!/redirect:\s*'error'/.test(options)) {
        const line = text.slice(0, m.index).split('\n').length
        const rel = file.slice(file.indexOf('/packages/') + 1)
        problems.push(
          `${rel}:${String(line)}: fetch(${name}, …) to a model endpoint does not set ` +
            "redirect: 'error' — a redirect would follow into the private network.",
        )
      }
    }
  }
}

if (checked === 0) {
  console.error(
    'check-embed-egress: found no fetch to an endpointUrl() target. Either the model ' +
      'clients moved or this check has stopped seeing them; a check with nothing to hold ' +
      'must not report green.',
  )
  process.exit(1)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`)
  console.error(`check-embed-egress: ${String(problems.length)} model fetch(es) follow redirects.`)
  process.exit(1)
}

console.log(`check-embed-egress: ${String(checked)} model-endpoint fetch(es), each refusing redirects.`)
