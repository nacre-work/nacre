import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool, withOrg } from '../../db/client.js'
import { effectivePrincipals } from '../principals.js'
import { resolve } from '../resolve.js'
import { loadGrants, loadScopeTree, PostgresGroupGraph } from '../store.js'

const url = process.env.NACRE_PG_URL

/**
 * These need a real database, because what they check is behaviour Postgres
 * provides and a fake would have to reimplement — which would mean testing the
 * fake. Skipped without one locally, and refused outright in CI: a leak test
 * that quietly turns itself off because an environment variable is missing is
 * the failure this project keeps coming back to.
 */
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. The integration tests would silently ' +
      'skip, and acl-invariants would report green having checked none of the ' +
      'tenant isolation it claims to cover.',
  )
}

const when = url ? describe : describe.skip

let pool: Pool

/** The application role. Reads as the owner would bypass the policies. */
const AS_APP = { role: 'nacre_app' } as const

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

// Fixed ids so a failure names something findable rather than a fresh uuid.
const ids = {
  aliceA: '00000000-0000-0000-0000-00000000a001',
  bobB: '00000000-0000-0000-0000-00000000b001',
  legalA: '00000000-0000-0000-0000-00000000a101',
  seniorA: '00000000-0000-0000-0000-00000000a102',
  wsA: '00000000-0000-0000-0000-00000000a201',
  wsB: '00000000-0000-0000-0000-00000000b201',
  contractsA: '00000000-0000-0000-0000-00000000a301',
  handbookA: '00000000-0000-0000-0000-00000000a302',
  financeB: '00000000-0000-0000-0000-00000000b301',
  docA: '00000000-0000-0000-0000-00000000a401',
  docB: '00000000-0000-0000-0000-00000000b401',
}

