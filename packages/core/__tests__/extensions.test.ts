import { afterEach, describe, expect, it } from 'vitest'

import {
  activeResolver,
  adminRoutes,
  auditSinks,
  authProviders,
  loadModules,
  loadedExtensions,
  mountAdminRoutes,
  registerAuditSink,
  registerAuthProvider,
  registerAuthzResolver,
  resetExtensionsForTests,
  withLoadingModuleForTests,
  type AdminRoute,
  type AuthzResolver,
} from '../extensions.js'
import type { AccessPlan, ResolveInput } from '../authz/resolve.js'
import { MemoryScopeTree } from '../authz/scope-tree.js'
import type { Permission } from '../types.js'

/**
 * The registry's refusals, which are the whole reason it is a registry.
 *
 * Everything here is about *when* something may register and what happens when
 * two things claim the same slot. The tests that matter are the negative ones:
 * a permissive registry is indistinguishable from a correct one until the day a
 * module registers late and is silently never consulted.
 */

afterEach(() => {
  resetExtensionsForTests()
})

const NOTHING: AccessPlan = { kind: 'none' }
const EVERYTHING: AccessPlan = { kind: 'all' }

const denyAll: AuthzResolver = { resolve: () => NOTHING }
const allowAll: AuthzResolver = { resolve: () => EVERYTHING }

/** A caller with no grants at all: the built-in resolver answers `none`. */
function ordinaryInput(): ResolveInput {
  return {
    orgId: '00000000-0000-0000-0000-0000000000aa',
    role: 'member',
    principals: new Set(),
    grants: [],
    tree: new MemoryScopeTree({ layers: {}, documents: {} }),
  }
}

const READ: Permission = 'read'

describe('the default registry', () => {
  it('is the built-in resolver, so the core is complete with nothing plugged in', () => {
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(NOTHING)
  })

  it('has no providers, no sinks and no routes', () => {
    expect(authProviders()).toEqual([])
    expect(auditSinks()).toEqual([])
    expect(adminRoutes()).toEqual([])
    expect(loadedExtensions()).toEqual({ resolver: null, providers: [], sinks: [], routes: 0 })
  })
})

