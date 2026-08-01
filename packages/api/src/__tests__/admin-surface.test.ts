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

describe('the administrative surface', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
      jobs: {
        read: async (orgId, jobId) =>
          orgId === ORG_A && jobId === DOC
            ? { jobId: DOC, documentId: DOC, status: 'indexed', progress: 1 }
            : undefined,
      },
      layers: {
        list: async () => [{ id: LAYER, slug: 'handbook', name: 'Handbook', workspaceId: WS_MINE }],
        // `denied` for "may not administer" and "no such workspace" alike;
        // `conflict` only once the caller has proved admin on the workspace.
        create: async (_a: AuthContext, input) =>
          input.workspaceId !== WS_MINE
            ? { kind: 'denied' as const }
            : input.slug === 'taken'
              ? { kind: 'conflict' as const }
              : {
                  kind: 'created' as const,
                  layer: { id: LAYER, slug: input.slug, name: input.name, workspaceId: WS_MINE },
                },
      },
      grants: {
        list: async () => [],
        issue: async (_a, input): Promise<GrantRecord | undefined> => {
          if (input.scopeId !== LAYER) return undefined
          issued.push(input)
          return { ...input, id: 'grant-1', effect: 'allow', source: 'api' }
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
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

  it('the admin routes need a token', async () => {
    for (const path of ['/v1/layers', '/v1/grants', `/v1/jobs/${DOC}`]) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(401)
    }
  })
})
