import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  hashPassword,
  needsRehash,
  spendVerificationTime,
  verifyPassword,
  whileAuthenticating,
  withOrg,
} from '@nacre.work/core'
import { SignJWT } from 'jose'
import type { Pool, PoolClient } from 'pg'

/**
 * Email and password sign-in.
 *
 * The last thing in `docs/api.md` that was described and not built. Until now
 * the only credentials were a token printed by `init` — valid for an hour,
 * signed with a symmetric secret, and printed into somebody's shell history —
 * and service account keys, which are for programs.
 *
 * SSO is a commercial module. This is the one every self-hoster gets, which is
 * why it is here rather than there.
 *
 * ## Invariant I1 at the one moment there is no token
 *
 * "The organization comes from the token, never from a body" governs
 * authenticated requests. Login is the request that has no token yet, and the
 * rule still shapes it: the body may name an organization, but only as part of
 * the lookup key. **What ends up in the token is the `org_id` on the row that
 * authenticated**, never the string the caller sent. A caller who names one
 * organization and holds a password in another gets a refusal, not a token for
 * either.
 *
 * The slug is optional because a single-organization installation — which is
 * what the open core is — should not make people type it. Omitted, the email
 * has to match exactly one user in the whole installation; zero and several
 * are the same refusal, so this cannot be used to ask how many organizations
 * an address appears in.
 *
 * ## One refusal, always
 *
 * Unknown address, wrong password, wrong organization, disabled account, an
 * account with no password set: all `401`, same wording, same time spent. The
 * timing is why `spendVerificationTime` exists — an early return on "no such
 * user" makes the response time an oracle for which addresses have accounts,
 * and that would undo the care taken everywhere else about not confirming what
 * exists.
 */

const ACCESS_MIN_SECONDS = 60

export interface LoginRequest {
  readonly email: string
  readonly password: string
  /** Optional; see the note on invariant I1 above. */
  readonly organization?: string
}

export interface Tokens {
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresIn: number
  /**
   * Who this was issued to, so the caller can audit it.
   *
   * The audit log is per-organization, and on a successful sign-in there is one
   * to write to. On a failure there is not — an address that matches no user
   * belongs to no tenant, and inventing an owner for that row would put one
   * organization's failed attempts in another's access log. Failures are logged
   * by the process instead; see the handler.
   */
  readonly orgId: string
  readonly userId: string
}

export interface LoginDeps {
  readonly pool: Pool
  readonly key: Uint8Array
  readonly issuer: string
  readonly audience: string
  readonly accessTokenTtl: number
  readonly refreshTokenTtl: number
  readonly role?: string
  /** Injected so tests are not asked to wait for wall-clock expiry. */
  readonly now?: () => Date
}

interface UserRow {
  readonly id: string
  readonly org_id: string
  readonly role: string
  readonly password_hash: string | null
  readonly disabled_at: Date | null
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

/** 32 bytes from the CSPRNG. Opaque — it is looked up, never parsed. */
const mint = (): string => randomBytes(32).toString('base64url')

export class Login {
  constructor(private readonly deps: LoginDeps) {}

  private get scope(): { role?: string } {
    return this.deps.role === undefined ? {} : { role: this.deps.role }
  }

  private get clock(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * Sign in, or refuse.
   *
   * `undefined` for every reason it can fail. The caller turns it into one
   * `401` with one message.
   */
  async login(request: LoginRequest): Promise<Tokens | undefined> {
    const email = request.email.trim().toLowerCase()
    if (email === '' || request.password === '') {
      // Still spend the time. A short-circuit on an empty field is a free probe
      // for how long the real path takes.
      await spendVerificationTime(request.password)
      return undefined
    }

    const candidate = await this.find(email, request.organization)
    if (candidate === undefined || candidate.password_hash === null || candidate.disabled_at !== null) {
      await spendVerificationTime(request.password)
      return undefined
    }

    if (!(await verifyPassword(request.password, candidate.password_hash))) return undefined

    // The only moment the plaintext exists, so the only moment a stored hash
    // made with weaker parameters can be brought up to date.
    if (needsRehash(candidate.password_hash)) {
      const rehashed = await hashPassword(request.password)
      await withOrg(
        this.deps.pool,
        candidate.org_id,
        (client) =>
          client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [rehashed, candidate.id]),
        this.scope,
      ).catch(() => undefined)
    }

    return this.issue(candidate, undefined)
  }

