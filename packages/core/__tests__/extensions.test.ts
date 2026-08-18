import { afterEach, describe, expect, it } from 'vitest'

import {
  activeResolver,
  admitIngest,
  adminRoutes,
  auditSinks,
  authProviders,
  loadModules,
  loadedExtensions,
  mountAdminRoutes,
  registerAuditSink,
  registerAuthProvider,
  registerAuthzResolver,
  registerIngestGate,
  admitSignIn,
  registerSignInGate,
  resetExtensionsForTests,
  withLoadingModuleForTests,
  type AdminRoute,
  type AuthzResolver,
  type IngestContext,
  type IngestGate,
} from '../extensions.js'
import type { SignInContext, SignInGate, SignInVerdict } from '../extensions.js'
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

function ingestContext(): IngestContext {
  return {
    orgId: '00000000-0000-0000-0000-0000000000aa',
    layerId: '00000000-0000-0000-0000-0000000000bb',
    principal: { type: 'user', id: '00000000-0000-0000-0000-0000000000cc' },
    role: 'member',
    externalId: 'doc-1',
    bytes: 42,
  }
}

const admitGate = (name: string): IngestGate => ({ name, admit: async () => ({ admit: true }) })
const denyGate = (name: string, reason: string, status?: number): IngestGate => ({
  name,
  admit: async () => ({ admit: false, reason, ...(status === undefined ? {} : { status }) }),
})

describe('the default registry', () => {
  it('is the built-in resolver, so the core is complete with nothing plugged in', () => {
    expect(activeResolver().resolve(ordinaryInput(), READ)).toEqual(NOTHING)
  })

  it('has no providers, no sinks and no routes', () => {
    expect(authProviders()).toEqual([])
    expect(auditSinks()).toEqual([])
    expect(adminRoutes()).toEqual([])
    expect(loadedExtensions()).toEqual({
      resolver: null,
      providers: [],
      sinks: [],
      routes: 0,
      gates: [],
      signIn: [],
    })
  })

  it('admits every ingest, so the open core accepts what a caller may write', async () => {
    expect(await admitIngest(ingestContext())).toBeUndefined()
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
    expect(loadedExtensions()).toEqual({
      resolver: null,
      providers: [],
      sinks: [],
      routes: 0,
      gates: [],
      signIn: [],
    })
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
      if (name === 'tenancy') {
        registerAuthzResolver(denyAll)
        registerIngestGate(admitGate('quota'))
        registerSignInGate({ name: 'policy', check: async () => ({ kind: 'admit' }) })
      }
      if (name === 'sso') registerAuthProvider({ name: 'oidc', authenticate: async () => undefined })
      if (name === 'audit') registerAuditSink({ name: 'siem', write: async () => {} })
    })
    expect(loadedExtensions()).toEqual({
      resolver: 'tenancy',
      providers: ['sso:oidc'],
      sinks: ['audit:siem'],
      routes: 0,
      gates: ['tenancy:quota'],
      signIn: ['tenancy:policy'],
    })
  })
})

describe('ingest gates', () => {
  it('refuses a gate registered outside loading, like every other point', () => {
    expect(() => registerIngestGate(admitGate('late'))).toThrow('registered outside module loading')
  })

  it('admits when every gate admits', async () => {
    withLoadingModuleForTests('tenancy', () => registerIngestGate(admitGate('quota')))
    expect(await admitIngest(ingestContext())).toBeUndefined()
  })

  it('refuses with the gate’s reason and status when one denies', async () => {
    withLoadingModuleForTests('tenancy', () => registerIngestGate(denyGate('quota', 'over the document quota', 402)))
    expect(await admitIngest(ingestContext())).toEqual({
      module: 'quota',
      status: 402,
      reason: 'over the document quota',
    })
  })

  it('defaults a refusal to 403 — a caller with write is entitled to an answer, not a 404', async () => {
    withLoadingModuleForTests('tenancy', () => registerIngestGate(denyGate('quota', 'suspended')))
    expect((await admitIngest(ingestContext()))?.status).toBe(403)
  })

  it('stops at the first deny, so a refused document does not pay for the rest', async () => {
    const asked: string[] = []
    const watch = (name: string, verdict: boolean): IngestGate => ({
      name,
      admit: async () => {
        asked.push(name)
        return verdict ? { admit: true } : { admit: false, reason: name }
      },
    })
    withLoadingModuleForTests('m', () => {
      registerIngestGate(watch('first', true))
      registerIngestGate(watch('second', false))
      registerIngestGate(watch('third', true))
    })
    const refusal = await admitIngest(ingestContext())
    expect(refusal?.module).toBe('second')
    expect(asked).toEqual(['first', 'second'])
  })

  it('reports its gates on the startup line', () => {
    withLoadingModuleForTests('tenancy', () => registerIngestGate(admitGate('quota')))
    expect(loadedExtensions().gates).toEqual(['tenancy:quota'])
  })
})

