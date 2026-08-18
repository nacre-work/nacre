import { createPool, hashPassword, registerSignInGate, resetExtensionsForTests, withLoadingModuleForTests } from '@nacre.work/core'
import type { SignInContext, SignInVerdict } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { Login } from '../login.js'

/**
 * A registered sign-in gate, against a real PostgreSQL.
 *
 * The gate itself is arithmetic and is unit-tested in the core. What needs a
 * database is *where it runs*: the claim this file exists to hold is that every
 * path from a verified credential to a session passes it, and there are four of
 * them — a password with no factor asked for, a completed second factor, a
 * spent refresh token, and a password change. A gate wired beside three of the
 * four is a policy an operator turned on and a door it never closed, which is
 * exactly the shape of defect no unit test sees.
 *
 * The refresh case is the one that cannot be faked at all. It needs a row that
 * a previous session inserted, an advisory lock, and a claim that commits — so
 * "does turning a policy on reach somebody who is already signed in" is a
 * question only Postgres can answer.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the sign-in gate would go untested.')
}

const PASSWORD = 'a properly long password here'
const SECRET = new TextEncoder().encode('g'.repeat(32))

let pool: Pool
let login: Login
let withFactors: Login
let orgId: string
let userId: string

/** What each gate call saw, so the context can be asserted rather than assumed. */
let seen: SignInContext[] = []

const install = (verdict: SignInVerdict): void => {
  withLoadingModuleForTests('policy', () =>
    registerSignInGate({
      name: 'second-factor',
      check: async (context) => {
        seen.push(context)
        return verdict
      },
    }),
  )
}

const when = url ? describe : describe.skip

