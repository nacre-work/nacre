import { createPool, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresDocumentStore } from '../adapters.js'

/**
 * `markTagged`, against a real database.
 *
 * The guard it carries is a `WHERE` clause, and a `WHERE` clause cannot be
 * tested against a fake without testing the fake. What it defends is invariant
 * I4's evidence: `acl_version` walking backwards invents propagation lag that
 * nothing is actually behind on, and a lag gauge that cries wolf is one nobody
 * reads by the time it is right.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the acl_version guard would go untested.')
}
const when = url ? describe : describe.skip

const ORG = '88888888-8888-8888-8888-888888888888'
const ids = {
  ws: '00000000-0000-0000-0000-0000000000e1',
  layer: '00000000-0000-0000-0000-0000000000e2',
  provider: '00000000-0000-0000-0000-0000000000e3',
  doc: '00000000-0000-0000-0000-0000000000e4',
}

const AS_APP = { role: 'nacre_app' } as const
let pool: Pool
let store: PostgresDocumentStore

async function versionOf(id: string): Promise<{ version: number; taggedAt: Date | null }> {
  return withOrg(
    pool,
    ORG,
    async (c) => {
      const { rows } = await c.query<{ acl_version: string; acl_tagged_at: Date | null }>(
        'SELECT acl_version, acl_tagged_at FROM documents WHERE org_id = $1 AND id = $2',
        [ORG, id],
      )
      return { version: Number(rows[0]?.acl_version), taggedAt: rows[0]?.acl_tagged_at ?? null }
    },
    AS_APP,
  )
}

when('PostgresDocumentStore · markTagged', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    store = new PostgresDocumentStore(pool, 'nacre_app')

    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'store','Store','org_store') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1,NULL,'store','http://e','m',4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'w','W') ON CONFLICT DO NOTHING`,
        [ids.ws, ORG],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'store','Store',$4,'v') ON CONFLICT DO NOTHING`,
        [ids.layer, ORG, ids.ws, ids.provider],
      )
      await c.query('COMMIT')
    } catch (e) {
      await c.query('ROLLBACK')
      throw e
    } finally {
      c.release()
    }

    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query(
          `INSERT INTO documents
             (id, org_id, layer_id, external_id, source_type, content_hash, status, chunk_count)
           VALUES ($1,$2,$3,'doc','inline','sha256:x','indexed',1)
           ON CONFLICT (id) DO NOTHING`,
          [ids.doc, ORG, ids.layer],
        )
      },
      AS_APP,
    )
  })

  afterAll(async () => {
    await pool?.end()
  })

  // Back to never-tagged before each case. The fixture row outlives the run,
  // and tests that only pass in order — or only on a clean database — are the
  // ones that get marked flaky and then ignored.
  beforeEach(async () => {
    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query(
          'UPDATE documents SET acl_version = 0, acl_tagged_at = NULL WHERE org_id = $1 AND id = $2',
          [ORG, ids.doc],
        )
      },
      AS_APP,
    )
  })

  it('a fresh document starts untagged, and says so', async () => {
    const { version, taggedAt } = await versionOf(ids.doc)

    // Zero and null rather than "now": a row that has never been tagged must
    // not arrive claiming it was, or the gauge reports a comfortable zero on
    // its first scrape for documents whose vectors carry no tags at all.
    expect(version).toBe(0)
    expect(taggedAt).toBeNull()
  })

  it('records the version and when', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    const { version, taggedAt } = await versionOf(ids.doc)

    expect(version).toBe(7)
    expect(taggedAt).not.toBeNull()
  })

  it('a late write with an older version is refused', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    await store.markTagged(ORG, ids.doc, 4)

    // Two ingests of the same document can finish out of order. Letting the
    // loser win would walk acl_version backwards and manufacture lag against a
    // recomputation that already happened.
    expect((await versionOf(ids.doc)).version).toBe(7)
  })

  it('an equal version still refreshes the timestamp', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    const first = (await versionOf(ids.doc)).taggedAt

    await new Promise((r) => setTimeout(r, 10))
    await store.markTagged(ORG, ids.doc, 7)
    const second = (await versionOf(ids.doc)).taggedAt

    // A retag at the same version is real work, and the lag is measured from
    // the timestamp. Freezing it would report the document as ageing while it
    // is being kept current.
    expect(second?.getTime()).toBeGreaterThan(first?.getTime() as number)
  })

  it('a newer version moves it forward', async () => {
    await store.markTagged(ORG, ids.doc, 7)
    await store.markTagged(ORG, ids.doc, 9)
    expect((await versionOf(ids.doc)).version).toBe(9)
  })

  it('another organization cannot mark this one’s document', async () => {
    await store.markTagged(ORG, ids.doc, 9)
    const other = '99999999-9999-9999-9999-999999999999'

    // It does not raise. Row-level security makes the row invisible to the
    // other tenant, so the UPDATE matches nothing and succeeds — which is the
    // behaviour to want here, not an error: a cross-tenant write that throws
    // tells the caller the document exists. A silent no-op tells it nothing,
    // and that is invariant I4's "indistinguishable" applied to writes.
    await expect(store.markTagged(other, ids.doc, 999)).resolves.toBeUndefined()

    expect((await versionOf(ids.doc)).version).toBe(9)
  })
})
