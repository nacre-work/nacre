import { SignJWT } from 'jose'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'

import { createApi, type ApiOptions } from '../server.js'

/**
 * `GET /v1/me` reports `manages_embedders`, and it is the predicate the server
 * enforces rather than a second copy of it — the console draws the embedder
 * screen only where the server would answer it.
 *
 * The value is `administers(auth) && (embeddersManageable ?? true)`: an
 * `org_admin` on an installation with `NACRE_EMBED_TENANT_PROVIDERS` on manages
 * their own providers; turn the switch off (a managed platform) and the same
 * administrator does not, and neither does a member on either setting. Both
 * halves are the thing under test, because the console needs to hide the screen
 * exactly where the route answers `404`.
 *
 * Driven over real HTTP against the real server, and no database is touched:
 * `/v1/me` composes from the token plus one boolean read that a harness with no
 * `users` port answers `true`, so this is the option and the role and nothing
 * else.
 */

const ORG = '6a1c9b0e-0000-4000-8000-0000000000e1'
const USER = '6a1c9b0e-0000-4000-8000-0000000000a1'
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const SECRET = new TextEncoder().encode('m'.repeat(32))

const token = (role: 'org_admin' | 'member'): Promise<string> =>
  new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(USER)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)

const base: Pick<ApiOptions, 'verify' | 'documents' | 'search' | 'ingest' | 'audit'> = {
  verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
  documents: { read: async () => undefined },
  search: { search: async () => [] },
  ingest: { queue: async () => undefined, remove: async () => false },
  audit: { write: async () => {} },
}

const servers: Server[] = []

function serve(embeddersManageable?: boolean): Promise<string> {
  const server = createApi(
    embeddersManageable === undefined ? { ...base } : { ...base, embeddersManageable },
  )
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

async function managesEmbedders(url: string, role: 'org_admin' | 'member'): Promise<boolean> {
  const res = await fetch(`${url}/v1/me`, {
    headers: { authorization: `Bearer ${await token(role)}` },
  })
  expect(res.status).toBe(200)
  return ((await res.json()) as { manages_embedders: boolean }).manages_embedders
}

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('manages_embedders on /v1/me', () => {
  it('is true for an org_admin when the switch is on (the default)', async () => {
    const url = await serve()
    expect(await managesEmbedders(url, 'org_admin')).toBe(true)
  })

  it('is true for an org_admin when the switch is explicitly on', async () => {
    const url = await serve(true)
    expect(await managesEmbedders(url, 'org_admin')).toBe(true)
  })

  it('is false for an org_admin when the switch is off — the managed-platform state', async () => {
    const url = await serve(false)
    expect(await managesEmbedders(url, 'org_admin')).toBe(false)
  })

  it('is false for a member whatever the switch says', async () => {
    const on = await serve(true)
    expect(await managesEmbedders(on, 'member')).toBe(false)
    const off = await serve(false)
    expect(await managesEmbedders(off, 'member')).toBe(false)
  })
})
