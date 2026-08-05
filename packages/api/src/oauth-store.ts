/**
 * Storage for the authorization server.
 *
 * Two tables and two shapes. `oauth_clients` holds no tenant data — a client
 * registers before anybody has signed in, and a `client_id` permits nothing —
 * so it is read and written outside `withOrg`, and that is stated here rather
 * than left for a reader to wonder about. `oauth_authorizations` is tenant data
 * the moment it exists, because it names a service account, and every statement
 * against it goes through `withOrg`.
 */

import { hashCode, whileAuthenticating, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'

import type { AuthContext } from './auth.js'

export interface RegisteredClient {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUris: readonly string[]
}

/** A consent that has been given and not yet exchanged. */
export interface PendingAuthorization {
  readonly orgId: string
  readonly serviceAccountId: string
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string | undefined
}

export interface OAuthClients {
  register(name: string, redirectUris: readonly string[], clientId: string): Promise<RegisteredClient>
  find(clientId: string): Promise<RegisteredClient | undefined>
}

export interface OAuthAuthorizations {
  /** Records a consent and returns nothing: the code is the caller's to hand back. */
  approve(auth: AuthContext, input: PendingAuthorization & { code: string; expiresAt: Date }): Promise<void>
  /**
   * Exchange, once.
   *
   * Consumption and lookup are one statement on purpose. Two — read, then mark
   * — is a window in which the same code is exchanged twice, and an
   * authorization code redeemed twice is the definition of a replay.
   */
  redeem(code: string): Promise<PendingAuthorization | undefined>
}

export class PostgresOAuthClients implements OAuthClients {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async register(
    name: string,
    redirectUris: readonly string[],
    clientId: string,
  ): Promise<RegisteredClient> {
    // Outside `withOrg`, and the mechanism that permits it is
    // `whileAuthenticating` — the same one credential resolution uses, for the
    // same reason: there is no organization yet, because nobody has signed in.
    // A client row is not tenant data and grants nothing.
    return whileAuthenticating(this.pool, async (client) => {
      await client.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)`,
        [clientId, name, [...redirectUris]],
      )
      return { clientId, clientName: name, redirectUris }
    }, this.role === undefined ? {} : { role: this.role })
  }

  async find(clientId: string): Promise<RegisteredClient | undefined> {
    return whileAuthenticating(this.pool, async (client) => {
      const { rows } = await client.query<{ client_id: string; client_name: string; redirect_uris: string[] }>(
        'SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1',
        [clientId],
      )
      const row = rows[0]
      if (row === undefined) return undefined
      return { clientId: row.client_id, clientName: row.client_name, redirectUris: row.redirect_uris }
    }, this.role === undefined ? {} : { role: this.role })
  }
}

export class PostgresOAuthAuthorizations implements OAuthAuthorizations {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async approve(
    auth: AuthContext,
    input: PendingAuthorization & { code: string; expiresAt: Date },
  ): Promise<void> {
    await withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        await client.query(
          `INSERT INTO oauth_authorizations
             (org_id, client_id, service_account_id, approved_by, code_hash,
              code_challenge, redirect_uri, resource, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            auth.orgId,
            input.clientId,
            input.serviceAccountId,
            auth.principal.id,
            hashCode(input.code),
            input.codeChallenge,
            input.redirectUri,
            input.resource ?? null,
            input.expiresAt,
          ],
        )
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }

  async redeem(code: string): Promise<PendingAuthorization | undefined> {
    // Two statements, and the split is the point rather than a compromise.
    //
    // The token endpoint is handed a code and nothing else, so it cannot scope
    // the lookup before it has done it — the same position credential
    // resolution is in, and it uses the same mechanism: the
    // `authenticating_lookup` policy from 0023, which is **SELECT only**. That
    // restriction is migration 0008's property and this must not end it: an
    // UPDATE under `whileAuthenticating` would be a cross-tenant write, and it
    // would also raise, because no organization is set for the org-scoped
    // policy to read.
    const found = await whileAuthenticating(
      this.pool,
      async (client) => {
        const { rows } = await client.query<{ org_id: string }>(
          `SELECT org_id FROM oauth_authorizations
            WHERE code_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
          [hashCode(code)],
        )
        return rows[0]?.org_id
      },
      this.role === undefined ? {} : { role: this.role },
    )
    if (found === undefined) return undefined

    // The decision, under the organization the lookup named. `consumed_at IS
    // NULL` inside the UPDATE is what refuses a replay: two exchanges race for
    // one row and exactly one of them gets it back. The SELECT above decides
    // nothing — it only says which tenant to ask.
    return withOrg(
      this.pool,
      found,
      async (client) => {
        const { rows } = await client.query<{
          org_id: string
          service_account_id: string
          client_id: string
          redirect_uri: string
          code_challenge: string
          resource: string | null
        }>(
          `UPDATE oauth_authorizations
              SET consumed_at = now()
            WHERE code_hash = $1
              AND consumed_at IS NULL
              AND expires_at > now()
          RETURNING org_id, service_account_id, client_id, redirect_uri, code_challenge, resource`,
          [hashCode(code)],
        )
        const row = rows[0]
        if (row === undefined) return undefined
        return {
          orgId: row.org_id,
          serviceAccountId: row.service_account_id,
          clientId: row.client_id,
          redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge,
          resource: row.resource ?? undefined,
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}
