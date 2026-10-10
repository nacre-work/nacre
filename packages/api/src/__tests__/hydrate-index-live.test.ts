import { randomUUID } from 'node:crypto'

import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HYDRATE_SQL } from '../adapters.js'

/**
 * Every search ends by joining the ten points the index returned to their rows,
 * and that join has to start from those ten ids.
 *
 * `chunks.point_id` had no index from 0001 until 0042, so the planner walked the
 * other way — every layer of the organization, every document in each, every
 * document's chunks — and kept ten. Measured on a loaded stack: 36 ms per search
 * at 27,000 chunks and Postgres the bottleneck, linear in the organization's
 * size. A plan is a database's answer, so it is asked of a real one, with the
 * query text the search path runs and enough rows that a walk is what a planner
 * without the index would pick.
 */

const pg = process.env.NACRE_PG_URL
if (process.env.CI && pg === undefined) {
  throw new Error('NACRE_PG_URL is required when CI is set: a query plan is a database question')
}
const when = pg ? describe : describe.skip

const ORG = randomUUID()
const DOCUMENTS = 2000
const CHUNKS_EACH = 5

let pool: Pool

interface PlanNode {
  readonly 'Node Type': string
  readonly 'Index Name'?: string
  readonly 'Relation Name'?: string
  readonly Plans?: readonly PlanNode[]
}
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)]

when('the search hydration join', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: pg as string, max: 2 })
    const suffix = ORG.slice(0, 8)
    const provider = randomUUID()
    const workspace = randomUUID()
    const layer = randomUUID()
    await pool.query(
      `INSERT INTO organizations (id, slug, name, vector_collection) VALUES ($1, $2, 'Plan', $3)`,
      [ORG, `plan-${suffix}`, `org_plan_${suffix}`],
    )
    await pool.query(
      `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
       VALUES ($1, $2, 'plan', 'http://e', 'm', 4)`,
      [provider, ORG],
    )
    await pool.query(`INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1, $2, 'w', 'W')`, [workspace, ORG])
    await pool.query(
      `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
       VALUES ($1, $2, $3, 'l', 'L', $4, 'v_plan_4')`,
      [layer, ORG, workspace, provider],
    )
    await pool.query(
      `INSERT INTO documents (id, org_id, layer_id, external_id, source_type, content_hash, status)
       SELECT gen_random_uuid(), $1, $2, 'doc-' || n, 'inline', 'h' || n, 'indexed'
         FROM generate_series(1, $3::int) AS n`,
      [ORG, layer, DOCUMENTS],
    )
    await pool.query(
      `INSERT INTO chunks (org_id, document_id, ordinal, text, point_id)
       SELECT $1, d.id, o, 'chunk text', gen_random_uuid()
         FROM documents d, generate_series(0, $2::int - 1) AS o
        WHERE d.org_id = $1`,
      [ORG, CHUNKS_EACH],
    )
    await pool.query('ANALYZE chunks')
    await pool.query('ANALYZE documents')
  })

  afterAll(async () => {
    await pool?.query(`DELETE FROM organizations WHERE id = $1`, [ORG])
    await pool?.end()
  })

  it('starts from the ids the index returned, not from the organization', async () => {
    const { rows: ids } = await pool.query<{ point_id: string }>(
      `SELECT point_id FROM chunks WHERE org_id = $1 ORDER BY random() LIMIT 10`,
      [ORG],
    )
    const { rows } = await pool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(`EXPLAIN (FORMAT JSON) ${HYDRATE_SQL}`, [
      ORG,
      ids.map((r) => r.point_id),
    ])
    const plan = nodes(rows[0]!['QUERY PLAN'][0].Plan)
    // The index is named on the node that reads it, which for a bitmap scan is
    // the `Bitmap Index Scan` under a `Bitmap Heap Scan` — and only the heap
    // node carries the relation. Asked of every node, or a planner that picks a
    // bitmap over the same index reads as one that walked the organization.
    const indexes = plan.map((n) => n['Index Name']).filter((name) => name !== undefined)
    expect(indexes, JSON.stringify(plan.map((n) => n['Node Type']))).toContain('chunks_org_point_idx')
    expect(indexes).not.toContain('chunks_document_id_ordinal_key')
    expect(plan.some((n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'chunks')).toBe(false)
  })

  it('and answers the rows it was asked for', async () => {
    const { rows: ids } = await pool.query<{ point_id: string }>(
      `SELECT point_id FROM chunks WHERE org_id = $1 ORDER BY random() LIMIT 10`,
      [ORG],
    )
    const { rows } = await pool.query<{ chunk_id: string }>(HYDRATE_SQL, [ORG, ids.map((r) => r.point_id)])
    expect(rows.map((r) => r.chunk_id).sort()).toEqual(ids.map((r) => r.point_id).sort())
  })
})
