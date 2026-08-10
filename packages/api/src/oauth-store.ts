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

import { hashCode, whileAuthenticating, withOrg, type OrgRole, type Permission } from '@nacre.work/core'
import type { Pool } from 'pg'

import { administers, administersTenants } from './auth.js'
import type { AuthContext, Delegations } from './auth.js'

export interface RegisteredClient {
  readonly clientId: string
  readonly clientName: string
  readonly redirectUris: readonly string[]
}

/**
 * What a connection acts as.
 *
 * A discriminated union rather than a nullable id, which is migration 0025's
 * argument carried into the code: inferring "this is a delegation" from a null
 * puts a guess on the issuance path, and the two modes mint different tokens.
 */
export type ConsentSubject =
  | { readonly actsAs: 'service_account'; readonly serviceAccountId: string }
  /** A delegation. `userId` is the person who approved it — see docs/authz.md. */
  | { readonly actsAs: 'user'; readonly userId: string }

/**
 * One layer in a delegation's narrowing, and what it may be used for there.
 *
 * `permissions` absent means this layer inherits the connection's ceiling,
 * which is what every narrowing written before per-layer ceilings meant and
 * still means. Present, it is intersected with that ceiling and never replaces
 * it — see docs/authz.md, "Per layer".
 */
export interface LayerNarrowing {
  readonly id: string
  readonly permissions?: readonly Permission[]
}

/**
 * The narrowing as Postgres hands it back, in the shape the rest of the code
 * reads.
 *
 * `JSON_BUILD_OBJECT` renders a NULL column as JSON `null`, not as an absent
 * key — so a layer inheriting the connection's ceiling arrives as
 * `permissions: null`, and `permissions === undefined` is false for it. That
 * threw on the first run of T26, which is the whole reason this conversion is a
 * named function rather than a cast: the type said optional and the value said
 * null, and only one of them was true.
 */
const narrowingOf = (
  rows: readonly { id: string; permissions: Permission[] | null }[] | null,
): readonly LayerNarrowing[] =>
  (rows ?? []).map((l) => ({ id: l.id, ...(l.permissions === null ? {} : { permissions: l.permissions }) }))

/** A standing connection: this application, acting as this agent or as a person. */
export interface Consent {
  readonly id: string
  readonly clientId: string
  readonly clientName: string
  readonly subject: ConsentSubject
  /** The agent's name, for a connection that has one. */
  readonly serviceAccountName: string | null
  readonly approvedBy: string
  /**
   * The layers a delegation was narrowed to at consent, if any.
   *
   * Empty means **no narrowing**, never "narrowed to nothing" — the two are
   * opposite, and the table deliberately cannot express the second.
   */
  readonly layers: readonly LayerNarrowing[]
  /**
   * The permissions a delegation may exercise. Empty means no ceiling — it
   * reaches every verb its person holds.
   */
  readonly permissions: readonly Permission[]
  readonly createdAt: string
  readonly lastRefreshedAt: string | null
  readonly revokedAt: string | null
}

/**
 * What a token is minted for.
 *
 * A union rather than a record with two optional halves, so the delegated case
 * **cannot** be constructed without the connection it names. The `del` claim is
 * that connection's id and the authentication path refuses a token whose
 * delegation does not resolve, so a delegated token minted with nothing to
 * point at would be one nobody can ever use — and a type is a cheaper place to
 * learn that than a running deployment.
 *
 * `consentId` is optional on the service-account side only, because 0023 wrote
 * authorization codes before 0024 gave connections a table.
 */
export type MintRequest =
  | {
      readonly orgId: string
      readonly subject: { readonly actsAs: 'service_account'; readonly serviceAccountId: string }
      readonly consentId?: string
    }
  | {
      readonly orgId: string
      readonly subject: { readonly actsAs: 'user'; readonly userId: string }
      readonly consentId: string
    }

