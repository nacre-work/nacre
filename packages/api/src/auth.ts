import {
  authProviders,
  type OrgRole,
  type Permission,
  type Principal,
  type ResolvedPrincipal,
} from '@nacre.work/core'
import { jwtVerify, type JWTPayload, type KeyObject } from 'jose'

import { forbidden, unauthorized, type Problem } from './errors.js'

export interface AuthContext {
  /** From the token. Never from anywhere else. */
  readonly orgId: string
  readonly principal: Principal
  readonly role: OrgRole
  /**
   * Present when an application is acting for the person in `principal`.
   *
   * The principal is the **user**, not the delegation, and that is the whole
   * design: `resolve` runs on them unchanged, so a delegation reaches exactly
   * what its user reaches and there is no second grant set to intersect. See
   * docs/authz.md, "Delegated authority".
   *
   * `layers` is the narrowing the person chose at consent, if any. `undefined`
   * means no narrowing — never "narrowed to nothing", which is a different
   * state and is deliberately not expressible.
   */
  readonly delegation?: {
    readonly id: string
    readonly layers?: readonly string[]
    /**
     * The permissions this token may exercise. Absent means no ceiling.
     *
     * A set rather than a level, because rule 6 makes permissions unordered —
     * `{write}` alone is an ingest pipeline that cannot read back what it
     * wrote. See docs/authz.md, "The permission ceiling".
     */
    readonly permissions?: readonly Permission[]
  }
}

/**
 * The one read docs/authz.md puts before `resolve` on a delegated request.
 *
 * Separate from everything else the auth path touches because it is the only
 * lookup here that exists to be *immediate*: it answers "may this authority
 * still be exercised", and the answer changes when an administrator acts.
 */
export interface Delegations {
  /**
   * The delegation, or `undefined` when it must not be exercised.
   *
   * One answer for a missing row, a revoked connection, a disabled user and a
   * `platform_admin`, on the same rule every other credential failure follows:
   * which of them applies is not something a caller is told.
   */
  resolve(
    orgId: string,
    id: string,
  ): Promise<
    | { userId: string; role: OrgRole; layers?: readonly string[]; permissions?: readonly Permission[] }
    | undefined
  >
}

export interface VerifyOptions {
  /** The current key. Everything issued from now on is signed with this one. */
  readonly key: KeyObject | Uint8Array
  /**
   * Accepted on verification, never used to sign.
   *
   * This is the whole of a rotation with no outage. There is one signing key
   * and no `kid`, so changing it used to invalidate every outstanding access
   * token at the same instant — and the SDK does not refresh on a 401, so that
   * reached applications as errors rather than as a pause. Carrying the
   * previous key here for one access-token lifetime makes the change invisible:
   * tokens already out keep verifying until they expire, and every token issued
   * after the restart is signed with the new one.
   *
   * Deliberately one extra key and not a list. A list invites the question of
   * which one signs, and it puts an unbounded number of HMAC verifications on
   * the path every invalid token takes. Two is the number a rotation needs.
   */
  readonly alsoAccept?: readonly (KeyObject | Uint8Array)[]
  /**
   * The one algorithm this deployment accepts, passed to `jwtVerify` rather
   * than taken from the token's header.
   *
   * A verifier that trusts the header's `alg` is the classic JWT mistake, and
   * the mixed case is where it bites: with an Ed25519 public key configured, a
   * token claiming `HS256` invites the library to treat those public bytes as
   * an HMAC secret — and the public key is published at
   * `/.well-known/jwks.json`. `jose` refuses that shape on its own, and pinning
   * says so here rather than relying on it continuing to.
   *
   * Optional so a caller constructing this by hand cannot be broken by the
   * field appearing; absent means HS256, which is what every such caller means.
   */
  readonly algorithms?: readonly string[]
  readonly issuer: string
  readonly audience: string
  /**
   * Resolves a service account key, when one is presented.
   *
   * Injected rather than imported so this module keeps no database of its own:
   * the JWT path is pure and stays that way, and a surface with no service
   * accounts simply does not pass this.
   */
  readonly serviceKeys?: {
    resolve(key: string): Promise<AuthContext | undefined>
  }
  /**
   * Consulted only for a token carrying a `del` claim.
   *
   * Optional so a deployment that has never issued a delegation pays nothing —
   * but a token *claiming* one where this is absent is refused rather than
   * accepted as its user. Invariant 3: a check that cannot run denies.
   */
  readonly delegations?: Delegations
}

/**
 * Whether this request may exercise a permission at all.
 *
 * The delegation's ceiling, and `true` for everything that is not one. It is
 * consulted by `contextFor` on the way into `resolve`, which is where it does
 * the work for documents; this is for the handful of places that ask about a
 * verb without building a plan.
 */
export function delegationPermits(auth: AuthContext, permission: Permission): boolean {
  const ceiling = auth.delegation?.permissions
  return ceiling === undefined || ceiling.includes(permission)
}

