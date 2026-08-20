import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi } from '../index.js'

/**
 * The contract says where a path lives and whether it needs a credential. This
 * asks the running server both questions.
 *
 * `docs/openapi.yaml` is normative here, and until now everything that read it
 * compared it against *other descriptions* — the SDK's method list, and (since
 * the embedding-providers gap) the paths the SDK calls. Nothing ever asked the
 * server. So two kinds of disagreement were invisible: a path documented at an
 * address it is not served at, and an operation documented as needing a token
 * that does not, or the reverse.
 *
 * Neither can be answered by reading the source. The API's routing is
 * `instance === '…'` beside half a dozen regexes, two constants resolved in
 * another module, and two prefix matches that are gates rather than routes; a
 * static extractor over that is a fragile parse whose false positives teach
 * people to edit the check instead of the code — which is exactly the argument
 * against the parser, and it applies to a parser written from either side. So
 * this drives the real server, which is this repository's rule anyway.
 *
 * **What it deliberately does not assert** is that every one of the 48
 * operations routes. Proving that needs every optional port wired, including a
 * nested OAuth server, and a harness that large fails on stub shape far more
 * often than on drift. The two properties below need almost no ports and are
 * the two that have actually been wrong.
 */

const OPENAPI = fileURLToPath(new URL('../../../../docs/openapi.yaml', import.meta.url))
const SECRET = new TextEncoder().encode('a'.repeat(32))

interface Operation {
  readonly method: string
  readonly path: string
  /** The base the contract declares this path under — global, or overridden. */
  readonly base: string
  /** `security: []` — documented as needing no credential. */
  readonly open: boolean
}

/**
 * The operations, read by scanning.
 *
 * No YAML dependency in this workspace and this is not the place to add one:
 * `redocly lint` already runs over the same file in CI, so it is known to be
 * well-formed, and this needs four things that live at known indentation — a
 * path, a method, a `security: []`, and a per-path `servers:` override.
 */
function operations(): Operation[] {
  const found: Operation[] = []
  let inPaths = false
  let path: string | undefined
  let index = -1
  let globalBase = ''
  let inGlobalServers = false
  /** Per-path `servers:` overrides, applied to every operation under the path. */
  const bases = new Map<string, string>()
  let serversFor: string | undefined

  for (const line of readFileSync(OPENAPI, 'utf8').split('\n')) {
    if (/^servers:\s*$/.test(line)) {
      inGlobalServers = true
      continue
    }
    if (inGlobalServers) {
      const url = /^\s*-\s*url:\s*(\S+)/.exec(line)
      if (url?.[1] !== undefined) globalBase = new URL(url[1]).pathname.replace(/\/$/, '')
      inGlobalServers = false
    }

    if (/^paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths && /^\S/.test(line)) inPaths = false
    if (!inPaths) continue

    const isPath = /^ {2}(\/\S*):\s*$/.exec(line)
    if (isPath?.[1] !== undefined) {
      path = isPath[1]
      serversFor = undefined
      continue
    }
    if (path === undefined) continue

    // A per-path override sits at the path's own level, above the methods.
    if (/^ {4}servers:\s*$/.test(line)) {
      serversFor = path
      continue
    }
    if (serversFor !== undefined) {
      const url = /^\s*-\s*url:\s*(\S+)/.exec(line)
      if (url?.[1] !== undefined) bases.set(serversFor, new URL(url[1]).pathname.replace(/\/$/, ''))
      serversFor = undefined
      continue
    }

    const isMethod = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line)
    if (isMethod?.[1] !== undefined) {
      found.push({ method: isMethod[1].toUpperCase(), path, base: '', open: false })
      index = found.length - 1
      continue
    }
    // `security: []` under an operation, and (rarer) under the path itself.
    if (/^ {6}security:\s*\[\]\s*$/.test(line) && index >= 0) {
      found[index] = { ...found[index], open: true } as Operation
    }
  }

  return found.map((op) => ({ ...op, base: bases.get(op.path) ?? globalBase }))
}

/**
 * The documents an operator's deployment actually serves without a
 * credential, wired so "where does this live" has an answer other than 404.
 *
 * Everything else stays absent. This suite is about the surface, not about
 * behaviour behind it, and an absent port answers 404 — which is not 401, so
 * the authentication assertion holds regardless.
 */
let server: Server
let base: string

beforeAll(async () => {
  server = createApi({
    verify: { key: SECRET, issuer: 'https://api.nacre.test', audience: 'nacre' },
    documents: { read: async () => undefined },
    search: { search: async () => [] },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: { write: async () => undefined },
    metrics: { render: async () => '# nacre\n' },
    ready: async () => ({ postgres: true, qdrant: true }),
    // Present so `/auth/*` is mounted at all, and reaching no further than
    // that: this suite asks where an operation lives, not what it answers.
    // Without it every open `/auth` operation is 404 for the honest reason
    // that the deployment has no sign-in, which would hide the one thing the
    // GET case is here to catch.
    login: {} as never,
    jwks: [{ kty: 'OKP', crv: 'Ed25519', x: 'x', kid: 'k' }],
    resourceMetadata: {
      resource: 'https://api.nacre.test',
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://nacre.work',
      scopes_supported: [],
    },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
})

/** The address the contract says an operation is at, with parameters filled in. */
const address = (op: Operation): string =>
  `${op.base}${op.path}`.replace(/\{[^}]+\}/g, '11111111-1111-1111-1111-111111111111')

const send = async (op: Operation): Promise<Response> =>
  fetch(`${base}${address(op)}`, {
    method: op.method,
    ...(op.method === 'GET' || op.method === 'DELETE'
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: '{}' }),
  })

