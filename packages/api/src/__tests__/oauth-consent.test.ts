import {
  consentRedirect,
  createPool,
  generateCode,
  hashCode,
  verifierMatches,
  redirectAllowed,
} from '@nacre.work/core'
import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
} from '../oauth-store.js'
import { PostgresServiceAccounts } from '../service-keys.js'

/**
 * The consent flow, against a real database.
 *
 * The property under test is not "a code round-trips". It is that a code is
 * exchanged for the authority the person **chose**, and for nothing else. This
 * file covers the agent half: naming a service account gets that account's
 * reach and never the approver's, which is what keeps "what may this agent
 * read" a separate question from "what may you read". The delegated half is
 * `packages/core/authz/__tests__/delegation.test.ts` — T16-T22.
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
let consents: PostgresOAuthConsents
let refresh: PostgresOAuthRefreshTokens

const admin = { orgId: ORG, principal: { type: 'user' as const, id: ADMIN }, role: 'org_admin' as const }
const theirs = { orgId: OTHER, principal: { type: 'user' as const, id: OTHER_ADMIN }, role: 'org_admin' as const }

when('the OAuth consent flow, against the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    clients = new PostgresOAuthClients(pool, APP_ROLE)
    authorizations = new PostgresOAuthAuthorizations(pool, APP_ROLE)
    accounts = new PostgresServiceAccounts(pool, APP_ROLE)
    consents = new PostgresOAuthConsents(pool, APP_ROLE)
    refresh = new PostgresOAuthRefreshTokens(pool, APP_ROLE)

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
      await c.query('DELETE FROM oauth_refresh_tokens WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM oauth_authorizations WHERE org_id IN ($1,$2)', [ORG, OTHER])
      await c.query('DELETE FROM oauth_consents WHERE org_id IN ($1,$2)', [ORG, OTHER])
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

  /**
   * The rotation, narrowed past the one answer that is not a refusal and not a
   * token. Cases that are not about suspension say so by going through this.
   */
  const granted = <T>(rotated: T | 'suspended'): Exclude<T, 'suspended'> => {
    expect(rotated).not.toBe('suspended')
    return rotated as Exclude<T, 'suspended'>
  }

  const setDisabled = async (id: string, disabled: boolean): Promise<void> => {
    const c = await pool.connect()
    try {
      await c.query('UPDATE users SET disabled_at = $2 WHERE id = $1', [id, disabled ? new Date() : null])
    } finally {
      c.release()
    }
  }

  it('exchanges a code for authority over the agent, not over the approver', async () => {
    const clientId = await register('a laptop agent')
    const { verifier, challenge } = pkce()
    const agent = (await accounts.create(admin, 'consent-agent'))!
    const code = generateCode()

    await authorizations.approve(admin, {
      orgId: ORG,
      subject: { actsAs: 'service_account', serviceAccountId: agent.account.id } as const,
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
    expect(approved?.subject).toEqual({ actsAs: 'service_account', serviceAccountId: agent.account.id })
    // And never the person. If this ever equals ADMIN, the flow has started
    // handing agents their approver's authority and the permission model has
    // nothing left to say.
    expect(approved?.subject).not.toEqual({ actsAs: 'service_account', serviceAccountId: ADMIN })
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
      subject: { actsAs: 'service_account', serviceAccountId: agent.account.id } as const,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
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
      subject: { actsAs: 'service_account', serviceAccountId: agent.account.id } as const,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
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
      subject: { actsAs: 'service_account', serviceAccountId: agent.account.id } as const,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
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
      subject: { actsAs: 'service_account', serviceAccountId: agent.account.id } as const,
      clientId,
      redirectUri: 'http://127.0.0.1:33418/callback',
      codeChallenge: challenge,
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

  /**
   * Forgetting an application.
   *
   * The property is that the connection stops being renewable, and that it
   * stops for *that application* rather than for the agent — several
   * applications can act as one agent, and revoking the agent is a different
   * and much larger act that lives on another screen.
   */
  it('ends one connection without touching the agent or the others', async () => {
    const agent = (await accounts.create(admin, 'shared-agent'))!
    const first = await register('first app')
    const second = await register('second app')

    const c1 = await consents.record(admin, first, { actsAs: 'service_account', serviceAccountId: agent.account.id })
    const c2 = await consents.record(admin, second, { actsAs: 'service_account', serviceAccountId: agent.account.id })
    expect(c1).not.toBe(c2)

    const t1 = generateCode()
    const t2 = generateCode()
    await refresh.issue(ORG, c1, t1, undefined, new Date(Date.now() + 60_000))
    await refresh.issue(ORG, c2, t2, undefined, new Date(Date.now() + 60_000))

    expect(await consents.revoke(admin, c1)).toBe(true)

    // The forgotten one cannot renew...
    expect(await refresh.rotate(t1)).toBeUndefined()
    // ...and the other is untouched, which is the whole distinction between
    // forgetting an application and revoking an agent.
    expect(granted(await refresh.rotate(t2))?.subject).toEqual({
      actsAs: 'service_account',
      serviceAccountId: agent.account.id,
    })

    // Ending it twice is not an error the second time, it is a no.
    expect(await consents.revoke(admin, c1)).toBe(false)

    const listed = await consents.list(admin)
    expect(listed.find((c) => c.id === c1)?.revokedAt).not.toBeNull()
    expect(listed.find((c) => c.id === c2)?.revokedAt).toBeNull()
  })

  it('reuses the connection when the same application is approved again', async () => {
    const agent = (await accounts.create(admin, 'reapproved-agent'))!
    const app = await register('returning app')

    const once = await consents.record(admin, app, { actsAs: 'service_account', serviceAccountId: agent.account.id })
    expect(await consents.revoke(admin, once)).toBe(true)

    // Approving again is the same connection, not a second one: a screen full
    // of duplicates is one where ending a connection leaves the others working.
    // And the revocation is cleared, or the person would be shown a connection
    // marked ended while the client works.
    const again = await consents.record(admin, app, { actsAs: 'service_account', serviceAccountId: agent.account.id })
    expect(again).toBe(once)
    expect((await consents.list(admin)).find((c) => c.id === once)?.revokedAt).toBeNull()
  })

  it('rotates a refresh token, and ends the family on a replay', async () => {
    const agent = (await accounts.create(admin, 'rotating-agent'))!
    const app = await register('rotating app')
    const consentId = await consents.record(admin, app, { actsAs: 'service_account', serviceAccountId: agent.account.id })

    const first = generateCode()
    await refresh.issue(ORG, consentId, first, undefined, new Date(Date.now() + 60_000))

    const rotated = granted(await refresh.rotate(first))
    expect(rotated?.subject).toEqual({ actsAs: 'service_account', serviceAccountId: agent.account.id })
    const second = generateCode()
    await refresh.issue(ORG, consentId, second, rotated!.family, new Date(Date.now() + 60_000))

    // Replaying the spent one: the legitimate holder has already exchanged it,
    // so two parties hold it and there is no telling which is genuine. Neither
    // continues — the whole family goes, not just the token.
    expect(await refresh.rotate(first)).toBeUndefined()
    expect(await refresh.rotate(second)).toBeUndefined()
  })

  it('suspends a delegation while its person is disabled, and restores it', async () => {
    // The promise docs/authz.md makes about disabling somebody: it is
    // reversible, so the connections they approved are *suspended* rather than
    // ended, and re-enabling is a restoration rather than a reconnection.
    //
    // The refusal was indistinguishable from a dead token — same `undefined`,
    // and therefore the same `invalid_grant` on the wire — so the half of the
    // promise that lives in the client was never kept: nothing retries a token
    // it was told is invalid. Suspension is its own answer now, and this is the
    // case that says so.
    const person = '0a111111-1111-4111-8111-1111111111b7'
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$2,$3,'member')
         ON CONFLICT (id) DO UPDATE SET disabled_at = NULL`,
        [person, ORG, 'suspendable@example.test'],
      )
    } finally {
      c.release()
    }

    const app = await register('an app a person connected')
    const consentId = await consents.record(
      { orgId: ORG, principal: { type: 'user', id: person }, role: 'member' },
      app,
      { actsAs: 'user', userId: person },
    )
    const token = generateCode()
    await refresh.issue(ORG, consentId, token, undefined, new Date(Date.now() + 60_000))

    await setDisabled(person, true)
    // Not `undefined`: the distinction is the whole point, because the caller
    // turns one into "start again" and the other into "not yet".
    expect(await refresh.rotate(token)).toBe('suspended')
    // And asked twice, because a suspension that spent the token on the way
    // past would answer differently the second time — which is exactly what
    // would make re-enabling a reconnection.
    expect(await refresh.rotate(token)).toBe('suspended')

    await setDisabled(person, false)
    // The same token, never reissued and never replaced.
    const restored = granted(await refresh.rotate(token))
    expect(restored?.subject).toEqual({ actsAs: 'user', userId: person })
    expect(restored?.consentId).toBe(consentId)
  })

  it('shows a member their own connections and an administrator the organization\'s', async () => {
    const agent = (await accounts.create(admin, 'visibility-agent'))!
    const app = await register('visible app')
    const mine = await consents.record(admin, app, { actsAs: 'service_account', serviceAccountId: agent.account.id })

    // A different person in the same organization, not an administrator.
    const c = await pool.connect()
    const someone = '0a111111-1111-4111-8111-1111111111b1'
    try {
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$2,'member@example.test','member')
         ON CONFLICT DO NOTHING`,
        [someone, ORG],
      )
    } finally {
      c.release()
    }
    const member = { orgId: ORG, principal: { type: 'user' as const, id: someone }, role: 'member' as const }

    expect((await consents.list(member)).some((x) => x.id === mine)).toBe(false)
    expect((await consents.list(admin)).some((x) => x.id === mine)).toBe(true)
    // And they cannot end what they cannot see — the same answer as "no such
    // connection", which is invariant 4.
    expect(await consents.revoke(member, mine)).toBe(false)
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
        subject: { actsAs: 'service_account', serviceAccountId: foreign.account.id } as const,
        clientId,
        redirectUri: 'http://127.0.0.1:33418/callback',
        codeChallenge: pkce().challenge,
          code: generateCode(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toThrow()
  })
})

