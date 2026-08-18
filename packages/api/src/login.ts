import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  hashPassword,
  needsRehash,
  spendVerificationTime,
  verifyPassword,
  whileAuthenticating,
  withOrg,
} from '@nacre.work/core'
import type { KeyObject } from 'node:crypto'

import { jwtVerify, SignJWT } from 'jose'
import type { Pool, PoolClient } from 'pg'

// A type only, and therefore no cycle: the store imports nothing from here.
// Restating its shape would be a second answer about what a ceremony needs.
import type { WebAuthnAssertionOptions } from './second-factor.js'

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

/** Long enough to read a phone, short enough not to survive walking away. */
const CHALLENGE_SECONDS = 300

/**
 * The challenge's audience, which is deliberately not the API's.
 *
 * An access token and a challenge are both JWTs signed by the same key, so the
 * only thing keeping one from being presented as the other is what they claim
 * to be for.
 */
const challengeAudience = (audience: string): string => `${audience}/second-factor`

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
  /**
   * The **signing** key: the secret for HMAC, the private half for Ed25519.
   *
   * This is the one place in the process that needs the private key at all —
   * verification takes the public one — which is what makes the asymmetric mode
   * worth the configuration.
   */
  readonly key: KeyObject | Uint8Array
  /** Whatever `loadJwtKeys` decided. Defaults to HS256 for a caller with a raw secret. */
  readonly algorithm?: 'HS256' | 'EdDSA'
  /** Published in the token header so a JWKS consumer can select a key. */
  readonly keyId?: string
  readonly issuer: string
  readonly audience: string
  readonly accessTokenTtl: number
  readonly refreshTokenTtl: number
  readonly role?: string
  /**
   * The second factor, when the deployment has a key to seal one with.
   *
   * Absent, `login` issues tokens as it always did — which is what every
   * existing installation gets, and why this is optional rather than a
   * constructor argument every caller had to learn about.
   */
  readonly secondFactors?: SecondFactorGate
  /** Injected so tests are not asked to wait for wall-clock expiry. */
  readonly now?: () => Date
}

/**
 * What `login` needs from the second factor, and no more.
 *
 * A narrow port rather than the class: this file is the sign-in path and has no
 * business being able to enrol anything. It also keeps the cycle out — the
 * store imports nothing from here.
 */
export interface SecondFactorGate {
  required(orgId: string, userId: string): Promise<boolean>
  verify(orgId: string, userId: string, code: string): Promise<boolean>
  beginWebAuthnAssertion(orgId: string, userId: string): Promise<WebAuthnAssertionOptions | undefined>
  verifyWebAuthnAssertion(orgId: string, userId: string, response: WebAuthnProof): Promise<boolean>
}

/** What a browser hands back from `navigator.credentials.get`. */
export interface WebAuthnProof {
  readonly credentialId: string
  readonly authenticatorData: Uint8Array
  readonly clientDataJSON: Uint8Array
  readonly signature: Uint8Array
  readonly challenge: string
}

/**
 * The proof the second half of a sign-in takes, and it is a union on purpose.
 *
 * A six-digit code and an assertion are not two spellings of one argument: the
 * first is a string a person read off a screen and the second is a signature
 * over an origin. Making the parameter a union means a caller has to say which
 * it holds, and a handler that forgot the new kind is a compile error rather
 * than a route that silently only ever accepts the old one.
 */
export type SecondFactorProof =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'webauthn'; readonly response: WebAuthnProof }

/**
 * Sign-in has three outcomes now, and a union rather than a nullable pair.
 *
 * Making it a union turns every existing call site into a compile error until
 * it says which one it means — the alternative is a second optional field that
 * a caller can ignore, and ignoring it here means issuing a session to somebody
 * who has not produced their second factor.
 */
export type LoginOutcome =
  | { readonly kind: 'tokens'; readonly tokens: Tokens }
  | {
      readonly kind: 'second-factor'
      /** Short-lived, single-purpose, and useless as an access token. */
      readonly challenge: string
      readonly expiresIn: number
    }

/**
 * What `changePassword` answers.
 *
 * A union rather than a boolean for the same reason `LoginOutcome` is one: a
 * caller that cannot tell "the current password was wrong" from "there is no
 * such account" answers both the same way, and only one of those is something
 * a person can act on.
 */