describe('registration is only open while modules load', () => {
  // The one that would otherwise be invisible. A module registering after the
  // surfaces are composed is configured, appears loaded, and is never asked
  // anything — the exact failure this file exists to make impossible.
  it('refuses a resolver registered outside loading', () => {
    expect(() => registerAuthzResolver(denyAll)).toThrow(/outside module loading/)
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(NOTHING)
  })

  it('refuses a provider, a sink and routes registered outside loading', () => {
    expect(() => registerAuthProvider({ name: 'p', authenticate: async () => undefined })).toThrow(
      /outside module loading/,
    )
    expect(() => registerAuditSink({ name: 's', write: async () => {} })).toThrow(
      /outside module loading/,
    )
    expect(() =>
      mountAdminRoutes({
        method: 'GET',
        pattern: /^\/v1\/admin\/x$/,
        handle: async () => ({ status: 200 }),
      }),
    ).toThrow(/outside module loading/)
  })

  it('closes registration again once loading returns', async () => {
    await loadModules(['m'], async () => {
      registerAuditSink({ name: 's', write: async () => {} })
    })
    expect(auditSinks()).toHaveLength(1)
    expect(() => registerAuditSink({ name: 'late', write: async () => {} })).toThrow(
      /outside module loading/,
    )
  })

  it('closes registration even when the module throws', async () => {
    await expect(
      loadModules(['bad'], async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow(/module bad could not be loaded/)
    expect(() => registerAuditSink({ name: 'after', write: async () => {} })).toThrow(
      /outside module loading/,
    )
  })
})

describe('the resolver slot', () => {
  it('takes one and it is then in force', () => {
    withLoadingModuleForTests('acl-advanced', () => registerAuthzResolver(allowAll))
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(EVERYTHING)
  })

  // Refused rather than settled by precedence: the loser would stay loaded and
  // look like it was deciding access. The same argument loadJwtKeys makes about
  // a secret and a key reference.
  it('refuses a second, naming both modules', () => {
    withLoadingModuleForTests('acl-advanced', () => registerAuthzResolver(allowAll))
    expect(() => withLoadingModuleForTests('tenancy', () => registerAuthzResolver(denyAll))).toThrow(
      /acl-advanced and tenancy/,
    )
  })

  it('leaves the first one in force after refusing the second', () => {
    withLoadingModuleForTests('acl-advanced', () => registerAuthzResolver(allowAll))
    try {
      withLoadingModuleForTests('tenancy', () => registerAuthzResolver(denyAll))
    } catch {
      // expected
    }
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(EVERYTHING)
  })

  it('is read per call, so a surface never holds a stale one', async () => {
    const before = activeResolver()
    withLoadingModuleForTests('acl-advanced', () => registerAuthzResolver(allowAll))
    expect(before.resolve(ordinaryInput(), READ)).toEqual(NOTHING)
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(EVERYTHING)
  })
})

describe('providers, sinks and routes are lists', () => {
  it('keeps every provider, in registration order', () => {
    withLoadingModuleForTests('sso', () => {
      registerAuthProvider({ name: 'oidc', authenticate: async () => undefined })
      registerAuthProvider({ name: 'saml', authenticate: async () => undefined })
    })
    expect(authProviders().map((p) => p.name)).toEqual(['oidc', 'saml'])
  })

  it('keeps every sink', () => {
    withLoadingModuleForTests('audit', () => {
      registerAuditSink({ name: 'splunk', write: async () => {} })
      registerAuditSink({ name: 'file', write: async () => {} })
    })
    expect(auditSinks().map((s) => s.name)).toEqual(['splunk', 'file'])
  })
})

describe('admin routes are confined to /v1/admin/', () => {
  const ok: AdminRoute = {
    method: 'GET',
    pattern: /^\/v1\/admin\/organizations$/,
    handle: async () => ({ status: 200 }),
  }

  it('mounts one under the prefix', () => {
    withLoadingModuleForTests('admin-global', () => mountAdminRoutes(ok))
    expect(adminRoutes()).toHaveLength(1)
  })

  // A module that could mount /v1/search would be replacing a surface the open
  // half documents and tests, which is a different thing from extending it.
  it('refuses a route outside the prefix', () => {
    expect(() =>
      withLoadingModuleForTests('admin-global', () =>
        mountAdminRoutes({
          method: 'GET',
          pattern: /^\/v1\/search$/,
          handle: async () => ({ status: 200 }),
        }),
      ),
    ).toThrow(/not anchored under/)
  })

  it('accepts either spelling of the escaped slash', () => {
    withLoadingModuleForTests('admin-global', () =>
      mountAdminRoutes(ok, {
        method: 'POST',
        // The same pattern as `ok`, spelled the other way. `RegExp.source`
        // reports `\/` for a literal and `/` for a constructed one, so a check
        // on the raw text is a check on the author's escaping.
        pattern: new RegExp('^/v1/admin/quotas$'),
        handle: async () => ({ status: 200 }),
      }),
    )
    expect(adminRoutes()).toHaveLength(2)
  })

  // The hole the anchor check cannot see: this one starts with the prefix and
  // leaves it again through a top-level alternation.
  it('refuses a pattern that escapes the prefix through an alternation', () => {
    expect(() =>
      withLoadingModuleForTests('admin-global', () =>
        mountAdminRoutes({
          method: 'GET',
          pattern: /^\/v1\/admin\/x$|^\/v1\/search$/,
          handle: async () => ({ status: 200 }),
        }),
      ),
    ).toThrow(/also matches \/v1\/search/)
  })

  it('refuses a stateful pattern', () => {
    expect(() =>
      withLoadingModuleForTests('admin-global', () =>
        mountAdminRoutes({
          method: 'GET',
          pattern: /^\/v1\/admin\/x$/g,
          handle: async () => ({ status: 200 }),
        }),
      ),
    ).toThrow(/carries the g flag/)
  })

  it('refuses an unanchored pattern that merely contains the prefix', () => {
    expect(() =>
      withLoadingModuleForTests('admin-global', () =>
        mountAdminRoutes({
          method: 'GET',
          pattern: /\/v1\/admin\/anything/,
          handle: async () => ({ status: 200 }),
        }),
      ),
    ).toThrow(/not anchored under/)
  })

  it('mounts none of a batch when one of them is refused', () => {
    expect(() =>
      withLoadingModuleForTests('admin-global', () =>
        mountAdminRoutes(ok, {
          method: 'POST',
          pattern: /^\/v1\/grants$/,
          handle: async () => ({ status: 200 }),
        }),
      ),
    ).toThrow(/not anchored under/)
    expect(loadedExtensions().routes).toBe(0)
  })
})

describe('loadModules', () => {
  it('loads nothing when nothing is named', async () => {
    await loadModules([], async () => {
      throw new Error('should not be called')
    })
    expect(loadedExtensions()).toEqual({ resolver: null, providers: [], sinks: [], routes: 0 })
  })

  it('imports each name in order', async () => {
    const seen: string[] = []
    await loadModules(['a', 'b', 'c'], async (name) => {
      seen.push(name)
    })
    expect(seen).toEqual(['a', 'b', 'c'])
  })

  // Not a warning. Naming a module means the deployment is paying for what it
  // does; starting without it is silently a different product.
  it('turns an import failure into a startup error naming the module', async () => {
    await expect(
      loadModules(['@nacre.work/whatever'], async () => {
        throw new Error('ERR_MODULE_NOT_FOUND')
      }),
    ).rejects.toThrow(/@nacre.work\/whatever could not be loaded.*ERR_MODULE_NOT_FOUND/s)
  })

  it('stops at the first failure rather than loading the rest', async () => {
    const seen: string[] = []
    await expect(
      loadModules(['a', 'b', 'c'], async (name) => {
        seen.push(name)
        if (name === 'b') throw new Error('no')
      }),
    ).rejects.toThrow()
    expect(seen).toEqual(['a', 'b'])
  })

  it('attributes each registration to the module that made it', async () => {
    await loadModules(['tenancy', 'sso', 'audit'], async (name) => {
      if (name === 'tenancy') registerAuthzResolver(denyAll)
      if (name === 'sso') registerAuthProvider({ name: 'oidc', authenticate: async () => undefined })
      if (name === 'audit') registerAuditSink({ name: 'siem', write: async () => {} })
    })
    expect(loadedExtensions()).toEqual({
      resolver: 'tenancy',
      providers: ['sso:oidc'],
      sinks: ['audit:siem'],
      routes: 0,
    })
  })
})
