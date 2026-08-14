#!/usr/bin/env node
/**
 * The front door's proxy headers, held against every `location` that proxies.
 *
 * Two rules, each learned the same way — by starting the stack and reading one
 * header — and each of which has to hold in **four** locations with nothing
 * that knew there were four.
 *
 * **`Host $http_host`, never `$host`.** `$host` strips the port. The MCP
 * transport builds its RFC 9728 `resource` identifier from the `Host` it was
 * given and RFC 9728 has the client compare it against the URL it connected to,
 * so forwarding `$host` answered `http://localhost/...` to a client that
 * reached `:8082` — a mismatch, and a refusal before any token is sent.
 *
 * **`X-Forwarded-Proto $nacre_forwarded_proto`, never `$scheme`.** `$scheme` is
 * the scheme of the connection *into this container*, which is plaintext behind
 * every ingress controller and every TLS-terminating proxy on a host. So the
 * front door overwrote the outer proxy's correct `https` with `http`, and an
 * HTTPS installation advertised `resource_metadata="http://host/..."` while the
 * document at that URL said `"resource":"https://host"`. The map preserves what
 * arrived and falls back to `$scheme` only when nothing is in front.
 *
 * The e2e smoke proves both branches against a running stack. This proves the
 * fifth location, whenever somebody adds one.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const template = readFileSync(join(root, 'docker/nginx.conf.template'), 'utf8')

const problems = []
const note = (line) => problems.push(line)

/** Strip `#` comments, which explain both rules at length and name the wrong forms. */
const code = template
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

/** The map that makes the second rule possible. */
if (!/map\s+\$http_x_forwarded_proto\s+\$nacre_forwarded_proto\s*\{/.test(code)) {
  note(
    'no `map $http_x_forwarded_proto $nacre_forwarded_proto` in docker/nginx.conf.template. ' +
      'Without it every location below sends this connection\'s scheme, which is plaintext ' +
      'behind any ingress.',
  )
}

/**
 * Each `location … { … }` block, by name.
 *
 * Brace counting rather than a regular expression, because a location body is
 * multi-line and nested blocks are legal nginx.
 */
const locations = []
for (const match of code.matchAll(/location\s+([^\s{]+)\s*\{/g)) {
  const start = match.index + match[0].length
  let depth = 1
  let i = start
  while (i < code.length && depth > 0) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') depth -= 1
    i += 1
  }
  locations.push({ name: match[1], body: code.slice(start, i) })
}

if (locations.length === 0) {
  note('docker/nginx.conf.template declares no locations; that is not a pass.')
}

let proxied = 0
for (const { name, body } of locations) {
  // A `location` that serves files has no upstream and no headers to get wrong.
  if (!/proxy_pass\s/.test(body)) continue
  proxied += 1

  if (/proxy_set_header\s+Host\s+\$host\s*;/.test(body)) {
    note(
      `location ${name} forwards \`Host $host\`, which strips the port. The MCP transport builds ` +
        'its RFC 9728 identifier from that header and the client compares it against the URL it ' +
        'connected to, so a client on a non-default port is refused before it sends a token.',
    )
  } else if (!/proxy_set_header\s+Host\s+\$http_host\s*;/.test(body)) {
    note(`location ${name} proxies and does not set \`Host $http_host\`.`)
  }

  if (/proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;/.test(body)) {
    note(
      `location ${name} forwards \`X-Forwarded-Proto $scheme\`, which is the scheme of the ` +
        'connection into this container and not the one the client used. Behind a TLS-terminating ' +
        'proxy that overwrites the outer `https` with `http`, and the installation then advertises ' +
        'plaintext URLs for its own discovery documents. Use `$nacre_forwarded_proto`.',
    )
  } else if (!/proxy_set_header\s+X-Forwarded-Proto\s+\$nacre_forwarded_proto\s*;/.test(body)) {
    note(`location ${name} proxies and does not set \`X-Forwarded-Proto $nacre_forwarded_proto\`.`)
  }

  if (!/proxy_set_header\s+X-Forwarded-For\s/.test(body)) {
    note(
      `location ${name} proxies and sets no X-Forwarded-For, so every request reaches the ` +
        "upstream as the proxy's own address — which is what `NACRE_TRUST_PROXY` reads to decide " +
        'what a client is, and therefore what the sign-in limiter counts.',
    )
  }
}

if (proxied === 0) {
  note('no location in docker/nginx.conf.template proxies anything; that is not a pass either.')
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`)
  process.stderr.write(`\n${String(problems.length)} problem(s).\n`)
  process.exit(1)
}

process.stdout.write(
  `${String(proxied)} proxying location(s), every one forwarding the client's host, address and ` +
    'scheme rather than this container\'s.\n',
)
