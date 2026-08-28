import { createPool, type AddressResolver } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PostgresEmbeddingProviders } from '../adapters.js'
import type { AuthContext } from '../auth.js'

/**
 * The egress guard on provider creation, against a real PostgreSQL.
 *
 * The pure guard is unit-tested in the core; what only a database can answer is
 * that the **allow-list is the installation's own** — the global (NULL-org)
 * provider rows, read under `org_isolation` where a tenant sees those and only
 * those. So an org_admin may reuse the internal embedder the operator
 * configured and may not name any other internal host, and this proves it
 * through the RLS the deployment actually runs.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the embedding-provider egress guard is untested.')
}
const when = url ? describe : describe.skip

const ORG = '77777777-7777-4777-8777-7777770eaa01'
const ADMIN_ID = '77777777-7777-4777-8777-7777770eaaa1'
const admin: AuthContext = {
  orgId: ORG,
  principal: { type: 'user', id: ADMIN_ID },
  role: 'org_admin',
}

// The deployment's configured embedder — the origin the global provider row
// carries. Nothing here resolves it; being named is what admits it.
const CONFIGURED = 'http://embedder:80'

// A resolver the guard uses for any *other* host, so the case decides what a
// name answers with rather than depending on the runner's DNS.
const resolver: AddressResolver = async (host) => {
  const map: Record<string, string[]> = {
    'good.example.com': ['93.184.216.34'],
    'evil.example.com': ['169.254.169.254'],
  }
  const a = map[host]
  if (a === undefined) throw new Error('ENOTFOUND')
  return a.map((address) => ({ address }))
}

let pool: Pool
let providers: PostgresEmbeddingProviders

when('the embedding-provider egress guard', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    providers = new PostgresEmbeddingProviders(pool, 'nacre_app', [], resolver)

    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'egressorg','egressorg','org_egressorg') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query("DELETE FROM embedding_providers WHERE org_id = $1", [ORG])
      // The installation default, NULL-org, carrying the configured embedder's
      // origin — which is what makes it the trusted internal host.
      await c.query("DELETE FROM embedding_providers WHERE org_id IS NULL AND model = 'egress-default'")
      await c.query(
        `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
         VALUES (NULL, 'egress default', $1, 'egress-default', 8)`,
        [CONFIGURED],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    if (pool !== undefined) {
      const c = await pool.connect()
      try {
        await c.query("DELETE FROM embedding_providers WHERE org_id = $1", [ORG])
        await c.query("DELETE FROM embedding_providers WHERE org_id IS NULL AND model = 'egress-default'")
        await c.query('DELETE FROM organizations WHERE id = $1', [ORG])
      } finally {
        c.release()
      }
      await pool.end()
    }
  })

  it('admits the configured internal embedder — the same origin the global row has', async () => {
    const outcome = await providers.create(admin, {
      name: 'reuse-internal',
      endpoint: 'http://embedder:80',
      model: 'm',
      dimensions: 8,
    })
    expect(outcome.kind).toBe('created')
  })

  it('admits a public https endpoint — point at your own embedder', async () => {
    const outcome = await providers.create(admin, {
      name: 'own-embedder',
      endpoint: 'https://good.example.com/v1',
      model: 'm',
      dimensions: 8,
    })
    expect(outcome.kind).toBe('created')
  })

  it('refuses an internal host that is not the configured one', async () => {
    // The metadata endpoint behind a public-looking name, resolved through the
    // seam. No row is written.
    const outcome = await providers.create(admin, {
      name: 'exfil',
      endpoint: 'https://evil.example.com',
      model: 'm',
      dimensions: 8,
    })
    expect(outcome.kind).toBe('refused')

    const { rows } = await pool.query(
      "SELECT 1 FROM embedding_providers WHERE org_id = $1 AND name = 'exfil'",
      [ORG],
    )
    expect(rows).toHaveLength(0)
  })

  it('refuses a raw private address that is not the configured embedder', async () => {
    const outcome = await providers.create(admin, {
      name: 'metadata',
      endpoint: 'http://169.254.169.254/latest/meta-data/',
      model: 'm',
      dimensions: 8,
    })
    expect(outcome.kind).toBe('refused')
  })

  it('refuses a public IP-literal endpoint, because a real embedder is a name', async () => {
    const outcome = await providers.create(admin, {
      name: 'literal',
      endpoint: 'https://8.8.8.8/v1',
      model: 'm',
      dimensions: 8,
    })
    expect(outcome.kind).toBe('refused')
  })

  it('admits a second internal embedder named in NACRE_EMBED_ALLOWED_HOSTS', async () => {
    // The env allow-list, threaded through the adapter constructor. A tenant may
    // reuse it though it is internal, because the operator named it.
    const withEnv = new PostgresEmbeddingProviders(
      pool,
      'nacre_app',
      ['http://embedder-2:8080'],
      resolver,
    )
    const ok = await withEnv.create(admin, {
      name: 'second-internal',
      endpoint: 'http://embedder-2:8080',
      model: 'm',
      dimensions: 8,
    })
    expect(ok.kind).toBe('created')

    // A different internal host is still refused, even with the env list set.
    const no = await withEnv.create(admin, {
      name: 'other-internal',
      endpoint: 'http://embedder-9:8080',
      model: 'm',
      dimensions: 8,
    })
    expect(no.kind).toBe('refused')
  })
})
