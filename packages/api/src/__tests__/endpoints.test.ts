import { SignJWT } from 'jose'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'

import { createApi, type ApiOptions, type ServedEndpoints } from '../server.js'

/**
 * `GET /v1/endpoints` says where a client connects, and says the administrative
 * MCP only to somebody who administers the organization.
 *
 * The console reads this to put the addresses on a screen, so the property
 * under test is that what it is told is what the operator configured — not the
 * address the request happened to arrive at — and that a member is never
 * offered a connection whose consent screen refuses them. Driven over real HTTP
 * against the real server; nothing here touches a database.
 */

const ORG = '6a1c9b0e-0000-4000-8000-0000000000e2'
const USER = '6a1c9b0e-0000-4000-8000-0000000000a2'
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'
const SECRET = new TextEncoder().encode('e'.repeat(32))

const ENDPOINTS: ServedEndpoints = {
  api: 'https://nacre.example.com/v1',
  mcp: 'https://mcp.example.com/mcp',
  mcpAdmin: 'https://mcp.example.com/mcp/admin',
  contract: 'https://github.com/nacre-work/nacre/blob/v0.34.0/docs/openapi.yaml',
  version: '0.34.0',
}

const token = (role: 'org_admin' | 'member' | 'platform_admin'): Promise<string> =>
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

function serve(endpoints?: ServedEndpoints): Promise<string> {
  const server = createApi(endpoints === undefined ? { ...base } : { ...base, endpoints })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    })
  })
}

const ask = async (url: string, role?: 'org_admin' | 'member' | 'platform_admin'): Promise<Response> =>
  fetch(`${url}/v1/endpoints`, role === undefined ? {} : { headers: { authorization: `Bearer ${await token(role)}` } })

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
})

describe('GET /v1/endpoints', () => {
  it('answers the configured addresses, not the one the request reached', async () => {
    const url = await serve(ENDPOINTS)
    const res = await ask(url, 'org_admin')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      api: ENDPOINTS.api,
      mcp: ENDPOINTS.mcp,
      mcp_admin: ENDPOINTS.mcpAdmin,
      contract: ENDPOINTS.contract,
      version: ENDPOINTS.version,
    })
  })

  it('does not offer the administrative MCP to somebody who cannot connect to it', async () => {
    const url = await serve(ENDPOINTS)
    for (const role of ['member', 'platform_admin'] as const) {
      const body = (await (await ask(url, role)).json()) as Record<string, unknown>
      expect(body, role).not.toHaveProperty('mcp_admin')
      expect(body.mcp, role).toBe(ENDPOINTS.mcp)
    }
  })

  it('needs a credential', async () => {
    const url = await serve(ENDPOINTS)
    expect((await ask(url)).status).toBe(401)
  })

  it('is 404 on a server built without the addresses', async () => {
    const url = await serve()
    expect((await ask(url, 'org_admin')).status).toBe(404)
  })
})