describe('the contract describes the surface the server presents', () => {
  it('reads the operations out of the contract at all', () => {
    // A scan that matched nothing makes every assertion below vacuously true,
    // which is the failure mode of testing against a file.
    const ops = operations()
    expect(ops.length).toBeGreaterThan(40)
    expect(ops.some((o) => o.method === 'POST' && o.path === '/search')).toBe(true)
    expect(ops.filter((o) => o.open).length).toBeGreaterThan(4)
  })

  it('needs a credential exactly where the contract says it does', async () => {
    // Sent with no Authorization header at all. A protected path answers 401
    // before it routes, so this needs none of the optional ports — and an open
    // one answers whatever it answers, which is never 401.
    //
    // The direction that matters most is an operation the contract does *not*
    // mark `security: []` answering something other than 401: that is an
    // endpoint reachable without a credential which the contract says is not.
    const wrong: string[] = []
    for (const op of operations()) {
      const response = await send(op)
      const unauthenticated = response.status !== 401
      if (unauthenticated !== op.open) {
        wrong.push(
          `${op.method} ${address(op)} — contract says ${op.open ? 'open' : 'authenticated'}, ` +
            `server answered ${String(response.status)}`,
        )
      }
    }

    expect(wrong, wrong.join('\n')).toEqual([])
  })

  it('serves the unauthenticated documents at the address the contract gives', async () => {
    // The five this deployment configured. `security: []` says a client may
    // fetch them with no credential; `servers` says where. A 404 here means the
    // contract sends a client somewhere the server does not answer — which is
    // how `/metrics` and both `/.well-known` documents were described: declared
    // under the `/v1` base and served at the origin root, where RFC 8615 puts
    // the well-known documents and where the `WWW-Authenticate` on every 401
    // already points.
    //
    // What is excluded is an operation needing a **body** this test does not
    // construct, which is a property of the method rather than of the path.
    // It used to exclude `/auth/*` by prefix, on the argument that those are
    // all POSTs — true when it was written, and it silently stopped covering
    // `GET /auth/methods` the day that one was added. That endpoint then
    // answered 404 for its whole life, because `handleAuth` refused anything
    // but POST, and the console it exists for hid the recovery link on every
    // deployment. A blanket exclusion is a check that shrinks without saying
    // so; `op.method === 'GET'` already carries the real condition.
    const documents = operations().filter((op) => op.open && op.method === 'GET')
    expect(documents.length).toBe(6)

    const missing: string[] = []
    for (const op of documents) {
      const response = await send(op)
      if (response.status !== 200) {
        missing.push(`GET ${address(op)} answered ${String(response.status)}, expected 200`)
      }
    }

    expect(
      missing,
      `${missing.join('\n')}\n\nThe contract's base for a path is its \`servers\` override, or ` +
        'the global one. A document served at the origin root needs the override.',
    ).toEqual([])
  })

  it('never answers 500 for a malformed percent-escape in a path parameter', async () => {
    // `/v1/documents/%ZZ`: WHATWG `URL` leaves an invalid escape in `pathname`
    // verbatim, so a handler decoding the captured segment by hand threw
    // `URIError`, and the boundary turned that into a `500` and an audit row
    // saying `error` — where the right answer is the `404` every other unknown
    // id gets, because a malformed escape names nothing. Twelve routes decoded
    // a segment; asking every parameterised operation in the contract is what
    // covers the thirteenth on the day it is written.
    //
    // Authenticated, because the throw lived past the credential check — an
    // unauthenticated sweep stops at the 401 and proves nothing about routing.
    const parameterised = operations().filter((op) => op.path.includes('{'))
    // A filter that matches nothing makes the loop below vacuously green.
    expect(parameterised.length).toBeGreaterThan(8)

    const token = await new SignJWT({
      org: '11111111-1111-1111-1111-111111111111',
      principal_type: 'user',
      role: 'org_admin',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('cccccccc-0000-4000-8000-000000000001')
      .setIssuer('https://api.nacre.test')
      .setAudience('nacre')
      .setExpirationTime('5m')
      .sign(SECRET)

    const broken: string[] = []
    for (const op of parameterised) {
      const target = `${op.base}${op.path}`.replace(/\{[^}]+\}/g, '%ZZ')
      const response = await fetch(`${base}${target}`, {
        method: op.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
        },
        ...(op.method === 'GET' || op.method === 'DELETE' ? {} : { body: '{}' }),
      })
      if (response.status >= 500) {
        broken.push(`${op.method} ${target} answered ${String(response.status)}`)
      }
    }

    expect(broken, broken.join('\n')).toEqual([])
  })
})
