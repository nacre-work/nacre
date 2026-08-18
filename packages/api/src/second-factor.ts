import { randomBytes } from 'node:crypto'

import {
  generateRecoveryCode,
  generateTotpSecret,
  hashRecoveryCode,
  openTotpSecret,
  otpauthUrl,
  RECOVERY_CODE_COUNT,
  sealTotpSecret,
  SUPPORTED_ALGORITHMS,
  verifyAssertion,
  verifyRegistration,
  verifyTotp,
  withOrg,
  type PublicKey,
} from '@nacre.work/core'
import type { Pool } from 'pg'

/**
 * The second factor, as far as the API is concerned.
 *
 * `packages/core/totp.ts` is the arithmetic and knows nothing about a database;
 * this is the storage, the replay bound and the brute-force bound. The split is
 * the same one `passwords.ts` has: an algorithm that can be checked against a
 * standard's own vectors, and a store that can be checked against a real
 * PostgreSQL.
 *
 * ## What a second factor decides
 *
 * Whether a session starts. Nothing here is read by `authz/`, and a token
 * minted after a correct code reaches exactly what the same token reaches
 * without one — the permitted set is computed per request from `grants`, as it
 * is for every other principal.
 *
 * ## Unconfigured is a supported state
 *
 * With no `NACRE_2FA_KEY` there is no key to seal a secret with, so
 * enrolment is refused and every read answers "no factor". Not a degraded mode
 * that stores secrets in the clear until somebody notices: a product that
 * half-does a second factor is worse than one that does none, because the
 * operator believes something.
 */

/** Five wrong codes and this factor stops answering for a while. */
const MAX_FAILURES = 5
const LOCK_SECONDS = 15 * 60

export interface EnrolledFactor {
  readonly id: string
  readonly kind: FactorKind
  readonly label: string
  readonly createdAt: Date
  readonly lastUsedAt: Date | null
}

export interface BegunEnrolment {
  readonly id: string
  /** Shown once, so a person can type it into an app that will not scan. */
  readonly secret: string
  readonly otpauthUrl: string
}

interface FactorRow {
  readonly id: string
  readonly secret: string
  readonly last_step: string | null
  readonly failed_attempts: number
  readonly locked_until: Date | null
}

export type FactorKind = 'totp' | 'webauthn'

/**
 * Where a WebAuthn ceremony happens, and it needs no new configuration.
 *
 * The relying party id is `NACRE_CANONICAL_URL`'s hostname and the origin list
 * is that URL's origin plus whatever `NACRE_API_ALLOWED_ORIGINS` already
 * admits — the console is served from the API's own origin unless a deployment
 * has said otherwise, and if it has said otherwise it has said so there. A
 * `NACRE_WEBAUTHN_*` variable would be a second answer to a question the
 * deployment has already answered twice.
 */
export interface RelyingParty {
  /** A registrable domain: `nacre.example.com`, never a URL and never a port. */
  readonly id: string
  /** What the authenticator shows. */
  readonly name: string
  /** Compared for equality. A suffix match would admit `evil-nacre.work`. */
  readonly origins: readonly string[]
}

export interface WebAuthnRegistrationOptions {
  readonly challenge: string
  readonly rp: { readonly id: string; readonly name: string }
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  readonly algorithms: readonly number[]
  readonly excludeCredentials: readonly string[]
  readonly timeoutMs: number
}

export interface WebAuthnAssertionOptions {
  readonly challenge: string
  readonly rpId: string
  readonly allowCredentials: readonly string[]
  readonly timeoutMs: number
}

/** Only what these two use of a client, so a transaction can be handed in. */
type PoolClientQuery = (text: string, values?: readonly unknown[]) => Promise<{ rowCount: number | null }>

export interface SecondFactorDeps {
  readonly pool: Pool
  /**
   * The sealing key, or `undefined` where the deployment configured none.
   *
   * **TOTP needs it and WebAuthn does not.** A TOTP secret is shared, so it has
   * to be kept and therefore sealed; a WebAuthn credential leaves a public key
   * here and nothing else, so there is nothing a dump could hand over. That is
   * why `available` became per kind rather than staying one boolean: an
   * installation with no key can still offer the *stronger* of the two, and
   * refusing it because the weaker one has no key would be an accident of how
   * this class was first written.
   */
  readonly key: Buffer | undefined
  /** What an authenticator shows above the account. */
  readonly issuer: string
  readonly relyingParty: RelyingParty
  readonly role?: string
  readonly now?: () => Date
}

/** How long a ceremony has to finish. Long enough to find a key in a drawer. */
const CHALLENGE_TTL_SECONDS = 300