/**
 * Whether this request administers the organization.
 *
 * Two facts, deliberately kept as two. `role` is what the *principal* is and
 * decides what they reach — an `org_admin` holds admin on every scope with no
 * grants at all, by rule 3. The ceiling is what this *token* may exercise, and
 * a delegation restricted to `{read}` must not mint a service account key even
 * though its person could.
 *
 * Rewriting the role to `member` instead would be the same check in one place
 * and would be wrong: `member` reaches only what grants give, so an `org_admin`
 * with a read-only delegation would stop reading the organization they came to
 * delegate. So the role stays, and every handler that gated on
 * `auth.role === 'org_admin'` asks this.
 *
 * `scripts/check-admin-gate.mjs` is what keeps that true — a rule that has to
 * hold in nine handlers, with nothing that knows nine, is the defect this
 * repository keeps re-deriving.
 */
export function administers(auth: AuthContext): boolean {
  return auth.role === 'org_admin' && delegationPermits(auth, 'admin')
}

/**
 * Whether this request administers *tenants* — the multi-tenancy module's role.
 *
 * No ceiling question: `platform_admin` is never delegable, refused at consent
 * and again at validation, so a request carrying this role is never a
 * delegation. Stated as its own function anyway, because the alternative is a
 * raw comparison and the check refuses those.
 */
export function administersTenants(auth: AuthContext): boolean {
  return auth.role === 'platform_admin'
}

/**
 * Whether a layer is inside this request's delegation, if it has one.
 *
 * `true` for everything that is not a delegation, because there is no narrowing
 * to be outside of — a plain token, a service account key and an SSO assertion
 * all reach whatever `resolve` says they reach.
 *
 * The **search** path does not go through this: there the narrowing is a `must`
 * on `layer_id` inside the index traversal, which is what invariant 2 requires
 * and what a per-result check would break. This is for the paths that already
 * hold one row and one layer id — a document fetched by id, an ingest naming
 * its target — where the same restriction has to hold and there is no traversal
 * to put it inside of.
 */
export function withinDelegation(auth: AuthContext, layerId: string): boolean {
  const narrowing = auth.delegation?.layers
  return narrowing === undefined || narrowing.includes(layerId)
}

/**
 * Fields a request body, path, or query string may never carry.
 *
 * Rule 1 is a precondition, not a validation step: the organization comes from
 * the token, so a request that names one is not a request with a bad field —
 * it is an attempt to act as another tenant, and it is journaled as one.
 *
 * `organization` and `tenant` are here because the next person to add a field
 * will not call it `org_id`.
 */
const FORBIDDEN_KEYS = ['org_id', 'orgId', 'organization', 'organization_id', 'tenant', 'tenant_id']

export function findTenantOverride(value: unknown, path: string[] = []): string | undefined {
  if (value === null || typeof value !== 'object') return undefined

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.includes(key)) return [...path, key].join('.')
    // Nested, because a body that cannot say org_id at the top level will say
    // it one level down.
    const deeper = findTenantOverride(nested, [...path, key])
    if (deeper !== undefined) return deeper
  }
  return undefined
}

/**
 * T2. A body, path, or header naming an organization is refused with 403.
 *
 * 403 rather than 404 is deliberate and is the one place the wording matters in
 * the other direction: the caller is authenticated, the refusal is about the
 * *operation*, and no object's existence is revealed by saying so.
 */
export function rejectTenantOverride(
  body: unknown,
  query: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  instance: string,
  requestId: string,
): Problem | undefined {
  const inBody = findTenantOverride(body)
  if (inBody !== undefined) {
    return forbidden(instance, requestId, `The organization comes from the token. Remove '${inBody}'.`)
  }

  for (const key of FORBIDDEN_KEYS) {
    if (query.has(key)) {
      return forbidden(instance, requestId, `The organization comes from the token. Remove '${key}'.`)
    }
    if (headers[`x-${key.replace(/_/g, '-')}`] !== undefined) {
      return forbidden(instance, requestId, 'The organization comes from the token.')
    }
  }

  return undefined
}

interface NacreClaims extends JWTPayload {
  readonly org?: unknown
  readonly principal_type?: unknown
  readonly role?: unknown
  /**
   * The connection an application is acting through, when it acts for a person.
   *
   * The permitted set is deliberately **not** in here. A token carrying one
   * would keep answering with the access its holder had at consent, and every
   * revocation would wait for it to expire — which is the one way to get
   * delegation wrong. What is in the token is an id; the authority is
   * recomputed from `grants` on every request, like everyone else's.
   */
  readonly del?: unknown
}

const ROLES: readonly OrgRole[] = ['platform_admin', 'org_admin', 'member']
const PRINCIPAL_TYPES = ['user', 'group', 'service_account'] as const

/**
 * Verify a bearer token into an AuthContext.
 *
 * Every failure path returns 401 with the same shape. Distinguishing "expired"
 * from "wrong audience" from "unknown issuer" in the response tells an attacker
 * which of their guesses was closest.
 */
