import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { NacreClient } from '../client.js'

/**
 * Every operation in the contract is either reachable from this client or
 * written down as deliberately absent.
 *
 * The SDK had fallen a third of the way behind `docs/openapi.yaml` before this
 * existed: no sign-in, no reindex, no reference queries, no audit read. Nothing
 * failed, because nothing compares the two — a client that is merely
 * *incomplete* compiles, passes its own tests, and is discovered by somebody
 * dropping to `curl` in the middle of a task.
 *
 * So this is the same shape as the checks elsewhere in this repository for a
 * variable accepted and never read, or a cache tested and never called: adding
 * a path to the contract and not to the client is a failing test, and the fix
 * is either a method or a sentence saying why not. Both are cheap. Silence is
 * what is not allowed.
 */

const OPENAPI = fileURLToPath(new URL('../../../../docs/openapi.yaml', import.meta.url))

/**
 * The paths, read by scanning rather than parsing.
 *
 * There is no YAML dependency in this workspace and this is not the place to
 * introduce one — `redocly lint` already runs over the same file in CI, so it
 * is known to be well-formed, and all this needs is the two indentation levels
 * that hold a path and a method.
 */
function operations(): string[] {
  const found: string[] = []
  let inPaths = false
  let path: string | undefined

  for (const line of readFileSync(OPENAPI, 'utf8').split('\n')) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true
      continue
    }
    if (inPaths && /^\S/.test(line)) inPaths = false
    if (!inPaths) continue

    const isPath = /^ {2}(\/\S*):\s*$/.exec(line)
    if (isPath?.[1] !== undefined) {
      path = isPath[1]
      continue
    }
    const isMethod = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line)
    if (isMethod?.[1] !== undefined && path !== undefined) {
      found.push(`${isMethod[1].toUpperCase()} ${path}`)
    }
  }
  return found
}

/**
 * How each operation is reached, or why it is not.
 *
 * A string names the client member. `null` is a deliberate absence and the
 * comment beside it is the reason — those are reviewed like any other decision,
 * which is the point of writing them here rather than leaving a gap.
 */
const COVERAGE: Record<string, string | null> = {
  'POST /auth/login': 'auth.login',
  'POST /auth/refresh': 'auth.refresh',
  'POST /auth/logout': 'auth.logout',

  'POST /search': 'search',

  'POST /documents': 'documents.add',
  'GET /documents/{id}': 'documents.get',
  'PATCH /documents/{id}': 'documents.setMetadata',
  'DELETE /documents/{id}': 'documents.remove',

  'GET /me': 'me',
  'POST /oauth/consent': 'consent',
  'GET /workspaces': 'workspaces.list',
  'POST /workspaces': 'workspaces.create',

  'GET /layers': 'layers.list',
  'POST /layers': 'layers.create',
  'PATCH /layers/{id}': 'layers.update',
  'DELETE /layers/{id}': 'layers.remove',
  'POST /layers/{id}/reindex': 'layers.reindex',
  'GET /layers/{id}/reindex': 'layers.reindexStatus',
  'GET /layers/{id}/reference-queries': 'layers.referenceQueries',
  'PUT /layers/{id}/reference-queries': 'layers.setReferenceQueries',

  'GET /grants': 'grants.list',
  'POST /grants': 'grants.issue',
  'DELETE /grants/{id}': 'grants.revoke',

  'GET /users': 'users.list',
  'POST /users': 'users.create',
  'PATCH /users/{id}': 'users.update',
  'DELETE /users/{id}': 'users.disable',
  'POST /users/{id}/password': 'users.resetPassword',

  'GET /groups': 'groups.list',
  'POST /groups': 'groups.create',
  'DELETE /groups/{id}': 'groups.remove',
  'GET /groups/{id}/members': 'groups.members',
  'POST /groups/{id}/members': 'groups.addMember',
  'DELETE /groups/{id}/members/{type}/{memberId}': 'groups.removeMember',

  'GET /service-accounts': 'serviceAccounts.list',
  'POST /service-accounts': 'serviceAccounts.create',
  'DELETE /service-accounts/{id}': 'serviceAccounts.revoke',

  'GET /jobs/{id}': 'jobs.get',

  'GET /audit': 'audit.read',

  // Discovery documents, read by an OAuth client rather than by an
  // application. A method here would be a wrapper around one `fetch` for a
  // consumer that is not this library's audience, and both are unauthenticated
  // — the one thing this client exists to attach a credential to.
  'GET /.well-known/oauth-protected-resource': null,
  // Same, and more so: whoever reads this holds no Nacre credential at all.
  // That is what a JWKS is for.
  'GET /.well-known/jwks.json': null,

  // Operational endpoints, in the contract because they are served, but not
  // this client's job. Liveness and readiness are probed by an orchestrator,
  // metrics scraped by Prometheus — none of them is an application calling the
  // API through the SDK, and two are unauthenticated, which is the one thing
  // this client exists to attach a credential to.
  'GET /health': null,
  'GET /ready': null,
  'GET /metrics': null,
}

/** Walk `a.b` on the client instance, so the map names something real. */
function member(client: NacreClient, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (value === null || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, client as unknown)
}

describe('the client covers the contract', () => {
  const client = new NacreClient({ baseUrl: 'https://api.test', token: 'nacre_sk_x' })

  it('reads the operations out of the contract at all', () => {
    // A scan that silently matched nothing would make every assertion below
    // vacuously true, which is the failure mode of testing against a file.
    expect(operations().length).toBeGreaterThan(20)
    expect(operations()).toContain('POST /search')
  })

  it('has an entry for every operation in the contract', () => {
    const missing = operations().filter((op) => !(op in COVERAGE))

    // The message matters more than the assertion here: whoever added the path
    // needs to know the fix is a method **or** a written reason.
    expect(
      missing,
      `${missing.join(', ')} — add a client method, or an explicit null with the reason`,
    ).toEqual([])
  })

  it('names a method that exists, for every operation it claims to cover', () => {
    // The half a stale map gets wrong: an entry pointing at a member that was
    // renamed reads as coverage and is not.
    const broken = Object.entries(COVERAGE)
      .filter(([, name]) => name !== null)
      .filter(([, name]) => typeof member(client, name as string) !== 'function')
      .map(([op, name]) => `${op} -> ${String(name)}`)

    expect(broken).toEqual([])
  })

  it('claims coverage of nothing the contract does not describe', () => {
    // The other direction. A method for a path the server does not serve is a
    // 404 an application meets at runtime, and an entry left behind after an
    // endpoint is removed is how one survives.
    const stale = Object.keys(COVERAGE).filter((op) => !operations().includes(op))
    expect(stale).toEqual([])
  })

  it('leaves nothing uncovered without a reason', () => {
    // Not a bound on how many may be null — a bound would be arbitrary. This
    // pins the two that are, so adding a third is a deliberate edit to this
    // list rather than a quiet addition to the map above.
    const uncovered = Object.entries(COVERAGE)
      .filter(([, name]) => name === null)
      .map(([op]) => op)

    expect(uncovered.sort()).toEqual([
      'GET /.well-known/jwks.json',
      'GET /.well-known/oauth-protected-resource',
      'GET /health',
      'GET /metrics',
      'GET /ready',
    ])
  })
})
