import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresLayers } from '@nacre.work/api'

import { createPool, withOrg } from '../../db/client.js'
import { cachedEffectivePrincipals, MemoryCache, principalsCacheKey } from '../cache.js'
import { effectivePrincipals } from '../principals.js'
import { resolve } from '../resolve.js'
import { loadGrants, loadGroupsVersion, loadScopeTree, PostgresGroupGraph } from '../store.js'

/**
 * T11 — a group changes while queries are in flight.
 *
 * The specification asks that nothing from a revoked layer appears after the
 * SLA. What is actually built here is stronger and simpler to reason about:
 * the cache key carries `groups_version`, so a revoked grant cannot be served
 * *at all* rather than for up to sixty seconds. A request that would have hit
 * the stale entry composes a different key and misses.
 *
 * The SLA then bounds the propagation of `acl_tags`, which is a cache of a
 * different thing, and not the resolver's answer.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; T11 would silently skip.')
}
const when = url ? describe : describe.skip

const ORG = '66666666-6666-6666-6666-666666666666'
const ids = {
  alice: '00000000-0000-0000-0000-0000000000c1',
  legal: '00000000-0000-0000-0000-0000000000c2',
  ws: '00000000-0000-0000-0000-0000000000c3',
  secret: '00000000-0000-0000-0000-0000000000c4',
  provider: '00000000-0000-0000-0000-0000000000c9',
}

const AS_APP = { role: 'nacre_app' } as const
const alice = { type: 'user' as const, id: ids.alice }
let pool: Pool

/**
 * One resolve, exactly as the search path does it, cache included.
 *
 * Returns the version the query itself observed alongside the answer. That
 * pairing is what makes a concurrency assertion possible at all: a query's
 * result can only be judged against the state its own transaction saw, not
 * against a flag set on the wall clock somewhere else.
 */
async function planFor(cache: MemoryCache): Promise<{ version: number; layers: readonly string[] }> {
  return withOrg(
    pool,
    ORG,
    async (client) => {
      const version = await loadGroupsVersion(client, ORG)
      const principals = await cachedEffectivePrincipals(
        { orgId: ORG, principal: alice, groupsVersion: version, ttlSeconds: 60 },
        cache,
        () => PostgresGroupGraph.load(client, ORG),
      )
      const grants = await loadGrants(client, ORG, principals)
      const tree = await loadScopeTree(client, ORG, [])
      const plan = resolve({ orgId: ORG, role: 'member', principals, grants, tree }, 'read')
      return { version, layers: plan.kind === 'scoped' ? plan.layers : [] }
    },
    AS_APP,
  )
}

const layersOf = async (cache: MemoryCache) => (await planFor(cache)).layers

