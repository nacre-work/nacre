import { createPool, hashPassword, verifyPassword } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Login } from '../login.js'

/**
 * A person changing their own password, against a real PostgreSQL.
 *
 * Everything interesting here is the database's, and it is all about *ordering*
 * inside one transaction: the row is updated, every refresh token for the
 * account is revoked, and the pair that comes back is inserted after the
 * revocation rather than before it. Get that order wrong and the endpoint
 * answers `200` with a refresh token it has just revoked — the caller works
 * until its access token expires and is then signed out fifteen minutes after a
 * password change that succeeded, which reads as the change having broken
 * something. No mock has an opinion about which statement ran first.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the password change would go untested.')
}

const OLD = 'the old password here'
const NEW = 'a properly long new password'

const SECRET = new TextEncoder().encode('a'.repeat(32))

let pool: Pool
let login: Login
let orgId: string
let userId: string

const when = url ? describe : describe.skip

when('changing your own password', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const client = await pool.connect()
    try {
      await client.query("DELETE FROM organizations WHERE slug = 'changepw'")
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, vector_collection)
         VALUES ('changepw','changepw','org_changepw') RETURNING id`,
      )
      orgId = rows[0]!.id
      const { rows: people } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'dana@changepw.test','org_admin',$2) RETURNING id`,
        [orgId, await hashPassword(OLD)],
      )
      userId = people[0]!.id
      // Two other devices, so "every other session" is more than a figure of
      // speech and a single revocation cannot pass by accident.
      for (const hash of ['a-phone', 'a-laptop']) {
        await client.query(
          `INSERT INTO refresh_tokens (org_id, user_id, token_hash, family_id, expires_at)
           VALUES ($1,$2,$3, gen_random_uuid(), now() + interval '1 day')`,
          [orgId, userId, hash],
        )
      }
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
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('refuses a wrong current password and changes nothing', async () => {
    expect(await login.changePassword(orgId, userId, 'not the password', NEW)).toBe('wrong-password')

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    )
    expect(await verifyPassword(OLD, rows[0]!.password_hash)).toBe(true)

    // And the refusal costs nobody their sessions. A wrong password is a typo
    // far more often than it is an attack, and signing somebody out of three
    // devices for one is a denial of service anybody can perform.
    const { rows: live } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
    expect(Number(live[0]!.n)).toBe(2)
  })

  it('changes the password, ends every other session, and hands back a live one', async () => {
    const outcome = await login.changePassword(orgId, userId, OLD, NEW)
    if (typeof outcome === 'string') throw new Error(`expected a change, got ${outcome}`)
    // No gate is registered here, so the only outcome a change can have is a
    // session. Narrowed rather than asserted away: a gate arriving later would
    // make this a compile error rather than a silent pass on a different shape.
    if (outcome.kind !== 'changed') throw new Error(`expected a change, got ${outcome.kind}`)

    // The address comes back so the caller can send the notice without a second
    // read of a row it has already got in hand.
    expect(outcome.email).toBe('dana@changepw.test')

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    )
    expect(await verifyPassword(NEW, rows[0]!.password_hash)).toBe(true)
    expect(await verifyPassword(OLD, rows[0]!.password_hash)).toBe(false)

    // The two devices are out, and exactly one token is live: the one just
    // issued. Counting rather than asserting on each is what catches the
    // ordering — a pair inserted before the revocation leaves *none* live.
    const { rows: live } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    )
    expect(Number(live[0]!.n)).toBe(1)

    // And it is live in the sense that matters: it can be exchanged. Reading
    // `revoked_at IS NULL` proves the column; this proves the session.
    const renewed = await login.refresh(outcome.tokens.refreshToken)
    expect(renewed).toBeDefined()
  })

  it('is refused for a disabled account', async () => {
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [userId])
    expect(await login.changePassword(orgId, userId, NEW, 'a third long password')).toBe('no-user')
    await pool.query('UPDATE users SET disabled_at = NULL WHERE id = $1', [userId])
  })
})
