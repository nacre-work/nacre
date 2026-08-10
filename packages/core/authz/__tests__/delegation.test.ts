import type { Permission } from '@nacre.work/core'
import {
  administers,
  authenticate,
  delegatedLayers,
  postgresVerification,
  PostgresDocuments,
  PostgresOAuthAuthorizations,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
  Problem,
  type AuthContext,
} from '@nacre.work/api'
import { createSecretKey } from 'node:crypto'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'
import { buildFilter } from '../filter.js'

/**
 * T16–T22 — delegated authority, from docs/authz.md.
 *
 * A delegation is authority a person hands to an application, and it can fail
 * in both of the ways this suite already guards against plus one of its own. So
 * these run against a real PostgreSQL: what is under test is whether the
 * *database* still permits an authority to be exercised, and every interesting
 * case here is a row changing under a token that already exists.
 *
 * T20 and T22 are the narrowing, and they are asserted on the filter the index
 * is asked with rather than on results that came back. That is deliberate and
 * it is the same argument T9 makes: a narrowing applied to a result set returns
 * fewer than `top_k` and reads as "there were only that many", so the property
 * worth pinning is that the clause is *inside* the traversal. `saturation.test`
 * proves the traversal honours a `must` on `layer_id` against a real index;
 * what is left to prove here is that the delegation's narrowing arrives as one.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. T16-T22 would silently skip, and they ' +
      'are the cases that decide whether a disabled person can still act ' +
      'through an application they connected.',
  )
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'

const id = (n: number): string => `de1e6a70-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const PERSON = id(2)
const ADMIN = id(3)
const PLATFORM = id(4)
const WS = id(5)
/** The layer the delegation is narrowed to, and one its person also reads. */
const LAYER_L = id(6)
const LAYER_M = id(7)
const PROVIDER = id(8)
const DOC_IN_L = id(9)
const DOC_IN_M = id(10)
const CLIENT = 'de1e6a70-client'

const KEY = createSecretKey(Buffer.from('d'.repeat(48)))
const ISSUER = 'https://delegation.test'

let pool: Pool
let consents: PostgresOAuthConsents
let authorizations: PostgresOAuthAuthorizations
let refreshTokens: PostgresOAuthRefreshTokens
let documents: PostgresDocuments
/** Documents whose payload was rewritten, so a refusal can be told from a write. */
const wrote: string[] = []

const context = (userId: string, role: AuthContext['role'] = 'member'): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role,
})

/** Exactly the claims main.ts's `mint` builds for a delegation. */
const mint = async (userId: string, delegationId: string): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ org: ORG, principal_type: 'user', role: 'member', del: delegationId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(KEY)
}

const present = async (token: string): Promise<AuthContext | Problem> =>
  authenticate(
    `Bearer ${token}`,
    { key: KEY, issuer: ISSUER, audience: ISSUER, ...postgresVerification(pool, AS_APP) },
    '/v1/search',
    'req-delegation',
  )

/** Connect an application as `who`, optionally narrowed. Returns the token. */
const connect = async (
  who: AuthContext,
  /** A bare id inherits the connection's ceiling; an object sets one for that layer. */
  layers: readonly (string | { id: string; permissions?: readonly Permission[] })[] = [],
  /** The permission ceiling. Empty is "no ceiling", as it is at the endpoint. */
  permissions: readonly Permission[] = [],
): Promise<{ token: string; delegationId: string }> => {
  const delegationId = await consents.record(
    who,
    CLIENT,
    { actsAs: 'user', userId: who.principal.id },
    layers.map((l) => (typeof l === 'string' ? { id: l } : l)),
    permissions.length === 0 ? undefined : permissions,
  )
  return { token: await mint(who.principal.id, delegationId), delegationId }
}

const disabled = async (value: boolean): Promise<void> => {
  const c = await pool.connect()
  try {
    await c.query(`UPDATE users SET disabled_at = ${value ? 'now()' : 'NULL'} WHERE id = $1`, [PERSON])
  } finally {
    c.release()
  }
}