export class SecondFactors {
  constructor(private readonly deps: SecondFactorDeps) {}

  /**
   * Whether this installation can hold a second factor at all.
   *
   * True where *either* kind is offered, which since WebAuthn is every
   * installation: it needs no sealing key, only the canonical URL every
   * deployment already sets.
   */
  get available(): boolean {
    return this.kinds.length > 0
  }

  /** The kinds this installation offers, so a screen can draw what works. */
  get kinds(): readonly FactorKind[] {
    const offered: FactorKind[] = []
    if (this.deps.key !== undefined) offered.push('totp')
    if (this.deps.relyingParty.id !== '') offered.push('webauthn')
    return offered
  }

  private get scope(): { role?: string } {
    return this.deps.role === undefined ? {} : { role: this.deps.role }
  }

  private get clock(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * Does this person have to produce one?
   *
   * Only confirmed factors count. A secret generated and never proved is a
   * secret that did not reach an authenticator, and treating it as live is how
   * somebody locks themselves out at the moment they turn 2FA on.
   */
  async required(orgId: string, userId: string): Promise<boolean> {
    // Deliberately not gated on `available`. A deployment that removes a key
    // still has the rows, and answering "no factor required" for somebody who
    // enrolled one would turn a configuration change into a silent downgrade
    // of every account that had turned it on.
    if (this.deps.key === undefined && this.deps.relyingParty.id === '') return false
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
          [orgId, userId],
        )
        return Number(rows[0]?.count ?? '0') > 0
      },
      this.scope,
    )
  }

  async list(orgId: string, userId: string): Promise<readonly EnrolledFactor[]> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          kind: FactorKind
          label: string
          created_at: Date
          last_used_at: Date | null
        }>(
          `SELECT id, kind, label, created_at, last_used_at
             FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL
            ORDER BY created_at, id`,
          [orgId, userId],
        )
        return rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          label: row.label,
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
        }))
      },
      this.scope,
    )
  }

  /**
   * Start enrolling one. The secret is stored sealed and unconfirmed.
   *
   * A second call with the same label replaces the unconfirmed row rather than
   * refusing: somebody who closed the page before scanning has no way to name
   * what they abandoned, and the alternative is a label nobody can reuse.
   */
  async begin(orgId: string, userId: string, label: string): Promise<BegunEnrolment | undefined> {
    const key = this.deps.key
    if (key === undefined) return undefined

    const secret = generateTotpSecret()
    const sealed = sealTotpSecret(secret, key)

    const begun = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        // The address, for the label an authenticator shows. Read here rather
        // than passed in: `AuthContext` carries the principal's id and not
        // their address, and a handler that had to fetch one would be a second
        // place that knows how to find a user.
        const { rows: people } = await client.query<{ email: string }>(
          'SELECT email FROM users WHERE org_id = $1 AND id = $2',
          [orgId, userId],
        )
        const account = people[0]?.email
        if (account === undefined) return undefined

        await client.query(
          `DELETE FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND label = $3 AND confirmed_at IS NULL`,
          [orgId, userId, label],
        )
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO user_second_factors (org_id, user_id, kind, secret, label)
           VALUES ($1, $2, 'totp', $3, $4)
           RETURNING id`,
          [orgId, userId, sealed, label],
        )
        const id = rows[0]?.id
        return id === undefined ? undefined : { id, account }
      },
      this.scope,
    )

    if (begun === undefined) return undefined
    return {
      id: begun.id,
      secret,
      otpauthUrl: otpauthUrl({ issuer: this.deps.issuer, account: begun.account, secret }),
    }
  }

  /**
   * Prove the secret arrived, and hand back the way in without it.
   *
   * The recovery codes are minted here rather than on demand for two reasons:
   * a person who has lost their phone cannot ask for them, and this is the one
   * moment the product has their attention about it.
   *
   * Replacing any codes that already exist — enrolling a second factor is not
   * a reason to invalidate them, so this only runs when there was none.
   */
  async confirm(
    orgId: string,
    userId: string,
    id: string,
    code: string,
  ): Promise<readonly string[] | undefined> {
    const key = this.deps.key
    if (key === undefined) return undefined

    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<FactorRow>(
          `SELECT id, secret, last_step, failed_attempts, locked_until
             FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND id = $3 AND confirmed_at IS NULL
              FOR UPDATE`,
          [orgId, userId, id],
        )
        const row = rows[0]
        if (row === undefined) return undefined

        const verified = verifyTotp(openTotpSecret(row.secret, key), code, {
          at: this.clock,
          after: row.last_step === null ? null : Number(row.last_step),
        })
        if (verified === undefined) return undefined

        await client.query(
          `UPDATE user_second_factors
              SET confirmed_at = now(), last_step = $2, last_used_at = now(), failed_attempts = 0
            WHERE id = $1`,
          [row.id, String(verified.step)],
        )

        const { rows: existing } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM user_recovery_codes
            WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
          [orgId, userId],
        )
        if (Number(existing[0]?.count ?? '0') > 0) return []

        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
        for (const one of codes) {
          await client.query(
            `INSERT INTO user_recovery_codes (org_id, user_id, code_hash) VALUES ($1, $2, $3)`,
            [orgId, userId, hashRecoveryCode(one)],
          )
        }
        return codes
      },
      this.scope,
    )
  }

  /**
   * A code at sign-in: a six-digit one from an authenticator, or a recovery code.
   *
   * Both are accepted here rather than on two endpoints, because from the
   * outside they answer the same question and a separate route would tell an
   * attacker which one a person is using.
   *
   * The brute-force bound is in Postgres and not in Redis: the rate limiter
   * fails **open** by design — it is not an authorization control and a cache
   * restart must not be an outage — and this one is. Six digits is a million,
   * and a limiter that forgets is a limiter an attacker waits out.
   */
  async verify(orgId: string, userId: string, code: string): Promise<boolean> {
    const key = this.deps.key
    if (key === undefined) return false

    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        // A recovery code first, and spent by the UPDATE itself: a read then a
        // write would let two requests spend one code.
        const spent = await client.query(
          `UPDATE user_recovery_codes
              SET used_at = now()
            WHERE org_id = $1 AND user_id = $2 AND code_hash = $3 AND used_at IS NULL`,
          [orgId, userId, hashRecoveryCode(code)],
        )
        if ((spent.rowCount ?? 0) > 0) return true

        const { rows } = await client.query<FactorRow>(
          `SELECT id, secret, last_step, failed_attempts, locked_until
             FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL
            ORDER BY created_at
              FOR UPDATE`,
          [orgId, userId],
        )

        const now = this.clock
        for (const row of rows) {
          if (row.locked_until !== null && row.locked_until > now) continue
          const verified = verifyTotp(openTotpSecret(row.secret, key), code, {
            at: now,
            after: row.last_step === null ? null : Number(row.last_step),
          })
          if (verified === undefined) continue
          await client.query(
            `UPDATE user_second_factors
                SET last_step = $2, last_used_at = now(), failed_attempts = 0, locked_until = NULL
              WHERE id = $1`,
            [row.id, String(verified.step)],
          )
          return true
        }

        // Counted against every factor this person holds, because the attacker
        // is guessing at the person and not at a device.
        for (const row of rows) {
          const failures = row.failed_attempts + 1
          // Every parameter cast, because `$2` is read twice — once as the new
          // value and once in the comparison — and Postgres infers a type from
          // each use. Uncast it raises `text versus integer` at run time and at
          // no other time, which is a query that type-checks, passes a mock and
          // fails against the database. Found by running it.
          await client.query(
            `UPDATE user_second_factors
                SET failed_attempts = $2::int,
                    locked_until = CASE
                      WHEN $2::int >= $3::int THEN now() + make_interval(secs => $4::int)
                      ELSE locked_until
                    END
              WHERE id = $1`,
            [row.id, failures, MAX_FAILURES, LOCK_SECONDS],
          )
        }
        return false
      },
      this.scope,
    )
  }

  /**
   * Remove one. The caller has already proved they are this person and holds a
   * current code — see the handler; removing a factor is exactly what somebody
   * with a stolen session would do first.
   */
  async remove(orgId: string, userId: string, id: string): Promise<boolean> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const done = await client.query(
          `DELETE FROM user_second_factors WHERE org_id = $1 AND user_id = $2 AND id = $3`,
          [orgId, userId, id],
        )
        if ((done.rowCount ?? 0) === 0) return false

        // The codes go with the last factor. Recovery codes are the way past a
        // second factor, so leaving them behind an account that no longer has
        // one is a set of long-lived credentials nobody remembers holding.
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND confirmed_at IS NOT NULL`,
          [orgId, userId],
        )
        if (Number(rows[0]?.count ?? '0') === 0) {
          await client.query(`DELETE FROM user_recovery_codes WHERE org_id = $1 AND user_id = $2`, [
            orgId,
            userId,
          ])
        }
        return true
      },
      this.scope,
    )
  }

  /**
   * The address, for a notice about this account's factors.
   *
   * Here rather than on a users port because this class already reads that
   * column for the authenticator label, and a second reader of one column is a
   * second thing to keep scoped correctly.
   */
  async emailOf(orgId: string, userId: string): Promise<string | undefined> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ email: string }>(
          'SELECT email FROM users WHERE org_id = $1 AND id = $2',
          [orgId, userId],
        )
        return rows[0]?.email
      },
      this.scope,
    )
  }

  /* ───────────────────────────── WebAuthn ───────────────────────────────
   *
   * Four calls, two ceremonies. Each begins by issuing a challenge this server
   * stores and ends by spending it — **single use**, because the signature
   * covers the challenge and an assertion captured on the wire is replayable
   * for exactly as long as its challenge is. Nothing else in the ceremony
   * stops that.
   *
   * The challenge is spent by the UPDATE that finds it, the way a recovery code
   * and a password reset link are, so two requests cannot both succeed on one.
   */

  /** Mint and store a challenge. Returned base64url, which is what the browser wants. */
  private async issueChallenge(
    orgId: string,
    userId: string,
    purpose: 'register' | 'authenticate',
  ): Promise<string> {
    const challenge = randomBytes(32).toString('base64url')
    await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        await client.query(
          `INSERT INTO webauthn_challenges (org_id, user_id, purpose, challenge, expires_at)
           VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5::int))`,
          [orgId, userId, purpose, challenge, CHALLENGE_TTL_SECONDS],
        )
      },
      this.scope,
    )
    return challenge
  }

  /**
   * Spend one, and refuse a challenge that is not outstanding for this person
   * and this ceremony.
   *
   * The purpose is in the WHERE clause rather than checked afterwards: a
   * challenge issued for enrolment must not be spendable on a sign-in, or a
   * session could mint the input to a ceremony it is not in.
   */
  private async spendChallenge(
    client: { query: PoolClientQuery },
    orgId: string,
    userId: string,
    purpose: 'register' | 'authenticate',
    challenge: string,
  ): Promise<boolean> {
    const { rowCount } = await client.query(
      `UPDATE webauthn_challenges SET used_at = now()
        WHERE org_id = $1 AND user_id = $2 AND purpose = $3 AND challenge = $4
          AND used_at IS NULL AND expires_at > now()`,
      [orgId, userId, purpose, challenge],
    )
    return (rowCount ?? 0) === 1
  }

  /**
   * Start enrolling an authenticator.
   *
   * `excludeCredentials` carries what this person has already registered, so an
   * authenticator they are holding refuses to make a second credential rather
   * than quietly making one — which is the difference between "you already have
   * this key" and two rows nobody can tell apart.
   */
  async beginWebAuthnRegistration(
    orgId: string,
    userId: string,
  ): Promise<WebAuthnRegistrationOptions | undefined> {
    if (!this.kinds.includes('webauthn')) return undefined

    const person = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ email: string }>(
          'SELECT email FROM users WHERE org_id = $1 AND id = $2',
          [orgId, userId],
        )
        return rows[0]
      },
      this.scope,
    )
    if (person === undefined) return undefined

    const existing = await this.credentialIds(orgId, userId)
    const challenge = await this.issueChallenge(orgId, userId, 'register')

    return {
      challenge,
      rp: { id: this.deps.relyingParty.id, name: this.deps.relyingParty.name },
      // The **account** id and never the email, because this value is stored on
      // the authenticator and may be shown by a password manager. A uuid says
      // nothing to anybody who reads the device.
      user: { id: Buffer.from(userId).toString('base64url'), name: person.email, displayName: person.email },
      algorithms: [...SUPPORTED_ALGORITHMS],
      excludeCredentials: existing,
      timeoutMs: CHALLENGE_TTL_SECONDS * 1000,
    }
  }

  /** Every credential id this person has, for `allowCredentials` and `excludeCredentials`. */
  private async credentialIds(orgId: string, userId: string): Promise<readonly string[]> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ credential_id: string }>(
          `SELECT credential_id FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND kind = 'webauthn'
              AND confirmed_at IS NOT NULL AND credential_id IS NOT NULL
            ORDER BY created_at`,
          [orgId, userId],
        )
        return rows.map((row) => row.credential_id)
      },
      this.scope,
    )
  }

  /**
   * Finish enrolling one, and hand back recovery codes if this is the first
   * factor of any kind.
   *
   * Confirmed in the same statement that inserts it, unlike TOTP: there is no
   * second step to prove the credential reached anything, because producing the
   * attestation *is* that proof. A TOTP secret can be generated and never
   * scanned; a WebAuthn credential cannot be registered without the
   * authenticator having made it.
   */
  async finishWebAuthnRegistration(
    orgId: string,
    userId: string,
    label: string,
    response: { readonly attestationObject: Uint8Array; readonly clientDataJSON: Uint8Array; readonly challenge: string },
  ): Promise<readonly string[] | undefined> {
    if (!this.kinds.includes('webauthn')) return undefined

    let registered
    try {
      registered = verifyRegistration({
        attestationObject: response.attestationObject,
        clientDataJSON: response.clientDataJSON,
        challenge: response.challenge,
        rpId: this.deps.relyingParty.id,
        origins: this.deps.relyingParty.origins,
      })
    } catch {
      // One refusal for every way a registration can be wrong. Telling them
      // apart would describe this server's checks to whoever is probing them.
      return undefined
    }

    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        if (!(await this.spendChallenge(client, orgId, userId, 'register', response.challenge))) {
          return undefined
        }

        await client.query(
          `INSERT INTO user_second_factors
             (org_id, user_id, kind, label, credential_id, public_key, alg, sign_count, confirmed_at)
           VALUES ($1, $2, 'webauthn', $3, $4, $5::jsonb, $6, $7, now())`,
          [
            orgId,
            userId,
            label,
            Buffer.from(registered.credentialId).toString('base64url'),
            JSON.stringify(registered.publicKey.jwk),
            registered.publicKey.alg,
            registered.signCount,
          ],
        )

        const { rows: existing } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM user_recovery_codes
            WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
          [orgId, userId],
        )
        if (Number(existing[0]?.count ?? '0') > 0) return []

        const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () => generateRecoveryCode())
        for (const one of codes) {
          await client.query(
            'INSERT INTO user_recovery_codes (org_id, user_id, code_hash) VALUES ($1, $2, $3)',
            [orgId, userId, hashRecoveryCode(one)],
          )
        }
        return codes
      },
      this.scope,
    )
  }

  /** The options a sign-in needs, or nothing where this person has no key enrolled. */
  async beginWebAuthnAssertion(
    orgId: string,
    userId: string,
  ): Promise<WebAuthnAssertionOptions | undefined> {
    if (!this.kinds.includes('webauthn')) return undefined
    const allow = await this.credentialIds(orgId, userId)
    if (allow.length === 0) return undefined
    return {
      challenge: await this.issueChallenge(orgId, userId, 'authenticate'),
      rpId: this.deps.relyingParty.id,
      allowCredentials: allow,
      timeoutMs: CHALLENGE_TTL_SECONDS * 1000,
    }
  }

  /**
   * Verify an assertion at sign-in.
   *
   * The counter is written back in the same transaction that spent the
   * challenge, because a counter that is checked and not stored is a counter
   * that only ever compares against zero — which is the clone detection not
   * existing rather than being lenient.
   */
  async verifyWebAuthnAssertion(
    orgId: string,
    userId: string,
    response: {
      readonly credentialId: string
      readonly authenticatorData: Uint8Array
      readonly clientDataJSON: Uint8Array
      readonly signature: Uint8Array
      readonly challenge: string
    },
  ): Promise<boolean> {
    if (!this.kinds.includes('webauthn')) return false

    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        if (!(await this.spendChallenge(client, orgId, userId, 'authenticate', response.challenge))) {
          return false
        }

        const { rows } = await client.query<{ id: string; public_key: Record<string, string>; alg: number; sign_count: string | null }>(
          `SELECT id, public_key, alg, sign_count FROM user_second_factors
            WHERE org_id = $1 AND user_id = $2 AND kind = 'webauthn'
              AND credential_id = $3 AND confirmed_at IS NOT NULL
              FOR UPDATE`,
          [orgId, userId, response.credentialId],
        )
        const row = rows[0]
        if (row === undefined) return false

        let assertion
        try {
          assertion = verifyAssertion({
            authenticatorData: response.authenticatorData,
            clientDataJSON: response.clientDataJSON,
            signature: response.signature,
            challenge: response.challenge,
            rpId: this.deps.relyingParty.id,
            origins: this.deps.relyingParty.origins,
            publicKey: { alg: row.alg as PublicKey['alg'], jwk: row.public_key },
            storedSignCount: Number(row.sign_count ?? 0),
          })
        } catch {
          return false
        }

        await client.query(
          'UPDATE user_second_factors SET last_used_at = now(), sign_count = $2 WHERE id = $1',
          [row.id, String(assertion.signCount)],
        )
        return true
      },
      this.scope,
    )
  }

  /** How many unspent recovery codes are left, for the screen that says so. */
  async recoveryCodesLeft(orgId: string, userId: string): Promise<number> {
    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM user_recovery_codes
            WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
          [orgId, userId],
        )
        return Number(rows[0]?.count ?? '0')
      },
      this.scope,
    )
  }
}