/** A consent that has been given and not yet exchanged. */
export type PendingAuthorization = MintRequest & {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource?: string
}

export interface OAuthClients {
  register(name: string, redirectUris: readonly string[], clientId: string): Promise<RegisteredClient>
  find(clientId: string): Promise<RegisteredClient | undefined>
}

export interface OAuthConsents {
  /**
   * The connection, created or found.
   *
   * Approving twice is the same connection rather than a second one: a screen
   * full of duplicates is one where ending a connection leaves the others
   * working.
   */
  record(
    auth: AuthContext,
    clientId: string,
    subject: ConsentSubject,
    /**
     * The layers a delegation is restricted to. Replaced wholesale on
     * re-approval, because a person reconnecting an application is answering
     * the narrowing question again rather than adding to a previous answer.
     */
    layers?: readonly LayerNarrowing[],
    /**
     * The permissions a delegation may exercise. Absent is no ceiling.
     *
     * Replaced wholesale for the same reason as `layers`, and empty is
     * deliberately not storable: a delegation that can do nothing is not a
     * restriction anybody meant to write, and the database refuses one.
     */
    permissions?: readonly Permission[],
  ): Promise<string>
  /**
   * Every connection this caller may see.
   *
   * An `org_admin` sees the organization's; everybody else sees the ones they
   * approved. That is not a permission gradient invented here — an agent is the
   * organization's, and somebody has to be able to end a connection whose
   * approver has left.
   */
  list(auth: AuthContext): Promise<readonly Consent[]>
  /**
   * End it. Returns false when there is nothing of theirs by that id, which is
   * the same answer as "no such connection" — invariant 4.
   */
  revoke(auth: AuthContext, id: string): Promise<boolean>
}

