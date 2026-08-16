import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  HttpEmbedder,
  NacreSearchService,
  PostgresDocuments,
  PostgresLayers,
  PostgresWorkspaces,
} from '@nacre.work/api'
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
  // `write` on the open layer and no `read`, which is rule 6's whole point.
  carol: '00000000-0000-0000-0000-0000000000a6',
  // admin on the workspace and nothing else; erin has nothing at all.
  dave: '00000000-0000-0000-0000-0000000000a7',
  erin: '00000000-0000-0000-0000-0000000000a8',
  // read *and* admin on a layer, and nothing on the workspace holding it. The
  // one principal that can tell "administers a workspace" from "administers
  // something inside one" apart, which every other principal here cannot.
  frank: '00000000-0000-0000-0000-0000000000a9',
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

/**
 * The metadata payload port, which the read path never touches. Raising rather
 * than pretending: if a read ever starts writing to the index, this is how it
 * gets caught rather than passing silently.
 */
const noPayload = {
  setMetadata: async () => {
    throw new Error('the read path must not write to the index')
  },
}

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
           ($1,$4,$6,'open','Open',$8,'v_m_4'), ($2,$4,$6,'shut','Shut',$8,'v_m_4'),
           ($3,$5,$7,'bee','Bee',$8,'v_m_4')
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
      // Carol writes and cannot read. Rule 6 says those are different sets, and
      // the metadata path is the first write endpoint where the difference is
      // observable from outside.
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$2,'c@sp.test') ON CONFLICT DO NOTHING`,
        [ids.carol, A],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'write','allow')
         ON CONFLICT DO NOTHING`,
        [A, ids.carol, ids.openA],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$3,'d@sp.test'), ($2,$3,'e@sp.test')
         ON CONFLICT DO NOTHING`,
        [ids.dave, ids.erin, A],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'workspace',$3,'admin','allow')
         ON CONFLICT DO NOTHING`,
        [A, ids.dave, ids.wsA],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email) VALUES ($1,$2,'f@sp.test') ON CONFLICT DO NOTHING`,
        [ids.frank, A],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'read','allow'),
                ($1,'user',$2,'layer',$3,'admin','allow')
         ON CONFLICT DO NOTHING`,
        [A, ids.frank, ids.openA],
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
      embedderFor: () => embedder,
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
    const documents = new PostgresDocuments(pool, noPayload, AS_APP)

    expect(await documents.read(as(A), ids.docA)).toMatchObject({
      document_id: ids.docA,
      layer: 'open',
      title: null,
    })
    // Same call, other organization's token: absent, not forbidden.
    expect(await documents.read(as(B), ids.docA)).toBeUndefined()
  })

  it('a failed document says why, and a working one carries no stale reason', async () => {
    // The worker has written `documents.error` since it had a message worth
    // writing, and no surface read it back — so five failed documents in a real
    // deployment reported `failed` with `chunk_count: 0` and nothing else, and
    // the reason was reachable only by whoever holds the host.
    const documents = new PostgresDocuments(pool, noPayload, AS_APP)
    const c = await pool.connect()
    try {
      await c.query(
        `UPDATE documents SET status = 'failed', error = $2 WHERE id = $1`,
        [ids.docA, 'the embedding endpoint at http://embedder/embeddings did not answer within 120 s'],
      )
    } finally {
      c.release()
    }

    // The wording survives and the endpoint does not. This surface handed back
    // the column verbatim while `/v1/jobs` carefully removed the host from the
    // same string — and `get_document` is an MCP tool resolving `read`, so its
    // caller can be a third party acting through a delegation. That is the
    // caller the redaction was written for, reached through the other door.
    const failed = await documents.read(as(A), ids.docA)
    expect(failed).toMatchObject({
      status: 'failed',
      error: 'the embedding endpoint at [endpoint] did not answer within 120 s',
    })
    expect(failed?.error).not.toContain('embedder')

    // And the layer says so too, which is the other half. `documentCount` stays
    // a count of rows — right, and by itself indistinguishable between a layer
    // that works and one where nothing does.
    const layers = new PostgresLayers(
      pool,
      { vectorsOf: async () => ({}), tombstoneLayer: async () => undefined },
      AS_APP,
    )
    const open = (await layers.list(as(A))).items.find((l) => l.slug === 'open')
    expect(open).toMatchObject({ documentCount: 1, failedCount: 1 })

    // A retry that succeeded leaves the column populated, because nothing
    // clears it — so the status decides, not the column. Reporting the last
    // failure beside `indexed` would describe a working document as broken.
    const back = await pool.connect()
    try {
      await back.query(`UPDATE documents SET status = 'indexed' WHERE id = $1`, [ids.docA])
    } finally {
      back.release()
    }
    expect(await documents.read(as(A), ids.docA)).toMatchObject({ status: 'indexed', error: null })
    const healthy = (await layers.list(as(A))).items.find((l) => l.slug === 'open')
    expect(healthy).toMatchObject({ documentCount: 1, failedCount: 0 })

    // And it is the document's own permission, so an unreachable document
    // discloses no reason either — the 404 keeps meaning what rule 4 says.
    expect(await documents.read(as(B), ids.docA)).toBeUndefined()
  })

  it('metadata is a write, and read alone does not reach it', async () => {
    // Rule 6, on the first write endpoint where the difference shows from
    // outside. Alice reads the document happily and cannot retag it, and the
    // refusal is the same `false` that an absent document gets — there is no
    // second answer for "you may look but not touch".
    const wrote: { collection: string; documentId: string }[] = []
    const recording = {
      setMetadata: async (collection: string, documentId: string) => {
        wrote.push({ collection, documentId })
      },
    }
    const documents = new PostgresDocuments(pool, recording, AS_APP)

    expect(await documents.read(as(A), ids.docA)).toBeDefined()
    expect(await documents.updateMetadata(as(A), ids.docA, { source: 'forged' })).toBe(false)
    // And nothing reached the index. A refusal that still wrote the payload
    // would be the permission check running after the side effect.
    expect(wrote).toEqual([])
  })

  it('write without read reaches it, which is the other half of rule 6', async () => {
    const wrote: string[] = []
    const documents = new PostgresDocuments(
      pool,
      { setMetadata: async (_c: string, id: string) => void wrote.push(id) },
      AS_APP,
    )

    expect(await documents.updateMetadata(as(A, ids.carol), ids.docA, { source: 'notion' })).toBe(
      true,
    )
    expect(wrote).toEqual([ids.docA])
    // Carol still cannot read it. If this ever returns a document, `write`
    // has started implying `read` and rule 6 is gone.
    expect(await documents.read(as(A, ids.carol), ids.docA)).toBeUndefined()
  })

  it('another organization cannot retag this one, and touches no index', async () => {
    const wrote: string[] = []
    const documents = new PostgresDocuments(
      pool,
      { setMetadata: async (_c: string, id: string) => void wrote.push(id) },
      AS_APP,
    )
    expect(await documents.updateMetadata(as(B), ids.docA, { source: 'x' })).toBe(false)
    expect(wrote).toEqual([])
  })

  it('an admin of an empty workspace can see it, which is what unblocks them', async () => {
    // `resolve` flattens a grant set to the layers it reaches, so a principal
    // whose only grant is on a workspace with nothing in it yet resolves to
    // `none`. Listing had an early return on that, so the one caller who needs
    // this endpoint — an administrator who has just been granted a workspace
    // and cannot create the first layer without its id — saw nothing. Caught by
    // running it, not by this test, which is here so it stays caught.
    const workspaces = new PostgresWorkspaces(pool, AS_APP)

    // dave administers wsA and holds nothing else. wsA has layers in this
    // fixture, so the empty case is the *grant* being the only route: the
    // assertion that matters is that a workspace grant alone is enough.
    const listed = await workspaces.list(as(A, ids.dave))
    expect(listed.items.map((w) => w.id)).toEqual([ids.wsA])

    // And a principal with no grants at all still sees nothing. Without this
    // the fix above could have been "show everyone every workspace".
    expect((await workspaces.list(as(A, ids.erin))).items).toEqual([])
  })

  it('the workspace listing says what the caller holds, and a layer inside is not authority over it', async () => {
    // `permissions` exists so a client can ask "may I create a layer here?".
    // The role cannot answer it — a grant of `admin` on the workspace is
    // enough, and reaching a *layer* inside one is not — so getting the second
    // half wrong would put "New layer" in front of every reader, and their next
    // request is the 404 invariant 4 owes an unreachable object.
    const workspaces = new PostgresWorkspaces(pool, AS_APP)

    // dave's only grant is `admin` on wsA itself. admin implies both.
    const [forDave] = (await workspaces.list(as(A, ids.dave))).items
    expect(forDave?.id).toBe(ids.wsA)
    expect([...(forDave?.permissions ?? [])].sort()).toEqual(['admin', 'read', 'write'])

    // alice reaches wsA only through grants on layers in it. She may read the
    // workspace — that is what put it in her list — and holds nothing on the
    // workspace itself.
    const [forAlice] = (await workspaces.list(as(A, ids.alice))).items
    expect(forAlice?.id).toBe(ids.wsA)
    expect([...(forAlice?.permissions ?? [])]).toEqual(['read'])

    // And frank, who holds `read` **and `admin`** on a layer inside wsA and
    // nothing on the workspace. This is the assertion that pins the rule rather
    // than agreeing with it by accident — alice and dave are each answered the
    // same way by a wrong implementation, and frank is not.
    //
    // Asking the plan instead of the workspace scope reports `admin` here,
    // because the resolver flattens a grant set to the layers it reaches: a
    // grant *on* a workspace and a grant on a layer *in* it produce the same
    // scoped plan and cannot be told apart from it. Reported as authority over
    // the workspace, that is "New layer" in front of a principal the server
    // refuses, and the refusal is the 404 rule 4 owes an unreachable object.
    //
    // It is also the case where `read` comes from having reached a layer rather
    // than from a grant on the workspace, which is the one thing `permissionsOn`
    // takes on trust from the filter that put the row here.
    const [forFrank] = (await workspaces.list(as(A, ids.frank))).items
    expect(forFrank?.id).toBe(ids.wsA)
    expect([...(forFrank?.permissions ?? [])]).toEqual(['read'])
  })

  it('creating a workspace is org_admin, and nobody else', async () => {
    const workspaces = new PostgresWorkspaces(pool, AS_APP)

    // A workspace admin is not an organization admin: there is no scope above a
    // workspace, so the role is the only thing that answers here.
    expect(await workspaces.create(as(A, ids.dave), { slug: 'nope', name: 'Nope' })).toEqual({
      kind: 'denied',
    })

    const admin = { orgId: A, principal: { type: 'user' as const, id: ids.dave }, role: 'org_admin' as const }
    const made = await workspaces.create(admin, { slug: 'made-by-admin', name: 'Made' })
    expect(made.kind).toBe('created')

    // Removed again, because the slug is unique per organization and this suite
    // runs against a database that outlives it — a second run would get
    // `conflict` and fail for a reason that has nothing to do with the rule.
    const c = await pool.connect()
    try {
      await c.query('DELETE FROM workspaces WHERE org_id = $1 AND slug = $2', [A, 'made-by-admin'])
    } finally {
      c.release()
    }

    // platform_admin administers organizations and reads no documents (rule 2),
    // and a workspace is where documents live.
    const platform = { orgId: A, principal: { type: 'user' as const, id: ids.dave }, role: 'platform_admin' as const }
    expect(await workspaces.create(platform, { slug: 'p', name: 'P' })).toEqual({ kind: 'denied' })
  })

  it('a malformed document id is absent, not an error', async () => {
    const documents = new PostgresDocuments(pool, noPayload, AS_APP)
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
