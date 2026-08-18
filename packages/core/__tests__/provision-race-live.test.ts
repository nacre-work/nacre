import { randomUUID } from 'node:crypto'

import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool } from '../db/client.js'
import { provisionOrganization } from '../provision.js'

/**
 * Two organizations provisioned at once, against a real PostgreSQL.
 *
 * ## The defect
 *
 * The installation default is one `org_id IS NULL` row, inserted by whichever
 * provisioning gets there first and reused by every one after. The guard was
 * `WHERE NOT EXISTS (SELECT 1 FROM embedding_providers WHERE org_id IS NULL)`
 * — a read — so two transactions whose snapshots predate either commit both saw
 * no default and both inserted one.
 *
 * That used to produce a silent duplicate. Migration 0028 added
 * `NULLS NOT DISTINCT` to `(org_id, name)` precisely to forbid it, and
 * forbidding it turned the race into a hard failure:
 *
 *     duplicate key value violates unique constraint "embedding_providers_org_name"
 *
 * out of `init`, with no organization created. A correct constraint met an
 * unprotected check-then-insert, and the constraint was right.
 *
 * ## Why it is not a rare window
 *
 * An installation provisions two organizations at once the ordinary way: a
 * bootstrap creating the operator's tenant and a seed creating a demonstration
 * one, both starting the moment the API reports ready. That is how this was
 * found — on a public stand, where the second `init` failed and the demo never
 * seeded, hours after a reset that reported success.
 *
 * ## What this asserts
 *
 * Both provisionings succeed, and they end up sharing **one** default provider.
 * The second half matters as much as the first: a fix that let each have its
 * own would pass "no error" and reintroduce the thing 0028 forbids.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the provisioning race would go untested.')
}
const when = url ? describe : describe.skip

/** A suffix per run, so a failed run does not collide with the next. */
const suffix = randomUUID().slice(0, 8)
const SLUGS = [`race-a-${suffix}`, `race-b-${suffix}`]

let pool: Pool
let client: Client

beforeAll(async () => {
  if (!url) return
  pool = createPool({ connectionString: url, max: 8 })
  client = new Client({ connectionString: url })
  await client.connect()
})

afterAll(async () => {
  if (!url) return
  await client.query(`DELETE FROM organizations WHERE slug = ANY($1::text[])`, [SLUGS])
  await client.end()
  await pool.end()
})

/** How many installation defaults there are. */
async function defaults(): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM embedding_providers WHERE org_id IS NULL`,
  )
  return Number(rows[0]?.n ?? 0)
}

when('two organizations provisioned at once', () => {
  it('both succeed and share one installation default', async () => {
    const before = await defaults()

    // The spec each one is handed. Identical, which is the real case: two
    // processes in one deployment reading the same configuration.
    const provider = {
      endpoint: 'http://embedder:80',
      model: `race-model-${suffix}`,
      dimensions: 384,
    }

    // The collection is the vector store's and this defect is entirely the
    // database's, so it is stubbed — the one port that would otherwise need a
    // running Qdrant to ask a question about a Postgres race.
    const vectors = { ensureCollection: async (slug: string) => `org_${slug}` }

    const results = await Promise.allSettled(
      SLUGS.map((slug) =>
        provisionOrganization(
          pool,
          vectors,
          { slug, name: slug, email: `admin@${slug}.test`, workspace: 'default' },
          provider,
        ),
      ),
    )

    const failed = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))
    // Named rather than counted, because the message is the whole diagnosis:
    // a duplicate key on `embedding_providers_org_name` is this defect and
    // anything else is a different one.
    expect(failed).toEqual([])

    // Both organizations exist. Asserted rather than assumed: a fix that made
    // the loser give up quietly would satisfy "nothing threw" and still leave
    // one of the two tenants uncreated, which is the symptom that was reported.
    const { rows } = await client.query<{ slug: string }>(
      `SELECT slug FROM organizations WHERE slug = ANY($1::text[]) ORDER BY slug`,
      [SLUGS],
    )
    expect(rows.map((r) => r.slug)).toEqual([...SLUGS].sort())

    // The count of installation defaults, not the model. Two provisionings must
    // add **at most one** row between them: one where there was none, and none
    // at all where a default already existed — which is the ordinary case and
    // the reason the requested model is ignored when one is there.
    //
    // Counting rows rather than asserting the model is what makes this run on
    // a database that has been used: the first version asked for a row carrying
    // the model it passed in, and got zero on any installation that already had
    // a default, because the existing one wins. That is the product working.
    const after = await defaults()
    expect(after).toBe(Math.max(before, 1))
    // And never two, which is what the race produced before 0028 refused it.
    expect(after).toBeLessThanOrEqual(Math.max(before, 1))
  })
})