when('a registered sign-in gate', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const client = await pool.connect()
    try {
      await client.query("DELETE FROM organizations WHERE slug = 'gate'")
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, vector_collection)
         VALUES ('gate','gate','org_gate') RETURNING id`,
      )
      orgId = rows[0]!.id
      const { rows: people } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'gil@gate.test','org_admin',$2) RETURNING id`,
        [orgId, await hashPassword(PASSWORD)],
      )
      userId = people[0]!.id
    } finally {
      client.release()
    }

    login = new Login({
      pool,
      key: SECRET,
      issuer: 'https://api.nacre.test',
      audience: 'nacre',
      accessTokenTtl: 900,
      refreshTokenTtl: 86_400,
    })

    // The same signing key, so the challenges are interchangeable as *tokens*
    // and only the purpose claim separates them — which is the property the
    // case below is about. `required` answers true so that `login` produces a
    // sign-in challenge to compare against, and `verify` admits anything so a
    // refusal can only be the purpose check.
    withFactors = new Login({
      pool,
      key: SECRET,
      issuer: 'https://api.nacre.test',
      audience: 'nacre',
      accessTokenTtl: 900,
      refreshTokenTtl: 86_400,
      secondFactors: {
        required: async () => true,
        verify: async () => true,
        beginWebAuthnAssertion: async () => undefined,
        verifyWebAuthnAssertion: async () => true,
      },
    })
  })

  afterEach(() => {
    resetExtensionsForTests()
    seen = []
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('changes nothing with no gate registered, which is the open core', async () => {
    const outcome = await login.login({ email: 'gil@gate.test', password: PASSWORD })
    expect(outcome?.kind).toBe('tokens')
  })

  it('refuses a sign-in in the gate’s own words', async () => {
    install({ kind: 'refuse', reason: 'This organization is suspended.' })
    const outcome = await login.login({ email: 'gil@gate.test', password: PASSWORD })
    expect(outcome).toEqual({ kind: 'refused', reason: 'This organization is suspended.' })
    // The password was right. A refusal here is a policy decision and never
    // "those credentials are not valid" — the two are different facts and only
    // one of them is something the person can act on.
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe('password')
  })

  it('hands back an enrolment challenge, and it is not a session', async () => {
    // Counted before and after rather than against zero. The case above signs
    // in successfully and leaves a token behind, so an absolute count asserts
    // the order these cases happen to run in — which is a test that fails when
    // somebody adds one above it and passes for no reason when they do not.
    const live = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      )
      return Number(rows[0]!.n)
    }
    const before = await live()

    install({ kind: 'enrol', reason: 'Acme requires a second factor.' })
    const outcome = await login.login({ email: 'gil@gate.test', password: PASSWORD })
    expect(outcome?.kind).toBe('enrol-second-factor')
    const challenge = (outcome as { challenge: string }).challenge
    expect(challenge.length).toBeGreaterThan(20)
    expect((outcome as { reason: string }).reason).toBe('Acme requires a second factor.')

    // No session was minted, which is the point: a refusal that left a refresh
    // token behind would be a policy that hands out what it just refused.
    expect(await live()).toBe(before)
  })

  /*
   * The two challenge kinds share an audience and are separated by a purpose
   * claim, so this is the case that says the claim is actually consulted.
   *
   * An enrolment challenge that could be spent on `completeSecondFactor` would
   * be the weaker ceremony minting the input to the stronger one — a person
   * sent away to enrol could instead present the token they were given and be
   * asked only for a code they do not have.
   */
  it('will not spend an enrolment challenge on the second half of a sign-in', async () => {
    install({ kind: 'enrol', reason: 'enrol first' })
    const outcome = await login.login({ email: 'gil@gate.test', password: PASSWORD })
    const challenge = (outcome as { challenge: string }).challenge
    resetExtensionsForTests()

    // Asked of a Login that **has** a second-factor store, and that is the
    // whole of why `withFactors` exists.
    //
    // The first version of this case used the Login above, which has none — so
    // `completeSecondFactor` returned on its `gate === undefined` guard one
    // line before it ever read the challenge, and the case passed with the
    // purpose check deleted. A projection narrow enough that it cannot fail is
    // the defect this repository names most often, and it was in the case
    // written to prove the separation. Measured: removing the purpose
    // comparison left the old version green and turns this one red.
    //
    // The store admits any code, so a challenge that got past the purpose check
    // would produce a session — which is exactly the failure being guarded
    // against, and makes the refusal below mean the one thing it should.
    expect(await withFactors.readEnrolmentChallenge(challenge)).toEqual({ orgId, userId })
    expect(
      await withFactors.completeSecondFactor(challenge, { kind: 'code', code: '000000' }),
    ).toBeUndefined()

    // And the reverse: a sign-in challenge is not an enrolment one. Same claim,
    // other direction, because a purpose check that held one way and not the
    // other would be a check on the spelling rather than on the pair.
    const signIn = await withFactors.login({ email: 'gil@gate.test', password: PASSWORD })
    expect(signIn?.kind).toBe('second-factor')
    expect(
      await withFactors.readEnrolmentChallenge((signIn as { challenge: string }).challenge),
    ).toBeUndefined()
  })

  it('reaches a renewal, so turning a policy on does not wait for every session to expire', async () => {
    const first = await login.login({ email: 'gil@gate.test', password: PASSWORD })
    expect(first?.kind).toBe('tokens')
    const refresh = (first as { tokens: { refreshToken: string } }).tokens.refreshToken

    install({ kind: 'enrol', reason: 'Acme requires a second factor.' })
    const renewed = await login.refresh(refresh)
    expect(renewed?.kind).toBe('enrol-second-factor')
    expect(seen.at(-1)?.path).toBe('refresh')

    // The refresh token is spent either way — the claim commits before the
    // gates are asked — so this is the end of that session and the challenge is
    // the way on rather than a retry.
    resetExtensionsForTests()
    expect(await login.refresh(refresh)).toBeUndefined()
  })

  it('reaches a password change, and the password is still changed', async () => {
    const NEXT = 'another properly long password'
    install({ kind: 'enrol', reason: 'Acme requires a second factor.' })
    const outcome = await login.changePassword(orgId, userId, PASSWORD, NEXT)
    expect(typeof outcome === 'string' ? outcome : outcome.kind).toBe('enrol-second-factor')
    expect(seen.at(-1)?.path).toBe('password-change')

    // The statement committed before the session was minted, so this is a
    // person with a new password and no session — not a change that failed.
    // Reporting it as a failure would leave them signing in with a password
    // that no longer works.
    resetExtensionsForTests()
    const after = await login.login({ email: 'gil@gate.test', password: NEXT })
    expect(after?.kind).toBe('tokens')

    // Put it back for whatever runs next.
    await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      userId,
      await hashPassword(PASSWORD),
    ])
  })

  it('is told what the account holds, which is not what was proved', async () => {
    install({ kind: 'admit' })
    await login.login({ email: 'gil@gate.test', password: PASSWORD })
    // No factor on this account and none proved, and the two arrive as two
    // fields rather than one — a gate that could not tell them apart would read
    // every renewal as a password-only sign-in.
    expect(seen[0]).toMatchObject({ orgId, userId, enrolled: false, secondFactor: undefined })
  })
})