export interface OAuthRefreshTokens {
  /** Issue one against a connection, in the family a rotation continues. */
  issue(orgId: string, consentId: string, token: string, family: string | undefined, expiresAt: Date): Promise<string>
  /**
   * Spend one and say what it was for, or refuse.
   *
   * Refuses an expired token, a revoked connection, and — loudly — a **replay**:
   * a token already spent means two holders have it and there is no way to tell
   * which is genuine, so the whole family is ended rather than the one token.
   *
   * `'suspended'` is the one refusal that is **not** final, and it is a distinct
   * answer because the caller has to say so on the wire. Every other reason
   * means the token is dead and the client must start again; this one means the
   * same token will work when the person is enabled, so answering it the same
   * way is what makes a reversible act irreversible in practice.
   */
  rotate(
    token: string,
  ): Promise<(MintRequest & { readonly consentId: string; readonly family: string }) | 'suspended' | undefined>
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
              code_challenge, redirect_uri, resource, expires_at, consent_id, acts_as)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            auth.orgId,
            input.clientId,
            input.subject.actsAs === 'service_account' ? input.subject.serviceAccountId : null,
            auth.principal.id,
            hashCode(input.code),
            input.codeChallenge,
            input.redirectUri,
            input.resource ?? null,
            input.expiresAt,
            input.consentId ?? null,
            input.subject.actsAs,
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
          acts_as: 'service_account' | 'user'
          service_account_id: string | null
          approved_by: string
          client_id: string
          redirect_uri: string
          code_challenge: string
          resource: string | null
          consent_id: string | null
        }>(
          `UPDATE oauth_authorizations
              SET consumed_at = now()
            WHERE code_hash = $1
              AND consumed_at IS NULL
              AND expires_at > now()
          RETURNING org_id, acts_as, service_account_id, approved_by, client_id,
                    redirect_uri, code_challenge, resource, consent_id`,
          [hashCode(code)],
        )
        const row = rows[0]
        if (row === undefined) return undefined
        // The database's CHECK guarantees the pairing, so this reads the
        // discriminator rather than testing the null — the same distinction
        // 0025 draws, kept on this side of the boundary too.
        const common = {
          orgId: row.org_id,
          clientId: row.client_id,
          redirectUri: row.redirect_uri,
          codeChallenge: row.code_challenge,
          ...(row.resource === null ? {} : { resource: row.resource }),
        }
        if (row.acts_as === 'user') {
          // `consent_id IS NOT NULL` is in 0025's CHECK for the delegated
          // shape, which is what lets this be a cast rather than a branch that
          // has to decide what a delegation with no connection means.
          return { ...common, subject: { actsAs: 'user', userId: row.approved_by }, consentId: row.consent_id as string }
        }
        return {
          ...common,
          subject: { actsAs: 'service_account', serviceAccountId: row.service_account_id as string },
          ...(row.consent_id === null ? {} : { consentId: row.consent_id }),
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

export class PostgresOAuthConsents implements OAuthConsents {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async record(
    auth: AuthContext,
    clientId: string,
    subject: ConsentSubject,
    layers?: readonly LayerNarrowing[],
    permissions?: readonly Permission[],
  ): Promise<string> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // Approving again reuses the row and clears a previous revocation: the
        // person is deliberately reconnecting an application they had ended,
        // and leaving it marked revoked would show them a connection that says
        // "ended" while the client works.
        //
        // Two conflict targets because there are two unique indexes, and the
        // delegated one is **partial** — `(org_id, client_id, approved_by)
        // WHERE acts_as = 'user'`, since NULLs are distinct and the 0024 index
        // would let a person approve the same application twice. The inference
        // clause has to repeat the index's predicate for Postgres to match it.
        const { rows } =
          subject.actsAs === 'service_account'
            ? await client.query<{ id: string }>(
                `INSERT INTO oauth_consents (org_id, client_id, service_account_id, approved_by, acts_as)
                 VALUES ($1,$2,$3,$4,'service_account')
                 ON CONFLICT (org_id, client_id, service_account_id)
                 DO UPDATE SET revoked_at = NULL, approved_by = EXCLUDED.approved_by
                 RETURNING id`,
                [auth.orgId, clientId, subject.serviceAccountId, auth.principal.id],
              )
            : await client.query<{ id: string }>(
                `INSERT INTO oauth_consents
                   (org_id, client_id, service_account_id, approved_by, acts_as, permissions)
                 VALUES ($1,$2,NULL,$3,'user',$4)
                 ON CONFLICT (org_id, client_id, approved_by) WHERE acts_as = 'user'
                 DO UPDATE SET revoked_at = NULL, permissions = EXCLUDED.permissions
                 RETURNING id`,
                // Replaced on re-approval, never merged. Merging would make a
                // ceiling that can only ever rise, which is the one direction
                // a restriction must not move in.
                [auth.orgId, clientId, subject.userId,
                 permissions === undefined || permissions.length === 0 ? null : [...permissions]],
              )
        const id = (rows[0] as { id: string }).id

        if (subject.actsAs === 'user') {
          // Replaced wholesale, in the same transaction as the row it belongs
          // to. A person reconnecting an application is answering the narrowing
          // question again, so merging their new answer into the old one would
          // make a narrowing that can only ever widen — the one direction this
          // whole mechanism is not allowed to move in.
          await client.query('DELETE FROM oauth_consent_layers WHERE org_id = $1 AND consent_id = $2', [
            auth.orgId,
            id,
          ])
          if (layers !== undefined && layers.length > 0) {
            // One jsonb array of objects rather than parallel arrays: a
            // `text[][]` would have to be rectangular, and these are not — a
            // layer inheriting the connection's ceiling stores NULL. The
            // multi-argument `unnest` that would carry two ragged arrays was
            // written first and inserted a null `layer_id`, which is the kind
            // of subtly-wrong SQL one parameter and one row shape avoids.
            await client.query(
              `INSERT INTO oauth_consent_layers (org_id, consent_id, layer_id, permissions)
               SELECT $1, $2, (e->>'id')::uuid,
                      CASE WHEN e->'permissions' IS NULL OR e->'permissions' = 'null'::jsonb
                           THEN NULL
                           ELSE ARRAY(SELECT jsonb_array_elements_text(e->'permissions')) END
                 FROM jsonb_array_elements($3::jsonb) AS e`,
              [
                auth.orgId,
                id,
                JSON.stringify(
                  layers.map((l) => ({
                    id: l.id,
                    ...(l.permissions === undefined ? {} : { permissions: l.permissions }),
                  })),
                ),
              ],
            )
          }
        }
        return id
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }

  async list(auth: AuthContext): Promise<readonly Consent[]> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // An org_admin sees the organization's, everybody else their own. Not
        // an invented gradient: an agent belongs to the organization, so
        // somebody has to be able to end a connection whose approver has left.
        const mine = administers(auth) || administersTenants(auth) ? '' : ' AND c.approved_by = $2'
        const { rows } = await client.query<{
          id: string
          client_id: string
          client_name: string
          acts_as: 'service_account' | 'user'
          service_account_id: string | null
          service_account_name: string | null
          approved_by: string
          layers: { id: string; permissions: Permission[] | null }[] | null
          permissions: Permission[] | null
          created_at: string
          last_refreshed_at: string | null
          revoked_at: string | null
        }>(
          // LEFT, because a delegation names no service account. It was an
          // inner join, which would have made every delegation invisible on the
          // one screen that can end it.
          `SELECT c.id, c.client_id, oc.client_name, c.acts_as, c.service_account_id,
                  sa.name AS service_account_name, c.approved_by, c.permissions,
                  JSON_AGG(JSON_BUILD_OBJECT('id', cl.layer_id, 'permissions', cl.permissions))
                    FILTER (WHERE cl.layer_id IS NOT NULL) AS layers,
                  c.created_at::text, c.last_refreshed_at::text, c.revoked_at::text
             FROM oauth_consents c
             JOIN oauth_clients oc ON oc.client_id = c.client_id
             LEFT JOIN service_accounts sa ON sa.id = c.service_account_id AND sa.org_id = c.org_id
             LEFT JOIN oauth_consent_layers cl ON cl.consent_id = c.id AND cl.org_id = c.org_id
            WHERE c.org_id = $1${mine}
            GROUP BY c.id, oc.client_name, sa.name
            ORDER BY c.created_at DESC, c.id`,
          mine === '' ? [auth.orgId] : [auth.orgId, auth.principal.id],
        )
        return rows.map((r) => ({
          id: r.id,
          clientId: r.client_id,
          clientName: r.client_name,
          subject:
            r.acts_as === 'user'
              ? ({ actsAs: 'user', userId: r.approved_by } as const)
              : ({ actsAs: 'service_account', serviceAccountId: r.service_account_id as string } as const),
          serviceAccountName: r.service_account_name,
          approvedBy: r.approved_by,
          layers: narrowingOf(r.layers),
          permissions: r.permissions ?? [],
          createdAt: r.created_at,
          lastRefreshedAt: r.last_refreshed_at,
          revokedAt: r.revoked_at,
        }))
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }

  async revoke(auth: AuthContext, id: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return false
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const mine = administers(auth) || administersTenants(auth) ? '' : ' AND approved_by = $3'
        const params = mine === '' ? [auth.orgId, id] : [auth.orgId, id, auth.principal.id]
        const { rows } = await client.query<{ id: string }>(
          `UPDATE oauth_consents SET revoked_at = now()
            WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL${mine}
            RETURNING id`,
          params,
        )
        if (rows.length === 0) return false

        // The refresh tokens go with it, in the same transaction. Leaving them
        // is the difference between a connection that says ended and one that
        // *is*: the application renews on its own schedule, and a token that
        // still works is a connection that has not ended.
        //
        // Deleted rather than marked. There is nothing to investigate later
        // about a credential whose whole purpose was to be exchanged, and a row
        // kept is a hash kept.
        await client.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1 AND consent_id = $2', [auth.orgId, id])
        return true
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

export class PostgresOAuthRefreshTokens implements OAuthRefreshTokens {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async issue(
    orgId: string,
    consentId: string,
    token: string,
    family: string | undefined,
    expiresAt: Date,
  ): Promise<string> {
    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ family_id: string }>(
          `INSERT INTO oauth_refresh_tokens (org_id, consent_id, token_hash, family_id, expires_at)
           VALUES ($1,$2,$3,COALESCE($4::uuid, gen_random_uuid()),$5)
           RETURNING family_id`,
          [orgId, consentId, hashCode(token), family ?? null, expiresAt],
        )
        return (rows[0] as { family_id: string }).family_id
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }

  async rotate(
    token: string,
  ): Promise<(MintRequest & { readonly consentId: string; readonly family: string }) | 'suspended' | undefined> {
    // The same split as an authorization code, and for the same reason: the
    // endpoint holds a bearer secret and no organization, so the lookup crosses
    // tenants and is **read-only** — that restriction is what keeps the one
    // tenant-spanning path unable to write.
    const found = await whileAuthenticating(
      this.pool,
      async (client) => {
        const { rows } = await client.query<{ org_id: string }>(
          'SELECT org_id FROM oauth_refresh_tokens WHERE token_hash = $1',
          [hashCode(token)],
        )
        return rows[0]?.org_id
      },
      this.role === undefined ? {} : { role: this.role },
    )
    if (found === undefined) return undefined

    return withOrg(
      this.pool,
      found,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          consent_id: string
          family_id: string
          used_at: Date | null
          expired: boolean
          revoked: boolean
          acts_as: 'service_account' | 'user'
          service_account_id: string | null
          approved_by: string
          suspended: boolean
        }>(
          // The user is joined for the delegated case only, and it is a LEFT
          // join so a service-account connection is unaffected by it. What it
          // answers is the same question the authentication path asks on every
          // request: may this authority still be exercised. Asking it here too
          // is not belt and braces — a renewal that succeeded while the person
          // was disabled would hand the application a fresh token for every one
          // of the next fourteen days, each of which 401s.
          `SELECT t.id, t.consent_id, t.family_id, t.used_at,
                  t.expires_at <= now() AS expired,
                  c.revoked_at IS NOT NULL AS revoked,
                  c.acts_as, c.service_account_id, c.approved_by,
                  (c.acts_as = 'user'
                     AND (u.id IS NULL OR u.disabled_at IS NOT NULL OR u.role = 'platform_admin')) AS suspended
             FROM oauth_refresh_tokens t
             JOIN oauth_consents c ON c.id = t.consent_id
             LEFT JOIN users u ON u.id = c.approved_by AND u.org_id = c.org_id
            WHERE t.token_hash = $1
            FOR UPDATE OF t`,
          [hashCode(token)],
        )
        const row = rows[0]
        if (row === undefined) return undefined

        if (row.used_at !== null) {
          // A replay. The legitimate holder has already exchanged this, so two
          // parties hold it and there is no way to tell which is which — the
          // only safe answer is that neither continues. Same rule as the
          // sign-in family, and it is the reason a family id exists at all.
          await client.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1 AND family_id = $2', [
            found,
            row.family_id,
          ])
          return undefined
        }
        if (row.expired || row.revoked) return undefined

        // Suspended, and the token is deliberately **not** spent. Disabling a
        // person is reversible — docs/authz.md is explicit that the grant
        // survives it — so burning their applications' refresh tokens on the
        // way past would make re-enabling them a reconnection rather than a
        // restoration.
        //
        // Said as its own answer rather than as "no". Keeping the row alive is
        // only half of "the application retries and the same token works": the
        // other half is the client not throwing the token away, and a client
        // decides that from what the endpoint returned. `invalid_grant` means
        // dead — so this branch, which existed to make the token survive,
        // arrived at a caller as an instruction to discard it.
        if (row.suspended) return 'suspended' as const

        // Spent, in the statement that reads it: two concurrent exchanges race
        // for one row and exactly one wins.
        const { rows: spent } = await client.query<{ id: string }>(
          'UPDATE oauth_refresh_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
          [row.id],
        )
        if (spent.length === 0) return undefined

        await client.query('UPDATE oauth_consents SET last_refreshed_at = now() WHERE org_id = $1 AND id = $2', [
          found,
          row.consent_id,
        ])
        const base = { orgId: found, consentId: row.consent_id, family: row.family_id }
        return row.acts_as === 'user'
          ? { ...base, subject: { actsAs: 'user', userId: row.approved_by } }
          : { ...base, subject: { actsAs: 'service_account', serviceAccountId: row.service_account_id as string } }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