  /**
   * Find the one user this login is about, without saying how many nearly were.
   *
   * `organizations` carries no row-level security — an organization is not
   * inside one — so the slug resolves on an ordinary connection, and the user
   * is then read through `withOrg` like everything else. That is why the login
   * path needs no cross-tenant read and no escape hatch: it is two scoped
   * queries rather than one unscoped one.
   */
  private async find(email: string, organization: string | undefined): Promise<UserRow | undefined> {
    if (organization !== undefined && organization.trim() !== '') {
      const orgId = await this.orgIdForSlug(organization.trim().toLowerCase())
      if (orgId === undefined) return undefined
      return this.userIn(orgId, email)
    }

    // No slug. Which is the ordinary case for the single-organization
    // installation the open core is, and has to stay silent about how many
    // organizations exist when it is not.
    const orgIds = await this.allOrgIds()
    const found: UserRow[] = []
    for (const orgId of orgIds) {
      const row = await this.userIn(orgId, email)
      if (row !== undefined) found.push(row)
      // Two is already ambiguous; there is nothing to learn from a third, and
      // stopping keeps the cost of a login independent of how many tenants a
      // deployment has.
      if (found.length > 1) return undefined
    }
    return found[0]
  }

  private async orgIdForSlug(slug: string): Promise<string | undefined> {
    const client = await this.deps.pool.connect()
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM organizations WHERE slug = $1 AND deleted_at IS NULL',
        [slug],
      )
      return rows[0]?.id
    } finally {
      client.release()
    }
  }

  private async allOrgIds(): Promise<readonly string[]> {
    const client = await this.deps.pool.connect()
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM organizations WHERE deleted_at IS NULL',
      )
      return rows.map((r) => r.id)
    } finally {
      client.release()
    }
  }

  private async userIn(orgId: string, email: string): Promise<UserRow | undefined> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<UserRow>(
          `SELECT id, org_id, role, password_hash, disabled_at
             FROM users WHERE org_id = $1 AND email = $2`,
          [orgId, email],
        )
        return rows[0]
      },
      this.scope,
    )
  }

  /**
   * Exchange a refresh token for a new pair, or refuse.
   *
   * Rotation on every use. A token presented after it has been used is not
   * tolerated as a client retry: the legitimate holder already exchanged it, so
   * a second presentation means two parties hold the same token and one of them
   * took it. Which one is unknowable from here, so the whole family is revoked
   * and both sign in again.
   */
  async refresh(token: string): Promise<Tokens | undefined> {
    const row = await whileAuthenticating(
      this.deps.pool,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          org_id: string
          user_id: string
          family_id: string
          expires_at: Date
          used_at: Date | null
          revoked_at: Date | null
          token_hash: string
        }>(
          `SELECT id, org_id, user_id, family_id, expires_at, used_at, revoked_at, token_hash
             FROM refresh_tokens WHERE token_hash = $1`,
          [digest(token)],
        )
        return rows[0]
      },
      this.scope,
    )

    if (row === undefined) return undefined

    // Constant-time on the hash as well. The lookup already matched it, so this
    // guards only against a future where the query becomes a prefix match — but
    // that is exactly the change that would otherwise turn this into an oracle.
    const presented = Buffer.from(digest(token), 'utf8')
    const stored = Buffer.from(row.token_hash, 'utf8')
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined

    if (row.revoked_at !== null) return undefined

    if (row.expires_at.getTime() <= this.clock.getTime()) return undefined

    // Everything from here is one transaction, serialized on the family.
    //
    // The read above is diagnosis, not the decision. Checking `used_at` in
    // application code and writing it later is a read-modify-write, and under
    // concurrency every request reads null before any of them writes: eight
    // simultaneous redemptions of one stolen token all succeeded, each with a
    // fresh session, and the reuse detection never fired. Rotation without an
    // atomic claim detects nothing — it only makes theft quieter.
    //
    // `used_at IS NULL` in the WHERE clause is the claim, and the advisory lock
    // is what makes the revocation that follows a loss complete: without it a
    // revoke whose statement began before this transaction committed cannot see
    // the row inserted here, so the token the winner just obtained would
    // survive the revocation meant to catch it.
    const outcome = await withOrg(
      this.deps.pool,
      row.org_id,
      async (client): Promise<Tokens | 'lost' | 'gone'> => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [row.family_id])

        const claimed = await client.query<{ id: string }>(
          `UPDATE refresh_tokens SET used_at = now()
            WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
            RETURNING id`,
          [row.id],
        )
        if (claimed.rows[0] === undefined) return 'lost'

        const { rows } = await client.query<UserRow>(
          `SELECT id, org_id, role, password_hash, disabled_at
             FROM users WHERE id = $1 AND org_id = $2`,
          [row.user_id, row.org_id],
        )
        const user = rows[0]
        if (user === undefined || user.disabled_at !== null) return 'gone'

        return this.issue(user, row.family_id, client)
      },
      this.scope,
    )

    if (outcome === 'lost') {
      // Someone already spent this one. Two parties hold the same token and
      // there is no way to tell which is genuine, so the session ends for both.
      await this.revokeFamily(row.org_id, row.family_id)
      return undefined
    }

    if (outcome === 'gone') {
      // Disabling an account has to end its sessions, or it only stops new
      // ones. The claim above is committed, so the token is spent either way —
      // a refusal here must not leave it redeemable.
      await this.revokeFamily(row.org_id, row.family_id)
      return undefined
    }

    return outcome
  }

  /** Sign out. Ends the family, not just this token. */
  async logout(token: string): Promise<boolean> {
    const row = await whileAuthenticating(
      this.deps.pool,
      async (client) => {
        const { rows } = await client.query<{ org_id: string; family_id: string }>(
          'SELECT org_id, family_id FROM refresh_tokens WHERE token_hash = $1 AND revoked_at IS NULL',
          [digest(token)],
        )
        return rows[0]
      },
      this.scope,
    )

    if (row === undefined) return false
    await this.revokeFamily(row.org_id, row.family_id)
    return true
  }

  /**
   * End every token descended from one login.
   *
   * Takes the same advisory lock the rotation path takes, and that is what
   * makes it complete rather than approximately complete. Without it the two
   * interleave badly: a statement's snapshot is fixed when the statement
   * starts, so a revoke that begins before a rotation commits will not see the
   * row that rotation inserts — and the token the racing party just obtained
   * survives the revocation that was supposed to catch it. Serialized on the
   * family, the revoke either runs first (and the rotation then finds the
   * family revoked) or runs second (and sees the new row).
   */
  private async revokeFamily(orgId: string, familyId: string): Promise<void> {
    await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [familyId])
        await client.query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL',
          [familyId],
        )
      },
      this.scope,
    )
  }

  /**
   * Mint an access token and the refresh token that succeeds it.
   *
   * `family` carries across a rotation so the whole chain from one login can be
   * revoked together; a fresh login starts a new one, so signing out of one
   * device does not sign out of the others.
   */
  private async issue(
    user: UserRow,
    family: string | undefined,
    client?: PoolClient,
  ): Promise<Tokens> {
    const ttl = Math.max(ACCESS_MIN_SECONDS, this.deps.accessTokenTtl)
    const now = this.clock

    const accessToken = await new SignJWT({
      // From the row that authenticated, never from the request. This is the
      // line invariant I1 is about.
      org: user.org_id,
      principal_type: 'user',
      role: user.role,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer(this.deps.issuer)
      .setAudience(this.deps.audience)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + ttl)
      .sign(this.deps.key)

    const refreshToken = mint()
    const expiresAt = new Date(now.getTime() + this.deps.refreshTokenTtl * 1000)

    const insert = (client: PoolClient): Promise<unknown> =>
      client.query(
        `INSERT INTO refresh_tokens (org_id, user_id, token_hash, family_id, expires_at)
         VALUES ($1, $2, $3, COALESCE($4::uuid, gen_random_uuid()), $5)`,
        [user.org_id, user.id, digest(refreshToken), family ?? null, expiresAt],
      )

    // On a rotation the caller hands in its own transaction, so the claim and
    // the token that replaces it commit together — a crash between them would
    // otherwise spend a token and issue nothing, ending a session for no
    // reason. A fresh login has no transaction to join and opens its own.
    if (client !== undefined) await insert(client)
    else await withOrg(
      this.deps.pool,
      user.org_id,
      insert,
      this.scope,
    )

    return { accessToken, refreshToken, expiresIn: ttl, orgId: user.org_id, userId: user.id }
  }
}
