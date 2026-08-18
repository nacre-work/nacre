import { createPool, hashPassword, verifyPassword, withOrg, type Mailer, type Message } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PasswordRecovery } from '../recovery.js'

/**
 * Password recovery, against a real PostgreSQL.
 *
 * Everything interesting here is the database's: a link spent by the UPDATE
 * that finds it rather than by a read and a write, an expiry, every other
 * session ending, and the silence for an address that has no account.
 *
 * The mailer records rather than sends, which is the one part that would be a
 * mock either way — what a relay does with a message is not this product's
 * property. What *is* its property is that a message is produced at all, and
 * that none is produced for an address it must not confirm.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; password recovery would go untested.')
}

const OLD = 'the old password here'
const NEW = 'a properly long password'

let pool: Pool
let recovery: PasswordRecovery
let orgId: string
let userId: string
let sent: Message[]

const when = url ? describe : describe.skip

const linkIn = (message: Message): string => {
  const found = /https:\/\/\S+/u.exec(message.text)
  if (found === null) throw new Error('the message carried no link')
  return decodeURIComponent(new URL(found[0]).hash.split('token=')[1] ?? '')
}

when('password recovery', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const client = await pool.connect()
    try {
      await client.query("DELETE FROM organizations WHERE slug = 'recoverx'")
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO organizations (slug, name, vector_collection)
         VALUES ('recoverx','recoverx','org_recoverx') RETURNING id`,
      )
      orgId = rows[0]!.id
      const { rows: people } = await client.query<{ id: string }>(
        `INSERT INTO users (org_id, email, role, password_hash)
         VALUES ($1,'dana@recover.test','org_admin',$2) RETURNING id`,
        [orgId, await hashPassword(OLD)],
      )
      userId = people[0]!.id
      await client.query(
        `INSERT INTO refresh_tokens (org_id, user_id, token_hash, family_id, expires_at)
         VALUES ($1,$2,'a-live-session-for-recovery', gen_random_uuid(), now() + interval '1 day')`,
        [orgId, userId],
      )
    } finally {
      client.release()
    }

    sent = []
    const mailer: Mailer = {
      send: async (message) => {
        sent.push(message)
      },
    }
    recovery = new PasswordRecovery({ pool, mailer, consoleBase: 'https://console.example' })
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('says nothing about an address that has no account', async () => {
    await recovery.request('nobody@recover.test')
    expect(sent).toHaveLength(0)
  })

  it('sends one link, spends it once, and ends every other session', async () => {
    await recovery.request('  Dana@Recover.Test ')
    expect(sent).toHaveLength(1)

    const token = linkIn(sent[0]!)
    // The organization travels in the token, so redemption reads through
    // `withOrg` and this path opens no cross-tenant lookup — see 0008's note
    // about `users` getting no `authenticating` policy on purpose.
    expect(token.startsWith(`${orgId}.`)).toBe(true)

    expect(await recovery.redeem(token, 'short')).toBe('too-short')
    // Refusing on length must not spend the link, or a typo costs a person
    // their one chance at it.
    expect(await recovery.redeem(token, NEW)).toBe('reset')
    expect(await recovery.redeem(token, 'another long password!!')).toBe('refused')

    const { rows } = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [userId],
    )
    expect(await verifyPassword(NEW, rows[0]!.password_hash)).toBe(true)
    expect(await verifyPassword(OLD, rows[0]!.password_hash)).toBe(false)

    const { rows: sessions } = await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM refresh_tokens WHERE org_id = $1 AND user_id = $2',
      [orgId, userId],
    )
    expect(sessions[0]?.revoked_at).not.toBeNull()

    // The person who did not do this is the one who needs to know.
    expect(sent).toHaveLength(2)
    expect(sent[1]?.subject).toMatch(/was changed/u)
  })

  it('refuses a link that has expired', async () => {
    await recovery.request('dana@recover.test')
    const token = linkIn(sent.at(-1)!)
    await withOrg(pool, orgId, (client) =>
      client.query(
        "UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL",
      ),
    )
    expect(await recovery.redeem(token, 'yet another long password')).toBe('refused')
  })

  it('is silent about an account that has been disabled', async () => {
    await pool.query('UPDATE users SET disabled_at = now() WHERE id = $1', [userId])
    const before = sent.length
    await recovery.request('dana@recover.test')
    expect(sent).toHaveLength(before)
  })
})
