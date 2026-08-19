import { createPool, hashPassword } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT } from 'jose'

import { createApi } from '../server.js'
import { PostgresUsers } from '../principals.js'
import { SecondFactors } from '../second-factor.js'
import { Login } from '../login.js'

/**
 * A shared account has no personal-credential surface, against a real
 * PostgreSQL.
 *
 * The case this exists for was live on a public stand: two demo logins printed
 * on a page, and until this column any visitor could enrol a second factor on
 * one of them. That locks out every other visitor **permanently** — an
 * administrator deliberately cannot remove somebody's second factor — so the
 * only repair is to rebuild the demonstration. Changing the password does the
 * same, and the password is on the page.
 *
 * Wants a database because the guarantee is one: the trigger is what holds when
 * a route is added later and forgets, and a route check tested against a mocked
 * store proves the check rather than the property.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the shared-account guard would go untested.')
}

const PASSWORD = 'a properly long password here'
const SECRET = new TextEncoder().encode('s'.repeat(32))
const SEAL = Buffer.alloc(32, 3)

let pool: Pool
let users: PostgresUsers
let factors: SecondFactors
let login: Login
let orgId: string
let sharedId: string
let personId: string

const when = url ? describe : describe.skip

when('a shared account', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const client = await pool.connect()
    try {
      await client.query("DELETE FROM organizations WHERE slug = 'sharedacct'")
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, vector_collection)
         VALUES ('sharedacct','sharedacct','org_sharedacct') RETURNING id`,
      )
      orgId = rows[0]!.id
      const hash = await hashPassword(PASSWORD)
      const { rows: s } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash, shared)
         VALUES ($1,'demo@sharedacct.test','member',$2,true) RETURNING id`,
        [orgId, hash],
      )
      sharedId = s[0]!.id
      const { rows: p } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'pat@sharedacct.test','member',$2) RETURNING id`,
        [orgId, hash],
      )
      personId = p[0]!.id
    } finally {
      client.release()
    }

    users = new PostgresUsers(pool)
    factors = new SecondFactors({
      pool,
      key: SEAL,
      issuer: 'api.nacre.test',
      relyingParty: { id: 'nacre.test', name: 'nacre.test', origins: ['https://nacre.test'] },
    })
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

  it('is what the column says, and an ordinary account is not', async () => {
    expect(await users.isShared(orgId, sharedId)).toBe(true)
    expect(await users.isShared(orgId, personId)).toBe(false)
  })

  it('answers false for an id that is not there, rather than raising', async () => {
    // The routes have already authenticated the id they ask about, so this is
    // about not becoming a way to find out which ids exist.
    expect(await users.isShared(orgId, '00000000-0000-4000-8000-000000000000')).toBe(false)
  })

  /*
   * The structural half, and the reason it is a trigger rather than a second
   * copy of the route check.
   *
   * The routes refuse first and answer 404, which is what a caller sees. This
   * is what holds when a route is added later and forgets — an enrolment is
   * refused by the database whichever surface issued it, so the worst a
   * forgotten check produces is a 500 rather than a locked-out demonstration.
   */
  it('cannot hold a second factor, and the database is what refuses', async () => {
    await expect(factors.begin(orgId, sharedId, 'Authenticator')).rejects.toThrow(
      /shared account cannot hold a second factor/,
    )
  })

  it('lets an ordinary account in the same organization enrol', async () => {
    const begun = await factors.begin(orgId, personId, 'Authenticator')
    expect(begun?.secret.length ?? 0).toBeGreaterThan(10)
  })

  /*
   * `required` is what sign-in asks, so a shared account must answer false —
   * otherwise a factor somehow present would demand a code nobody has, and the
   * demonstration would be dead in the other direction.
   */
  it('is never asked for a second factor at sign-in', async () => {
    expect(await factors.required(orgId, sharedId)).toBe(false)
  })

  it('signs in with the password, which is the whole point of publishing one', async () => {
    const outcome = await login.login({ email: 'demo@sharedacct.test', password: PASSWORD })
    expect(outcome?.kind).toBe('tokens')
  })

  /*
   * The password is the other half. It is printed on a page, so anybody holding
   * it could otherwise change it — and every other holder is locked out with no
   * administrative route back except reissuing the credential.
   */
  it('cannot change its own password, while an ordinary account can', async () => {
    expect(await login.changePassword(orgId, sharedId, PASSWORD, 'a different long password')).toBe(
      'shared',
    )

    const changed = await login.changePassword(orgId, personId, PASSWORD, 'a different long password')
    expect(typeof changed === 'string' ? changed : changed.kind).toBe('changed')
  })

  /*
   * And the same thing as a caller meets it, over the real routes.
   *
   * The stores above are the guarantee; this is the answer. `404` on all three
   * rather than `403`, which is what a service account and a delegation already
   * get there: the surface is not there for this principal rather than one it
   * is being kept out of. And `holds_own_credentials` is what lets a screen
   * leave the controls off instead of drawing ones that answer 404.
   */
  it('answers 404 on the whole credential surface, and says so on /v1/me', async () => {
    const ISSUER = 'https://api.nacre.test'
    const AUD = 'nacre'
    const api: Server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUD },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
      login,
      secondFactors: factors,
      users,
    })
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const bearer = async (id: string): Promise<string> =>
      `Bearer ${await new SignJWT({ org: orgId, principal_type: 'user', role: 'member' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(id)
        .setIssuer(ISSUER)
        .setAudience(AUD)
        .setExpirationTime('5m')
        .sign(SECRET)}`

    const surface = async (id: string): Promise<Record<string, unknown>> => {
      const authorization = await bearer(id)
      const json = { authorization, 'content-type': 'application/json' }
      const [list, enrol, password, me] = await Promise.all([
        fetch(`${base}/v1/me/second-factor`, { headers: { authorization } }),
        fetch(`${base}/v1/me/second-factor`, { method: 'POST', headers: json, body: '{}' }),
        fetch(`${base}/v1/me/password`, {
          method: 'POST',
          headers: json,
          body: JSON.stringify({ current_password: PASSWORD, new_password: 'another long password' }),
        }),
        fetch(`${base}/v1/me`, { headers: { authorization } }),
      ])
      return {
        list: list.status,
        enrol: enrol.status,
        password: password.status,
        holds: ((await me.json()) as { holds_own_credentials?: unknown }).holds_own_credentials,
      }
    }

    // A fresh person, because the password case above already changed the other
    // one's — an assertion that depends on the order these run in is one that
    // breaks when somebody adds a case above it.
    const client = await pool.connect()
    let freshId: string
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'fresh@sharedacct.test','member',$2) RETURNING id`,
        [orgId, await hashPassword(PASSWORD)],
      )
      freshId = rows[0]!.id
    } finally {
      client.release()
    }

    expect(await surface(sharedId)).toEqual({ list: 404, enrol: 404, password: 404, holds: false })
    expect(await surface(freshId)).toEqual({ list: 200, enrol: 201, password: 200, holds: true })

    await new Promise<void>((r) => api.close(() => r()))
  })

  it('still has its password set by an administrator, which is how one is rotated', async () => {
    const auth = {
      orgId,
      role: 'org_admin' as const,
      principal: { type: 'user' as const, id: personId },
    }
    const reset = await users.resetPassword(auth as never, sharedId)
    expect(typeof reset === 'string' ? reset : reset.password.length).toBeGreaterThan(10)
  })
})