when('adversarial · revocation under load', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'prop','Prop','org_prop') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$2,'alice@prop.test') ON CONFLICT DO NOTHING`,
        [ids.alice, ORG],
      )
      await c.query(`INSERT INTO groups (id, org_id, name) VALUES ($1,$2,'legal') ON CONFLICT DO NOTHING`, [
        ids.legal,
        ORG,
      ])
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'prop','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'secret','Secret',$4,'v') ON CONFLICT DO NOTHING`,
        [ids.secret, ORG, ids.ws, ids.provider],
      )
      // The group holds the grant. Alice's access exists only through it.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'group',$2,'layer',$3,'read','allow') ON CONFLICT DO NOTHING`,
        [ORG, ids.legal, ids.secret],
      )
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  const join = async () => {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO group_members (org_id, group_id, member_user) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [ORG, ids.legal, ids.alice],
      )
    } finally {
      c.release()
    }
  }

  const leave = async () => {
    const c = await pool.connect()
    try {
      await c.query(`DELETE FROM group_members WHERE org_id = $1 AND group_id = $2 AND member_user = $3`, [
        ORG,
        ids.legal,
        ids.alice,
      ])
    } finally {
      c.release()
    }
  }

  /**
   * The gap this file did not cover, and the reason it did not look like a gap.
   *
   * Every case above exercises `cachedEffectivePrincipals` directly. All of them
   * passed while **nothing in the request path called it**: `NACRE_ACL_CACHE_TTL`
   * was validated at startup and read by nothing, so the API resolved the group
   * closure from scratch on every request and this suite proved a code path that
   * did not run. A cache tested and never called is the same shape as a
   * configuration variable accepted and never read.
   *
   * So these two ask the adapter, not the module.
   */
  it('the request path consults the cache it is given', async () => {
    await join()
    const counting = new MemoryCache()
    let reads = 0
    const store = {
      get: async (key: string) => {
        reads++
        return counting.get(key)
      },
      set: (key: string, value: string, ttl: number) => counting.set(key, value, ttl),
    }

    const layers = new PostgresLayers(pool, { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined }, 'nacre_app', {
      store,
      ttlSeconds: 60,
    })

    await layers.list({ orgId: ORG, principal: alice, role: 'member' })
    await layers.list({ orgId: ORG, principal: alice, role: 'member' })

    // Two requests, two reads. Zero would mean the adapter was constructed with
    // a cache and resolves without it, which is the state this change fixes and
    // which every other test in this file would still pass through.
    expect(reads).toBe(2)
    expect(counting.size).toBe(1)
  })

  it('T11 · a revocation is immediate through the adapter, not merely through the module', async () => {
    await join()
    const cache = new MemoryCache()
    const principals = { store: cache, ttlSeconds: 60 }
    const layers = new PostgresLayers(pool, { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined }, 'nacre_app', principals)
    const auth = { orgId: ORG, principal: alice, role: 'member' as const }

    const before = await layers.list(auth)
    expect(before.items.map((l) => l.slug)).toContain('secret')

    // The entry for the version just used is now warm. If the adapter served
    // from it, this revocation would be invisible for the length of the TTL.
    await leave()

    const after = await layers.list(auth)
    expect(after.items.map((l) => l.slug)).not.toContain('secret')

    await join()
  })

  it('a membership change moves groups_version, by trigger', async () => {
    const version = async () =>
      withOrg(pool, ORG, async (c) => loadGroupsVersion(c, ORG), AS_APP)

    await leave()
    const before = await version()
    await join()
    const afterJoin = await version()
    await leave()
    const afterLeave = await version()

    // 0001 shipped the column and nothing incremented it. A cache keyed on a
    // constant is a cache that never invalidates.
    expect(afterJoin).toBeGreaterThan(before)
    expect(afterLeave).toBeGreaterThan(afterJoin)
  })

  it('T11 · a revoked grant is not served from cache, at any point', async () => {
    const cache = new MemoryCache()

    await join()
    expect(await layersOf(cache)).toEqual([ids.secret])

    // Warm it hard, so a TTL-based cache would certainly still be holding it.
    for (let i = 0; i < 20; i++) await planFor(cache)

    await leave()

    // No sleep. Not "within the SLA" — immediately. The version moved, so the
    // warmed entries are keyed to a version nothing asks for any more.
    expect(await layersOf(cache)).toEqual([])
  })

  it('T11 · a membership change under 1000 concurrent resolves', async () => {
    const cache = new MemoryCache()
    await join()
    await planFor(cache) // warm

    let revokedAtVersion = Number.MAX_SAFE_INTEGER
    const failures: string[] = []

    const queries = Array.from({ length: 1000 }, async (_, i) => {
      // Spread the load across the change rather than bunching before or after.
      await new Promise((r) => setTimeout(r, i % 40))
      const { version, layers } = await planFor(cache)

      // Judged against the version this query itself read, not against a flag
      // set on the wall clock. A query whose snapshot predates the revocation
      // is *correct* to see the layer — its transaction began before the
      // change committed. The property that must hold is narrower and exact:
      // once a query has observed the post-revocation version, the layer is
      // gone for it.
      if (version >= revokedAtVersion && layers.includes(ids.secret)) {
        failures.push(`query ${i} saw the revoked layer at version ${version}`)
      }
    })

    const revocation = (async () => {
      await new Promise((r) => setTimeout(r, 15))
      await leave()
      revokedAtVersion = await withOrg(pool, ORG, async (c) => loadGroupsVersion(c, ORG), AS_APP)
    })()

    await Promise.all([...queries, revocation])

    expect(failures).toEqual([])
    // The window has to have been exercised, or this proves nothing.
    expect(revokedAtVersion).toBeLessThan(Number.MAX_SAFE_INTEGER)
  }, 60_000)

  it('the cache key changes with the version, rather than being invalidated', async () => {
    // The mechanism, stated as a test: nothing deletes anything. Two versions
    // are two keys, and the stale one ages out unread.
    const a = principalsCacheKey(ORG, alice, 41)
    const b = principalsCacheKey(ORG, alice, 42)
    expect(a).not.toBe(b)
    expect(b).toContain('v42')
  })

  it('an unreachable cache is slow, not wrong', async () => {
    const broken = {
      get: async () => {
        throw new Error('redis is down')
      },
      set: async () => {
        throw new Error('redis is down')
      },
    }

    await join()
    const principals = await withOrg(
      pool,
      ORG,
      async (client) =>
        cachedEffectivePrincipals(
          { orgId: ORG, principal: alice, groupsVersion: 1, ttlSeconds: 60 },
          broken,
          () => PostgresGroupGraph.load(client, ORG),
        ),
      AS_APP,
    )

    // Falls through to the graph. Treating a cache outage as a permission
    // failure would turn a Redis restart into an outage; treating it as an
    // allow is not on the table, because the fallback computes the same answer.
    expect(principals.has(`group:${ids.legal}`)).toBe(true)
    await leave()
  })

  it('a cache entry written in a shape we do not recognize is recomputed', async () => {
    const cache = new MemoryCache()
    await join()

    const version = await withOrg(pool, ORG, async (c) => loadGroupsVersion(c, ORG), AS_APP)
    await cache.set(principalsCacheKey(ORG, alice, version), '{"not":"an array"}', 60)

    const principals = await withOrg(
      pool,
      ORG,
      async (client) =>
        cachedEffectivePrincipals(
          { orgId: ORG, principal: alice, groupsVersion: version, ttlSeconds: 60 },
          cache,
          () => PostgresGroupGraph.load(client, ORG),
        ),
      AS_APP,
    )

    // A malformed principal set is a wrong permission set. Recompute, never
    // coerce.
    expect(principals.has(`group:${ids.legal}`)).toBe(true)
    await leave()
  })

  it('the cached answer matches the uncached one', async () => {
    const cache = new MemoryCache()
    await join()

    const [cached, direct] = await withOrg(
      pool,
      ORG,
      async (client) => {
        const version = await loadGroupsVersion(client, ORG)
        const graph = await PostgresGroupGraph.load(client, ORG)
        return [
          await cachedEffectivePrincipals(
            { orgId: ORG, principal: alice, groupsVersion: version, ttlSeconds: 60 },
            cache,
            async () => graph,
          ),
          effectivePrincipals(alice, graph),
        ]
      },
      AS_APP,
    )

    expect([...cached].sort()).toEqual([...direct].sort())
    await leave()
  })
})
