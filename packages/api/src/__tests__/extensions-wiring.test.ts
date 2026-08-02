import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  loadModules,
  mountAdminRoutes,
  registerAuditSink,
  registerAuthProvider,
  resetExtensionsForTests,
  type AdminRequest,
  type AuditEvent,
} from '@nacre.work/core'

import { createApi } from '../index.js'

/**
 * What a registered module actually reaches on a live request.
 *
 * `packages/core/__tests__/extensions.test.ts` covers the registry's refusals.
 * This covers the other half, which is the one that has been wrong before in
 * this repository: something registered, present in the configuration, and
 * consulted by nothing. Every case here goes through a real server.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG_A = '11111111-1111-1111-1111-111111111111'
const ORG_B = '22222222-2222-2222-2222-222222222222'

let server: Server
let base: string

const audited: AuditEvent[] = []
const forwarded: AuditEvent[] = []
const seenByRoute: AdminRequest[] = []

/** A sink that raises. The request must not notice. */
let sinkShouldThrow = false

async function tokenFor(role: string): Promise<string> {
  return new SignJWT({ org: ORG_A, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('someone')
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

const headers = async (role: string) => ({
  authorization: `Bearer ${await tokenFor(role)}`,
  'content-type': 'application/json',
})

describe('a loaded module on the request path', () => {
  beforeAll(async () => {
    // Loaded the way a deployment loads one: named, imported, registering from
    // the module body. The importer is substituted because the module this
    // stands in for lives in a repository this one may not name.
    await loadModules(['stand-in'], async () => {
      registerAuditSink({
        name: 'siem',
        write: async (event) => {
          if (sinkShouldThrow) throw new Error('the collector is down')
          forwarded.push(event)
        },
      })

      registerAuthProvider({
        name: 'oidc',
        // Greedy on purpose. A polite provider that only claimed its own
        // credential would pass the "cannot shadow" tests below no matter what
        // order the paths ran in, which would make them assertions about
        // nothing. This one claims a JWT and a service account key too, so the
        // only thing keeping it out of them is that it is consulted last.
        authenticate: async (credential) => {
          if (credential === 'explodes') throw new Error('the IdP is down')
          if (credential === 'not-mine') return undefined
          return {
            // From the credential, never from the request. Invariant 1.
            orgId: ORG_B,
            principal: { type: 'user', id: 'idp-user' },
            role: 'org_admin',
          }
        },
      })

      mountAdminRoutes(
        {
          method: 'GET',
          pattern: /^\/v1\/admin\/organizations\/([0-9a-z-]+)$/,
          handle: async (request) => {
            seenByRoute.push(request)
            return { status: 200, body: { id: request.params[0] } }
          },
        },
        {
          method: 'POST',
          pattern: /^\/v1\/admin\/quotas$/,
          handle: async (request) => {
            seenByRoute.push(request)
            return { status: 409, body: { error: 'already set' } }
          },
        },
      )
    })

    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      idempotency: {
        begin: async () => ({ proceed: true as const, store: async () => {} }),
      },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    resetExtensionsForTests()
  })

  describe('mounted admin routes', () => {
    it('dispatches to the route, with the captures as params', async () => {
      const res = await fetch(`${base}/v1/admin/organizations/acme?verbose=1`, {
        headers: await headers('org_admin'),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ id: 'acme' })

      const seen = seenByRoute.at(-1) as AdminRequest
      expect(seen.params).toEqual(['acme'])
      expect(seen.query.get('verbose')).toBe('1')
      expect(seen.path).toBe('/v1/admin/organizations/acme')
      // Already authenticated, and the organization is the token's.
      expect(seen.auth.orgId).toBe(ORG_A)
      expect(seen.auth.role).toBe('org_admin')
    })

    it('passes the route its own status, including a failure', async () => {
      const res = await fetch(`${base}/v1/admin/quotas`, {
        method: 'POST',
        headers: await headers('org_admin'),
        body: JSON.stringify({ searches: 10 }),
      })
      expect(res.status).toBe(409)
      expect((seenByRoute.at(-1) as AdminRequest).body).toEqual({ searches: 10 })
    })

    // The dispatcher journals it, not the module. A module that forgot would
    // otherwise be an administrative action nobody recorded.
    it('journals every call as admin.<method>', async () => {
      audited.length = 0
      await fetch(`${base}/v1/admin/organizations/acme`, { headers: await headers('org_admin') })
      await fetch(`${base}/v1/admin/quotas`, {
        method: 'POST',
        headers: await headers('org_admin'),
        body: '{}',
      })
      expect(audited.map((e) => [e.action, e.surface, e.result])).toEqual([
        ['admin.get', 'admin', 'allow'],
        ['admin.post', 'admin', 'deny'],
      ])
      expect(audited[0]?.target).toEqual({ path: '/v1/admin/organizations/acme' })
    })

    it('is 404 for a member, never 403', async () => {
      const before = seenByRoute.length
      const res = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: await headers('member'),
      })
      expect(res.status).toBe(404)
      // And the module was never reached. The role check is in front of the
      // lookup: "the module had no matching route" is not a reason to be safe.
      expect(seenByRoute).toHaveLength(before)
    })

    it('is the same 404 for a path no module mounted', async () => {
      const mounted = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: await headers('member'),
      })
      const absent = await fetch(`${base}/v1/admin/nothing-here`, {
        headers: await headers('member'),
      })
      expect(absent.status).toBe(mounted.status)
      const a = (await mounted.json()) as Record<string, unknown>
      const b = (await absent.json()) as Record<string, unknown>
      expect(b['title']).toBe(a['title'])
      expect(b['detail']).toBe(a['detail'])
    })

    it('is 404 for the right path on the wrong method', async () => {
      const res = await fetch(`${base}/v1/admin/quotas`, { headers: await headers('org_admin') })
      expect(res.status).toBe(404)
    })

    it('refuses an anonymous request before any of that', async () => {
      const res = await fetch(`${base}/v1/admin/organizations/acme`)
      expect(res.status).toBe(401)
    })
  })

  describe('a registered auth provider', () => {
    it('is consulted for a credential the core cannot verify', async () => {
      const res = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: { authorization: 'Bearer opaque-idp-token' },
      })
      expect(res.status).toBe(200)
      expect((seenByRoute.at(-1) as AdminRequest).auth.orgId).toBe(ORG_B)
    })

    it('cannot shadow a token the core can verify', async () => {
      // The provider would claim this one too. It never sees it, because the
      // JWT path resolved first — which is the whole guarantee.
      const res = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: await headers('org_admin'),
      })
      expect(res.status).toBe(200)
      expect((seenByRoute.at(-1) as AdminRequest).auth.orgId).toBe(ORG_A)
    })

    // `nacre_sk_` is the core's namespace and stays the core's. This surface
    // has no service keys configured, so the key is refused — and the provider,
    // which would happily have claimed it, is not consulted at all.
    it('cannot shadow the service account key namespace', async () => {
      const res = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: { authorization: 'Bearer nacre_sk_wouldbeclaimed' },
      })
      expect(res.status).toBe(401)
    })

    it('declining leaves the one 401 with the one message', async () => {
      const declined = await fetch(`${base}/v1/search`, {
        method: 'POST',
        headers: { authorization: 'Bearer not-mine', 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      })
      const garbage = await fetch(`${base}/v1/search`, {
        method: 'POST',
        headers: { authorization: 'Bearer nacre_sk_nope', 'content-type': 'application/json' },
        body: JSON.stringify({ query: 'x' }),
      })
      expect(declined.status).toBe(401)
      expect(garbage.status).toBe(401)
      const a = (await declined.json()) as Record<string, unknown>
      const b = (await garbage.json()) as Record<string, unknown>
      expect(a['detail']).toBe(b['detail'])
    })

    // Invariant 3, one level out: a failure to evaluate denies.
    it('treats a provider that throws as a decline', async () => {
      const res = await fetch(`${base}/v1/admin/organizations/acme`, {
        headers: { authorization: 'Bearer explodes' },
      })
      expect(res.status).toBe(401)
    })
  })

  describe('a registered audit sink', () => {
    it('receives every event the table receives', async () => {
      audited.length = 0
      forwarded.length = 0
      await fetch(`${base}/v1/admin/quotas`, {
        method: 'POST',
        headers: await headers('org_admin'),
        body: '{}',
      })
      expect(forwarded).toEqual(audited)
      expect(forwarded).toHaveLength(1)
    })

    // In addition to the table, never instead of it. A forwarder that could
    // take down the request would make the durable record depend on a network
    // hop.
    it('does not fail the request when it raises', async () => {
      audited.length = 0
      forwarded.length = 0
      sinkShouldThrow = true
      try {
        const res = await fetch(`${base}/v1/admin/organizations/acme`, {
          headers: await headers('org_admin'),
        })
        expect(res.status).toBe(200)
      } finally {
        sinkShouldThrow = false
      }
      expect(audited).toHaveLength(1)
      expect(forwarded).toHaveLength(0)
    })
  })
})