export type ChangePasswordOutcome =
  | { readonly kind: 'changed'; readonly tokens: Tokens; readonly email: string }
  | 'wrong-password'
  | 'no-user'

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
  async login(request: LoginRequest): Promise<LoginOutcome | undefined> {
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

    /*
     * The password was right. Whether that is a session depends on the factor.
     *
     * The check is here rather than in the handler because there is exactly one
     * path from a correct password to a token, and a check beside it is a check
     * the next path forgets. `required` answers false for an installation with
     * no key configured, so nothing changes for a deployment that has not asked
     * for this.
     */
    if (this.deps.secondFactors !== undefined && (await this.deps.secondFactors.required(candidate.org_id, candidate.id))) {
      return { kind: 'second-factor', challenge: await this.challenge(candidate), expiresIn: CHALLENGE_SECONDS }
    }

    return { kind: 'tokens', tokens: await this.issue(candidate, undefined) }
  }

  /**
   * The token that says "this password was correct", and nothing else.
   *
   * Its audience is not the API's, so it is refused everywhere an access token
   * is accepted — a challenge that could be presented as a bearer token would
   * be a way past the factor it exists to demand. Five minutes, which is longer
   * than reading a phone and shorter than walking away from one.
   *
   * Not stored, and it does not need to be: replaying it needs the *code* as
   * well, the code is single-use through `last_step`, and a person holding both
   * has finished signing in anyway.
   */
  private async challenge(user: UserRow): Promise<string> {
    const now = this.clock
    return new SignJWT({ org: user.org_id, purpose: 'second-factor' })
      .setProtectedHeader({
        alg: this.deps.algorithm ?? 'HS256',
        ...(this.deps.keyId === undefined ? {} : { kid: this.deps.keyId }),
      })
      .setSubject(user.id)
      .setIssuer(this.deps.issuer)
      .setAudience(challengeAudience(this.deps.audience))
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(now.getTime() / 1000) + CHALLENGE_SECONDS)
      .sign(this.deps.key)
  }

  /**
   * The second half of a sign-in: a challenge and a code, for a session.
   *
   * `undefined` for every reason it can fail — an expired challenge, one signed
   * for something else, a wrong code, a disabled account — and the caller turns
   * all of them into one refusal. Which of the four it was is not something a
   * client needs and is something an attacker would use.
   */
  async completeSecondFactor(challenge: string, proof: SecondFactorProof): Promise<Tokens | undefined> {
    const gate = this.deps.secondFactors
    if (gate === undefined) return undefined

    const who = await this.readChallenge(challenge)
    if (who === undefined) return undefined
    const { orgId, userId } = who

    const proved =
      proof.kind === 'code'
        ? await gate.verify(orgId, userId, proof.code)
        : await gate.verifyWebAuthnAssertion(orgId, userId, proof.response)
    if (!proved) return undefined

    // Re-read the row rather than trusting the challenge for anything but
    // identity: five minutes is long enough to be disabled, and the role in the
    // token has to be the one the database holds now.
    const user = await this.userById(orgId, userId)
    if (user === undefined || user.disabled_at !== null) return undefined

    return this.issue(user, undefined)
  }

  /**
   * The options a browser needs for the assertion half of a sign-in.
   *
   * It takes the same challenge `login` handed back, and that is the whole
   * reason this method is here rather than on the store: the JWT is what says
   * who is signing in, and it is signed by a key the store does not have. An
   * endpoint that took a user id instead would answer "which authenticators
   * does this person hold" to anybody who asked.
   *
   * `undefined` where the challenge is not one of ours, where it has expired,
   * and where the person has no key enrolled — one refusal, for the reason
   * every refusal on this path is one.
   */
  async beginSecondFactorWebAuthn(challenge: string): Promise<WebAuthnAssertionOptions | undefined> {
    const gate = this.deps.secondFactors
    if (gate === undefined) return undefined
    const who = await this.readChallenge(challenge)
    if (who === undefined) return undefined
    return gate.beginWebAuthnAssertion(who.orgId, who.userId)
  }

  /**
   * Who a sign-in challenge names, or nothing.
   *
   * One reader for the two halves that consult it, because a challenge whose
   * audience is checked on one path and not the other is an access token
   * accepted as a challenge — which is exactly what `challengeAudience` exists
   * to stop.
   */
  private async readChallenge(
    challenge: string,
  ): Promise<{ readonly orgId: string; readonly userId: string } | undefined> {
    try {
      const { payload } = await jwtVerify(challenge, this.verificationKey, {
        issuer: this.deps.issuer,
        audience: challengeAudience(this.deps.audience),
        algorithms: [this.deps.algorithm ?? 'HS256'],
        currentDate: this.clock,
      })
      if (payload.purpose !== 'second-factor' || typeof payload.sub !== 'string' || typeof payload.org !== 'string') {
        return undefined
      }
      return { orgId: payload.org, userId: payload.sub }
    } catch {
      return undefined
    }
  }

  /**
   * A person changes their own password, having proved the current one.
   *
   * ## Why this is not `POST /v1/users/{id}/password`
   *
   * That one is an **administrator** setting somebody else's, and it returns
   * the plaintext because a generated password has to be shown once. This is
   * the person themselves choosing one, so nothing is returned and nothing is
   * generated — and it needs no administrator at all, which on a
   * single-administrator installation is the whole point. Recovery closed the
   * case where the password is *forgotten*; this closes the ordinary one, where
   * it is merely known to somebody else.
   *
   * ## What it costs to get in
   *
   * The current password, always, and that is the only proof this takes. A
   * session is not enough: changing the password is the first thing somebody
   * with a stolen session does, and it is what locks the owner out. It is the
   * same reasoning that makes removing a second factor take a current code.
   *
   * A second factor is deliberately *not* asked for here. It bounds sign-in,
   * and this caller has already signed in and just produced the password
   * besides; demanding a code would mean somebody whose phone is lost cannot
   * change a password they know is compromised.
   *
   * ## Every other session ends, and this one is replaced
   *
   * The reason to change a password is usually that somebody else knows it, and
   * leaving their refresh token alive would leave them signed in. So all of them
   * are revoked — including this caller's, since there is no way to tell one
   * refresh token from another with only an access token in hand — and a fresh
   * pair comes back with the answer. Signing the person out of the browser they
   * did it in would read as a failure.
   */
  async changePassword(
    orgId: string,
    userId: string,
    current: string,
    next: string,
  ): Promise<ChangePasswordOutcome> {
    const row = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<UserRow & { email: string }>(
          `SELECT id, org_id, role, email, password_hash, disabled_at
             FROM users WHERE org_id = $1 AND id = $2`,
          [orgId, userId],
        )
        return rows[0]
      },
      this.scope,
    )

    // A disabled account and one with no password set are the same answer as an
    // account that is not there. Nobody reaching here is any of the three —
    // they hold a token this row issued — so this is a guard rather than a
    // branch anybody sees.
    if (row === undefined || row.disabled_at !== null || row.password_hash === null) return 'no-user'

    // Outside the transaction on purpose: scrypt at OWASP's minimum takes long
    // enough that holding a row lock across it is a lock held on arithmetic.
    if (!(await verifyPassword(current, row.password_hash))) return 'wrong-password'
    const hash = await hashPassword(next)

    const tokens = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        await client.query(
          'UPDATE users SET password_hash = $3 WHERE org_id = $1 AND id = $2',
          [orgId, userId, hash],
        )
        // Every one, and before the new pair is inserted so the pair this
        // returns is not revoked by the statement that ends the old sessions.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [orgId, userId],
        )
        // A new family. Carrying the old one would put the session that
        // replaces every other one in the same chain as the tokens just
        // revoked.
        return this.issue(row, undefined, client)
      },
      this.scope,
    )

    return { kind: 'changed', tokens, email: row.email }
  }

  private async userById(orgId: string, userId: string): Promise<UserRow | undefined> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<UserRow>(
          `SELECT id, org_id, role, password_hash, disabled_at
             FROM users WHERE org_id = $1 AND id = $2`,
          [orgId, userId],
        )
        return rows[0]
      },
      this.scope,
    )
  }

  /**
   * What verifies the challenge this same object signed.
   *
   * With a shared secret the key is its own verifier; with Ed25519 the public
   * half comes out of the private one, so nothing new has to be configured for
   * a round trip that never leaves this process.
   */
  private get verificationKey(): KeyObject | Uint8Array {
    if (this.deps.key instanceof Uint8Array) return this.deps.key
    return createPublicKey(this.deps.key)
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
      .setProtectedHeader({
        alg: this.deps.algorithm ?? 'HS256',
        // Only when there is a published key to point at. A `kid` on an HMAC
        // token names nothing a caller could fetch.
        ...(this.deps.keyId === undefined ? {} : { kid: this.deps.keyId }),
      })
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
