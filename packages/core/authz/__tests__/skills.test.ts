import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { PostgresSkills, type AuthContext, type SkillLevel } from '@nacre.work/api'
import { createMcpServer } from '@nacre.work/mcp'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createPool } from '../../db/client.js'
import { protectedResourceMetadata } from '../../oauth.js'

/**
 * T26–T28, T33 and T34 — who sees which skill, from docs/authz.md.
 *
 * Against a real PostgreSQL, through the application role, because every rule
 * here is a question about rows: which layers a caller resolves to, which
 * organization a row belongs to, and whether row-level security is the second
 * line it is meant to be. A fake would answer with whatever it was written to
 * believe about visibility, which is the thing under test.
 *
 * The rule the cases hold is one sentence in docs/skills.md: **a layer skill is
 * visible exactly when its layer is.** Every way that could fail is a way to
 * learn which layers exist, which is invariant I6 broken through a side door.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error(
    'NACRE_PG_URL is not set and CI is. T26-T28, T33 and T34 would silently skip, and ' +
      'they decide whether a skill is a way to learn which layers another principal holds.',
  )
}
const when = url ? describe : describe.skip

const AS_APP = 'nacre_app'

const id = (n: number): string => `5c111000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG_A = id(1)
const ORG_B = id(2)
const READER = id(3)
const WRITER = id(4)
const LAYER_ADMIN = id(5)
const ORG_ADMIN = id(6)
const PLATFORM = id(7)
const STRANGER = id(8)
const WS = id(9)
const PROVIDER = id(10)
/** Read by READER. Carries a skill. */
const L_READ = id(11)
/** Written, never read, by WRITER. Carries a skill. */
const L_WRITE = id(12)
/** Nobody below holds anything on it. Carries a skill. */
const L_HIDDEN = id(13)
/** Read by READER, and carries no skill. */
const L_BARE = id(14)
const WS_B = id(15)
const L_B = id(16)
/** Also read by READER, and carries a skill — the M of T28. */
const L_ALSO = id(17)

/** Text that exists in exactly one organization's skill, so a leak is a substring. */
const ORG_A_MARK = 'zebra-orchid-a7f1'
const ORG_B_MARK = 'harbor-quill-b9c2'

const skill = (name: string, body: string): Record<string, string> => ({
  'SKILL.md': `---\nname: ${name}\ndescription: What ${name} holds.\n---\n\n${body}\n`,
})

const as = (orgId: string, userId: string, role: AuthContext['role'] = 'member'): AuthContext => ({
  orgId,
  principal: { type: 'user', id: userId },
  role,
})

let pool: Pool
let skills: PostgresSkills

/** A version written by the database's owner, around the port — the fixture, not the subject. */
async function seed(orgId: string, layerId: string | null, files: Record<string, string>, name: string): Promise<void> {
  const c = await pool.connect()
  try {
    await c.query(
      `INSERT INTO skill_versions (org_id, layer_id, version, files, name, description, principal, surface)
       VALUES ($1, $2, 1, $3::jsonb, $4, $5, 'user:fixture', 'rest')`,
      [orgId, layerId, JSON.stringify(files), name, `What ${name} holds.`],
    )
  } finally {
    c.release()
  }
}

