import type { AuthContext } from '@nacre.work/api'
import { writeSkillZip } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildServices, type Services } from '../services.js'

/**
 * What the skill panel asks of the server, against a real PostgreSQL.
 *
 * Two things the panel depends on and a stub would agree with whatever it was
 * written to. `writable` decides whether the panel draws a load at all — drawn
 * where the server would refuse it, it is a control that only ever fails —
 * and it is answered by the same question the console asks, so a reader is
 * told no and the layer's administrator yes. And a `.zip` sent from the panel
 * is read by the server's one bounded reader and written as a version, which
 * is the path a browser cannot take on its own.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the skill panel’s server half is untested.')
}
const when = url ? describe : describe.skip

const id = (n: number): string => `5a11e7f0-0000-4000-8000-${String(n).padStart(12, '0')}`
const ORG = id(1)
const ADMIN = id(2)
const READER = id(3)
const LAYER = id(4)

const as = (userId: string, role: AuthContext['role']): AuthContext => ({
  orgId: ORG,
  principal: { type: 'user', id: userId },
  role,
})

const SKILL = {
  'SKILL.md': '---\nname: panel\ndescription: Written from the panel.\n---\n\nOne page per policy.\n',
  'reference/naming.md': '# Naming\n\nTopic first.\n',
}

let pool: Pool
let services: Services

when('the skill panel, against a real database', () => {
  beforeAll(async () => {
    process.env.NACRE_PG_URL = url as string
    process.env.NACRE_QDRANT_URL ??= 'http://127.0.0.1:6333'
    process.env.NACRE_REDIS_URL ??= 'redis://127.0.0.1:6379'
    process.env.NACRE_PARSER_ENDPOINT ??= 'http://127.0.0.1:9998'
    process.env.NACRE_CANONICAL_URL ??= 'http://127.0.0.1:8080'
    process.env.NACRE_JWT_ISSUER ??= 'http://127.0.0.1:8080'
    process.env.NACRE_JWT_AUDIENCE ??= 'nacre'
    process.env.NACRE_JWT_SECRET ??= 's'.repeat(40)
    const { loadConfig } = await import('@nacre.work/core')
    services = buildServices(loadConfig())
    pool = services.pool

    const c = await pool.connect()
    try {
      await c.query('DELETE FROM skill_versions WHERE org_id = $1', [ORG])
      await c.query('DELETE FROM grants WHERE org_id = $1', [ORG])
      await c.query(
        `INSERT INTO organizations (id, slug, name, vector_collection)
         VALUES ($1,'skillpanel','skillpanel','org_skillpanel') ON CONFLICT DO NOTHING`,
        [ORG],
      )
      await c.query(
        `INSERT INTO users (id, org_id, email, role) VALUES ($1,$3,'admin@sp.test','org_admin'), ($2,$3,'reader@sp.test','member')
         ON CONFLICT DO NOTHING`,
        [ADMIN, READER, ORG],
      )
      const ws = await c.query<{ id: string }>(
        `INSERT INTO workspaces (org_id, slug, name) VALUES ($1,'w','w')
         ON CONFLICT (org_id, slug) DO UPDATE SET name = 'w' RETURNING id`,
        [ORG],
      )
      const provider = await c.query<{ id: string }>(
        `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
         VALUES ($1,'p','http://embedder','stub',4) ON CONFLICT DO NOTHING RETURNING id`,
        [ORG],
      )
      const pid =
        provider.rows[0]?.id ??
        (await c.query<{ id: string }>(`SELECT id FROM embedding_providers WHERE org_id = $1 AND name = 'p'`, [ORG]))
          .rows[0]!.id
      await c.query(
        `INSERT INTO layers (id, org_id, workspace_id, slug, name, provider_id, vector_name)
         VALUES ($1,$2,$3,'handbook','Handbook',$4,'v') ON CONFLICT DO NOTHING`,
        [LAYER, ORG, ws.rows[0]!.id, pid],
      )
      await c.query(
        `INSERT INTO grants (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect)
         VALUES ($1,'user',$2,'layer',$3,'read','allow')`,
        [ORG, READER, LAYER],
      )
    } finally {
      c.release()
    }
  })

  afterAll(async () => {
    await pool?.end()
  })

  const call = (auth: AuthContext, name: string, args: Record<string, unknown>) =>
    services.tools.call(name, args, auth, 'skill-panel')

  it('writes a .zip sent from the panel as a version, read by the server', async () => {
    const zip = writeSkillZip('panel', SKILL).toString('base64')
    const written = (await call(as(ADMIN, 'org_admin'), 'update_skill', {
      skill: 'handbook',
      zip_base64: zip,
      based_on: 0,
    })) as { version: number }
    expect(written.version).toBe(1)

    const read = (await call(as(ADMIN, 'org_admin'), 'get_skill', { skill: 'handbook', path: 'reference/naming.md' })) as {
      paths: string[]
      content: string
      writable: boolean
      by_agent: boolean
    }
    expect(read.paths.sort()).toEqual(['SKILL.md', 'reference/naming.md'])
    expect(read.content).toContain('Topic first')
    // Through MCP is an agent's write, which the panel marks.
    expect(read.by_agent).toBe(true)
    expect(read.writable).toBe(true)
  })

  it('tells a reader the skill is not theirs to write, so the panel draws no load', async () => {
    const read = (await call(as(READER, 'member'), 'get_skill', { skill: 'handbook' })) as { writable: boolean }
    expect(read.writable).toBe(false)
    // And the base is never writable from here, whoever asks.
    const base = (await call(as(ADMIN, 'org_admin'), 'get_skill', { skill: 'base' })) as { writable: boolean }
    expect(base.writable).toBe(false)
  })

  it('refuses both forms at once, neither, and a zip that is not a skill — naming why', async () => {
    const admin = as(ADMIN, 'org_admin')
    await expect(
      call(admin, 'update_skill', { skill: 'handbook', files: SKILL, zip_base64: 'AA==', based_on: 1 }),
    ).rejects.toThrow(/exactly one/)
    await expect(call(admin, 'update_skill', { skill: 'handbook', based_on: 1 })).rejects.toThrow(/exactly one/)
    await expect(
      call(admin, 'update_skill', { skill: 'handbook', zip_base64: Buffer.from('not a zip').toString('base64'), based_on: 1 }),
    ).rejects.toThrow(/not a skill zip/)
  })
})
