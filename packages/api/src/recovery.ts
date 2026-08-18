import { createHash, randomBytes } from 'node:crypto'

import { consoleUrl, hashPassword, type Mailer, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'

/**
 * Recovering a password, by email, without a `psql` session.
 *
 * ## The hole this closes
 *
 * `POST /v1/users/{id}/password` is an **administrator** setting somebody
 * else's. The person who forgot theirs had no route, and on a
 * single-administrator installation — which the open core mostly is — the
 * administrator who forgot theirs had no route that did not go through the
 * database. That is the model-offers-it-and-the-product-gives-no-route shape
 * this repository keeps closing.
 *
 * ## Why the token carries its organization
 *
 * `<org_id>.<secret>`. Redemption therefore knows the tenant before it reads
 * anything, so this table is read through `withOrg` like every other and the
 * one path a stranger can reach unauthenticated opens no cross-tenant read.
 *
 * Migration 0008 says `users` gets no `authenticating` policy "as a decision
 * rather than an omission"; this keeps that decision rather than arguing with
 * it. The organization id is not a secret from the person holding the link —
 * it is in their own `/v1/me` — and the half beside it is.
 *
 * ## What a reset does not do
 *
 * **It does not touch a second factor.** If it did, an email account would be a
 * way around one, which is the whole thing a second factor exists to not be.
 * Somebody who resets a password still produces a code afterwards.
 *
 * It *does* end every other session: a reset is what somebody does when they
 * think their password is known, and leaving the refresh tokens alive would
 * leave whoever knows it signed in.
 */

/** An hour. Long enough to reach an inbox, short enough to be worth stealing. */
export const RESET_TTL_SECONDS = 3600

/**
 * The shortest password this will accept from a person choosing their own.
 *
 * Length and nothing else — no composition rule. A rule demanding a digit and a
 * symbol produces `Password1!` and a person who writes it down; length is the
 * only requirement that reliably buys entropy. The passwords this product
 * *generates* are six words and a number, and are longer than this.
 */
export const MIN_PASSWORD_LENGTH = 12

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

export interface RecoveryDeps {
  readonly pool: Pool
  readonly mailer: Mailer
  /** Where the link points. From configuration, never from a request header. */
  readonly consoleBase: string
  readonly role?: string
  readonly now?: () => Date
}

export type Redemption = 'reset' | 'refused' | 'too-short'

export class PasswordRecovery {
  constructor(private readonly deps: RecoveryDeps) {}

  private get scope(): { role?: string } {
    return this.deps.role === undefined ? {} : { role: this.deps.role }
  }

  private get clock(): Date {
    return this.deps.now?.() ?? new Date()
  }

  /**
   * Send a link, or do nothing, and answer the same either way.
   *
   * The caller writes one `204` whatever happened here. An address that has an
   * account and one that does not must be indistinguishable, or this endpoint
   * becomes the account-enumeration oracle that the sign-in path is careful not
   * to be — and it is reachable without a credential.
   *
   * An address in two organizations is the same silence, for the reason the
   * login path gives: telling somebody how many tenants an address appears in
   * is telling them about tenants.
   */
  async request(email: string): Promise<void> {
    const address = email.trim().toLowerCase()
    if (address === '') return

    const found = await this.findUser(address)
    if (found === undefined) return

    const secret = randomBytes(32).toString('base64url')
    const token = `${found.orgId}.${secret}`
    const expiresAt = new Date(this.clock.getTime() + RESET_TTL_SECONDS * 1000)

    await withOrg(
      this.deps.pool,
      found.orgId,
      async (client) => {
        // Any older link this person holds stops working. Two live links is two
        // things to steal for one account, and somebody asking again is
        // somebody who does not have the first.
        await client.query(
          `UPDATE password_reset_tokens SET used_at = now()
            WHERE org_id = $1 AND user_id = $2 AND used_at IS NULL`,
          [found.orgId, found.userId],
        )
        await client.query(
          `INSERT INTO password_reset_tokens (org_id, user_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4)`,
          [found.orgId, found.userId, digest(token), expiresAt],
        )
      },
      this.scope,
    )

    const link = consoleUrl(this.deps.consoleBase, `#/reset?token=${encodeURIComponent(token)}`)
    await this.deps.mailer.send({
      to: address,
      subject: 'Reset your Nacre password',
      text: [
        'Somebody asked to reset the password for this address.',
        '',
        link,
        '',
        `The link works once and expires in ${String(Math.round(RESET_TTL_SECONDS / 60))} minutes.`,
        'If it was not you, nothing has changed and you can ignore this message.',
        '',
        'Resetting a password does not remove a second factor: you will still be',
        'asked for a code afterwards.',
      ].join('\n'),
    })
  }

  /**
   * Spend a link and set the password, or refuse.
   *
   * The spend is the UPDATE that finds it, so two requests cannot both succeed
   * — a read followed by a write is a race with a stolen link on the other side
   * of it.
   */
  async redeem(token: string, password: string): Promise<Redemption> {
    if (password.length < MIN_PASSWORD_LENGTH) return 'too-short'

    const [orgId, secret] = token.split('.')
    if (orgId === undefined || secret === undefined || !UUID.test(orgId)) return 'refused'

    const hash = await hashPassword(password)

    const address = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ user_id: string }>(
          `UPDATE password_reset_tokens SET used_at = now()
            WHERE org_id = $1 AND token_hash = $2 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id`,
          [orgId, digest(token)],
        )
        const userId = rows[0]?.user_id
        if (userId === undefined) return undefined

        const { rows: people } = await client.query<{
          email: string
          disabled_at: Date | null
          shared: boolean
        }>('SELECT email, disabled_at, shared FROM users WHERE org_id = $1 AND id = $2', [
          orgId,
          userId,
        ])
        const person = people[0]
        // A disabled account is refused, and the token is spent anyway: it was
        // issued before the account was disabled, and leaving it live would be
        // a link that starts working again if the account is ever re-enabled.
        //
        // `shared` is asked here as well as where a token is issued, and that
        // is not a second copy of one check: a token minted before the account
        // was marked would otherwise still work, which is the same window the
        // line above closes for `disabled`.
        if (person === undefined || person.disabled_at !== null || person.shared) return undefined

        await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash])

        // Every other session ends. A reset is what somebody does when they
        // think their password is known, and leaving the refresh tokens alive
        // would leave whoever knows it signed in.
        await client.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
          [orgId, userId],
        )
        return person.email
      },
      this.scope,
    )

    if (address === undefined) return 'refused'

    // A notice, not a confirmation: the person who receives this and did not do
    // it is the one who needs to know, and they need to know now.
    await this.deps.mailer
      .send({
        to: address,
        subject: 'Your Nacre password was changed',
        text: [
          'The password for this address has just been changed using a recovery link.',
          '',
          'Every other session was signed out. Any second factor on the account is',
          'untouched and is still required.',
          '',
          'If this was not you, whoever did it can read your mail — change the',
          'password again from a device you trust and tell your administrator.',
        ].join('\n'),
      })
      // Dropped rather than raised: the password *is* changed, and refusing the
      // request over a notice would be worse than a notice that did not arrive.
      .catch(() => undefined)

    return 'reset'
  }

  /**
   * The one user this address names, or nothing.
   *
   * The same shape the login path uses, and for the same reasons: two matches
   * is silence rather than a choice, and the scan stops at two so the cost does
   * not grow with how many tenants a deployment has.
   */
  private async findUser(email: string): Promise<{ orgId: string; userId: string } | undefined> {
    const client = await this.deps.pool.connect()
    let orgIds: readonly string[]
    try {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM organizations WHERE deleted_at IS NULL',
      )
      orgIds = rows.map((row) => row.id)
    } finally {
      client.release()
    }

    const found: { orgId: string; userId: string }[] = []
    for (const orgId of orgIds) {
      const row = await withOrg(
        this.deps.pool,
        orgId,
        async (scoped) => {
          const { rows } = await scoped.query<{ id: string }>(
            // `NOT shared` in the WHERE clause rather than checked after, for
            // the reason every predicate here is: an account more than one
            // person holds has no mailbox that belongs to one of them, so a
            // link sent to it lets whichever of them reads first take it from
            // the rest. The endpoint still answers 204 — that is what stops it
            // being an oracle — so this is a token that is never minted rather
            // than a refusal anybody can observe.
            `SELECT id FROM users
              WHERE org_id = $1 AND email = $2 AND disabled_at IS NULL
                AND password_hash IS NOT NULL AND NOT shared`,
            [orgId, email],
          )
          return rows[0]
        },
        this.scope,
      )
      if (row !== undefined) found.push({ orgId, userId: row.id })
      if (found.length > 1) return undefined
    }
    return found[0]
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