describe('where /oauth/authorize sends the browser', () => {
  const request = new URLSearchParams({
    response_type: 'code',
    client_id: 'nacre_client_x',
    redirect_uri: 'http://127.0.0.1:6274/oauth/callback',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
    state: 's',
  })

  /**
   * The one assertion that matters, and the one nothing made until the flow was
   * run end to end: **the SPA route survives**.
   *
   * `NACRE_OAUTH_CONSENT_URL` defaults to `…/#/consent`, and the handler
   * assigned the fragment rather than appending to it — so the browser landed
   * on `#response_type=code&…`, the hash router saw no route, and the person
   * got the default view with no way to approve anything. Everything about the
   * request was intact and the screen it belonged to never rendered.
   *
   * `readRequest` in the consent view is the other half: it strips a leading
   * `/consent?` before parsing. These two are only correct together, which is
   * why the shape is pinned here rather than left to each side's assumption.
   */
  it('keeps the hash route and appends the request to it', () => {
    const to = new URL(consentRedirect('http://admin.example.test/#/consent', request))
    expect(to.origin + to.pathname).toBe('http://admin.example.test/')
    expect(to.hash.startsWith('#/consent?')).toBe(true)

    const parsed = new URLSearchParams(to.hash.replace(/^#\/consent\??/, ''))
    expect(parsed.get('client_id')).toBe('nacre_client_x')
    expect(parsed.get('redirect_uri')).toBe('http://127.0.0.1:6274/oauth/callback')
    expect(parsed.get('code_challenge')).toBe('abc')
    expect(parsed.get('state')).toBe('s')
  })

  it('leaves a consent URL with no route alone', () => {
    // A deployment serving the consent screen at its own path rather than
    // through a hash router. There is nothing to preserve, so nothing is
    // invented — the request is the whole fragment.
    const to = new URL(consentRedirect('https://consent.example.test/approve', request))
    expect(to.pathname).toBe('/approve')
    expect(to.hash.startsWith('#response_type=code')).toBe(true)
  })

  it('does not double the separator on a route already ending in ?', () => {
    const to = new URL(consentRedirect('http://admin.example.test/#/consent?', request))
    expect(to.hash.startsWith('#/consent?response_type=')).toBe(true)
    expect(to.hash).not.toContain('??')
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
