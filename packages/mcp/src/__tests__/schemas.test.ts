import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { AuthContext } from '@nacre.work/api'
import { describe, expect, it } from 'vitest'

import { buildAdminServer } from '../admin.js'
import { ADMIN_CATALOG } from '../admin-tools.js'
import { buildServer } from '../factory.js'
import { compiledSchemaCount } from '../schemas.js'

/**
 * A tool schema is compiled once per process, not once per request.
 *
 * The SDK's `fromJsonSchema` compiles with an Ajv instance it never releases,
 * and Ajv keeps every schema it compiled. Streamable HTTP builds a server per
 * request, so compiling there was a leak of about 80 KB a request — measured on
 * a running stack until the transport died with "JavaScript heap out of memory"
 * — and most of what made an MCP search cost four times a REST one.
 */

const member: AuthContext = { orgId: 'o', principal: { type: 'user', id: 'u' }, role: 'member' }
const admin: AuthContext = { orgId: 'o', principal: { type: 'user', id: 'a' }, role: 'org_admin' }

const layers = (slug: string) => ({
  forCaller: async () => ({
    layers: [{ id: `id-${slug}`, slug, name: slug, description: `the ${slug} layer`, documentCount: 3 }],
    nextCursor: null,
  }),
})

describe('tool schemas', () => {
  it('are compiled by the first server and by no server after it', async () => {
    const build = (auth: AuthContext, slug: string) =>
      buildServer({ auth, requestId: () => 'r', layers: layers(slug), tools: { call: async () => [] }, apiOrigin: 'https://api.test' })

    await build(member, 'handbook')
    const afterFirst = compiledSchemaCount()
    expect(afterFirst).toBeGreaterThan(0)

    // Different callers, different layers and so different descriptions —
    // everything a per-request build varies — and not one more compile.
    for (let i = 0; i < 25; i += 1) await build(i % 2 === 0 ? member : admin, `layer-${String(i)}`)
    expect(compiledSchemaCount()).toBe(afterFirst)
  })

  it('on the administrative surface too, prompts included', () => {
    const tools = { catalog: ADMIN_CATALOG, call: async () => [] }
    buildAdminServer({ auth: admin, requestId: () => 'r', tools })
    const afterFirst = compiledSchemaCount()
    for (let i = 0; i < 25; i += 1) buildAdminServer({ auth: admin, requestId: () => 'r', tools, ui: i % 2 === 0 })
    expect(compiledSchemaCount()).toBe(afterFirst)
  })

  it('are compiled through one function, so a second spelling cannot bring the leak back', () => {
    const src = join(import.meta.dirname, '..')
    const offenders = readdirSync(src)
      .filter((file) => file.endsWith('.ts') && file !== 'schemas.ts')
      .filter((file) =>
        readFileSync(join(src, file), 'utf8')
          .split('\n')
          .filter((line) => !/^\s*(\*|\/\/)/u.test(line))
          .some((line) => /\bfromJsonSchema\b/u.test(line)),
      )
    expect(offenders, 'call compiledSchema from schemas.ts instead').toEqual([])
  })
})