describe('sign-in gates', () => {
  const signInContext = (over: Partial<SignInContext> = {}): SignInContext => ({
    orgId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    role: 'member',
    path: 'password',
    secondFactor: undefined,
    enrolled: false,
    ...over,
  })

  const gate = (name: string, verdict: SignInVerdict): SignInGate => ({
    name,
    check: async () => verdict,
  })

  it('refuses a gate registered outside loading, like every other point', () => {
    expect(() => registerSignInGate(gate('late', { kind: 'admit' }))).toThrow(
      'registered outside module loading',
    )
  })

  it('admits when nothing is registered, which is the open core', async () => {
    expect(await admitSignIn(signInContext())).toBeUndefined()
  })

  it('admits when every gate admits', async () => {
    withLoadingModuleForTests('m', () => {
      registerSignInGate(gate('a', { kind: 'admit' }))
      registerSignInGate(gate('b', { kind: 'admit' }))
    })
    expect(await admitSignIn(signInContext())).toBeUndefined()
  })

  it('reports an enrolment demand with the gate’s own reason', async () => {
    withLoadingModuleForTests('policy', () =>
      registerSignInGate(gate('second-factor', { kind: 'enrol', reason: 'Acme requires a second factor.' })),
    )
    expect(await admitSignIn(signInContext())).toEqual({
      module: 'second-factor',
      kind: 'enrol',
      reason: 'Acme requires a second factor.',
    })
  })

  /*
   * The property `admitIngest` does not have, and the reason this one asks
   * every gate instead of stopping at the first.
   *
   * `enrol` is the weaker answer: it still hands out a challenge that reaches
   * the enrolment routes. A gate answering it while a later gate would refuse
   * outright must not be what the caller acts on — so the scan continues past
   * an `enrol` and `refuse` wins wherever it appears, before or after.
   */
  it('lets a later refusal beat an earlier enrolment demand', async () => {
    withLoadingModuleForTests('m', () => {
      registerSignInGate(gate('policy', { kind: 'enrol', reason: 'enrol first' }))
      registerSignInGate(gate('suspension', { kind: 'refuse', reason: 'this organization is suspended' }))
    })
    expect(await admitSignIn(signInContext())).toEqual({
      module: 'suspension',
      kind: 'refuse',
      reason: 'this organization is suspended',
    })
  })

  it('takes the first enrolment demand when no gate refuses', async () => {
    withLoadingModuleForTests('m', () => {
      registerSignInGate(gate('first', { kind: 'enrol', reason: 'first' }))
      registerSignInGate(gate('second', { kind: 'enrol', reason: 'second' }))
    })
    expect((await admitSignIn(signInContext()))?.reason).toBe('first')
  })

  it('stops at a refusal, because nothing outranks one', async () => {
    const asked: string[] = []
    const watch = (name: string, verdict: SignInVerdict): SignInGate => ({
      name,
      check: async () => {
        asked.push(name)
        return verdict
      },
    })
    withLoadingModuleForTests('m', () => {
      registerSignInGate(watch('first', { kind: 'admit' }))
      registerSignInGate(watch('second', { kind: 'refuse', reason: 'no' }))
      registerSignInGate(watch('third', { kind: 'admit' }))
    })
    expect((await admitSignIn(signInContext()))?.module).toBe('second')
    expect(asked).toEqual(['first', 'second'])
  })

  /*
   * What was proved *on this request* and what the account *holds* are two
   * inputs, and a gate that could not tell them apart would treat a renewal as
   * a password-only sign-in.
   */
  it('carries the path, the kind proved and whether the account holds one', async () => {
    const seen: SignInContext[] = []
    withLoadingModuleForTests('m', () =>
      registerSignInGate({
        name: 'watch',
        check: async (context) => {
          seen.push(context)
          return { kind: 'admit' }
        },
      }),
    )
    await admitSignIn(signInContext({ path: 'refresh', enrolled: true }))
    await admitSignIn(signInContext({ path: 'second-factor', secondFactor: 'webauthn', enrolled: true }))
    expect(seen.map((c) => [c.path, c.secondFactor, c.enrolled])).toEqual([
      ['refresh', undefined, true],
      ['second-factor', 'webauthn', true],
    ])
  })

  it('reports its gates on the startup line', () => {
    withLoadingModuleForTests('policy', () => registerSignInGate(gate('second-factor', { kind: 'admit' })))
    expect(loadedExtensions().signIn).toEqual(['policy:second-factor'])
  })
})
