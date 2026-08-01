import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresGrants } from '@nacre.work/api'
import type { AuthContext } from '@nacre.work/api'

import { createPool } from '../../db/client.js'
import { loadGroupsVersion } from '../store.js'

/**
 * Withdrawing a grant.
 *
 * `nacre_acl_propagation_lag_seconds` is the only external evidence that
 * invariant I4 holds — a revocation is reflected within the SLA — and the
 * operation it measures had no implementation on any surface. Three documents
 * described revocation; the only way to perform one was a DELETE against the
 * table by hand, which no permission check and no audit row went anywhere near.
 *
 * Two properties carry the risk here. Admin is resolved against the grant's own
 * scope, read from the stored row rather than from anything the caller sent —
 * otherwise an administrator of one layer revokes access anywhere. And the row
 * is removed rather than flipped to `deny`, which looks equivalent and is not.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; grant revocation would go untested.')
}
const when = url ? describe : describe.skip

const ORG = 'e5e5e5e5-0000-4000-8000-000000000001'
const ids = {
  root: 'e5e5e5e5-0000-4000-8000-000000000002',
  lena: 'e5e5e5e5-0000-4000-8000-000000000003',
  outsider: 'e5e5e5e5-0000-4000-8000-000000000004',
  ws: 'e5e5e5e5-0000-4000-8000-000000000005',
  open: 'e5e5e5e5-0000-4000-8000-000000000006',
  other: 'e5e5e5e5-0000-4000-8000-000000000007',
  provider: 'e5e5e5e5-0000-4000-8000-000000000008',
}

const AS_APP = 'nacre_app'

const auth = (userId: string): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role: 'member',
})

let pool: Pool
let grants: PostgresGrants

when('baseline · grant revocation', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    grants = new PostgresGrants(pool, AS_APP)

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'revoke','Revoke','org_revoke') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES
           ($1,$4,'root@rv.test'), ($2,$4,'lena@rv.test'), ($3,$4,'out@rv.test')
         ON CONFLICT DO NOTHING`,
        [ids.root, ids.lena, ids.outsider, ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'rv', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'rv','W')
         ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$3,$4,'open','Open',$5,'v'), ($2,$3,$4,'other','Other',$5,'v')
         ON CONFLICT DO NOTHING`,
        [ids.open, ids.other, ORG, ids.ws, ids.provider],
      )
      await c.query('COMMIT')
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  /** Root administers the whole workspace; Lena administers one layer only. */
  beforeEach(async () => {
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'workspace',$4,'admin','allow'),
                ($1,'user',$3,'layer',$5,'admin','allow')`,
        [ORG, ids.root, ids.lena, ids.ws, ids.open],
      )
    } finally {
      c.release()
    }
  })

  /** A read grant for the outsider on `scope`, and its id. */
  async function readGrant(scopeType: 'layer' | 'workspace', scopeId: string): Promise<string> {
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,$3,$4,'read','allow') RETURNING id`,
        [ORG, ids.outsider, scopeType, scopeId],
      )
      return rows[0]?.id as string
    } finally {
      c.release()
    }
  }

  const exists = async (id: string): Promise<boolean> => {
    const c = await pool.connect()
    try {
      const { rows } = await c.query('SELECT 1 FROM grants WHERE id = $1', [id])
      return rows.length > 0
    } finally {
      c.release()
    }
  }

  it('an administrator of the scope withdraws the grant', async () => {
    const id = await readGrant('layer', ids.open)
    expect(await grants.revoke(auth(ids.lena), id)).toBe(true)
    expect(await exists(id)).toBe(false)
  })

  it('the row is removed, not flipped to deny', async () => {
    const id = await readGrant('layer', ids.open)
    await grants.revoke(auth(ids.root), id)

    const c = await pool.connect()
    try {
      const { rows } = await c.query('SELECT effect FROM grants WHERE id = $1', [id])
      // A deny beats an allow at any depth, so a "revocation" written that way
      // would also suppress access the principal holds through a group or a
      // parent scope. It is also a commercial capability this build refuses to
      // issue, which would make the revoke path the one way to get one.
      expect(rows).toHaveLength(0)
    } finally {
      c.release()
    }
  })

  it('an administrator of one layer cannot revoke on another', async () => {
    const id = await readGrant('layer', ids.other)

    // Lena administers `open` and nothing else. Resolving admin against
    // anything but the grant's own scope is how she reaches this one.
    expect(await grants.revoke(auth(ids.lena), id)).toBe(false)
    expect(await exists(id)).toBe(true)
  })

  it('a grant on a parent scope needs admin on that parent', async () => {
    const id = await readGrant('workspace', ids.ws)

    // Lena's admin on a layer inside the workspace does not reach a grant
    // written on the workspace itself — that grant governs the other layer too.
    expect(await grants.revoke(auth(ids.lena), id)).toBe(false)
    expect(await grants.revoke(auth(ids.root), id)).toBe(true)
  })

  it('a principal with no admin anywhere revokes nothing', async () => {
    const id = await readGrant('layer', ids.open)
    expect(await grants.revoke(auth(ids.outsider), id)).toBe(false)
    expect(await exists(id)).toBe(true)
  })

  it('an absent grant and an unreachable one answer identically', async () => {
    const unreachable = await readGrant('layer', ids.other)
    const absent = 'e5e5e5e5-0000-4000-8000-0000000000ff'

    // Rule 4 does not stop applying because the object is a grant. A difference
    // here enumerates the organization's grants for an administrator of one
    // layer.
    expect(await grants.revoke(auth(ids.lena), absent)).toBe(false)
    expect(await grants.revoke(auth(ids.lena), unreachable)).toBe(false)
  })

  it('an id that is not a uuid is refused without touching the database', async () => {
    expect(await grants.revoke(auth(ids.root), "' OR 1=1 --")).toBe(false)
  })

  it('revoking moves groups_version, which is what propagation is measured against', async () => {
    const id = await readGrant('layer', ids.open)

    const c = await pool.connect()
    const before = await (async () => {
      await c.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
      return loadGroupsVersion(c, ORG)
    })()

    expect(await grants.revoke(auth(ids.root), id)).toBe(true)

    await c.query(`SELECT set_config('app.current_org', $1, true)`, [ORG])
    const after = await loadGroupsVersion(c, ORG)
    c.release()

    // The trigger does this, not the adapter. If it ever stops, the worker
    // never recomputes the payload tags, the lag gauge reports zero because
    // nothing is behind, and the revocation is invisible to every piece of
    // evidence the SLA rests on — while the grant really is gone from Postgres.
    expect(after).toBeGreaterThan(before)
  })
})
