import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { authenticate } from '../auth.js'
import { Problem } from '../errors.js'
import {
  generateKey,
  hashOf,
  KEY_PREFIX,
  looksLikeServiceKey,
  PostgresServiceAccounts,
  PostgresServiceKeys,
  prefixOf,
} from '../service-keys.js'

/**
 * Service account keys.
 *
 * The one credential meant to outlive a session, and therefore the one whose
 * failures are worth being paranoid about: a key that survives revocation, a
 * key that authenticates into the wrong organization, or a key recoverable from
 * the database are each worse than anything the token path can do, because a
 * token expires on its own and this does not.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the service key path would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const OTHER = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

const admin = { orgId: ORG, principal: { type: 'user' as const, id: 'u1' }, role: 'org_admin' as const }

let pool: Pool
let accounts: PostgresServiceAccounts
let keys: PostgresServiceKeys

describe('key shape', () => {
  it('a key is opaque, prefixed, and not a UUID', () => {
    const key = generateKey()
    expect(key.startsWith(KEY_PREFIX)).toBe(true)
    expect(looksLikeServiceKey(key)).toBe(true)
    // 32 bytes from the CSPRNG. A UUID is 122 bits of which several are fixed,
    // and it is routinely treated as an identifier rather than a secret.
    expect(key.length).toBeGreaterThan(KEY_PREFIX.length + 40)
  })

  it('two keys never collide', () => {
    const many = new Set(Array.from({ length: 500 }, () => generateKey()))
    expect(many.size).toBe(500)
  })

  it('the stored prefix is not enough to reconstruct the key', () => {
    const key = generateKey()
    expect(prefixOf(key).length).toBe(KEY_PREFIX.length + 8)
    expect(key.startsWith(prefixOf(key))).toBe(true)
    expect(prefixOf(key).length).toBeLessThan(key.length / 2)
  })

  it('the hash is not the key', () => {
    const key = generateKey()
    expect(hashOf(key)).not.toContain(key.slice(KEY_PREFIX.length))
    expect(hashOf(key)).toBe(hashOf(key))
    expect(hashOf(key)).not.toBe(hashOf(generateKey()))
  })
})

when('service accounts, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    accounts = new PostgresServiceAccounts(pool, 'nacre_app')
    keys = new PostgresServiceKeys(pool, 'nacre_app')

    const c = await pool.connect()
    try {
      for (const [id, slug] of [
        [ORG, 'keysone'],
        [OTHER, 'keystwo'],
      ] as const) {
        await c.query(
          // slug is citext and name is text; one parameter cannot feed both.
          `INSERT INTO organizations (id, slug, name, vector_collection)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, slug, slug, `org_${slug}`],
        )
      }
      await c.query(`DELETE FROM service_accounts WHERE org_id IN ($1,$2)`, [ORG, OTHER])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  it('a new key authenticates as its own organization, as a member', async () => {
    const { key, account } = (await accounts.create(admin, 'agent'))!

    const resolved = await keys.resolve(key)
    expect(resolved?.orgId).toBe(ORG)
    expect(resolved?.principal).toEqual({ type: 'service_account', id: account.id })
    // Never an admin by virtue of being a service account. Everything it can
    // reach comes from a grant — which is what "permissions are exactly the
    // service account's" has to mean if it means anything.
    expect(resolved?.role).toBe('member')
  })

  it('the key is never readable again', async () => {
    const { key, account } = (await accounts.create(admin, 'agent-2'))!

    const listed = ((await accounts.list(admin)).items).find((a) => a.id === account.id)
    expect(listed).toBeDefined()
    expect(JSON.stringify(listed)).not.toContain(key.slice(KEY_PREFIX.length))
    // The prefix is shown so two keys can be told apart when revoking one.
    expect(listed?.keyPrefix).toBe(prefixOf(key))
  })

  it('a revoked key stops working immediately', async () => {
    const { key, account } = (await accounts.create(admin, 'agent-3'))!
    expect(await keys.resolve(key)).toBeDefined()

    expect(await accounts.revoke(admin, account.id)).toBe(true)

    // No TTL, no propagation window, nothing to wait for. Unlike a token, this
    // credential has no expiry of its own, so revocation is the only thing that
    // ever ends it.
    expect(await keys.resolve(key)).toBeUndefined()
  })

  it('revoking twice is not an error the second time, it is a no', async () => {
    const { account } = (await accounts.create(admin, 'agent-4'))!
    expect(await accounts.revoke(admin, account.id)).toBe(true)
    expect(await accounts.revoke(admin, account.id)).toBe(false)
  })

  it('a revoked key is still listed, and says when', async () => {
    const { account } = (await accounts.create(admin, 'agent-5'))!
    await accounts.revoke(admin, account.id)

    const listed = ((await accounts.list(admin)).items).find((a) => a.id === account.id)
    // A key that vanishes on revocation looks like one that never existed, and
    // the audit log refers to this id — a row that disappears turns every past
    // event into an unresolvable reference.
    expect(listed?.revokedAt).not.toBeNull()
  })

  it('another organization cannot revoke this one’s key', async () => {
    const { key, account } = (await accounts.create(admin, 'agent-6'))!
    const intruder = { ...admin, orgId: OTHER }

    expect(await accounts.revoke(intruder, account.id)).toBe(false)
    expect(await keys.resolve(key), 'the key must still work').toBeDefined()
  })

  it('a name already taken is a refusal, not an internal error', async () => {
    const first = (await accounts.create(admin, 'duplicate-name'))!
    expect(first.key).toBeDefined()

    // The name is unique per organization. It used to raise the constraint
    // violation out of the handler, which answered 500 — an error page for a
    // form validation, with the constraint name in the log and nothing on
    // screen. Found by driving the UI, not by a test.
    expect(await accounts.create(admin, 'duplicate-name')).toBeUndefined()
  })

  it('the same name in another organization is fine', async () => {
    await accounts.create(admin, 'shared-name')
    // Unique per organization, not globally. A tenant must not be able to
    // discover another's account names by watching which ones are refused.
    expect(await accounts.create({ ...admin, orgId: OTHER }, 'shared-name')).toBeDefined()
  })

  it('a refused name creates nothing', async () => {
    await accounts.create(admin, 'once-only')
    const before = ((await accounts.list(admin)).items).filter((a) => a.name === 'once-only').length
    await accounts.create(admin, 'once-only')
    const after = ((await accounts.list(admin)).items).filter((a) => a.name === 'once-only').length

    // ON CONFLICT DO NOTHING rather than a caught exception: the insert is
    // inside the transaction withOrg opens, and a raised constraint error
    // would abort everything after it.
    expect(after).toBe(before)
  })

  it('another organization does not see this one’s keys', async () => {
    (await accounts.create(admin, 'agent-7'))!
    const theirs = (await accounts.list({ ...admin, orgId: OTHER })).items
    expect(theirs.every((a) => a.name !== 'agent-7')).toBe(true)
  })

  it('a key that does not exist, and a mangled one, resolve to nothing', async () => {
    const { key } = (await accounts.create(admin, 'agent-8'))!

    for (const bad of [
      generateKey(),
      `${key}x`,
      key.slice(0, -1),
      `${prefixOf(key)}${'A'.repeat(43)}`,
      'nacre_sk_',
      'not-a-key',
    ]) {
      expect(await keys.resolve(bad), bad.slice(0, 20)).toBeUndefined()
    }
  })

  it('a key with the right prefix and the wrong secret is refused', async () => {
    const { key } = (await accounts.create(admin, 'agent-9'))!

    // The prefix is the indexed lookup, not the credential. If the hash
    // comparison were ever dropped, every one of these would authenticate as
    // the real account — and the prefix is stored in clear and shown in
    // listings, so it is not a secret to begin with.
    const forged = `${prefixOf(key)}${'B'.repeat(key.length - prefixOf(key).length)}`
    expect(forged.startsWith(prefixOf(key))).toBe(true)
    expect(await keys.resolve(forged)).toBeUndefined()
  })

  it('authenticate() answers a bad key exactly as it answers a bad token', async () => {
    const verify = {
      key: new TextEncoder().encode('a'.repeat(32)),
      issuer: 'https://api.nacre.test',
      audience: 'nacre',
      serviceKeys: keys,
    }

    const badKey = await authenticate(`Bearer ${generateKey()}`, verify, '/v1/search', 'r1')
    const badToken = await authenticate('Bearer not-a-token', verify, '/v1/search', 'r1')

    expect(badKey).toBeInstanceOf(Problem)
    expect(badToken).toBeInstanceOf(Problem)
    // "Revoked key", "unknown key" and "expired token" are one answer. Telling
    // them apart says which guess was closest, and a key is guessable in a way
    // a signature is not.
    expect((badKey as Problem).toJSON()).toEqual((badToken as Problem).toJSON())
  })

  it('authenticate() accepts a real key and carries its organization', async () => {
    const { key, account } = (await accounts.create(admin, 'agent-10'))!
    const resolved = await authenticate(
      `Bearer ${key}`,
      {
        key: new TextEncoder().encode('a'.repeat(32)),
        issuer: 'https://api.nacre.test',
        audience: 'nacre',
        serviceKeys: keys,
      },
      '/v1/search',
      'r1',
    )

    expect(resolved).not.toBeInstanceOf(Problem)
    const context = resolved as { orgId: string; principal: { type: string; id: string } }
    expect(context.orgId).toBe(ORG)
    // The account it names, not just some account in the right organization.
    // Every grant is keyed on this id, so resolving to the wrong one would
    // hand the caller another service account's permissions.
    expect(context.principal).toEqual({ type: 'service_account', id: account.id })
  })

  it('a surface with no resolver refuses keys rather than ignoring the prefix', async () => {
    const { key } = (await accounts.create(admin, 'agent-11'))!
    const result = await authenticate(
      `Bearer ${key}`,
      {
        key: new TextEncoder().encode('a'.repeat(32)),
        issuer: 'https://api.nacre.test',
        audience: 'nacre',
      },
      '/v1/search',
      'r1',
    )

    // Falling through to the JWT path would try to verify an opaque string as a
    // signed token. That fails today, but it fails for the wrong reason, and
    // "this credential type is not served here" should not depend on that.
    expect(result).toBeInstanceOf(Problem)
  })

  it('using a key records when, without touching the decision', async () => {
    const { key, account } = (await accounts.create(admin, 'agent-12'))!
    expect(((await accounts.list(admin)).items).find((a) => a.id === account.id)?.lastUsedAt).toBeNull()

    expect(await keys.resolve(key)).toBeDefined()
    await new Promise((r) => setTimeout(r, 50))

    expect(((await accounts.list(admin)).items).find((a) => a.id === account.id)?.lastUsedAt).not.toBeNull()
  })
})