/**
 * The one read docs/authz.md puts before `resolve` on a delegated request.
 *
 * Its whole job is to be *current*. Everything a JWT can say was true when it
 * was signed; whether this authority may still be exercised changes when an
 * administrator acts, and that question has no answer in a token.
 *
 * One statement, joined by primary key, inside `withOrg` — the organization
 * comes from the token, so unlike a refresh token there is no cross-tenant
 * lookup here and no `app.authenticating` shape to it.
 */
export class PostgresDelegations implements Delegations {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async resolve(
    orgId: string,
    id: string,
  ): Promise<{ userId: string; role: OrgRole; layers?: readonly LayerNarrowing[] } | undefined> {
    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        // Every refusal is expressed as "no row" rather than as a flag the
        // caller then interprets. A revoked connection, a disabled user and a
        // platform_admin are three different facts and one answer, and putting
        // that in the predicate means there is no branch above it where two of
        // them could drift apart.
        //
        // `acts_as = 'user'` is part of it: a service-account connection has a
        // row here too, and resolving one as its approver would hand an
        // application the person's own reach instead of the agent's.
        const { rows } = await client.query<{
          user_id: string
          role: OrgRole
          layers: { id: string; permissions: Permission[] | null }[] | null
          permissions: Permission[] | null
        }>(
          `SELECT c.approved_by AS user_id,
                  u.role,
                  c.permissions,
                  JSON_AGG(JSON_BUILD_OBJECT('id', l.layer_id, 'permissions', l.permissions))
                    FILTER (WHERE l.layer_id IS NOT NULL) AS layers
             FROM oauth_consents c
             JOIN users u
               ON u.id = c.approved_by AND u.org_id = c.org_id
             LEFT JOIN oauth_consent_layers l
               ON l.consent_id = c.id AND l.org_id = c.org_id
            WHERE c.org_id = $1
              AND c.id = $2
              AND c.acts_as = 'user'
              AND c.revoked_at IS NULL
              AND u.disabled_at IS NULL
              AND u.role <> 'platform_admin'
            GROUP BY c.approved_by, u.role, c.permissions`,
          [orgId, id],
        )

        const row = rows[0]
        if (row === undefined) return undefined
        // No rows in the join table means **no narrowing**, never "narrowed to
        // nothing". The `FILTER` above drops the LEFT JOIN's one null row, and
        // `JSON_AGG` over nothing is NULL rather than `[null]` — so an
        // unnarrowed delegation does not arrive here as a narrowing nobody can
        // satisfy. That was a real defect in the array version of this query
        // and the filter is how it stays fixed.
        return {
          userId: row.user_id,
          role: row.role,
          ...(row.layers === null ? {} : { layers: narrowingOf(row.layers) }),
          // NULL is no ceiling, which is a different state from an empty set —
          // the CHECK on the column refuses the second, so this cannot arrive
          // as a delegation that may do nothing.
          ...(row.permissions === null ? {} : { permissions: row.permissions }),
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}
