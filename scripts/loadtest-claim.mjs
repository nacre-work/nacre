#!/usr/bin/env node
/**
 * How fast the ingest queue's claim drains, and where SKIP LOCKED stops
 * scaling.
 *
 * This runs the **real** claim statement from `packages/worker/src/claim.ts`
 * verbatim — the SELECT … FOR UPDATE OF d SKIP LOCKED with its joins, the
 * copy-in-progress NOT EXISTS, and the retry-window predicate — then marks the
 * row `indexed` and commits, which is a claim's whole database cost minus the
 * parse/embed/index that dominates a real document's wall time. So the number
 * this produces is the ceiling: claims per second the *queue* can hand out, not
 * documents per second a worker can finish.
 *
 * It seeds one org with N pending documents, spawns C connections each looping
 * claim→mark until the queue is empty, and reports total claims/sec and the
 * per-connection latency. Run across C to see the scaling curve; the knee is
 * where row-lock contention on `ORDER BY created_at LIMIT 1` stops paying for
 * another connection.
 *
 *   NACRE_PG_URL=… node scripts/loadtest-claim.mjs [--docs N] [--conns 1,2,4,8,16,32]
 */
import { Client, Pool } from 'pg'

const url = process.env.NACRE_PG_URL
if (!url) {
  console.error('NACRE_PG_URL is required')
  process.exit(2)
}
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}
const DOCS = Number(arg('docs', '100000'))
const CONNS = arg('conns', '1,2,4,8,16,32').split(',').map(Number)

const ORG = '55555555-5555-4555-8555-555555555001'

// The claim statement, copied byte for byte from claim.ts so this measures the
// query that ships, not a paraphrase. `CLAIMABLE_NOW` is inlined here as the
// same predicate the export expands to.
const CLAIM = `
  SELECT d.id, d.org_id, o.vector_collection AS collection, d.layer_id, d.external_id, l.vector_name,
         l.provider_id, d.metadata, d.source_ref, d.source_type, d.content_type, d.attempts
    FROM documents d
    JOIN organizations o ON o.id = d.org_id
    JOIN layers l        ON l.id = d.layer_id
   WHERE d.status = 'pending' AND d.deleted_at IS NULL
     AND (d.retry_after IS NULL OR d.retry_after <= now())
     AND NOT EXISTS (
       SELECT 1 FROM layers c
        WHERE c.org_id = d.org_id
          AND c.reindex_state ->> 'status' = 'running'
          AND c.reindex_state ->> 'phase'  = 'copying'
     )
   ORDER BY d.created_at
   LIMIT 1
   FOR UPDATE OF d SKIP LOCKED`

async function seed(pool) {
  const c = await pool.connect()
  try {
    await c.query(
      `INSERT INTO organizations (id, slug, name, vector_collection)
       VALUES ($1,'loadtest','loadtest','org_loadtest') ON CONFLICT (id) DO NOTHING`,
      [ORG],
    )
    const ws = await c.query(
      `INSERT INTO workspaces (org_id, slug, name) VALUES ($1,'w','w')
       ON CONFLICT (org_id, slug) DO UPDATE SET name='w' RETURNING id`,
      [ORG],
    )
    const prov = await c.query(
      `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
       VALUES ($1,'p','http://embedder','stub',4) ON CONFLICT DO NOTHING RETURNING id`,
      [ORG],
    )
    const pid =
      prov.rows[0]?.id ??
      (await c.query(`SELECT id FROM embedding_providers WHERE org_id=$1 AND name='p'`, [ORG]))
        .rows[0].id
    await c.query('DELETE FROM layers WHERE org_id=$1', [ORG])
    const layer = await c.query(
      `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name)
       VALUES ($1,$2,'l','l',$3,'v_stub_4') RETURNING id`,
      [ORG, ws.rows[0].id, pid],
    )
    return { layerId: layer.rows[0].id }
  } finally {
    c.release()
  }
}

async function fill(pool, layerId, n) {
  const c = await pool.connect()
  try {
    await c.query('DELETE FROM documents WHERE org_id=$1', [ORG])
    // Batches of 5,000 with generate_series, so a hundred thousand rows land in
    // seconds rather than a hundred thousand round trips.
    const BATCH = 5000
    for (let i = 0; i < n; i += BATCH) {
      const count = Math.min(BATCH, n - i)
      await c.query(
        `INSERT INTO documents
           (org_id, layer_id, external_id, title, source_type, source_ref, content_hash, status, created_at)
         SELECT $1, $2, 'd' || (g + $3), 'd', 'inline', 'body',
                lpad((g + $3)::text, 64, '0'), 'pending', now() + (g || ' microseconds')::interval
           FROM generate_series(1, $4) g`,
        [ORG, layerId, i, count],
      )
    }
  } finally {
    c.release()
  }
}

/** One connection, looping the real claim until the queue is empty. */
async function drainer(latencies) {
  const client = new Client({ connectionString: url })
  await client.connect()
  let claimed = 0
  try {
    for (;;) {
      const t0 = process.hrtime.bigint()
      await client.query('BEGIN')
      const { rows } = await client.query(CLAIM)
      if (rows.length === 0) {
        await client.query('COMMIT')
        break
      }
      await client.query(
        `UPDATE documents SET status='indexed', claimed_at=now(), attempts=attempts+1 WHERE id=$1`,
        [rows[0].id],
      )
      await client.query('COMMIT')
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6)
      claimed += 1
    }
  } finally {
    await client.end()
  }
  return claimed
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function main() {
  const pool = new Pool({ connectionString: url, max: 4 })
  const { layerId } = await seed(pool)
  console.log(`# claim-throughput  docs=${DOCS}  conns=${CONNS.join(',')}`)
  console.log('conns\tclaims/s\tper-conn/s\tp50 ms\tp99 ms\tdrain s')
  for (const conns of CONNS) {
    await fill(pool, layerId, DOCS)
    const latencies = []
    const t0 = Date.now()
    const counts = await Promise.all(Array.from({ length: conns }, () => drainer(latencies)))
    const seconds = (Date.now() - t0) / 1000
    const total = counts.reduce((a, b) => a + b, 0)
    latencies.sort((a, b) => a - b)
    console.log(
      [
        conns,
        Math.round(total / seconds),
        Math.round(total / seconds / conns),
        pct(latencies, 50).toFixed(3),
        pct(latencies, 99).toFixed(3),
        seconds.toFixed(1),
      ].join('\t'),
    )
  }
  await pool.query('DELETE FROM organizations WHERE id=$1', [ORG])
  await pool.end()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