export async function authenticate(
  authorization: string | undefined,
  options: VerifyOptions,
  instance: string,
  requestId: string,
): Promise<AuthContext | Problem> {
  const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined
  if (bearer === undefined) {
    return unauthorized(instance, requestId, 'A bearer token is required.')
  }

  // A service account key is opaque and has nothing to verify locally, so it
  // takes a different route — but only the route differs. It fails into the
  // same 401 with the same wording as every JWT failure below, because
  // "revoked key" and "wrong audience" and "expired" must be one answer.
  if (bearer.startsWith('nacre_sk_')) {
    if (options.serviceKeys === undefined) {
      return unauthorized(instance, requestId, 'The token is not valid.')
    }
    const resolved = await options.serviceKeys.resolve(bearer)
    return resolved ?? unauthorized(instance, requestId, 'The token is not valid.')
  }

  // The current key first, then whatever a rotation left behind. Every one of
  // them fails into the same 401 with the same wording: which key a token was
  // signed with is not something a caller is told, and neither is whether one
  // of them is a key on its way out.
  let claims: NacreClaims | undefined
  for (const key of [options.key, ...(options.alsoAccept ?? [])]) {
    try {
      const verified = await jwtVerify<NacreClaims>(bearer, key, {
        algorithms: [...(options.algorithms ?? ['HS256'])],
        issuer: options.issuer,
        audience: options.audience,
      })
      claims = verified.payload
      break
    } catch {
      // Next key, or out of the loop into the single refusal below.
    }
  }
  if (claims === undefined) {
    // A credential type this build does not understand — an ID-JAG, an SSO
    // assertion — before the refusal, and only here. A provider cannot shadow a
    // JWT this deployment can verify or a `nacre_sk_` key, because both were
    // tried above and neither reached this line.
    //
    // `undefined` from a provider means "not mine", which is not "invalid".
    // Either way the caller gets the one 401 with the one message: which
    // provider declined, and whether any recognised the shape, is exactly the
    // information invariant 4 exists to withhold.
    for (const provider of authProviders()) {
      let resolved: ResolvedPrincipal | undefined
      try {
        resolved = await provider.authenticate(bearer)
      } catch {
        // A provider that throws denies, like every other failure to evaluate
        // a credential. Invariant 3 has no "could not compute it, let it
        // through" path, and a network hiccup inside an SSO module is exactly
        // the case that would otherwise open one.
        resolved = undefined
      }
      if (resolved !== undefined) return resolved
    }
    return unauthorized(instance, requestId, 'The token is not valid.')
  }

  const org = claims.org
  const sub = claims.sub
  const type = claims.principal_type
  const role = claims.role ?? 'member'

  if (
    typeof org !== 'string' ||
    typeof sub !== 'string' ||
    typeof type !== 'string' ||
    !(PRINCIPAL_TYPES as readonly string[]).includes(type) ||
    typeof role !== 'string' ||
    !(ROLES as readonly string[]).includes(role)
  ) {
    // A token that verifies but does not say who it is cannot be evaluated, and
    // rule I3 makes that a denial rather than a default.
    return unauthorized(instance, requestId, 'The token is not valid.')
  }

  const base: AuthContext = {
    orgId: org,
    principal: { type: type as Principal['type'], id: sub },
    role: role as OrgRole,
  }

  if (claims.del === undefined) return base

  // ── a delegated token ──
  //
  // Everything above verified the signature; none of it says whether this
  // authority may still be exercised. That question has no answer in a JWT —
  // it changes when an administrator acts — so it is asked here, before
  // `resolve`, on every request.
  //
  // Uncached, deliberately. The effective-principals cache keys on
  // `organizations.groups_version`, which triggers bump on `groups`,
  // `group_members` and `grants` — and not on `users`. Behind that cache a
  // disabled user's delegations would keep working for the TTL, which is the
  // lag the ACL tag cache was removed for.
  if (typeof claims.del !== 'string' || options.delegations === undefined) {
    return unauthorized(instance, requestId, 'The token is not valid.')
  }

  const delegation = await options.delegations.resolve(org, claims.del)
  if (delegation === undefined) {
    return unauthorized(instance, requestId, 'The token is not valid.')
  }

  // The token says who it acts for and the row says who it was issued for. They
  // are two copies of one fact, so they are compared rather than one being
  // trusted: a token whose subject no longer matches its connection is refused,
  // not resolved as whichever of the two the code happened to read.
  if (delegation.userId !== sub || type !== 'user') {
    return unauthorized(instance, requestId, 'The token is not valid.')
  }

  return {
    orgId: org,
    principal: { type: 'user', id: delegation.userId },
    // From the row and never from the claim. A role in a token is a snapshot,
    // and an administrator demoted since consent must not keep administering
    // through an application they connected while they still could.
    role: delegation.role,
    delegation: {
      id: claims.del,
      ...(delegation.layers === undefined ? {} : { layers: delegation.layers }),
      ...(delegation.permissions === undefined ? {} : { permissions: delegation.permissions }),
    },
  }
}