when('baseline · tenant isolation in the database', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES
           ($1,'org-a','A','org_a'), ($2,'org-b','B','org_b')
         ON CONFLICT (id) DO NOTHING`,
        [A, B],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$3,'alice@a.test'), ($2,$4,'bob@b.test')
         ON CONFLICT (id) DO NOTHING`,
        [ids.aliceA, ids.bobB, A, B],
      )
      await c.query(
        `INSERT INTO groups (id, org_id, name) VALUES ($1,$3,'legal'), ($2,$3,'senior')
         ON CONFLICT (id) DO NOTHING`,
        [ids.legalA, ids.seniorA, A],
      )
      // alice ∈ legal ⊂ senior — one nesting level, so the transitive walk is
      // exercised rather than assumed.
      await c.query(
        `INSERT INTO group_members (org_id, group_id, member_user) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [A, ids.legalA, ids.aliceA],
      )
      await c.query(
        `INSERT INTO group_members (org_id, group_id, member_group) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [A, ids.seniorA, ids.legalA],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$3,'main','Main'), ($2,$4,'main','Main')
         ON CONFLICT (id) DO NOTHING`,
        [ids.wsA, ids.wsB, A, B],
      )
      await c.query(
        // Named `acl-fixture` and not `default`, which is the name
        // `provisionOrganization` gives the installation default it creates.
        // Migration 0028 made `(org_id, name)` unique with NULLS NOT DISTINCT,
        // so two NULL-org rows called `default` collide — and this fixture pins
        // its row by *id* because the layers below reference that id, so
        // `ON CONFLICT (id) DO NOTHING` cannot absorb a collision on the other
        // key. Two suites sharing one database is the release job's
        // arrangement, and it is the only place the two ever met.
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ('00000000-0000-0000-0000-0000000000e1', NULL, 'acl-fixture', 'http://e', 'bge-m3', 1024)
         ON CONFLICT (id) DO NOTHING`,
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$4,$6,'contracts','Contracts','00000000-0000-0000-0000-0000000000e1','v_bge_m3_1024'),
           ($2,$4,$6,'handbook','Handbook','00000000-0000-0000-0000-0000000000e1','v_bge_m3_1024'),
           ($3,$5,$7,'finance','Finance','00000000-0000-0000-0000-0000000000e1','v_bge_m3_1024')
         ON CONFLICT (id) DO NOTHING`,
        [ids.contractsA, ids.handbookA, ids.financeB, A, B, ids.wsA, ids.wsB],
      )
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, source_type, content_hash) VALUES
           ($1,$3,$5,'inline','h1'), ($2,$4,$6,'inline','h2')
         ON CONFLICT (id) DO NOTHING`,
        [ids.docA, ids.docB, A, B, ids.contractsA, ids.financeB],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'group',$2,'workspace',$3,'read','allow'),
                ($1,'user',$4,'layer',$5,'read','deny'),
                ($6,'user',$7,'workspace',$8,'read','allow')
         ON CONFLICT DO NOTHING`,
        [A, ids.seniorA, ids.wsA, ids.aliceA, ids.handbookA, B, ids.bobB, ids.wsB],
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

  /**
   * Every row a scoped connection returns carries the org it was scoped to.
   *
   * This is the assertion these two cases make, and it is deliberately not a
   * census of the fixture. Comparing against an exact list makes the test a
   * statement about *what else is in the database*, which is not what T1 is
   * about: any row added to the fixture organization by anything else — another
   * suite, a developer driving the stack by hand between runs — turns it red
   * while isolation is intact, and a suite that goes red for reasons unrelated
   * to the change is one people learn to re-run rather than read.
   *
   * It is also strictly stronger. The census caught a leak from org B, because
   * B is what the fixture names; this catches a leak from *any* tenant, which
   * is the property the policies actually have to hold.
   *
   * The embedding-provider case below already made this argument for its own
   * table — "the assertion is the property, not a row count" — and the reason
   * it was not applied here is the reason it is worth writing down: a fix that
   * lands in one place and not its sibling is the most repeated defect in this
   * repository.
   */
  const everyRowBelongsTo = (org: string, table: string, rows: readonly { org_id: string }[]): void => {
    for (const [index, row] of rows.entries()) {
      expect(row.org_id, `${table}[${String(index)}] visible to a connection scoped to ${org}`).toBe(org)
    }
  }

  it('T1 · a connection scoped to org A sees no org B rows', async () => {
    const seen = await withOrg(pool, A, async (c) => ({
      documents: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM documents')).rows,
      layers: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM layers')).rows,
      users: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM users')).rows,
      grants: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM grants')).rows,
    }), AS_APP)

    // The fixture is reachable. Without this the loop below passes on an empty
    // set, which is how a test about what is *visible* fails open — a policy
    // that hid everything from everybody would satisfy the property and break
    // the product.
    expect(seen.documents.map((r) => r.id)).toContain(ids.docA)
    expect(seen.layers.map((r) => r.id)).toEqual(
      expect.arrayContaining([ids.contractsA, ids.handbookA]),
    )
    expect(seen.users.map((r) => r.id)).toContain(ids.aliceA)
    expect(seen.grants.length).toBeGreaterThanOrEqual(2)

    for (const [table, rows] of Object.entries(seen)) everyRowBelongsTo(A, table, rows)
  })

  it('T1 · row-level security also covers the tables 0001 left open', async () => {
    // users, groups, group_members, service_accounts, sso_configs, audit_events
    // and embedding_providers had no policy until migration 0002.
    //
    // Org A's rows have to exist before org B seeing none of them means
    // anything: a fixture that failed to seed would otherwise satisfy this
    // case by leaving the tables empty.
    const owner = await withOrg(pool, A, async (c) => ({
      groups: (await c.query('SELECT id FROM groups')).rowCount ?? 0,
      members: (await c.query('SELECT group_id FROM group_members')).rowCount ?? 0,
    }), AS_APP)
    expect(owner.groups, "org A's groups exist, so there is something to leak").toBeGreaterThan(0)
    expect(owner.members, "org A's group members exist, so there is something to leak").toBeGreaterThan(0)

    const seen = await withOrg(pool, B, async (c) => ({
      users: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM users')).rows,
      groups: (await c.query<{ id: string; org_id: string }>('SELECT id, org_id FROM groups')).rows,
      members: (await c.query<{ group_id: string; org_id: string }>(
        'SELECT group_id, org_id FROM group_members',
      )).rows,
    }), AS_APP)

    expect(seen.users.map((r) => r.id)).toContain(ids.bobB)
    for (const [table, rows] of Object.entries(seen)) everyRowBelongsTo(B, table, rows)
  })

  it('the installation-wide default model stays visible to every tenant', async () => {
    // The one deliberate exception in the policy: org_id IS NULL is the global
    // default, and a tenant that cannot see it cannot index anything.
    //
    // The assertion is the property, not a row count. Counting was brittle —
    // another test adding a global provider broke it while nothing about
    // isolation had changed.
    for (const org of [A, B]) {
      const rows = await withOrg(pool, org, async (c) =>
        (await c.query<{ id: string; org_id: string | null }>(
          'SELECT id, org_id FROM embedding_providers',
        )).rows, AS_APP)

      expect(rows.length, 'the global default must be reachable').toBeGreaterThan(0)
      for (const row of rows) {
        // Global, or this tenant's own. Never another tenant's — that row would
        // carry an endpoint and a credentials reference.
        expect([null, org], `provider ${row.id}`).toContain(row.org_id)
      }
    }
  })

  it('another tenant’s embedding provider stays invisible', async () => {
    const c = await pool.connect()
    try {
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ('00000000-0000-0000-0000-0000000000f1', $1, 'b-private', 'http://secret.internal', 'm', 4)
         ON CONFLICT (id) DO NOTHING`,
        [B],
      )
    } finally {
      c.release()
    }

    const visible = await withOrg(pool, A, async (client) =>
      (await client.query<{ endpoint: string }>('SELECT endpoint FROM embedding_providers')).rows.map(
        (r) => r.endpoint,
      ), AS_APP)

    expect(visible).not.toContain('http://secret.internal')
  })

  it('the audit log refuses UPDATE and DELETE for the application role', async () => {
    const c = await pool.connect()
    try {
      const { rows } = await c.query<{ has: boolean }>(
        `SELECT has_table_privilege('nacre_app','audit_events',$1) AS has`,
        ['UPDATE'],
      )
      expect(rows[0]?.has, 'nacre_app must not be able to rewrite the audit log').toBe(false)

      const del = await c.query<{ has: boolean }>(
        `SELECT has_table_privilege('nacre_app','audit_events',$1) AS has`,
        ['DELETE'],
      )
      expect(del.rows[0]?.has).toBe(false)

      const ins = await c.query<{ has: boolean }>(
        `SELECT has_table_privilege('nacre_app','audit_events',$1) AS has`,
        ['INSERT'],
      )
      expect(ins.rows[0]?.has, 'but it must be able to write events').toBe(true)
    } finally {
      c.release()
    }
  })

  it('T3, T6 · the resolver agrees with the database round trip', async () => {
    const plan = await withOrg(pool, A, async (c) => {
      const graph = await PostgresGroupGraph.load(c, A)
      const principals = effectivePrincipals({ type: 'user', id: ids.aliceA }, graph)

      // alice ∈ legal ⊂ senior, so the workspace grant on `senior` reaches her.
      expect([...principals].sort()).toEqual(
        [`group:${ids.legalA}`, `group:${ids.seniorA}`, `user:${ids.aliceA}`].sort(),
      )

      const grants = await loadGrants(c, A, principals)
      const tree = await loadScopeTree(
        c,
        A,
        grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
      )
      return resolve({ orgId: A, role: 'member', principals, grants, tree }, 'read')
    }, AS_APP)

    // Workspace-wide read, minus the explicit deny on handbook.
    expect(plan.kind).toBe('scoped')
    if (plan.kind !== 'scoped') return
    expect(plan.layers).toEqual([ids.contractsA])
    expect(plan.layers).not.toContain(ids.handbookA)
  })

  it('the policies apply to the table owner, not just to other roles', async () => {
    // ENABLE alone leaves the owner unfiltered, and migrations run as the owner.
    // Without FORCE every policy in 0001 was enabled and inert — this is the
    // test that says so out loud.
    const forced = await withOrg(pool, A, async (c) =>
      (await c.query<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relrowsecurity AND NOT c.relforcerowsecurity`,
      )).rows.map((r) => r.relname), AS_APP)

    expect(forced, 'RLS enabled but not forced — inert for the owning role').toEqual([])
  })

  it('a cross-tenant group membership row cannot be written', async () => {
    // The composite foreign keys added in 0002 are what make this a database
    // guarantee rather than an application convention. Without them, one row
    // joining an org B user to an org A group would hand that user every grant
    // the group holds.
    const c = await pool.connect()
    try {
      await expect(
        c.query(
          `INSERT INTO group_members (org_id, group_id, member_user) VALUES ($1,$2,$3)`,
          [A, ids.legalA, ids.bobB],
        ),
      ).rejects.toThrow()
    } finally {
      c.release()
    }
  })
})
