import { describe, expect, it } from 'vitest'

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readSkillZip, writeSkillZip } from '@nacre.work/core'
import { SignJWT } from 'jose'

import { createApi } from '../server.js'
import type { EffectiveBase, SkillLevel, Skills, SkillVersion, SkillWrite } from '../skills.js'

/**
 * `/v1/skills` — the half above the port: paths, bodies, status codes and the
 * journal.
 *
 * Who may see and write which level is the port's, and `skills.test.ts` holds
 * it against a real PostgreSQL. What can still go wrong here is the mapping:
 * a `forbidden` answered as `404` sends somebody hunting for a skill that is on
 * their screen, a `not_found` answered as `403` says a hidden layer exists, a
 * `.zip` read as JSON is a `400` for the format Claude actually exports, and a
 * write that names no version is the silent overwrite the version exists to
 * refuse.
 */

const SECRET = new TextEncoder().encode('s'.repeat(32))
const LAYER = '11111111-1111-4111-8111-111111111111'

async function token(): Promise<string> {
  return await new SignJWT({ org: 'org-1', principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer('https://api.nacre.test')
    .setAudience('nacre')
    .setExpirationTime('5m')
    .sign(SECRET)
}

const FILES = { 'SKILL.md': '---\nname: handbook\ndescription: What the handbook holds.\n---\n\nName pages by topic.\n' }

const version = (n: number, extra: Partial<SkillVersion> = {}): SkillVersion => ({
  version: n,
  name: 'handbook',
  description: 'What the handbook holds.',
  hasScripts: false,
  fileCount: 1,
  principal: 'user:user-1',
  surface: 'rest',
  connectionId: null,
  byAgent: false,
  restoredFrom: null,
  createdAt: '2026-10-09 10:00:00.123456+00',
  files: FILES,
  ...extra,
})

interface Written {
  readonly action: string
  readonly result: string
  readonly target?: Record<string, unknown>
  readonly detail?: Record<string, unknown>
}

interface Seen {
  level?: SkillLevel
  files?: unknown
  basedOn?: number
}

async function serve(answer: SkillWrite = { kind: 'written', version: version(2), cleared: false }) {
  const audited: Written[] = []
  const seen: Seen = {}
  const base: EffectiveBase = {
    level: 'organization',
    layerId: null,
    layerSlug: null,
    name: 'handbook',
    description: 'What the handbook holds.',
    version: 1,
    hasScripts: false,
    paths: ['SKILL.md'],
    files: FILES,
  }
  const skills: Skills = {
    base: async () => base,
    list: async () => ({ base, layers: { items: [], nextCursor: null } }),
    layerBySlug: async () => undefined,
    current: async (_auth, level) => (level.kind === 'layer' && level.layerId === LAYER ? version(1) : undefined),
    versions: async () => ({ items: [version(1)], nextCursor: null }),
    version: async (_auth, _level, n) => (n === 1 ? version(1) : undefined),
    write: async (_auth, level, files, basedOn) => {
      Object.assign(seen, { level, files, basedOn })
      return answer
    },
    restore: async (_auth, level, _n, basedOn) => {
      Object.assign(seen, { level, basedOn })
      return answer
    },
  }
  const api = createApi({
    verify: { key: SECRET, issuer: 'https://api.nacre.test', audience: 'nacre' },
    documents: { read: async () => undefined },
    search: { search: async () => [] },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: {
      write: async (event: Written) => {
        audited.push(event)
      },
    },
    metrics: { render: async () => '' },
    ready: async () => ({ postgres: true, qdrant: true }),
    skills,
  } as unknown as Parameters<typeof createApi>[0])

  const server: Server = api.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    audited,
    seen,
    async call(method: string, path: string, init: { body?: string | Uint8Array; type?: string } = {}) {
      return await fetch(`http://127.0.0.1:${String(port)}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${await token()}`,
          ...(init.type === undefined ? {} : { 'content-type': init.type }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const json = (value: unknown) => ({ body: JSON.stringify(value), type: 'application/json' })

describe('reading skills', () => {
  it('lists the base and a page of layers, and serves the base with its files', async () => {
    const s = await serve()
    try {
      const listed = await s.call('GET', '/v1/skills')
      expect(listed.status).toBe(200)
      expect(await listed.json()).toMatchObject({ base: { level: 'organization', name: 'handbook' }, items: [], next_cursor: null })
      const base = (await (await s.call('GET', '/v1/skills/base')).json()) as { files: Record<string, string> }
      expect(base.files).toEqual(FILES)
    } finally {
      await s.close()
    }
  })

  it('exports a zip Claude installs, under a folder named after the skill', async () => {
    const s = await serve()
    try {
      const res = await s.call('GET', `/v1/skills/layers/${LAYER}/export`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/zip')
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="handbook.zip"')
      const zip = Buffer.from(await res.arrayBuffer())
      expect(readSkillZip(zip)).toEqual({ files: FILES })
    } finally {
      await s.close()
    }
  })

  it('answers a level that is absent or invisible with the one 404, never a hint', async () => {
    const s = await serve()
    try {
      const res = await s.call('GET', `/v1/skills/layers/22222222-2222-4222-8222-222222222222`)
      expect(res.status).toBe(404)
      expect(((await res.json()) as { detail: string }).detail).not.toMatch(/skill|layer|permission/i)
      // And the base is read-only: there is nothing there to write.
      expect((await s.call('PUT', '/v1/skills/base', json({ files: FILES, based_on: 0 }))).status).toBe(404)
    } finally {
      await s.close()
    }
  })
})

describe('writing skills', () => {
  it('writes JSON, naming the version it was based on, and journals what changed — never the text', async () => {
    const s = await serve()
    try {
      const res = await s.call('PUT', `/v1/skills/layers/${LAYER}`, json({ files: FILES, based_on: 1 }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ version: 2, cleared: false })
      expect(s.seen).toMatchObject({ level: { kind: 'layer', layerId: LAYER }, files: FILES, basedOn: 1 })
      const event = s.audited.find((e) => e.action === 'skill.updated')
      expect(event?.result).toBe('allow')
      expect(event?.target).toEqual({ skill: 'layer', layer_id: LAYER })
      expect(event?.detail).toMatchObject({ version: 2, file_count: 1, surface: 'rest' })
      expect(JSON.stringify(event)).not.toContain('Name pages by topic')
    } finally {
      await s.close()
    }
  })

  it('takes the zip Claude exports, with based_on in the query', async () => {
    const s = await serve()
    try {
      const zip = writeSkillZip('handbook', FILES)
      const res = await s.call('PUT', '/v1/skills/organization?based_on=3', { body: zip, type: 'application/zip' })
      expect(res.status).toBe(200)
      expect(s.seen).toMatchObject({ level: { kind: 'organization' }, files: FILES, basedOn: 3 })
    } finally {
      await s.close()
    }
  })

  it('refuses a write that names no version, rather than overwriting whatever is there', async () => {
    const s = await serve()
    try {
      const res = await s.call('PUT', '/v1/skills/organization', json({ files: FILES }))
      expect(res.status).toBe(400)
      expect(((await res.json()) as { detail: string }).detail).toMatch(/based_on/)
      expect(s.seen.files).toBeUndefined()
    } finally {
      await s.close()
    }
  })

  it('refuses an archive that is not a skill, naming why', async () => {
    const s = await serve()
    try {
      const res = await s.call('PUT', '/v1/skills/organization?based_on=0', { body: 'not a zip', type: 'application/zip' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { detail: string }).detail).toMatch(/not a zip archive/)
    } finally {
      await s.close()
    }
  })

  it('answers a stale based_on with 409 and the version to start again from', async () => {
    const s = await serve({ kind: 'conflict', current: 7 })
    try {
      const res = await s.call('PUT', '/v1/skills/organization', json({ files: FILES, based_on: 5 }))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ current_version: 7, type: 'https://nacre.work/errors/skill-version-conflict' })
    } finally {
      await s.close()
    }
  })

  it('answers 403 for a skill the caller sees and may not write, and 404 for one it cannot see', async () => {
    const forbidden = await serve({ kind: 'forbidden' })
    try {
      const res = await forbidden.call('PUT', `/v1/skills/layers/${LAYER}`, json({ files: FILES, based_on: 1 }))
      expect(res.status).toBe(403)
      expect(forbidden.audited.find((e) => e.action === 'skill.updated')?.result).toBe('deny')
    } finally {
      await forbidden.close()
    }
    const invisible = await serve({ kind: 'not_found' })
    try {
      const res = await invisible.call('PUT', `/v1/skills/layers/${LAYER}`, json({ files: FILES, based_on: 1 }))
      expect(res.status).toBe(404)
      expect(invisible.audited.find((e) => e.action === 'skill.updated')?.result).toBe('deny')
    } finally {
      await invisible.close()
    }
  })

  it('clears with DELETE and restores with POST, each recorded under its own name', async () => {
    const cleared = await serve({ kind: 'written', version: version(4, { name: null, fileCount: 0 }), cleared: true })
    try {
      const res = await cleared.call('DELETE', '/v1/skills/organization?based_on=3')
      expect(res.status).toBe(200)
      expect(cleared.seen).toMatchObject({ files: {}, basedOn: 3 })
      expect(cleared.audited.find((e) => e.action === 'skill.cleared')?.result).toBe('allow')
    } finally {
      await cleared.close()
    }
    const restored = await serve({ kind: 'written', version: version(5, { restoredFrom: 1 }), cleared: false })
    try {
      const res = await restored.call('POST', '/v1/skills/organization/versions/1/restore', json({ based_on: 4 }))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ version: 5, restored_from: 1 })
      expect(restored.audited.find((e) => e.action === 'skill.restored')?.detail).toMatchObject({ restored_from: 1 })
    } finally {
      await restored.close()
    }
  })
})
