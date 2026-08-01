import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { createApi, type AuditEvent, type AuthContext } from '@nacre.work/api'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * T2 and T8 — the two cases that are properties of the response rather than of
 * the plan.
 *
 * They live here, next to the rest of the leak suite, because that is where the
 * gate is. The surface is exercised over a real socket with a real signed
 * token; the storage behind it is injected, since what is under test is what
 * the API says, not what the database holds.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

const DOC_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const DOC_B = 'bbbbbbbb-0000-4000-8000-000000000001'
const DOC_NOWHERE = 'cccccccc-0000-4000-8000-000000000001'

/** The problem+json shape, so tests can read fields without casting at each use. */
interface ProblemBody {
  readonly type: string
  readonly title: string
  readonly status: number
  readonly detail: string
  readonly instance: string
  readonly request_id: string
}

const problemOf = async (r: Response): Promise<ProblemBody> => (await r.json()) as ProblemBody

/**
 * Everything except the two fields that describe the request rather than the
 * answer: `instance` echoes a path the caller already knows, and `request_id`
 * is per request. A difference anywhere else — a word in `detail`, a different
 * `type` — is an oracle.
 */
async function answerOnly(r: Response): Promise<Omit<ProblemBody, 'instance' | 'request_id'>> {
  const { instance, request_id, ...rest } = await problemOf(r)
  void instance
  void request_id
  return rest
}

/** Documents keyed by organization. Undefined for absent and for foreign alike. */
const STORE: Record<string, Record<string, { id: string; title: string }>> = {
  [ORG_A]: { [DOC_A]: { id: DOC_A, title: 'Contract A' } },
  [ORG_B]: { [DOC_B]: { id: DOC_B, title: 'Contract B' } },
}

const audited: AuditEvent[] = []

let server: Server
let base: string

async function token(orgId: string): Promise<string> {
  return new SignJWT({ org: orgId, principal_type: 'user', role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

describe('baseline · the HTTP surface', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: {
        read: async (orgId, id) => STORE[orgId]?.[id],
      },
      search: {
        search: async (auth: AuthContext) => [{ org: auth.orgId }],
      },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('T2 · a body naming an organization is refused with 403 and journaled', async () => {
    audited.length = 0
    const res = await fetch(`${base}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(ORG_A)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything', org_id: ORG_B }),
    })

    expect(res.status).toBe(403)
    const body = await problemOf(res)
    expect(body.type).toContain('forbidden')
    expect(body.request_id).toBeTruthy()

    const attempt = audited.find((e) => e.action === 'tenant_override_attempt')
    expect(attempt, 'the attempt must reach the journal').toBeDefined()
    expect(attempt?.result).toBe('deny')
    // Journaled against the token's organization, not the one the body claimed.
    expect(attempt?.orgId).toBe(ORG_A)
  })

  it('T2 · a nested org_id is caught too', async () => {
    const res = await fetch(`${base}/v1/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(ORG_A)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything', filters: { meta: { org_id: ORG_B } } }),
    })
    expect(res.status).toBe(403)
  })

  it('T2 · the query string and headers are covered as well', async () => {
    const auth = { authorization: `Bearer ${await token(ORG_A)}` }

    const viaQuery = await fetch(`${base}/v1/search?org_id=${ORG_B}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything' }),
    })
    expect(viaQuery.status).toBe(403)

    const viaHeader = await fetch(`${base}/v1/search`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', 'x-org-id': ORG_B },
      body: JSON.stringify({ query: 'anything' }),
    })
    expect(viaHeader.status).toBe(403)
  })

  it('T8 · another organization’s document is 404, not 403', async () => {
    const res = await fetch(`${base}/v1/documents/${DOC_B}`, {
      headers: { authorization: `Bearer ${await token(ORG_A)}` },
    })
    expect(res.status).toBe(404)
  })

  it('T8 · invisible and absent are byte-identical apart from the request id', async () => {
    const auth = { authorization: `Bearer ${await token(ORG_A)}` }

    const foreign = await fetch(`${base}/v1/documents/${DOC_B}`, { headers: auth })
    const missing = await fetch(`${base}/v1/documents/${DOC_NOWHERE}`, { headers: auth })

    expect(foreign.status).toBe(missing.status)
    expect(foreign.headers.get('content-type')).toBe(missing.headers.get('content-type'))

    expect(await answerOnly(foreign)).toEqual(await answerOnly(missing))
  })

  it('the caller’s own document is returned', async () => {
    const res = await fetch(`${base}/v1/documents/${DOC_A}`, {
      headers: { authorization: `Bearer ${await token(ORG_A)}` },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { id: string }).id).toBe(DOC_A)
  })

  it('a token for another organization does not reach this one’s document', async () => {
    const res = await fetch(`${base}/v1/documents/${DOC_A}`, {
      headers: { authorization: `Bearer ${await token(ORG_B)}` },
    })
    expect(res.status).toBe(404)
  })

  it('every way a token can fail verification says the same thing', async () => {
    // Not "every 401 is identical" — a missing Authorization header is about
    // the shape of the request and telling the caller so reveals nothing. What
    // must not be distinguishable is *why a token was rejected*: knowing that
    // the signature was fine but the audience was wrong tells an attacker which
    // guess was closest.
    const signed = (claims: Record<string, unknown>, issuer: string, audience: string, exp: string) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('alice')
        .setIssuer(issuer)
        .setAudience(audience)
        .setExpirationTime(exp)
        .sign(SECRET)

    const claims = { org: ORG_A, principal_type: 'user', role: 'member' }
    const tokens = [
      'not-a-token',
      await signed(claims, 'https://not-us.test', AUDIENCE, '5m'),      // wrong issuer
      await signed(claims, ISSUER, 'somebody-else', '5m'),              // wrong audience
      await signed(claims, ISSUER, AUDIENCE, '-1h'),                    // expired
      await signed({ principal_type: 'user' }, ISSUER, AUDIENCE, '5m'), // verifies, says nothing
    ]

    const bodies: Omit<ProblemBody, 'instance' | 'request_id'>[] = []
    for (const value of tokens) {
      const res = await fetch(`${base}/v1/documents/${DOC_A}`, {
        headers: { authorization: `Bearer ${value}` },
      })
      expect(res.status, `token: ${value.slice(0, 24)}`).toBe(401)
      bodies.push(await answerOnly(res))
    }

    for (const body of bodies) expect(body).toEqual(bodies[0])
  })

  it('a missing header is a 401 too, and may say so plainly', async () => {
    const res = await fetch(`${base}/v1/documents/${DOC_A}`)
    expect(res.status).toBe(401)
  })

  it('health touches no dependency and needs no token', async () => {
    const res = await fetch(`${base}/v1/health`)
    expect(res.status).toBe(200)
  })
})
