import { createSecretKey } from 'node:crypto'

import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { authenticate, type Delegations, type VerifyOptions } from '../auth.js'
import { Problem } from '../errors.js'

/**
 * The check docs/authz.md puts before `resolve` on a delegated request.
 *
 * These are unit tests on purpose: the question here is what `authenticate`
 * does with a token, and the database's part — that a revoked connection or a
 * disabled user produces no row — is T18 and T19 against a real Postgres. What
 * cannot be checked there is the shape of the refusal, because every one of
 * them is the same 401 with the same words, which is the point.
 */

const KEY = createSecretKey(Buffer.from('a'.repeat(48)))
const ISSUER = 'https://nacre.test'
const AUDIENCE = 'https://nacre.test'
const ORG = '11111111-1111-1111-1111-111111111111'
const USER = '22222222-2222-2222-2222-222222222222'
const DEL = '33333333-3333-3333-3333-333333333333'

const sign = async (claims: Record<string, unknown>, sub: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

const delegations = (
  answer: Awaited<ReturnType<Delegations['resolve']>>,
  seen?: { orgId?: string; id?: string },
): Delegations => ({
  resolve: async (orgId, id) => {
    if (seen !== undefined) {
      seen.orgId = orgId
      seen.id = id
    }
    return answer
  },
})

const options = (extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
  key: KEY,
  issuer: ISSUER,
  audience: AUDIENCE,
  ...extra,
})

const verify = async (token: string, extra: Partial<VerifyOptions> = {}) =>
  authenticate(`Bearer ${token}`, options(extra), '/v1/search', 'req-1')

describe('a delegated token', () => {
  it('resolves as its user, carrying the delegation and its narrowing', async () => {
    const seen: { orgId?: string; id?: string } = {}
    const token = await sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER)

    const auth = await verify(token, {
      delegations: delegations({ userId: USER, role: 'member', layers: ['layer-a'] }, seen),
    })

    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    // The principal is the person, which is what makes `resolve` unchanged.
    expect(auth.principal).toEqual({ type: 'user', id: USER })
    expect(auth.delegation).toEqual({ id: DEL, layers: ['layer-a'] })
    // Looked up in the organization the token names, never one from elsewhere.
    expect(seen).toEqual({ orgId: ORG, id: DEL })
  })

  it('is refused when the connection no longer resolves', async () => {
    // One answer for a revoked connection, a disabled user and a
    // platform_admin: the adapter returns nothing for all three, and which one
    // applied is not something a caller is told.
    const token = await sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER)
    const refused = await verify(token, { delegations: delegations(undefined) })

    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)
    expect((refused as Problem).toJSON().detail).toBe('The token is not valid.')
  })

  it('takes the role from the row and not from the claim', async () => {
    // An administrator demoted since consent must not keep administering
    // through an application they connected while they still could. A role in a
    // token is a snapshot; the row is current.
    const token = await sign({ org: ORG, principal_type: 'user', role: 'org_admin', del: DEL }, USER)

    const auth = await verify(token, {
      delegations: delegations({ userId: USER, role: 'member' }),
    })

    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(auth.role).toBe('member')
  })

  it('is refused when the token and the connection name different people', async () => {
    // Two copies of one fact, compared rather than one being trusted.
    const token = await sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER)

    const refused = await verify(token, {
      delegations: delegations({ userId: '99999999-9999-9999-9999-999999999999', role: 'member' }),
    })

    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)
  })

  it('is refused when it claims a delegation and nothing can check it', async () => {
    // Invariant 3: a check that cannot run denies. Accepting this as the plain
    // user token it resembles would make an unconfigured deployment the one
    // where a revoked connection keeps working.
    const token = await sign({ org: ORG, principal_type: 'user', role: 'member', del: DEL }, USER)
    const refused = await verify(token)

    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)
  })

  it('is refused when it delegates to something that is not a user', async () => {
    // A delegation is a person lending their own reach. A service account
    // cannot lend one, and the shape that says otherwise is a token nobody
    // should be able to mint — so it is refused here as well as never issued.
    const token = await sign(
      { org: ORG, principal_type: 'service_account', role: 'member', del: DEL },
      USER,
    )

    const refused = await verify(token, {
      delegations: delegations({ userId: USER, role: 'member' }),
    })

    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)
  })

  it('leaves an ordinary token alone, and asks nothing', async () => {
    let asked = false
    const token = await sign({ org: ORG, principal_type: 'user', role: 'org_admin' }, USER)

    const auth = await verify(token, {
      delegations: {
        resolve: async () => {
          asked = true
          return undefined
        },
      },
    })

    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(auth.role).toBe('org_admin')
    expect(auth.delegation).toBeUndefined()
    // A deployment that has never issued one pays nothing on every request.
    expect(asked).toBe(false)
  })
})
