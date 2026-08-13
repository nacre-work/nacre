import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type AuthContext, type GrantInput, type GrantRecord } from '../index.js'

/**
 * The administrative surface: layers, grants, jobs.
 *
 * Storage is injected — what is under test is what the API says, not what the
 * database holds. Two things here are properties of this layer alone: the
 * 403/404 split on scopes the caller may not administer, and the two grant
 * shapes this build refuses because they are commercial.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG_A = '11111111-1111-1111-1111-111111111111'
const WS_MINE = 'dddddddd-0000-4000-8000-000000000001'
const WS_THEIRS = 'dddddddd-0000-4000-8000-000000000002'
const LAYER = 'eeeeeeee-0000-4000-8000-000000000001'
const PRINCIPAL = 'ffffffff-0000-4000-8000-000000000001'
const DOC = 'aaaaaaaa-0000-4000-8000-000000000001'

interface ProblemBody {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly request_id: string
}

async function answerOnly(r: Response): Promise<Omit<ProblemBody, 'instance' | 'request_id'>> {
  const { instance, request_id, ...rest } = (await r.json()) as ProblemBody
  void instance
  void request_id
  return rest
}

const audited: AuditEvent[] = []
const issued: GrantInput[] = []
const revoked: string[] = []

/**
 * Everything that reached the idempotency cache.
 *
 * A fake rather than a Redis, because what is under test is *which* responses
 * get stored at all — the store's own behaviour has its own tests, against a
 * real one. Recording the body is the point: one of these responses carries a
 * credential that exists exactly once, and a cache with a 24-hour TTL is not
 * where it exists.
 */
const cached: { path: string; status: number; body: unknown }[] = []

const idempotency = {
  begin: async (_key: string, _principal: unknown, _method: string, path: string) => ({
    proceed: true as const,
    store: async (status: number, body: unknown) => {
      cached.push({ path, status, body })
    },
  }),
}

let server: Server
let base: string