when('skills · a layer skill is visible exactly when its layer is', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    skills = new PostgresSkills(pool, AS_APP)

    const c = await pool.connect()
    try {
      await c.query('DELETE FROM skill_versions WHERE org_id = ANY($1::uuid[])', [[ORG_A, ORG_B]])
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection) VALUES
           ($1,'skills-a','Skills A','org_skills_a'), ($2,'skills-b','Skills B','org_skills_b')
         ON CONFLICT DO NOTHING`,
        [ORG_A, ORG_B],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES
           ($1,$7,'reader@sk.test','member'),
           ($2,$7,'writer@sk.test','member'),
           ($3,$7,'layer-admin@sk.test','member'),
           ($4,$7,'admin@sk.test','org_admin'),
           ($5,$7,'platform@sk.test','platform_admin'),
           ($6,$8,'stranger@sk.test','org_admin')
         ON CONFLICT DO NOTHING`,
        [READER, WRITER, LAYER_ADMIN, ORG_ADMIN, PLATFORM, STRANGER, ORG_A, ORG_B],
      )
      await c.query(
        `INSERT INTO embedding_providers (id, org_id, name, endpoint, model, dimensions)
         VALUES ($1, NULL, 'sk', 'http://e', 'm', 4) ON CONFLICT DO NOTHING`,
        [PROVIDER],
      )
      await c.query(
        `INSERT INTO workspaces (id, org_id, slug, name) VALUES ($1,$2,'sk','W'), ($3,$4,'sk','W')
         ON CONFLICT DO NOTHING`,
        [WS, ORG_A, WS_B, ORG_B],
      )
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name) VALUES
           ($1,$6,$7,'read-me','R',$8,'v'),
           ($2,$6,$7,'write-me','W',$8,'v'),
           ($3,$6,$7,'hidden','H',$8,'v'),
           ($4,$6,$7,'bare','B',$8,'v'),
           ($5,$9,$10,'b-layer','B',$8,'v'),
           ($11,$6,$7,'also','A',$8,'v')
         ON CONFLICT DO NOTHING`,
        [L_READ, L_WRITE, L_HIDDEN, L_BARE, L_B, ORG_A, WS, PROVIDER, ORG_B, WS_B, L_ALSO],
      )
      await c.query('DELETE FROM grants WHERE org_id = ANY($1::uuid[])', [[ORG_A, ORG_B]])
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect) VALUES
           ($1,'user',$2,'layer',$5,'read','allow'),
           ($1,'user',$2,'layer',$6,'read','allow'),
           ($1,'user',$2,'layer',$8,'read','allow'),
           ($1,'user',$3,'layer',$7,'write','allow'),
           ($1,'user',$4,'layer',$5,'admin','allow')`,
        [ORG_A, READER, WRITER, LAYER_ADMIN, L_READ, L_BARE, L_WRITE, L_ALSO],
      )
    } finally {
      c.release()
    }

    await seed(ORG_A, L_READ, skill('read-me', 'Name pages by topic.'), 'read-me')
    await seed(ORG_A, L_WRITE, skill('write-me', 'Ingest-only conventions.'), 'write-me')
    await seed(ORG_A, L_ALSO, skill('also', 'The other layer the reader reads.'), 'also')
    await seed(ORG_A, L_HIDDEN, skill('hidden', 'Nobody may learn this layer exists.'), 'hidden')
    await seed(ORG_A, null, skill('org-a', `Organization A works like this: ${ORG_A_MARK}.`), 'org-a')
    await seed(ORG_B, null, skill('org-b', `Organization B works like this: ${ORG_B_MARK}.`), 'org-b')
  })

  afterAll(async () => {
    await pool?.end()
  })

  const page = { limit: 50, after: undefined }
  const layerIds = async (auth: AuthContext): Promise<string[]> =>
    (await skills.list(auth, page)).layers.items.map((e) => e.layerId as string).sort()

  it('T26 · a layer skill on a layer the caller holds nothing on is absent, and answers as a layer with no skill', async () => {
    const reader = as(ORG_A, READER)

    // Absent from the listing — the listing is not a directory of layers.
    expect(await layerIds(reader)).toEqual([L_READ, L_ALSO].sort())

    // Fetched directly, it answers exactly as a visible layer with no skill
    // does, and exactly as a layer that does not exist. Three different facts,
    // one answer, which is what the REST surface turns into one 404.
    const hidden = await skills.current(reader, { kind: 'layer', layerId: L_HIDDEN })
    const bare = await skills.current(reader, { kind: 'layer', layerId: L_BARE })
    const absent = await skills.current(reader, { kind: 'layer', layerId: id(999) })
    expect(hidden).toBeUndefined()
    expect(bare).toBeUndefined()
    expect(absent).toBeUndefined()

    // By slug too — `get_skill` takes one, and a slug that resolves only for
    // callers who can see it is the same answer one step earlier.
    expect(await skills.layerBySlug(reader, 'hidden')).toBeUndefined()
    expect(await skills.layerBySlug(reader, 'read-me')).toBe(L_READ)

    // And a write is the same not-found a missing layer gets — never the
    // `forbidden` a visible one would, which would say the layer is there.
    const files = skill('hidden', 'overwritten')
    expect((await skills.write(reader, { kind: 'layer', layerId: L_HIDDEN }, files, 1, 'rest')).kind).toBe('not_found')
    expect((await skills.write(reader, { kind: 'layer', layerId: id(999) }, files, 1, 'rest')).kind).toBe('not_found')
    expect((await skills.versions(reader, { kind: 'layer', layerId: L_HIDDEN }, page))).toBeUndefined()
  })

  it('T27 · a principal holding only write on a layer sees that layer’s skill', async () => {
    const writer = as(ORG_A, WRITER)

    // Rule 6 keeps the documents from them, not the layer's conventions: an
    // agent that only ingests needs to know how a document there is named.
    expect(await layerIds(writer)).toEqual([L_WRITE])
    const current = await skills.current(writer, { kind: 'layer', layerId: L_WRITE })
    expect(current?.files['SKILL.md']).toContain('Ingest-only conventions.')

    // Seeing it is not writing it. Visible, so this is the refusal a caller
    // looking at the skill can be told — and it is not `not_found`.
    const refused = await skills.write(writer, { kind: 'layer', layerId: L_WRITE }, skill('write-me', 'x'), 1, 'rest')
    expect(refused.kind).toBe('forbidden')
  })

  it('T28 · a delegation narrowed to L whose person reads L and M lists L\u2019s skill and never M\u2019s', async () => {
    // The person reads both, and both carry a skill.
    expect(await layerIds(as(ORG_A, READER))).toEqual([L_READ, L_ALSO].sort())

    const narrowed: AuthContext = { ...as(ORG_A, READER), delegation: { id: id(500), layers: [{ id: L_READ }] } }
    expect(await layerIds(narrowed)).toEqual([L_READ])
    expect(await skills.current(narrowed, { kind: 'layer', layerId: L_ALSO })).toBeUndefined()
    expect(await skills.layerBySlug(narrowed, 'also')).toBeUndefined()
    expect((await skills.current(narrowed, { kind: 'layer', layerId: L_READ }))?.name).toBe('read-me')

    // A per-layer ceiling that leaves no permission the person holds is the
    // same narrowing: `{admin}` on a layer they only read admits it for nothing.
    const adminOnly: AuthContext = {
      ...as(ORG_A, READER),
      delegation: { id: id(502), layers: [{ id: L_READ, permissions: ['admin'] }] },
    }
    expect(await layerIds(adminOnly)).toEqual([])
  })

  it('T33 · platform_admin never reads an organization’s skill; only that role writes the installation’s', async () => {
    const platform = as(ORG_A, PLATFORM, 'platform_admin')
    const admin = as(ORG_A, ORG_ADMIN, 'org_admin')
    const installation: SkillLevel = { kind: 'installation' }

    // Rule 2: administering tenants is not access to a tenant's text. Not
    // through the level, not through the base, not through the listing.
    expect(await skills.current(platform, { kind: 'organization' })).toBeUndefined()
    const base = await skills.base(platform)
    expect(base.level).not.toBe('organization')
    expect(JSON.stringify(base.files)).not.toContain(ORG_A_MARK)
    expect((await skills.list(platform, page)).layers.items).toEqual([])
    expect((await skills.write(platform, { kind: 'organization' }, skill('x', 'y'), 1, 'rest')).kind).toBe('not_found')

    // The installation's is written by that role, through the API, and by
    // nobody else — an org_admin's attempt is the not-found a level they
    // cannot write gets, and the platform's own attempt over MCP is refused
    // too: rights spanning tenants stay where a person is doing it.
    const before = (await skills.current(admin, installation))?.version ?? 0
    expect((await skills.write(admin, installation, skill('installation', 'z'), before, 'rest')).kind).toBe('not_found')
    expect((await skills.write(platform, installation, skill('installation', 'z'), before, 'mcp')).kind).toBe('not_found')
    const written = await skills.write(platform, installation, skill('installation', 'Everybody reads this.'), before, 'rest')
    expect(written.kind).toBe('written')

    // Readable by everybody it applies to — which is everybody.
    expect((await skills.current(admin, installation))?.files['SKILL.md']).toContain('Everybody reads this.')
  })

  it('T34 · an organization’s skill never reaches a caller from another organization', async () => {
    const stranger = as(ORG_B, STRANGER, 'org_admin')

    // Not listed, not fetched, not the base.
    const listed = await skills.list(stranger, page)
    expect(JSON.stringify(listed)).not.toContain('org-a')
    expect(listed.layers.items.map((e) => e.layerId)).not.toContain(L_READ)
    const own = await skills.current(stranger, { kind: 'organization' })
    expect(own?.files['SKILL.md']).toContain(ORG_B_MARK)
    expect(JSON.stringify(own)).not.toContain(ORG_A_MARK)
    expect((await skills.base(stranger)).files['SKILL.md']).toContain(ORG_B_MARK)

    // A layer id from the other organization is not there — the composite key
    // and the policy are the second line, and the port is the first.
    expect(await skills.current(stranger, { kind: 'layer', layerId: L_READ })).toBeUndefined()
    expect((await skills.write(stranger, { kind: 'layer', layerId: L_READ }, skill('x', 'y'), 1, 'rest')).kind).toBe(
      'not_found',
    )

    // And through `instructions`, which is how most agents will ever read a
    // skill: the transport, built the way main.ts builds it, asked by a token
    // from each organization in turn.
    const instructions = await instructionsVia(ORG_B, STRANGER)
    expect(instructions).toContain(ORG_B_MARK)
    expect(instructions).not.toContain(ORG_A_MARK)
    const fromA = await instructionsVia(ORG_A, READER)
    expect(fromA).toContain(ORG_A_MARK)
    expect(fromA).not.toContain(ORG_B_MARK)
  })

  it('a stale write is refused, a rollback is a version, and clearing falls back a level', async () => {
    const layerAdmin = as(ORG_A, LAYER_ADMIN)
    const level: SkillLevel = { kind: 'layer', layerId: L_READ }

    const now = (await skills.current(layerAdmin, level))?.version ?? 0
    const first = await skills.write(layerAdmin, level, skill('read-me', 'Second edition.'), now, 'mcp')
    expect(first.kind).toBe('written')
    if (first.kind !== 'written') return
    expect(first.version.version).toBe(now + 1)
    // Written through MCP, so it says an agent wrote it.
    expect(first.version.byAgent).toBe(true)

    // Two agents editing from the same base: the second is told, not erased.
    const stale = await skills.write(layerAdmin, level, skill('read-me', 'Third.'), now, 'rest')
    expect(stale).toEqual({ kind: 'conflict', current: now + 1 })

    // Going back is a write, carrying the old files and saying where from.
    const restored = await skills.restore(layerAdmin, level, now, now + 1, 'rest')
    expect(restored.kind).toBe('written')
    if (restored.kind !== 'written') return
    expect(restored.version.restoredFrom).toBe(now)
    expect((await skills.current(layerAdmin, level))?.files['SKILL.md']).toContain('Name pages by topic.')

    // History is the writer's to read, and the reader's is not.
    expect((await skills.versions(layerAdmin, level, page))?.items[0]?.version).toBe(now + 2)
    expect(await skills.versions(as(ORG_A, READER), level, page)).toBeUndefined()

    // Clearing the organization's skill puts the installation's back.
    const admin = as(ORG_A, ORG_ADMIN, 'org_admin')
    const org = (await skills.current(admin, { kind: 'organization' }))?.version ?? 0
    const cleared = await skills.write(admin, { kind: 'organization' }, {}, org, 'rest')
    expect(cleared).toMatchObject({ kind: 'written', cleared: true })
    expect((await skills.base(admin)).level).not.toBe('organization')
    // Restored, so the next case and the next run start where they expect.
    const back = await skills.restore(admin, { kind: 'organization' }, org, org + 1, 'rest')
    expect(back.kind).toBe('written')
    expect((await skills.base(admin)).files['SKILL.md']).toContain(ORG_A_MARK)
  })
})

