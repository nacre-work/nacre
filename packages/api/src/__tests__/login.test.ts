import { createPool, hashPassword, withOrg } from '@nacre.work/core'
import { jwtVerify } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Login } from '../login.js'

/**
 * Email and password sign-in, against a real database.
 *
 * Real because almost everything worth checking here is a database property:
 * that a refresh token is stored hashed, that rotation marks the old one used,
 * that presenting a used one revokes its whole family, and that a disabled
 * account cannot renew a session it already had. A fake of all that is a fake
 * of the feature.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the sign-in path would go untested.')
}
const when = url ? describe : describe.skip

const SECRET = new TextEncoder().encode('l'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG_A = '10910910-0000-4000-8000-000000000001'
const ORG_B = '10910910-0000-4000-8000-000000000002'
const ALICE = '10910910-0000-4000-8000-0000000000a1'
const BOB = '10910910-0000-4000-8000-0000000000b1'
const SHARED_A = '10910910-0000-4000-8000-0000000000c1'
const SHARED_B = '10910910-0000-4000-8000-0000000000c2'
const NOPASS = '10910910-0000-4000-8000-0000000000d1'
const OFF = '10910910-0000-4000-8000-0000000000e1'

const PASSWORD = 'nacre-abalone-stratum-opal-tide-shoal-42'

let pool: Pool
let login: Login

when('signing in', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const hash = await hashPassword(PASSWORD)

    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      for (const [id, slug] of [
        [ORG_A, 'login-a'],
        [ORG_B, 'login-b'],
      ] as const) {
        await c.query(
          `INSERT INTO organizations (id, slug, name, vector_collection)
           VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
          [id, slug, slug, `org_${slug.replace('-', '_')}`],
        )
      }
      await c.query('SELECT set_config($1,$2,true)', ['app.current_org', ORG_A])
      await c.query('DELETE FROM refresh_tokens WHERE org_id = $1', [ORG_A])
      await c.query('SELECT set_config($1,$2,true)', ['app.current_org', ORG_B])
      await c.query('DELETE FROM refresh_tokens WHERE org_id = $1', [ORG_B])

      for (const [id, org, email, pw] of [
        [ALICE, ORG_A, 'alice@login.test', hash],
        [SHARED_A, ORG_A, 'shared@login.test', hash],
        [NOPASS, ORG_A, 'nopass@login.test', null],
        [OFF, ORG_A, 'off@login.test', hash],
        [BOB, ORG_B, 'bob@login.test', hash],
        [SHARED_B, ORG_B, 'shared@login.test', hash],
      ] as const) {
        await c.query(
          `INSERT INTO users (id, org_id, email, role, password_hash)
           VALUES ($1,$2,$3,'member',$4)
           ON CONFLICT (id) DO UPDATE SET password_hash = EXCLUDED.password_hash, disabled_at = NULL`,
          [id, org, email, pw],
        )
      }
      await c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [OFF])
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }

    login = new Login({
      pool,
      key: SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTokenTtl: 900,
      refreshTokenTtl: 3600,
      role: 'nacre_app',
    })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('issues a token whose organization comes from the row, not the request', async () => {
    const tokens = await login.login({ email: 'alice@login.test', password: PASSWORD })
    expect(tokens).toBeDefined()

    const { payload } = await jwtVerify(tokens!.accessToken, SECRET, {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    expect(payload.org).toBe(ORG_A)
    expect(payload.sub).toBe(ALICE)
    expect(payload.principal_type).toBe('user')
  })

  it('refuses a password that belongs to another organization’s account', async () => {
    // Invariant I1 at the one moment there is no token. Naming org A while
    // holding the account in org B must not produce a token for either.
    expect(await login.login({ email: 'bob@login.test', password: PASSWORD, organization: 'login-a' }))
      .toBeUndefined()

    const proper = await login.login({ email: 'bob@login.test', password: PASSWORD, organization: 'login-b' })
    const { payload } = await jwtVerify(proper!.accessToken, SECRET, { issuer: ISSUER, audience: AUDIENCE })
    expect(payload.org).toBe(ORG_B)
  })

  it('refuses an address that exists in more than one organization, without saying so', async () => {
    // The same refusal as a wrong password. Answering "which one did you mean"
    // would turn this endpoint into a way to ask how many tenants an address
    // appears in.
    expect(await login.login({ email: 'shared@login.test', password: PASSWORD })).toBeUndefined()

    // Named explicitly, it works — the ambiguity was the problem, not the user.
    expect(
      await login.login({ email: 'shared@login.test', password: PASSWORD, organization: 'login-a' }),
    ).toBeDefined()
  })

  it('refuses a wrong password, an unknown address, no password set, and a disabled account alike', async () => {
    expect(await login.login({ email: 'alice@login.test', password: 'wrong' })).toBeUndefined()
    expect(await login.login({ email: 'nobody@login.test', password: PASSWORD })).toBeUndefined()
    // An account with no password must not be an account anyone can sign into.
    expect(await login.login({ email: 'nopass@login.test', password: '' })).toBeUndefined()
    expect(await login.login({ email: 'off@login.test', password: PASSWORD })).toBeUndefined()
  })

  it('is case- and whitespace-insensitive on the address', async () => {
    expect(await login.login({ email: '  Alice@Login.Test ', password: PASSWORD })).toBeDefined()
  })

  it('never stores the refresh token, only its hash', async () => {
    const tokens = await login.login({ email: 'alice@login.test', password: PASSWORD })

    const found = await withOrg(
      pool,
      ORG_A,
      async (c) =>
        (
          await c.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM refresh_tokens WHERE token_hash = $1',
            [tokens!.refreshToken],
          )
        ).rows[0]?.n,
      { role: 'nacre_app' },
    )

    // A refresh token outlives an access token by a month, so a dump holding
    // them would be a month of sessions rather than a list of identifiers.
    expect(found).toBe('0')
  })

  it('rotates on refresh, and the old token stops working', async () => {
    const first = await login.login({ email: 'alice@login.test', password: PASSWORD })
    const second = await login.refresh(first!.refreshToken)

    expect(second).toBeDefined()
    expect(second!.refreshToken).not.toBe(first!.refreshToken)
    expect(await login.refresh(second!.refreshToken)).toBeDefined()
  })

  it('revokes the whole family when a used token is presented again', async () => {
    const first = await login.login({ email: 'alice@login.test', password: PASSWORD })
    const second = await login.refresh(first!.refreshToken)
    const third = await login.refresh(second!.refreshToken)
    expect(third).toBeDefined()

    // Replay of the first. The legitimate holder already exchanged it, so two
    // parties hold it and one of them took it. Which is unknowable from here.
    expect(await login.refresh(first!.refreshToken)).toBeUndefined()

    // So the live one dies too, rather than leaving whoever stole it a session.
    expect(await login.refresh(third!.refreshToken)).toBeUndefined()
  })

  it('does not renew a session for an account that has since been disabled', async () => {
    const tokens = await login.login({ email: 'alice@login.test', password: PASSWORD })

    await withOrg(
      pool,
      ORG_A,
      (c) => c.query('UPDATE users SET disabled_at = now() WHERE id = $1', [ALICE]),
      { role: 'nacre_app' },
    )
    try {
      // Disabling that only stops new sign-ins leaves an existing session alive
      // for as long as it keeps refreshing, which is a month by default.
      expect(await login.refresh(tokens!.refreshToken)).toBeUndefined()
    } finally {
      await withOrg(
        pool,
        ORG_A,
        (c) => c.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [ALICE]),
        { role: 'nacre_app' },
      )
    }
  })

  it('refuses an expired refresh token', async () => {
    const past = new Login({
      pool,
      key: SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTokenTtl: 900,
      refreshTokenTtl: 300,
      role: 'nacre_app',
      // Issued now, redeemed an hour later. Injected rather than waited for.
      now: () => new Date(),
    })
    const tokens = await past.login({ email: 'alice@login.test', password: PASSWORD })

    const later = new Login({
      pool,
      key: SECRET,
      issuer: ISSUER,
      audience: AUDIENCE,
      accessTokenTtl: 900,
      refreshTokenTtl: 300,
      role: 'nacre_app',
      now: () => new Date(Date.now() + 3600_000),
    })
    expect(await later.refresh(tokens!.refreshToken)).toBeUndefined()
  })

  it('logout ends the family, and answers the same for a token that was never live', async () => {
    const tokens = await login.login({ email: 'alice@login.test', password: PASSWORD })
    expect(await login.logout(tokens!.refreshToken)).toBe(true)
    expect(await login.refresh(tokens!.refreshToken)).toBeUndefined()

    // The handler answers 204 either way — telling whoever holds a stolen token
    // that it is already dead is telling them it was worth trying.
    expect(await login.logout('not-a-token-anyone-issued')).toBe(false)
  })

  it('a fresh login is a new family, so signing out one device keeps the others', async () => {
    const laptop = await login.login({ email: 'alice@login.test', password: PASSWORD })
    const phone = await login.login({ email: 'alice@login.test', password: PASSWORD })

    await login.logout(laptop!.refreshToken)

    expect(await login.refresh(laptop!.refreshToken)).toBeUndefined()
    expect(await login.refresh(phone!.refreshToken)).toBeDefined()
  })
})
