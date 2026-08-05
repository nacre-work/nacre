import { createPool, generateCode, hashCode, verifierMatches, redirectAllowed } from '@nacre.work/core'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresOAuthAuthorizations, PostgresOAuthClients } from '../oauth-store.js'
import { PostgresServiceAccounts } from '../service-keys.js'

/**
 * The consent flow, against a real database.
 *
 * The property under test is not "a code round-trips". It is the one decision
 * the whole feature turns on: **the code is exchanged for authority to act as a
 * service account, and never as the person who approved it.** A consent screen
 * that mints the approver's own token would pass every mechanical check here
 * and be the wrong product.
 *
 * The rest is the part that has to be right because it is a credential:
 * exchange exactly once, PKCE actually compared, and a code that belongs to one
 * organization never readable as another's — the last one against real
 * row-level security, because the cross-tenant lookup this flow needs is the
 * one place the isolation guard is deliberately opened.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the consent flow would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '0a111111-1111-4111-8111-111111111101'
const OTHER = '0a111111-1111-4111-8111-111111111102'
const ADMIN = '0a111111-1111-4111-8111-1111111111a1'
const OTHER_ADMIN = '0a111111-1111-4111-8111-1111111111a2'

const APP_ROLE = 'nacre_app'

let pool: Pool
let clients: PostgresOAuthClients
let authorizations: PostgresOAuthAuthorizations
let accounts: PostgresServiceAccounts

const admin = { orgId: ORG, principal: { type: 'user' as const, id: ADMIN }, role: 'org_admin' as const }
const theirs = { orgId: OTHER, principal: { type: 'user' as const, id: OTHER_ADMIN }, role: 'org_admin' as const }

when('the OAuth consent flow, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    clients = new PostgresOAuthClients(pool, APP_ROLE)
    authorizations = new PostgresOAuthAuthorizations(pool, APP_ROLE)
    accounts = new PostgresServiceAccounts(pool, APP_ROLE)

    const c = await pool.connect()
    try {
      for (const [id, slug, who] of [
        [ORG, 'consentone', ADMIN],
        [OTHER, 'consenttwo', OTHER_ADMIN],
      ] as const) {
        await c.query(
          `INSERT INTO organizations (id, slug, name, vector_collection)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [id, slug, slug, `org_${slug}`],
        )
        await c.query(
          `INSERT INTO users (id, org_id, email, role)
           VALUES ($1,$2,$3,'org_admin') ON CONFLICT DO NOTHING`,
          [who, id, `${slug}@example.test`],
        )
      }
      await c.query('DELETE FROM oauth_authorizations WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM service_accounts WHERE org_id IN ($1,$2)', [ORG, OTHER])
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  const register = async (name: string): Promise<string> => {
    const id = `nacre_client_${randomBytes(8).toString('hex')}`
    await clients.register(name, ['http://127.0.0.1:33418/callback'], id)
    return id
  }

  /** A real PKCE pair, computed the way a client computes it. */
  const pkce = (): { verifier: string; challenge: string } => {
    const verifier = randomBytes(32).toString('base64url')
    return { verifier, challenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') }
  }

  it('exchanges a code for authority over the agent, not over the approver', async () => {
    const clientId = await register('a laptop agent')
    const { verifier, challenge } = pkce()
    const agent = (await accounts.create(admin, 'consent-agent'))!
    const code = generateCode()

    await authorizations.approve(admin, {
      orgId: ORG,
      serviceAccountId: agent.account.id,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
      resource: 'https://api.example.test',
      code,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const approved = await authorizations.redeem(code)
    expect(approved).toBeDefined()
    // The whole point, stated as an assertion: what comes back names the agent.
    expect(approved?.serviceAccountId).toBe(agent.account.id)
    // And never the person. If this ever equals ADMIN, the flow has started
    // handing agents their approver's authority and the permission model has
    // nothing left to say.
    expect(approved?.serviceAccountId).not.toBe(ADMIN)
    expect(approved?.orgId).toBe(ORG)
    expect(verifierMatches(verifier, approved!.codeChallenge)).toBe(true)
  })

  it('is exchangeable exactly once', async () => {
    const clientId = await register('replay client')
    const { challenge } = pkce()
    const agent = (await accounts.create(admin, 'replay-agent'))!
    const code = generateCode()
    await authorizations.approve(admin, {
      orgId: ORG,
      serviceAccountId: agent.account.id,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
      resource: undefined,
      code,
      expiresAt: new Date(Date.now() + 60_000),
    })

    expect(await authorizations.redeem(code)).toBeDefined()
    // A code redeemed twice is the definition of a replay. The refusal is in
    // the UPDATE's own predicate rather than in a read that precedes it, so two
    // concurrent exchanges race for one row and exactly one wins.
    expect(await authorizations.redeem(code)).toBeUndefined()
  })

  it('refuses a code that has expired', async () => {
    const clientId = await register('slow client')
    const { challenge } = pkce()
    const agent = (await accounts.create(admin, 'expired-agent'))!
    const code = generateCode()
    await authorizations.approve(admin, {
      orgId: ORG,
      serviceAccountId: agent.account.id,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
      resource: undefined,
      code,
      expiresAt: new Date(Date.now() - 1000),
    })
    expect(await authorizations.redeem(code)).toBeUndefined()
  })

  it('never stores the code itself', async () => {
    const clientId = await register('storage client')
    const { challenge } = pkce()
    const agent = (await accounts.create(admin, 'stored-agent'))!
    const code = generateCode()
    await authorizations.approve(admin, {
      orgId: ORG,
      serviceAccountId: agent.account.id,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
      resource: undefined,
      code,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const c = await pool.connect()
    try {
      // Hashed, for the reason a service account key is: a readable
      // authorization code in a backup is a credential nobody revoked.
      const { rows } = await c.query<{ code_hash: string }>(
        'SELECT code_hash FROM oauth_authorizations WHERE code_hash = $1',
        [hashCode(code)],
      )
      expect(rows).toHaveLength(1)
      const { rows: plain } = await c.query('SELECT 1 FROM oauth_authorizations WHERE code_hash = $1', [code])
      expect(plain).toHaveLength(0)
    } finally {
      c.release()
    }
  })

  it("cannot be read as another organization's, under real row-level security", async () => {
    const clientId = await register('tenant client')
    const { challenge } = pkce()
    const agent = (await accounts.create(admin, 'tenant-agent'))!
    const code = generateCode()
    await authorizations.approve(admin, {
      orgId: ORG,
      serviceAccountId: agent.account.id,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
      resource: undefined,
      code,
      expiresAt: new Date(Date.now() + 60_000),
    })

    // Scoped to the other organization, as `nacre_app` and with the policy in
    // force: the row is invisible. The lookup the token endpoint makes is
    // deliberately allowed to cross tenants — it has only a code and the row is
    // what says whose it is — and this is the check that the *ordinary* path
    // still cannot.
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL ROLE ${APP_ROLE}`)
      await c.query('SELECT set_config($1, $2, true)', ['app.current_org', OTHER])
      const { rows } = await c.query('SELECT 1 FROM oauth_authorizations WHERE code_hash = $1', [hashCode(code)])
      expect(rows).toHaveLength(0)
      await c.query('COMMIT')
    } finally {
      c.release()
    }

    // And it is still there for the organization it belongs to.
    expect(await authorizations.redeem(code)).toBeDefined()
  })

  it('records who created an agent, and leaves it null when nobody did', async () => {
    const mine = (await accounts.create(admin, 'owned-agent'))!
    expect(mine.account.createdBy).toBe(ADMIN)

    // An agent creating an agent leaves no owner rather than naming the parent:
    // an owner is a person who can be asked about it, and a chain of agents is
    // not an answer to "whose is this".
    const byAgent = (await accounts.create(
      { orgId: ORG, principal: { type: 'service_account', id: mine.account.id }, role: 'org_admin' },
      'agent-made-agent',
    ))!
    expect(byAgent.account.createdBy).toBeNull()
  })

  it('keeps a code inside the organization it was approved in', async () => {
    // The composite foreign key, not the code that writes the insert: an
    // authorization naming an agent from another organization is refused by the
    // database.
    const foreign = (await accounts.create(theirs, 'foreign-agent'))!
    const clientId = await register('crossing client')
    await expect(
      authorizations.approve(admin, {
        orgId: ORG,
        serviceAccountId: foreign.account.id,
        clientId,
        redirectUri: 'http://127.0.0.1:33418/callback',
        codeChallenge: pkce().challenge,
        resource: undefined,
        code: generateCode(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow()
  })
})

describe('what a redirect URI may be', () => {
  const registered = [
    'https://app.example.com/cb',
    'http://127.0.0.1:1234/cb',
    'http://localhost:1234/cb',
    'http://example.com/cb',
  ]

  it('takes https anywhere and http only on loopback', () => {
    expect(redirectAllowed('https://app.example.com/cb', registered)).toBe(true)
    // RFC 8252: a native application listens on loopback, which is exactly the
    // MCP client case.
    expect(redirectAllowed('http://127.0.0.1:1234/cb', registered)).toBe(true)
    expect(redirectAllowed('http://localhost:1234/cb', registered)).toBe(true)
    // A code delivered over plain HTTP to a routable address is a code on the
    // wire.
    expect(redirectAllowed('http://example.com/cb', registered)).toBe(false)
  })

  it('compares exactly, with no normalisation to be exploited', () => {
    // Every relaxation here is a way to deliver a code somewhere the client did
    // not register: a trailing slash, a different case, a longer path.
    expect(redirectAllowed('https://app.example.com/cb/', registered)).toBe(false)
    expect(redirectAllowed('https://app.example.com/cb/../evil', registered)).toBe(false)
    expect(redirectAllowed('https://APP.example.com/cb', registered)).toBe(false)
    expect(redirectAllowed('https://app.example.com/cb?x=1', registered)).toBe(false)
    expect(redirectAllowed('https://evil.example.com/cb', registered)).toBe(false)
  })
})

describe('PKCE', () => {
  it('accepts the verifier that produced the challenge and nothing else', () => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
    expect(verifierMatches(verifier, challenge)).toBe(true)
    expect(verifierMatches(`${verifier}x`, challenge)).toBe(false)
    expect(verifierMatches(randomBytes(32).toString('base64url'), challenge)).toBe(false)
    // A length mismatch must answer false rather than raise: `timingSafeEqual`
    // throws on unequal lengths, so a wrong-length verifier would otherwise be
    // a 500 and a right-length one a comparison.
    expect(verifierMatches('short', challenge)).toBe(false)
    expect(() => verifierMatches('', '')).not.toThrow()
  })
})