// ── the instructions half of T34 ─────────────────────────────────────────────

const KEY = new TextEncoder().encode('s'.repeat(32))
const ISSUER = 'https://skills.test'

/**
 * `initialize` on the real Streamable HTTP transport, as `orgId`'s user.
 *
 * The transport is built with the same skill source main.ts gives it, and the
 * catalog and tools stubbed — what is under test is which organization's text
 * the instructions carry, and nothing about layers or tools decides that.
 */
async function instructionsVia(orgId: string, userId: string): Promise<string> {
  const server: Server = createMcpServer({
    // No agent keys here: every caller below is a person with a token.
    verify: { key: KEY, issuer: ISSUER, audience: ISSUER, serviceKeys: { resolve: async () => undefined } },
    resourceMetadataUrl: `${ISSUER}/.well-known/oauth-protected-resource`,
    resourceMetadata: protectedResourceMetadata({ canonicalUrl: ISSUER }),
    layers: { forCaller: async () => ({ layers: [], nextCursor: null }) },
    tools: { call: async () => ({}) },
    skills: { base: (auth) => skills.base(auth) },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({ org: orgId, principal_type: 'user', role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(ISSUER)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(KEY)
    const res = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'skills', version: '0' } },
      }),
    })
    const body = (await res.json()) as { result?: { instructions?: string } }
    const instructions = body.result?.instructions
    if (instructions === undefined) throw new Error(`initialize answered ${String(res.status)} with no instructions`)
    return instructions
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
