import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { HttpEmbedder, NacreSearchService, PostgresDocuments } from '@nacre.work/api'
import type { AuthContext } from '@nacre.work/api'

import { createPool } from '../../db/client.js'
import type { Hit } from '../../vector/search.js'

/**
 * The search path, end to end through the permission model.
 *
 * The claim under test is the product's whole claim: a token goes in, and what
 * comes out is bounded by the grants in Postgres — not by anything the caller
 * asked for. The vector store is a stub that records what it was handed,
 * because what matters here is *what reached it*.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the search path would go untested.')
}
const when = url ? describe : describe.skip

const A = '33333333-3333-3333-3333-333333333333'
const B = '44444444-4444-4444-4444-444444444444'
const ids = {
  alice: '00000000-0000-0000-0000-0000000000a1',
  bob: '00000000-0000-0000-0000-0000000000b1',
  wsA: '00000000-0000-0000-0000-0000000000a2',
  wsB: '00000000-0000-0000-0000-0000000000b2',
  openA: '00000000-0000-0000-0000-0000000000a3',
  shutA: '00000000-0000-0000-0000-0000000000a4',
  layerB: '00000000-0000-0000-0000-0000000000b3',
  docA: '00000000-0000-0000-0000-0000000000a5',
  provider: '00000000-0000-0000-0000-0000000000e2',
}

const AS_APP = 'nacre_app'

/** The port takes the whole context now, because it resolves before it reads. */
const as = (orgId: string, principal = ids.alice) => ({
  orgId,
  principal: { type: 'user' as const, id: principal },
  role: 'member' as const,
})
let pool: Pool

/** Records the plan it was asked to search with; returns nothing. */
class RecordingVectors {
  readonly seen: unknown[] = []
  async search(request: { plan: unknown; topK: number; orgId: string }): Promise<readonly Hit[]> {
    this.seen.push(request)
    return []
  }
  async close(): Promise<void> {}
}

const auth = (orgId: string, userId: string): AuthContext => ({
  orgId,
  principal: { type: 'user', id: userId },
  role: 'member',
})

const embedder = { embed: async (texts: readonly string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4]) }

when('baseline · the search path', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES
           ($1,'sp-a','A','org_sp_a'), ($2,'sp-b','B','org_sp_b') ON CONFLICT DO NOTHING`,
        [A, B],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$3,'a@sp.test'), ($2,$4,'b@sp.test')
         ON CONFLICT DO NOTHING`,
        [ids.alice, ids.bob, A, B],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'sp', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [ids.provider],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$3,'sp','W'), ($2,$4,'sp','W')
         ON CONFLICT DO NOTHING`,
        [ids.wsA, ids.wsB, A, B],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$4,$6,'open','Open',$8,'v'), ($2,$4,$6,'shut','Shut',$8,'v'), ($3,$5,$7,'bee','Bee',$8,'v')
         ON CONFLICT DO NOTHING`,
        [ids.openA, ids.shutA, ids.layerB, A, B, ids.wsA, ids.wsB, ids.provider],
      )
      await c.query(
        `INSERT INTO documents (id, org_id, layer_id, source_type, content_hash)
         VALUES ($1,$2,$3,'inline','h') ON CONFLICT DO NOTHING`,
        [ids.docA, A, ids.openA],
      )
      // Read on the workspace, denied on one layer. The plan must show it.
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'workspace',$3,'read','allow'),
                ($1,'user',$2,'layer',$4,'read','deny')
         ON CONFLICT DO NOTHING`,
        [A, ids.alice, ids.wsA, ids.shutA],
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

  const service = (vectors: RecordingVectors) =>
    new NacreSearchService({
      pool,
      vectors: vectors as never,
      embedder,
      orgSlug: async (orgId) => (orgId === A ? 'sp-a' : orgId === B ? 'sp-b' : undefined),
      vectorName: 'v',
      role: AS_APP,
    })

  it('T3 · the plan reaching the index carries the deny', async () => {
    const vectors = new RecordingVectors()
    await service(vectors).search(auth(A, ids.alice), 'anything', 10)

    const request = vectors.seen[0] as { plan: { kind: string; layers: string[] } }
    expect(request.plan.kind).toBe('scoped')
    expect(request.plan.layers).toEqual([ids.openA])
    expect(request.plan.layers, 'the denied layer must not reach the query').not.toContain(ids.shutA)
  })

  it('T1 · the organization on the query comes from the token', async () => {
    const vectors = new RecordingVectors()
    await service(vectors).search(auth(A, ids.alice), 'anything', 10)
    expect((vectors.seen[0] as { orgId: string }).orgId).toBe(A)
  })

  it('a caller with no grants never reaches the index at all', async () => {
    const vectors = new RecordingVectors()
    const results = await service(vectors).search(auth(B, ids.bob), 'anything', 10)

    expect(results).toEqual([])
    // Not "queried and got nothing" — no query was made. buildFilter refuses a
    // plan that reaches nothing, and this is the branch that keeps it from ever
    // being asked to.
    expect(vectors.seen).toHaveLength(0)
  })

  it('a token naming an organization that does not exist denies', async () => {
    const vectors = new RecordingVectors()
    const results = await service(vectors).search(
      auth('55555555-5555-5555-5555-555555555555', ids.alice),
      'anything',
      10,
    )
    expect(results).toEqual([])
    expect(vectors.seen).toHaveLength(0)
  })

  it('top_k reaches the index uncorrected', async () => {
    const vectors = new RecordingVectors()
    await service(vectors).search(auth(A, ids.alice), 'anything', 7)
    expect((vectors.seen[0] as { topK: number }).topK).toBe(7)
  })

  it('T8 · a document read is scoped by the token, twice over', async () => {
    const documents = new PostgresDocuments(pool, AS_APP)

    expect(await documents.read(as(A), ids.docA)).toEqual({ id: ids.docA, title: '' })
    // Same call, other organization's token: absent, not forbidden.
    expect(await documents.read(as(B), ids.docA)).toBeUndefined()
  })

  it('a malformed document id is absent, not an error', async () => {
    const documents = new PostgresDocuments(pool, AS_APP)
    // A cast error distinguishable from "not found" is an oracle for the id
    // format, and the first step in probing what the ids look like.
    expect(await documents.read(as(A), 'not-a-uuid')).toBeUndefined()
    expect(await documents.read(as(A), "'; drop table documents; --")).toBeUndefined()
  })
})

describe('baseline · the embedding client', () => {
  it('a short batch raises rather than misaligning vectors', async () => {
    const server = new HttpEmbedder('http://unused.test', 'm', 4)
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3, 4] }] }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    try {
      await expect(server.embed(['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('a dimension mismatch raises, because the index would be built wrong', async () => {
    const client = new HttpEmbedder('http://unused.test', 'm', 4)
    const original = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch

    try {
      await expect(client.embed(['a'])).rejects.toThrow(/NACRE_DEFAULT_EMBEDDING_DIM disagree/)
    } finally {
      globalThis.fetch = original
    }
  })

  it('an empty input list makes no request', async () => {
    const client = new HttpEmbedder('http://unused.test', 'm', 4)
    let called = false
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      called = true
      return new Response('{}')
    }) as typeof fetch

    try {
      expect(await client.embed([])).toEqual([])
      expect(called).toBe(false)
    } finally {
      globalThis.fetch = original
    }
  })
})