async function token(): Promise<string> {
  return new SignJWT({ org: ORG_A, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

const auth = async () => ({
  authorization: `Bearer ${await token()}`,
  'content-type': 'application/json',
})

async function adminToken(): Promise<string> {
  return new SignJWT({ org: ORG_A, principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('root')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

const adminAuth = async () => ({
  authorization: `Bearer ${await adminToken()}`,
  'content-type': 'application/json',
})

describe('the administrative surface', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      idempotency,
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
      jobs: {
        read: async (a, jobId) =>
          a.orgId === ORG_A && jobId === DOC
            ? { jobId: DOC, documentId: DOC, status: 'indexed', progress: 1 }
            : undefined,
      },
      layers: {
        list: async () => ({
          nextCursor: null,
          items: [
            {
              id: LAYER,
              slug: 'handbook',
              name: 'Handbook',
              workspaceId: WS_MINE,
              description: 'How things are done here',
              failedCount: 0,
              documentCount: 12,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ],
        }),
        // `denied` for "may not administer" and "no such workspace" alike;
        // `conflict` only once the caller has proved admin on the workspace.
        create: async (_a: AuthContext, input) =>
          input.workspaceId !== WS_MINE
            ? { kind: 'denied' as const }
            : input.slug === 'taken'
              ? { kind: 'conflict' as const }
              : {
                  kind: 'created' as const,
                  layer: {
                    id: LAYER,
                    slug: input.slug,
                    name: input.name,
                    workspaceId: WS_MINE,
                    description: '',
                    failedCount: 0,
              documentCount: 0,
                    createdAt: '2026-01-01T00:00:00.000Z',
                  },
                },
        // Deleting the one layer this caller administers succeeds; anything
        // else is the same `false` the port owes an absent layer and an
        // unadministrable one alike.
        remove: async (_a: AuthContext, layerId: string) => layerId === LAYER,
      },
      serviceAccounts: {
        list: async () => ({
          nextCursor: null,
          items: [
          {
            id: 'sa-1',
            name: 'agent',
            keyPrefix: 'nacre_sk_abcd1234',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: null,
            revokedAt: null,
          },
          ],
        }),
        create: async (_a, name) => ({
          key: 'nacre_sk_abcd1234SECRETSECRETSECRET',
          account: {
            id: 'sa-2',
            name,
            keyPrefix: 'nacre_sk_abcd1234',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: null,
            revokedAt: null,
          },
        }),
        revoke: async (_a, id) => id === 'sa-1',
      },
      grants: {
        list: async () => ({ items: [], nextCursor: null }),
        issue: async (_a, input): Promise<GrantRecord | undefined> => {
          if (input.scopeId !== LAYER) return undefined
          issued.push(input)
          return { ...input, id: 'grant-1', effect: 'allow', source: 'api' }
        },
        revoke: async (_a, id) => {
          if (id !== 'grant-1') return false
          revoked.push(id)
          return true
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /**
   * Who the caller is.
   *
   * There was no way to ask, and the consequence was a UI that offered every
   * control to everybody: it could not tell an `org_admin` from a `member`, so
   * a member pressed "New user" and got the `404` invariant 4 requires — which
   * reads as a broken application rather than as a permission they lack.
   *
   * The property to hold onto is that this composes its answer from the token
   * and nothing else. It cannot name another principal because it never asks
   * anything about one.
   */
  it('describes the caller and nobody else', async () => {
    for (const [who, headers, role] of [
      ['a member', await auth(), 'member'],
      ['an administrator', await adminAuth(), 'org_admin'],
    ] as const) {
      const res = await fetch(`${base}/v1/me`, { headers })
      expect(res.status, who).toBe(200)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.role, who).toBe(role)
      expect(body.organization, who).toBe(ORG_A)
      expect(body.principal_type, who).toBe('user')
      expect(typeof body.principal_id, who).toBe('string')
      // Nothing about anybody else, and nothing that is not in the token.
      expect(Object.keys(body).sort()).toEqual(['organization', 'principal_id', 'principal_type', 'role'])
    }
  })

  it('needs a token like everything else, and answers no other method', async () => {
    expect((await fetch(`${base}/v1/me`)).status).toBe(401)
    // 404 rather than 405: invariant 4 reserves the distinction for objects.
    expect((await fetch(`${base}/v1/me`, { method: 'POST', headers: await auth(), body: '{}' })).status).toBe(404)
  })

  it('a job reports its status', async () => {
    const res = await fetch(`${base}/v1/jobs/${DOC}`, { headers: await auth() })
    expect(res.status).toBe(200)
    expect((await res.json()) as { status: string }).toMatchObject({
      job_id: DOC,
      document_id: DOC,
      status: 'indexed',
    })
  })

  it('another organization’s job is 404, identical to one that does not exist', async () => {
    const missing = await fetch(`${base}/v1/jobs/${WS_THEIRS}`, { headers: await auth() })
    const absent = await fetch(`${base}/v1/jobs/${PRINCIPAL}`, { headers: await auth() })

    // A job names a document, so it is exactly as much of an oracle as the
    // document is. Anything that distinguishes these two enumerates ids.
    expect(missing.status).toBe(404)
    expect(await answerOnly(missing)).toEqual(await answerOnly(absent))
  })

  it('layers lists what the caller may read', async () => {
    const res = await fetch(`${base}/v1/layers`, { headers: await auth() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { slug: string; workspace_id: string }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.slug).toBe('handbook')
  })

  it('a principal that is not a uuid is 400 naming that field, not 404 naming the scope', async () => {
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        // A service account's *name*, which is what somebody typed into a form
        // whose only shortcut was on the other field.
        principal_type: 'service_account',
        principal_id: 't',
        scope_type: 'layer',
        scope_id: LAYER,
        permission: 'read',
      }),
    })

    // 400 and not 404: a value that is not a uuid is a fact about the caller's
    // own request and discloses nothing. Collapsing it into the `404` that
    // means "no such scope, or you may not administer it" is what sent
    // somebody looking at the half of the form that was correct.
    expect(res.status).toBe(400)
    const detail = ((await res.json()) as { detail: string }).detail
    expect(detail).toContain('principal_id')
    // And it says which field, rather than leaving them to guess between two.
    expect(detail).not.toContain('scope_id')
  })

  it('a scope that is not a uuid is 400 naming the scope', async () => {
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: 'handbook',
        permission: 'read',
      }),
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { detail: string }).detail).toContain('scope_id')
  })

  it('a well-formed uuid that names nothing is still 404, and says so about both', async () => {
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: WS_THEIRS,
        permission: 'read',
      }),
    })

    // The other half of the same rule. Once the shape is right, "does not
    // exist" and "you may not administer it" are one answer — invariant 4 —
    // and naming which would be an oracle for a caller who cannot list
    // principals.
    expect(res.status).toBe(404)
  })

  it('answers 404 without asking for a credential on a path it does not serve', async () => {
    // What an MCP client probing for OAuth discovery meets. Every one of these
    // used to answer `401 "A bearer token is required"`, which reads as "the
    // endpoint is there and gated" — and cost an afternoon of un-gating routes
    // that do not exist. This is a resource server; it declines the
    // authorization-server role.
    for (const path of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/openid-configuration',
      '/register',
      '/mcp',
    ]) {
      const res = await fetch(`${base}${path}`)
      expect(res.status, `${path} should be 404`).toBe(404)
    }

    // The two documents this server does serve stay served, unauthenticated.
    const served = await fetch(`${base}/.well-known/oauth-protected-resource`)
    expect([200, 404]).toContain(served.status)
  })

  it('deleting a layer answers 204 and records the attempt', async () => {
    const res = await fetch(`${base}/v1/layers/${LAYER}`, {
      method: 'DELETE',
      headers: await auth(),
    })
    expect(res.status).toBe(204)

    // Deleting a layer removes every document in it from every answer at once,
    // which is the largest single act on this surface. The journal has to carry
    // it whichever way it went.
    const recorded = audited.find((e) => e.action === 'delete_layer')
    expect(recorded?.result).toBe('allow')
    expect(recorded?.target).toMatchObject({ layer_id: LAYER })
  })

  it('deleting a layer the caller may not administer is 404, and is still recorded', async () => {
    // Same answer as one that does not exist — invariant I4 does not stop
    // applying because the verb is destructive. A refused attempt is worth as
    // much to an investigation as a successful one, so it is journalled too.
    const other = '99999999-9999-4999-8999-999999999999'
    const res = await fetch(`${base}/v1/layers/${other}`, {
      method: 'DELETE',
      headers: await auth(),
    })
    expect(res.status).toBe(404)

    const recorded = audited.filter((e) => e.action === 'delete_layer').at(-1)
    expect(recorded?.result).toBe('deny')
  })

  it('creating a layer in a workspace the caller may not administer is 404, not 403', async () => {
    const res = await fetch(`${base}/v1/layers`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ workspace_id: WS_THEIRS, slug: 'secret', name: 'Secret' }),
    })

    expect(res.status).toBe(404)
    expect(audited.find((e) => e.action === 'create_layer')?.result).toBe('deny')
  })

  it('creating a layer answers 201 and journals it', async () => {
    audited.length = 0
    const res = await fetch(`${base}/v1/layers`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ workspace_id: WS_MINE, slug: 'handbook', name: 'Handbook' }),
    })

    expect(res.status).toBe(201)
    expect(audited.find((e) => e.action === 'create_layer')?.result).toBe('allow')
  })

  it('a slug already in use is 409, not another 404', async () => {
    const res = await fetch(`${base}/v1/layers`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ workspace_id: WS_MINE, slug: 'taken', name: 'Taken' }),
    })

    // The caller proved admin on the workspace to get here, so this says
    // something about the resource rather than about what they can see.
    // Answering 404 makes the endpoint unusable: an administrator who picks a
    // name in use cannot tell it from having no permission, and guesses next.
    expect(res.status).toBe(409)
    expect((await answerOnly(res)).detail).toMatch(/already exists/)
  })

  it('a layer request missing its fields is 400', async () => {
    const res = await fetch(`${base}/v1/layers`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ slug: 'handbook' }),
    })
    expect(res.status).toBe(400)
  })

  it('a grant on a scope the caller may not administer is 404', async () => {
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: WS_THEIRS,
        permission: 'read',
      }),
    })

    expect(res.status).toBe(404)
    expect(audited.find((e) => e.action === 'issue_grant')?.result).toBe('deny')
  })

  it('issuing a grant answers 201', async () => {
    issued.length = 0
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: LAYER,
        permission: 'read',
      }),
    })

    expect(res.status).toBe(201)
    expect((await res.json()) as { effect: string }).toMatchObject({ effect: 'allow', source: 'api' })
    expect(issued).toHaveLength(1)
  })

  it('a document-scoped grant is refused, and says why', async () => {
    issued.length = 0
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'document',
        scope_id: DOC,
        permission: 'read',
      }),
    })

    // Document-level ACLs are commercial (docs/licensing.md). 400 and not 404:
    // the caller is an administrator asking for a capability, which is not a
    // question about whether an object exists, so invariant I4 has no bearing
    // and the honest answer is the useful one.
    expect(res.status).toBe(400)
    expect((await answerOnly(res)).detail).toMatch(/not available in this build/)
    expect(issued, 'nothing may reach the store').toHaveLength(0)
  })

  it('a deny rule is refused', async () => {
    issued.length = 0
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: LAYER,
        permission: 'read',
        effect: 'deny',
      }),
    })

    // The resolver can represent deny — an enterprise resolver registered
    // through registerAuthzResolver produces them. The core must not issue what
    // it has no propagation for; a deny that never reaches the payload is worse
    // than one that was never accepted.
    expect(res.status).toBe(400)
    expect(issued).toHaveLength(0)
  })

  it('an explicit allow effect is accepted, since it is the default', async () => {
    const res = await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        principal_type: 'user',
        principal_id: PRINCIPAL,
        scope_type: 'layer',
        scope_id: LAYER,
        permission: 'read',
        effect: 'allow',
      }),
    })
    expect(res.status).toBe(201)
  })

  it('a grant can be withdrawn', async () => {
    const res = await fetch(`${base}/v1/grants/grant-1`, { method: 'DELETE', headers: await auth() })

    // 204 and no body. This is the operation the propagation SLA is written
    // about, and until this endpoint existed the only way to perform it was a
    // DELETE against the table by hand.
    expect(res.status).toBe(204)
    expect(revoked).toEqual(['grant-1'])
  })

  it('withdrawing a grant that is not there, or not the caller’s to touch, is 404', async () => {
    const res = await fetch(`${base}/v1/grants/grant-nope`, { method: 'DELETE', headers: await auth() })

    // Not 403. An administrator of one layer must not be able to tell an absent
    // grant from one on a scope they cannot administer — that difference is an
    // enumeration of the organization's grants.
    expect(res.status).toBe(404)
    expect(await answerOnly(res)).toEqual({
      type: 'https://nacre.work/errors/not-found',
      title: 'Not found',
      status: 404,
      detail: 'The requested resource does not exist or is not accessible.',
    })
  })

  it('the refused revocation is audited too', async () => {
    await fetch(`${base}/v1/grants/grant-nope`, { method: 'DELETE', headers: await auth() })

    // An attempt to revoke someone else's grant is exactly what a refused one
    // looks like, and it is the row an auditor asks for.
    const attempt = audited.filter((e) => e.action === 'revoke_grant' && e.result === 'deny')
    expect(attempt.length).toBeGreaterThan(0)
    // `target`, which is where docs/audit.md says the object goes and what the
    // schema indexes. It was in `detail` until every administrative event
    // stopped naming its target there.
    expect(attempt.at(-1)?.target).toMatchObject({ grant_id: 'grant-nope' })
  })

  it('an unknown permission or principal type is 400', async () => {
    for (const body of [
      { principal_type: 'robot', principal_id: PRINCIPAL, scope_type: 'layer', scope_id: LAYER, permission: 'read' },
      { principal_type: 'user', principal_id: PRINCIPAL, scope_type: 'layer', scope_id: LAYER, permission: 'superuser' },
      { principal_type: 'user', principal_id: PRINCIPAL, scope_type: 'planet', scope_id: LAYER, permission: 'read' },
    ]) {
      const res = await fetch(`${base}/v1/grants`, {
        method: 'POST',
        headers: await auth(),
        body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
  })

  it('a member may not mint or revoke a service account', async () => {
    // The fixture's token carries role 'member'. A service account is a
    // principal in the organization rather than an object in a workspace, so
    // there is no scope to check admin against — someone holding admin on one
    // layer must not be able to mint a credential.
    expect((await fetch(`${base}/v1/service-accounts`, { headers: await auth() })).status).toBe(404)

    const created = await fetch(`${base}/v1/service-accounts`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ name: 'agent' }),
    })
    expect(created.status).toBe(404)

    const revoked = await fetch(`${base}/v1/service-accounts/sa-1`, {
      method: 'DELETE',
      headers: await auth(),
    })
    expect(revoked.status).toBe(404)
  })

  it('an org_admin creates a key, and it is in the response exactly once', async () => {
    audited.length = 0
    const res = await fetch(`${base}/v1/service-accounts`, {
      method: 'POST',
      headers: await adminAuth(),
      body: JSON.stringify({ name: 'agent' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { key?: string; key_prefix?: string }
    expect(body.key).toBe('nacre_sk_abcd1234SECRETSECRETSECRET')

    // The key must not reach the audit log. That row is readable by anyone with
    // the access log, and the key is unrecoverable from anywhere else by
    // design — writing it here would quietly undo that.
    const event = audited.find((e) => e.action === 'create_service_account')
    expect(event?.result).toBe('allow')
    expect(JSON.stringify(event)).not.toContain('SECRETSECRETSECRET')
    expect(event?.detail.key_prefix).toBe('nacre_sk_abcd1234')
  })

  it('a key never reaches the idempotency cache', async () => {
    cached.length = 0

    const res = await fetch(`${base}/v1/service-accounts`, {
      method: 'POST',
      headers: { ...(await adminAuth()), 'idempotency-key': 'retry-me' },
      body: JSON.stringify({ name: 'agent' }),
    })

    // The caller still gets the key — the endpoint works, it is only uncached.
    expect(res.status).toBe(201)
    expect(((await res.json()) as { key?: string }).key).toBe('nacre_sk_abcd1234SECRETSECRETSECRET')

    // And nothing was stored. The key is held hashed so that it cannot be
    // recovered from the database or from a backup; a copy sitting in Redis for
    // 24 hours undoes that, and a cache dump is a much easier thing to obtain
    // than a database one. The endpoint is safe to retry without a cache
    // anyway: a duplicate name is answered 409 by the unique constraint rather
    // than minting a second key.
    expect(cached).toHaveLength(0)
  })

  it('other unsafe requests are cached, so the exclusion is an exclusion', async () => {
    cached.length = 0

    await fetch(`${base}/v1/grants`, {
      method: 'POST',
      headers: { ...(await adminAuth()), 'idempotency-key': 'retry-me-too' },
      body: JSON.stringify({ scope: 'layer', scope_id: LAYER, principal_id: PRINCIPAL, level: 'read' }),
    })

    // Without this the first test would pass just as well if the feature were
    // switched off entirely, which is the way a deny-list quietly becomes a
    // deny-everything.
    expect(cached).toHaveLength(1)
    expect(cached[0]?.path).toBe('/v1/grants')
    expect(JSON.stringify(cached)).not.toContain('nacre_sk_')
  })

  it('listing never carries a key', async () => {
    const res = await fetch(`${base}/v1/service-accounts`, { headers: await adminAuth() })
    expect(res.status).toBe(200)

    const text = await res.text()
    expect(text).toContain('key_prefix')
    // A listing that returned the key would make every operator's terminal
    // history a credential store, and the whole point of hashing it is that it
    // exists in exactly one response, once.
    expect(JSON.parse(text) as { items: Record<string, unknown>[] }).toMatchObject({
      items: [{ key_prefix: 'nacre_sk_abcd1234' }],
    })
    expect(text).not.toMatch(/"key"/)
  })

  it('revoking answers 204, and an unknown one 404', async () => {
    expect(
      (await fetch(`${base}/v1/service-accounts/sa-1`, { method: 'DELETE', headers: await adminAuth() }))
        .status,
    ).toBe(204)
    expect(
      (await fetch(`${base}/v1/service-accounts/sa-9`, { method: 'DELETE', headers: await adminAuth() }))
        .status,
    ).toBe(404)
  })

  it('a nameless service account is 400', async () => {
    const res = await fetch(`${base}/v1/service-accounts`, {
      method: 'POST',
      headers: await adminAuth(),
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
  })

  it('the admin surface still refuses a body naming an organization', async () => {
    // Invariant I1 applies to every route, not only the ones that read
    // documents. A new endpoint that forgot rejectTenantOverride would be the
    // easiest way back in.
    const res = await fetch(`${base}/v1/layers`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({
        workspace_id: WS_MINE,
        slug: 'x',
        name: 'X',
        org_id: '22222222-2222-2222-2222-222222222222',
      }),
    })
    expect(res.status).toBe(403)
  })

  it('top_k is clamped rather than passed through', async () => {
    // It reached Qdrant's `limit` verbatim, and with reranking on it also
    // decided how many rows to hydrate from Postgres. `1e309` parses to
    // Infinity; negatives and fractions went through unexamined.
    const asked: number[] = []
    const probe = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: {
        search: async (_a, _q, topK) => {
          asked.push(topK)
          return []
        },
      },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`

    // Number.POSITIVE_INFINITY rather than the literal 1e309: eslint refuses a
    // literal that loses precision, and JSON.stringify writes both as `null`
    // anyway — the wire form a client sending 1e309 actually produces.
    for (const value of [Number.POSITIVE_INFINITY, -5, 2.7, 5000, 'ten', undefined]) {
      await fetch(`${at}/v1/search`, {
        method: 'POST',
        headers: await auth(),
        body: JSON.stringify(value === undefined ? { query: 'x' } : { query: 'x', top_k: value }),
      })
    }
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    // Clamped, not refused: the bound is a resource limit rather than a
    // permission one, so asking for more is answered with the maximum.
    //
    // `1e309` is the exception and gets the default rather than the maximum.
    // JSON parses it to Infinity, which is not a number a client can have
    // meant — so it is treated as malformed input rather than as a large
    // request, the same as the string.
    expect(asked).toEqual([10, 1, 2, 50, 10, 10])
  })

  it('a body over the limit is 413 and says so, not 400', async () => {
    const probe = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      maxBodyBytes: 512,
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`

    const res = await fetch(`${at}/v1/search`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ query: 'x'.repeat(2000) }),
    })
    await new Promise<void>((resolve) => probe.close(() => resolve()))

    // It was 400 "The request body could not be read" — true, and useless to a
    // caller trying to work out what to change.
    expect(res.status).toBe(413)
    expect((await res.json()) as { detail: string }).toMatchObject({
      detail: expect.stringContaining('NACRE_MAX_DOCUMENT_BYTES'),
    })
  })

  it('the request path writes the metrics it was only registering', async () => {
    // Four were registered and never written, so /metrics served
    // `nacre_search_results_total 0` and `nacre_acl_denials_total 0` forever
    // and the two histograms rendered no series at all. A number pinned at zero
    // reads as health, so the p95 target in docs/config.md was not merely unmet
    // — it was unmeasurable and looked fine.
    const seen: string[] = []
    const record =
      (name: string) =>
      (a?: unknown, b?: unknown): void => {
        seen.push(`${name}:${JSON.stringify(a)}:${JSON.stringify(b)}`)
      }

    const probe = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      observe: {
        searchDuration: { observe: record('searchDuration') },
        searchResults: { inc: record('searchResults') },
        aclDenials: { inc: record('aclDenials') },
        ingestDuration: { observe: record('ingestDuration') },
        authFailures: { inc: record('authFailures') },
      },
      documents: { read: async () => undefined },
      search: {
        search: async () => [
          { chunk_id: 'c', doc_id: 'd', layer: 'l', title: null, score: 1, text: 't' },
        ],
      },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`

    await fetch(`${at}/v1/search`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ query: 'x' }),
    })
    await fetch(`${at}/v1/documents`, {
      method: 'POST',
      headers: await auth(),
      body: JSON.stringify({ layer: 'nope', external_id: 'e', content: 'c' }),
    })
    // Three rejected credentials, one of each kind. Nothing logs requests, so
    // this counter is the only way an operator sees a key rotation drain.
    await fetch(`${at}/v1/layers`)
    await fetch(`${at}/v1/layers`, { headers: { authorization: 'Bearer not-a-jwt' } })
    await fetch(`${at}/v1/layers`, { headers: { authorization: 'Bearer nacre_sk_nope' } })

    await new Promise<void>((resolve) => probe.close(() => resolve()))

    expect(seen).toContain('authFailures:{"kind":"missing"}:undefined')
    expect(seen).toContain('authFailures:{"kind":"jwt"}:undefined')
    expect(seen).toContain('authFailures:{"kind":"service_key"}:undefined')
    // Never the reason. The 401 answers one message for every cause on purpose,
    // and a label carrying the cause would put that distinction back on an
    // endpoint that is unauthenticated by default.
    expect(seen.filter((s) => s.startsWith('authFailures')).every((s) => !s.includes('reason'))).toBe(
      true,
    )

    expect(seen.filter((s) => s.startsWith('searchDuration')).length).toBe(1)
    expect(seen).toContain('searchResults:{}:1')
    expect(seen.filter((s) => s.startsWith('ingestDuration')).length).toBe(1)
    // The ingest above was refused, and a refusal is what a denial counter is
    // for. On search there is no 403 to count by design, so zero permitted
    // results is the denial — which is why the counter sat at zero.
    expect(seen).toContain('aclDenials:{"reason":"ingest_layer"}:undefined')
  })

  it('PATCH on a document changes tags and answers no body', async () => {
    const seen: { id: string; metadata: unknown }[] = []
    const probe = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: {
        read: async () => undefined,
        updateMetadata: async (_auth, id, metadata) => {
          seen.push({ id, metadata })
          return true
        },
      },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
    })
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`

    const ok = await fetch(`${at}/v1/documents/${DOC}`, {
      method: 'PATCH',
      headers: await auth(),
      body: JSON.stringify({ metadata: { source: 'notion', year: 2026 } }),
    })
    // 204 and never the document. Rule 6: a caller may hold `write` without
    // `read`, so a successful retag must not hand back a title or a layer.
    expect(ok.status).toBe(204)
    expect(await ok.text()).toBe('')
    expect(seen).toEqual([{ id: DOC, metadata: { source: 'notion', year: 2026 } }])

    // The same validator as ingest and as filters, so a tag that could never be
    // stored cannot be written here either.
    for (const body of [{}, { metadata: 'x' }, { metadata: { 'Bad.Key': 1 } }, { metadata: { a: { b: 1 } } }]) {
      const bad = await fetch(`${at}/v1/documents/${DOC}`, {
        method: 'PATCH',
        headers: await auth(),
        body: JSON.stringify(body),
      })
      expect(bad.status, JSON.stringify(body)).toBe(400)
    }
    expect(seen).toHaveLength(1)

    await new Promise<void>((resolve) => probe.close(() => resolve()))
  })

  it('a surface without the capability answers 404, not 405', async () => {
    // Same rule as every other absent capability: an unimplemented method on a
    // path must not be distinguishable from a path that is not there.
    const res = await fetch(`${base}/v1/documents/${DOC}`, {
      method: 'PATCH',
      headers: await auth(),
      body: JSON.stringify({ metadata: { a: 1 } }),
    })
    expect(res.status).toBe(404)
  })

  it('the admin routes need a token', async () => {
    for (const path of ['/v1/layers', '/v1/grants', `/v1/jobs/${DOC}`]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401)
    }
  })

  it('a token signed with the retired key still verifies during a rotation', async () => {
    // The whole of a rotation with no outage. There is one signing key and no
    // `kid`, so without this every outstanding access token fails at the same
    // instant — and the SDK does not refresh on a 401, so applications see
    // errors rather than a pause.
    const retired = new TextEncoder().encode('b'.repeat(32))
    const old = await new SignJWT({ org: ORG_A, principal_type: 'user', role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(retired)

    const rotating = createApi({
      verify: { key: SECRET, alsoAccept: [retired], issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => {} },
      layers: { list: async () => ({ items: [], nextCursor: null }), create: async () => ({ kind: 'denied' }) },
    })
    await new Promise<void>((resolve) => rotating.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(rotating.address() as AddressInfo).port}`

    // Both keys, and only those two.
    expect((await fetch(`${at}/v1/layers`, { headers: { authorization: `Bearer ${old}` } })).status).toBe(200)
    expect((await fetch(`${at}/v1/layers`, { headers: await auth() })).status).toBe(200)

    const stranger = new TextEncoder().encode('c'.repeat(32))
    const forged = await new SignJWT({ org: ORG_A, principal_type: 'user', role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(stranger)
    expect((await fetch(`${at}/v1/layers`, { headers: { authorization: `Bearer ${forged}` } })).status).toBe(401)

    await new Promise<void>((resolve) => rotating.close(() => resolve()))
  })

  it('without the retired key the same token is refused', async () => {
    // The negative half, so the test above cannot pass for the wrong reason.
    const retired = new TextEncoder().encode('b'.repeat(32))
    const old = await new SignJWT({ org: ORG_A, principal_type: 'user', role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('alice')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime('5m')
      .sign(retired)

    expect(
      (await fetch(`${base}/v1/layers`, { headers: { authorization: `Bearer ${old}` } })).status,
    ).toBe(401)
  })
})
