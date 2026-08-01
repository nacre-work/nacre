import { collectDatabaseGauges, createMetrics, createPool, Registry, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { claimStale, PostgresDocumentStore, tagsForLayer } from '../adapters.js'
import { retagOnce } from '../retag.js'

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

  it('the version tags are built from is the organization’s groups_version', async () => {
    const { version } = await tagsForLayer(pool, ORG, ids.layer, 'nacre_app')
    const current = await withOrg(
      pool,
      ORG,
      async (c) =>
        Number(
          (
            await c.query<{ groups_version: string }>(
              'SELECT groups_version FROM organizations WHERE id = $1',
              [ORG],
            )
          ).rows[0]?.groups_version,
        ),
      AS_APP,
    )

    // The first version of this passed `Date.now()`. It typechecks — both are
    // numbers — and it silently disables the propagation gauge outright: the
    // lag asks whether acl_version has fallen behind groups_version, and a
    // millisecond timestamp is a thousand times larger than that counter will
    // ever reach, so the comparison never fires and the metric reports perfect
    // health forever. Nothing about a wrong number here is visible except this.
    expect(version).toBe(current)
    expect(version).toBeLessThan(1_000_000)
  })

  it('claimStale finds a document behind its organization’s version, and stops finding it once marked', async () => {
    const current = await withOrg(
      pool,
      ORG,
      async (c) =>
        Number(
          (
            await c.query<{ groups_version: string }>(
              'SELECT groups_version FROM organizations WHERE id = $1',
              [ORG],
            )
          ).rows[0]?.groups_version,
        ),
      AS_APP,
    )

    const mine = async () => (await claimStale(pool, 500)).filter((d) => d.documentId === ids.doc)

    // Left at 0 by beforeEach, so it is behind whatever the version is now.
    expect(await mine()).toHaveLength(1)
    expect((await mine())[0]?.orgSlug).toBe('store')

    await store.markTagged(ORG, ids.doc, current)

    // The loop terminates only because this stops returning what it just
    // handled. If the claim did not narrow on acl_version, the pass would retag
    // the same documents forever, report progress every time, and never drain
    // the lag it is meant to clear.
    expect(await mine()).toHaveLength(0)
  })

  it('claimStale ignores deleted documents', async () => {
    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query('UPDATE documents SET deleted_at = now() WHERE org_id = $1 AND id = $2', [
          ORG,
          ids.doc,
        ])
      },
      AS_APP,
    )

    // I5 keeps them out of every answer already, so retagging one spends a
    // vector-store call on a document nothing can return.
    expect((await claimStale(pool, 500)).filter((d) => d.documentId === ids.doc)).toHaveLength(0)

    await withOrg(
      pool,
      ORG,
      async (c) => {
        await c.query('UPDATE documents SET deleted_at = NULL WHERE org_id = $1 AND id = $2', [
          ORG,
          ids.doc,
        ])
      },
      AS_APP,
    )
  })

  it('claimStale honours its limit', async () => {
    expect((await claimStale(pool, 1)).length).toBeLessThanOrEqual(1)
  })

  it('a retag pass drains the propagation lag it was built to measure', async () => {
    // The loop closed, end to end: a document behind the version, a gauge that
    // says so, a pass, and a gauge that no longer does. Every piece of this
    // subsystem exists for this one sentence to be true, and each of them is
    // individually capable of being wrong in a way that reports success.
    //
    // Qdrant is the one port faked here — the payload write has no bearing on
    // what Postgres reports, and standing one up would test the client rather
    // than this.
    const written: string[] = []
    const ports = {
      // The real query, narrowed to this fixture's organization afterwards.
      //
      // `claimStale` is cross-tenant by design — one worker drains every
      // tenant — so a test that acted on everything it returned would retag
      // whatever another test file had just set up and assert against. That is
      // not hypothetical: it is what made this suite pass alone and fail beside
      // the observability tests, which stage a stale document and then check
      // the gauge reports it.
      claim: async (limit: number) => (await claimStale(pool, limit)).filter((d) => d.orgId === ORG),
      tagsFor: (orgId: string, layerId: string) => tagsForLayer(pool, orgId, layerId, 'nacre_app'),
      retag: async (input: { documentId: string }) => {
        written.push(input.documentId)
      },
      markTagged: (orgId: string, id: string, version: number) => store.markTagged(orgId, id, version),
      onError: (_d: unknown, error: unknown) => {
        throw error
      },
    }

    const lag = async (): Promise<number | undefined> => {
      const registry = new Registry()
      const metrics = createMetrics(registry)
      registry.collect(collectDatabaseGauges(pool, metrics, 'nacre_app'))
      const line = (await registry.render())
        .split('\n')
        .find((l) => l.startsWith('nacre_acl_propagation_lag_seconds{org="store"} '))
      return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1))
    }

    // beforeEach reset it to version 0, which is behind.
    expect(await lag()).toBeGreaterThan(0)

    let guard = 0
    for (;;) {
      const pass = await retagOnce(ports, 1000, 4)
      expect(pass.failed).toBe(0)
      if (pass.retagged === 0) break
      if (++guard > 50) throw new Error('the pass never drained; claimStale is not narrowing')
    }

    expect(written).toContain(ids.doc)
    expect(await lag()).toBe(0)
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