when('delegation · a person lending their own reach', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    consents = new PostgresOAuthConsents(pool, AS_APP)
    authorizations = new PostgresOAuthAuthorizations(pool, AS_APP)
    refreshTokens = new PostgresOAuthRefreshTokens(pool, AS_APP)
    // The payload writer records rather than throws.
    //
    // It threw until T24, on the argument that every case here refuses before
    // the index is touched — which was true of T16-T22 and is exactly what T24
    // is about: a `{write}` ceiling *should* reach the index, because writing
    // is what it permits. Recording keeps the assertion available without
    // making "the write happened" a failure.
    documents = new PostgresDocuments(
      pool,
      { setMetadata: async (collection, documentId) => { wrote.push(`${collection}:${documentId}`) } },
      AS_APP,
    )

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'delegation','Delegation','org_delegation') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES
           ($1,$4,'person@dg.test','member'),
           ($2,$4,'admin@dg.test','org_admin'),
           ($3,$4,'platform@dg.test','platform_admin')
         ON CONFLICT DO NOTHING`,
        [PERSON, ADMIN, PLATFORM, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'dg', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [PROVIDER],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'dg','W') ON CONFLICT DO NOTHING`,
        [WS, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$3,$4,'ell','L',$5,'v'), ($2,$3,$4,'em','M',$5,'v')
         ON CONFLICT DO NOTHING`,
        [LAYER_L, LAYER_M, ORG, WS, PROVIDER],
      )
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, title, status, source_type, source_ref, content_hash) VALUES
           ($1,$3,$4,'In L','indexed','inline','a','h1'),
           ($2,$3,$5,'In M','indexed','inline','b','h2')
         ON CONFLICT DO NOTHING`,
        [DOC_IN_L, DOC_IN_M, ORG, LAYER_L, LAYER_M],
      )
      await c.query(
        `INSERT INTO oauth_clients (client_id, client_name, redirect_uris)
         VALUES ($1,'Test client',$2) ON CONFLICT DO NOTHING`,
        [CLIENT, ['http://localhost/cb']],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** The person reads both layers, and every test starts from that. */
  beforeEach(async () => {
    wrote.length = 0
    await disabled(false)
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM oauth_consent_layers WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_refresh_tokens WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM oauth_consents WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'read','allow'),
                ($1,'user',$2,'layer',$4,'read','allow')`,
        [ORG, PERSON, LAYER_L, LAYER_M],
      )
    } finally {
      c.release()
    }
  })

  it('T16 · resolves as its user, and the principal is the person', async () => {
    const { token, delegationId } = await connect(context(PERSON))
    const auth = await present(token)

    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    // The whole design in one assertion: `resolve` runs on the person, so there
    // is no second grant set and no intersection to compute.
    expect(auth.principal).toEqual({ type: 'user', id: PERSON })
    expect(auth.delegation?.id).toBe(delegationId)
    // No narrowing is `undefined`, never `[]` — the second would mean "reaches
    // nothing", which is the opposite state and is deliberately unrepresentable.
    expect(auth.delegation?.layers).toBeUndefined()

    // And it reaches exactly what the person reaches, by the same call.
    expect(await documents.read(auth, DOC_IN_L)).toBeDefined()
    expect(await documents.read(auth, DOC_IN_M)).toBeDefined()
  })

  it('T17 · a grant revoked from the user is gone on the next request, no renewal between', async () => {
    const { token } = await connect(context(PERSON))
    const before = await present(token)
    expect(before).not.toBeInstanceOf(Problem)
    if (before instanceof Problem) return
    expect(await documents.read(before, DOC_IN_M)).toBeDefined()

    const c = await pool.connect()
    try {
      await c.query('DELETE FROM grants WHERE org_id = $1 AND scope_id = $2', [ORG, LAYER_M])
    } finally {
      c.release()
    }

    // Same token, no refresh, no re-consent. Structural, not eventual: the
    // permitted set was never in the token to go stale.
    const after = await present(token)
    expect(after).not.toBeInstanceOf(Problem)
    if (after instanceof Problem) return
    expect(await documents.read(after, DOC_IN_M)).toBeUndefined()
    expect(await documents.read(after, DOC_IN_L)).toBeDefined()
  })

  it('T18 · disabling suspends every delegation and re-enabling restores them', async () => {
    const { token } = await connect(context(PERSON))
    const refresh = 'rt-' + id(11)
    await refreshTokens.issue(ORG, (await present(token) as AuthContext).delegation?.id as string, refresh, undefined,
      new Date(Date.now() + 600_000))

    await disabled(true)
    const refused = await present(token)
    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)

    // And renewal refuses without **spending** the token. Disabling is
    // reversible and docs/authz.md is explicit that the grant survives it, so
    // burning the refresh token would make re-enabling a reconnection.
    //
    // `'suspended'` and not `undefined`, which is what this asserted and what
    // was only half the property. Keeping the row alive does nothing on its own
    // if the refusal reaches the client as `invalid_grant` — RFC 6749's "this
    // grant is dead" — because the client then discards the token this branch
    // exists to preserve. The endpoint turns this answer into a `503` with
    // `Retry-After`; the distinction has to survive the port to get there.
    expect(await refreshTokens.rotate(refresh)).toBe('suspended')

    await disabled(false)
    const restored = await present(token)
    expect(restored).not.toBeInstanceOf(Problem)
    if (restored instanceof Problem) return
    // The grant was untouched throughout, which is the sentence that makes
    // "suspended" different from "revoked".
    expect(await documents.read(restored, DOC_IN_L)).toBeDefined()
    expect(await refreshTokens.rotate(refresh)).toBeDefined()
  })

  it('T19 · forgetting the application stops it, and the person is unaffected', async () => {
    const { token, delegationId } = await connect(context(PERSON))
    expect(await present(token)).not.toBeInstanceOf(Problem)

    expect(await consents.revoke(context(PERSON), delegationId)).toBe(true)

    const refused = await present(token)
    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)

    // Their own token carries no `del`, so nothing about it changed.
    const now = Math.floor(Date.now() / 1000)
    const own = await new SignJWT({ org: ORG, principal_type: 'user', role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(PERSON)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(KEY)
    const mine = await present(own)
    expect(mine).not.toBeInstanceOf(Problem)
    if (mine instanceof Problem) return
    expect(await documents.read(mine, DOC_IN_L)).toBeDefined()
  })

  it('T20 · a narrowing removes layer M, on search and on a fetch by id alike', async () => {
    const { token } = await connect(context(PERSON), [LAYER_L])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(auth.delegation?.layers?.map((l) => l.id)).toEqual([LAYER_L])

    // Inside the traversal. `buildFilter` puts the narrowing in `must` beside
    // the permission constraint, so it can only ever remove — and the person's
    // own plan is unchanged, which is what "the narrowing narrows scopes, never
    // verbs" means.
    const filter = buildFilter(ORG, { kind: 'scoped', layers: [LAYER_L, LAYER_M], extraDocs: [], deniedDocs: [] },
      { layers: (auth.delegation?.layers ?? []).map((l) => l.id) })
    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: [LAYER_L] } })

    // And the path that has one row and no traversal to put a clause inside of.
    // Fetching by id is exactly how a narrowing gets walked around otherwise.
    expect(await documents.read(auth, DOC_IN_L)).toBeDefined()
    expect(await documents.read(auth, DOC_IN_M)).toBeUndefined()
  })

  it('T20 · and never more from L than the person themselves gets', async () => {
    const c = await pool.connect()
    try {
      // A deny on the layer the delegation was narrowed to. The narrowing is
      // not a grant, so it must not survive one.
      // The allow is turned into a deny rather than joined by one: the unique
      // key is (principal, scope, permission) with no `effect`, which is the
      // schema saying the same thing rule 5 does — one answer per pair.
      await c.query(
        `UPDATE grants SET effect = 'deny'
          WHERE org_id = $1 AND principal_id = $2 AND scope_id = $3 AND permission = 'read'`,
        [ORG, PERSON, LAYER_L],
      )
    } finally {
      c.release()
    }

    const { token } = await connect(context(PERSON), [LAYER_L])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(await documents.read(auth, DOC_IN_L)).toBeUndefined()
  })

  it('T23 · a {read} ceiling reads, and every write path answers as no-write', async () => {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow')`,
        [ORG, PERSON, LAYER_L],
      )
    } finally {
      c.release()
    }

    const { token } = await connect(context(PERSON), [], ['read'])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(auth.delegation?.permissions).toEqual(['read'])

    expect(await documents.read(auth, DOC_IN_L)).toBeDefined()
    // The person holds `write` on this layer and the delegation does not, so
    // the write path answers exactly as it would for somebody with no write
    // grant at all — `false`, which the handler turns into 404.
    expect(await documents.updateMetadata(auth, DOC_IN_L, { tag: 'x' })).toBe(false)
    // And it refused before the index, rather than writing and reporting false.
    expect(wrote).not.toContain(`org_delegation:${DOC_IN_L}`)
  })

  it('T24 · a {write} ceiling ingests and reads nothing — rule 6, inherited', async () => {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow')`,
        [ORG, PERSON, LAYER_L],
      )
    } finally {
      c.release()
    }

    const { token } = await connect(context(PERSON), [], ['write'])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    // The case a ceiling modelled as a level would have lost: write without
    // read is a real thing to want, and it is what rule 6 exists to express.
    expect(await documents.read(auth, DOC_IN_L)).toBeUndefined()
    expect(await documents.updateMetadata(auth, DOC_IN_L, { tag: 'y' })).toBe(true)
    // The index was reached, which is the difference between "permitted" and
    // "refused quietly" that a boolean alone cannot show.
    expect(wrote).toContain(`org_delegation:${DOC_IN_L}`)
  })

  it('T25 · an org_admin with a {read} ceiling reads all and administers nothing', async () => {
    const { token } = await connect(context(ADMIN, 'org_admin'), [], ['read'])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    // Rule 3 still applies: they reach the whole organization, including a
    // layer no grant of theirs names. Rewriting the role to `member` would
    // have taken this away, which is why role and ceiling stay two facts.
    expect(auth.role).toBe('org_admin')
    expect(await documents.read(auth, DOC_IN_L)).toBeDefined()
    expect(await documents.read(auth, DOC_IN_M)).toBeDefined()

    // And nothing administrative. This is the half a naive ceiling misses: a
    // read-only delegation that can still mint a credential, and the
    // credential it mints has no ceiling at all.
    expect(administers(auth)).toBe(false)
    // The same person without the ceiling does administer, so the assertion
    // above is about the ceiling rather than about the fixture.
    const { token: full } = await connect(context(ADMIN, 'org_admin'), [], [])
    const unbounded = await present(full)
    if (unbounded instanceof Problem) throw new Error('expected the unbounded delegation to resolve')
    expect(administers(unbounded)).toBe(true)
  })

  it('T21 · platform_admin is refused at validation, however the token was minted', async () => {
    // Recorded through the store rather than the endpoint, which is the point:
    // the endpoint refuses this too, and this is the check that still holds if
    // a token is ever minted some other way.
    const { token } = await connect(context(PLATFORM, 'platform_admin'))
    const refused = await present(token)
    expect(refused).toBeInstanceOf(Problem)
    expect((refused as Problem).status).toBe(401)
  })

  it('T22 · the narrowing is a clause, not a trim — top_k is unaffected by it', () => {
    // The saturation argument aimed at the new clause. 20 layers, the person
    // reads one, the delegation narrowed to that one: what must be true is that
    // the filter carries a single `must` on `layer_id` and nothing anywhere
    // subtracts from a result set afterwards. `saturation.test.ts` proves such a
    // filter returns exactly `top_k` against a real index.
    const many = Array.from({ length: 20 }, (_, i) => id(100 + i))
    const reads = [many[0] as string, many[1] as string]
    const filter = buildFilter(
      ORG,
      { kind: 'scoped', layers: reads, extraDocs: [], deniedDocs: [] },
      { layers: [many[0] as string] },
    )

    // The narrowing is a `must`, which is an intersection: it can only remove.
    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: [many[0]] } })
    expect(filter.must.filter((clause) => clause.key === 'layer_id')).toHaveLength(1)

    // And the permitted set is untouched. `should` means "at least one", so
    // narrowing *it* would be widening — the delegation must not be able to
    // change what its person may reach, only which part of it this application
    // sees. This is the assertion that fails if a later refactor decides the
    // two lists are the same list.
    expect(filter.should).toContainEqual({ key: 'layer_id', match: { any: reads } })
  })

  it('the delegation does not become a way to write outside the narrowing', async () => {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow')`,
        [ORG, PERSON, LAYER_M],
      )
    } finally {
      c.release()
    }
    const { token } = await connect(context(PERSON), [LAYER_L])
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    // The person holds `write` on M and the delegation must not: "the narrowing
    // narrows scopes, never verbs" cuts both ways, and a delete is the verb
    // where rule 6 offers no cover because their own `read` never came into it.
    expect(await documents.updateMetadata(auth, DOC_IN_M, { tag: 'x' })).toBe(false)
  })

  it('a used authorization code mints for the connection it named', async () => {
    const delegationId = await consents.record(
      context(PERSON),
      CLIENT,
      { actsAs: 'user', userId: PERSON },
      [{ id: LAYER_L }],
    )
    const code = 'code-' + id(12)
    await authorizations.approve(context(PERSON), {
      orgId: ORG,
      subject: { actsAs: 'user', userId: PERSON },
      clientId: CLIENT,
      redirectUri: 'http://localhost/cb',
      codeChallenge: 'challenge',
      code,
      consentId: delegationId,
      expiresAt: new Date(Date.now() + 60_000),
    })

    const redeemed = await authorizations.redeem(code)
    expect(redeemed?.subject).toEqual({ actsAs: 'user', userId: PERSON })
    // Without this the minted token would carry a `del` pointing at nothing,
    // and every request made with it would 401.
    expect(redeemed?.consentId).toBe(delegationId)
    // Once. A code redeemed twice is the definition of a replay.
    expect(await authorizations.redeem(code)).toBeUndefined()
  })

  it('reconnecting is one connection, and re-answers the narrowing rather than adding to it', async () => {
    const first = await connect(context(PERSON), [LAYER_L, LAYER_M])
    const second = await connect(context(PERSON), [LAYER_L])
    expect(second.delegationId).toBe(first.delegationId)

    const auth = await present(second.token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return
    expect(auth.delegation?.layers?.map((l) => l.id)).toEqual([LAYER_L])

    // And answering it with nothing means no narrowing, not an empty one.
    const third = await connect(context(PERSON), [])
    const widened = await present(third.token)
    expect(widened).not.toBeInstanceOf(Problem)
    if (widened instanceof Problem) return
    expect(widened.delegation?.layers).toBeUndefined()
  })

  it('T26 · a per-layer ceiling narrows that layer and leaves the other alone', async () => {
    // The case the screen could not express: read the handbook, write to
    // scratch. As two independent questions the only approximation was `write`
    // on both, which is what this closes.
    // The person holds read **and** write on both layers. Without that there
    // would be nothing for the narrowing to narrow: `authority(delegation) =
    // resolve(person)`, so a delegation cannot reach what its person cannot,
    // and asserting otherwise would be asserting that a restriction grants.
    // The first run of this case did exactly that and failed, correctly.
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow'),
                ($1,'user',$2,'layer',$4,'write','allow')
         ON CONFLICT DO NOTHING`,
        [ORG, PERSON, LAYER_L, LAYER_M],
      )
    } finally {
      c.release()
    }

    const { token } = await connect(
      context(PERSON),
      [
        { id: LAYER_L, permissions: ['read'] },
        { id: LAYER_M, permissions: ['write'] },
      ],
      ['read', 'write'],
    )
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    // The narrowing is one set **per permission** now, and this is the whole
    // of it: the same delegation admits a different pair of layers for `read`
    // than for `write`.
    expect(delegatedLayers(auth, 'read')).toEqual([LAYER_L])
    expect(delegatedLayers(auth, 'write')).toEqual([LAYER_M])

    // Reading: L is in, M is out — despite M being the layer it may write.
    expect(await documents.read(auth, DOC_IN_L)).toBeDefined()
    expect(await documents.read(auth, DOC_IN_M)).toBeUndefined()

    // Writing: the mirror image, which is rule 6 arriving through a narrowing
    // rather than through a grant. A layer given only `read` is not writable
    // even though it is the one the application can see.
    expect(await documents.updateMetadata(auth, DOC_IN_L, { source: 'x' })).toBe(false)
    expect(await documents.updateMetadata(auth, DOC_IN_M, { source: 'x' })).toBe(true)

    // And inside the traversal, where invariant 2 lives. The clause carries the
    // read set, so a search cannot reach the write-only layer.
    const filter = buildFilter(
      ORG,
      { kind: 'scoped', layers: [LAYER_L, LAYER_M], extraDocs: [], deniedDocs: [] },
      { layers: [...(delegatedLayers(auth, 'read') ?? [])] },
    )
    expect(filter.must).toContainEqual({ key: 'layer_id', match: { any: [LAYER_L] } })
  })

  it('T27 · a layer with no ceiling of its own inherits the connection\'s', async () => {
    // Which is what every narrowing written before per-layer ceilings meant,
    // and the reason the column is nullable rather than defaulted.
    const { token } = await connect(
      context(PERSON),
      [{ id: LAYER_L, permissions: ['read'] }, LAYER_M],
      ['read', 'write'],
    )
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    expect(delegatedLayers(auth, 'read')).toEqual([LAYER_L, LAYER_M])
    expect(delegatedLayers(auth, 'write')).toEqual([LAYER_M])
  })

  it('T28 · a per-layer ceiling never reaches administration', async () => {
    // `admin` inside one layer is not authority over the organization holding
    // it. Minting a user is gated on the connection's ceiling and never on a
    // layer's, so this delegation administers nothing — and the endpoint
    // refuses the pair anyway, which is the belt to this brace.
    const { token } = await connect(
      context(PERSON),
      [{ id: LAYER_L, permissions: ['admin'] }],
      ['admin'],
    )
    const auth = await present(token)
    expect(auth).not.toBeInstanceOf(Problem)
    if (auth instanceof Problem) return

    // The person is a `member` in this fixture, so `administers` is false on
    // the role alone — and that is the point: the layer's `admin` did not
    // promote them. Asserted through the same helper every handler calls.
    expect(administers(auth)).toBe(false)

    // What it *does* reach is the layer, which is the narrowing doing its job.
    expect(delegatedLayers(auth, 'admin')).toEqual([LAYER_L])
  })

  it('nothing is granted to a delegation, and the database still says so', async () => {
    // The structural claim docs/authz.md opens the section with. A delegation
    // is not a fourth principal type, so there is no second grant set and no
    // intersection to compute — which is why this feature adds no new way for
    // the resolver to be wrong. Read from the live CHECK rather than from the
    // migration text: what matters is the constraint on the database the code
    // is talking to.
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = 'grants'::regclass AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%principal_type%'`,
      )
      expect(rows.length).toBeGreaterThan(0)
      const admitted = rows.map((r) => r.def).join(' ')
      for (const kind of ['user', 'group', 'service_account']) {
        expect(admitted).toContain(kind)
      }
      expect(admitted).not.toContain('delegation')
    } finally {
      c.release()
    }
  })
})
