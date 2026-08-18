import type { OrgRole, Permission, Principal } from './types.js'
import type { AccessPlan, ResolveInput } from './authz/resolve.js'
import { resolve as builtInResolve } from './authz/resolve.js'

/**
 * The points a commercial module plugs into, and the loader that lets one do so
 * without this repository knowing it exists.
 *
 * Four of them — `registerAuthProvider`, `registerAuthzResolver`,
 * `registerAuditSink`, `mountAdminRoutes` — `nacre-enterprise` named before
 * there was a module to write. The fifth, `registerIngestGate`, is the other
 * direction: a point the core declares for a capability the schema always had
 * and nothing enforced (`max_documents`), designed so the open half is complete
 * and correct with no gate registered. The sixth, `registerSignInGate`, is the
 * same direction again: both kinds of second factor are individually opt-in and
 * an organization had no way to *require* one, so the point is declared here
 * and the policy that uses it is a module.
 *
 * `nacre-enterprise` has named these since before there was a module to write —
 * `registerAuthProvider`, `registerAuthzResolver`, `registerAuditSink`,
 * `mountAdminRoutes` — and nothing here declared them. That document was the
 * only place they existed, which made "plug into points declared by
 * `@nacre.work/core`" a sentence about a thing that was not there.
 *
 * ## The boundary is the reason for the shape
 *
 * The core's CI fails if anything under `packages/` or `services/` mentions the
 * enterprise package by name, and that check is what keeps the open half
 * honest: it cannot import the closed half even by accident. So a module cannot
 * be wired in by `main.ts` importing it. It is named in configuration
 * (`NACRE_MODULES`), imported dynamically here, and registers itself.
 *
 * A registry is therefore not a style preference — it is the only shape that
 * satisfies "the core must not know this repository exists" while still letting
 * a deployment run both halves in one process.
 *
 * ## What the registry refuses
 *
 * **Registration is only open while modules are loading.** Anything registered
 * afterwards would be registered after the surfaces were composed, so it would
 * be configured, look present, and never be consulted — the failure this file
 * exists to prevent, one level up.
 *
 * **One resolver, and a second is an error rather than a replacement.** Two
 * answers to "who decides access" is not something to settle by precedence: the
 * loser stays loaded, appears to be in force, and is not. The same argument
 * `loadJwtKeys` makes about a secret and a key reference.
 *
 * Sinks, providers and routes are lists, because more than one of each is a
 * coherent thing to want and none of them decides access on its own.
 *
 * ## The core is complete with nothing plugged in
 *
 * Every default here is the behaviour this repository already had: the built-in
 * resolver, no extra credential types, no extra sinks, no extra routes. A
 * deployment that sets no modules gets exactly the code path it got before this
 * file existed, and the tests that prove the permission model still run against
 * the built-in resolver because that is what is registered.
 */

/**
 * A replacement for permission evaluation.
 *
 * **This is the only interface in this repository that can break the six
 * invariants from outside it.** A module that implements it takes over the
 * question every other rule depends on, so `nacre-enterprise/CLAUDE.md` binds
 * it to the same document the built-in one is written from: it does not relax
 * rule 6, and it does not return `403` where the core returns `404`.
 *
 * The signature is deliberately the built-in one. A resolver that needed extra
 * inputs would be a change to `ResolveInput` here, in the open half, reviewed
 * like any other change to the model — not a private extension of it.
 */
export interface AuthzResolver {
  resolve(input: ResolveInput, permission: Permission): AccessPlan
}

/** What a credential resolves to. Structurally the API's `AuthContext`. */
export interface ResolvedPrincipal {
  /** From the credential, never from the request. Invariant 1. */
  readonly orgId: string
  readonly principal: Principal
  readonly role: OrgRole
}

/**
 * A credential type the core does not understand.
 *
 * Consulted only after the built-in paths decline, and only for a bearer token
 * that is not a JWT this deployment can verify and not a `nacre_sk_` key — so a
 * provider cannot shadow either. `undefined` means "not mine", which is not the
 * same as "invalid": every refusal still ends in the one `401` with the one
 * message, because distinguishing them is what invariant 4 forbids one level
 * down.
 */
export interface AuthProvider {
  /** For the startup line and for errors. Not shown to a caller. */
  readonly name: string
  authenticate(credential: string): Promise<ResolvedPrincipal | undefined>
}

/**
 * One recorded access, as handed to a sink.
 *
 * Declared here rather than in `packages/api` because a sink is registered from
 * outside both, and a second structurally-identical definition is two things
 * that have to agree with nothing making them.
 */
export interface AuditEvent {
  readonly orgId: string
  readonly actor: string
  readonly action: string
  readonly result: 'allow' | 'deny' | 'error'
  readonly detail: Record<string, unknown>
  readonly requestId: string
  /** Which surface the call came in on. Defaults to `api` at the writer. */
  readonly surface?: 'api' | 'mcp' | 'admin' | 'system'
  /** What the call was about, as `docs/audit.md` specifies it. */
  readonly target?: Record<string, unknown>
}

/**
 * Somewhere else an event goes, **in addition to** the table.
 *
 * Never instead of it. The journal is append-only and is what an auditor reads;
 * a forwarder that could replace it would make the guarantee depend on a
 * network hop. `docs/audit.md`'s SIEM export is this.
 */
export interface AuditSink {
  readonly name: string
  write(event: AuditEvent): Promise<void>
}

/** A request as an admin route sees it — no framework, no server type. */
export interface AdminRequest {
  readonly method: string
  readonly path: string
  /** Capture groups from `pattern`, in order. */
  readonly params: readonly string[]
  readonly query: URLSearchParams
  readonly body: unknown
  /** Already authenticated. A route never sees an anonymous request. */
  readonly auth: ResolvedPrincipal
}

export interface AdminResponse {
  readonly status: number
  readonly body?: unknown
}

/**
 * A route a module adds under `/v1/admin/`.
 *
 * Confined to that prefix by the mounter rather than by convention: a module
 * that could mount `/v1/search` would be replacing a surface the open half
 * documents and tests, which is a different thing from extending it.
 */
export interface AdminRoute {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  /** Matched against the path. Must be anchored under `/v1/admin/`. */
  readonly pattern: RegExp
  handle(request: AdminRequest): Promise<AdminResponse>
}

/**
 * What an ingest gate is told about a document before it is stored.
 *
 * Metadata, never the bytes. The gate decides whether this document may be
 * accepted at all — a quota, a suspension, a per-source rule — and for that it
 * needs to know the tenant, the layer and how big the thing is, not its
 * content. Keeping the content out is the same discipline `rejectTenantOverride`
 * follows: a document body does not belong in something that gets passed around,
 * logged and put into a refusal message.
 */
export interface IngestContext {
  /** From the credential. Invariant 1. */
  readonly orgId: string
  readonly layerId: string
  readonly principal: Principal
  readonly role: OrgRole
  readonly externalId: string
  /** The document's size in bytes, for a gate that bounds volume. */
  readonly bytes: number
}

/**
 * A gate's answer. Admit, or refuse with a reason and the 4xx to answer with.
 *
 * A refusal is **not** a `404`: the caller has already been shown to hold
 * `write` on the layer by the time a gate runs, so the layer's existence is not
 * a secret this hides — unlike the write check itself, which returns `404` for
 * absent and unpermitted alike. A quota or a suspension is a real answer a
 * caller with access is entitled to, so it defaults to `403` and carries a
 * reason.
 */
export type IngestVerdict =
  | { readonly admit: true }
  | { readonly admit: false; readonly status?: number; readonly reason: string }

/**
 * A check run before a document is accepted, in addition to the permission
 * check the core already does.
 *
 * A list, and every gate must admit — one deny refuses the ingest, with that
 * gate's reason. Gates decide admission, not access: a gate cannot *grant* an
 * ingest the permission model would refuse, because it runs only after
 * `write` has been established. It can only subtract, which is why more than one
 * is coherent and why the default — no gates — is the open core accepting every
 * document a caller may write, exactly as it did before this point existed.
 *
 * `max_documents`, which the schema has carried since 0001 and nothing enforced,
 * is the first user: a commercial `tenancy` gate that counts a tenant's live
 * documents and refuses over the quota.
 */
export interface IngestGate {
  readonly name: string
  admit(context: IngestContext): Promise<IngestVerdict>
}

/**
 * What is known about a session at the moment one would be minted.
 *
 * The principal is always a **user**, because this is the only path that mints
 * a Nacre session and only a person walks it. A service account presents its
 * `nacre_sk_` key on every request and a delegation carries a token issued at
 * consent; neither reaches here, which is why there is no principal type on
 * this object to branch on.
 *
 * `secondFactor` is what was *proved on this sign-in* and `enrolled` is what
 * the account *holds*, and they are two facts rather than one. A refresh proves
 * no factor and the account still has one; an account with a factor that was
 * never used is the case a policy is being turned on for. Collapsing them would
 * make a renewal indistinguishable from a password-only sign-in.
 */
export interface SignInContext {
  /** From the row that authenticated, never from the request. Invariant 1. */
  readonly orgId: string
  readonly userId: string
  readonly role: OrgRole
  /** Which of the four paths is minting: a sign-in, a renewal, a password change. */
  readonly path: 'password' | 'second-factor' | 'refresh' | 'password-change'
  /** The kind proved on this sign-in, or `undefined` where none was asked for. */
  readonly secondFactor: 'totp' | 'webauthn' | undefined
  /** Whether the account holds any confirmed factor at all. */
  readonly enrolled: boolean
  /**
   * Whether this account can hold a credential of its own at all.
   *
   * `false` is a **shared** account — a login several people hold, published or
   * handed round — and its whole `/v1/me` credential surface answers `404`: no
   * second factor, no password change, no reset link. The same fact `GET
   * /v1/me` reports as `holds_own_credentials`, under the same name, because a
   * second spelling of one question is two answers waiting to disagree.
   *
   * A gate that answers `enrol` without reading it tells somebody to add a
   * factor through routes that refuse them, which is a lockout with no route
   * back — produced by the one verdict that exists so a policy *has* a route
   * back. It is here rather than left to the gate because the core has the row
   * in hand and a gate would have to read `users` again on every sign-in to
   * learn it.
   */
  readonly holdsOwnCredentials: boolean
}

/**
 * A gate's answer, and three outcomes rather than a boolean with a flag.
 *
 * A union for the reason `LoginOutcome` is one: a caller that can ignore a
 * field will, and ignoring this one means issuing a full session to somebody a
 * policy says may only enrol.
 *
 * **`enrol` is what makes such a policy usable at all.** Enrolment lives under
 * `/v1/me` and therefore needs authority, so a policy that only refused would
 * lock out everybody who had not already enrolled on the day it was turned on,
 * with no route back that does not go through the database — the shape this
 * repository keeps closing. So a gate may say "this person may sign in, but
 * only far enough to add a factor", and the core answers with a challenge that
 * reaches the enrolment routes and nothing else.
 *
 * `refuse` is the stronger answer and is for the case where no action by the
 * person could change it.
 */
export type SignInVerdict =
  | { readonly kind: 'admit' }
  | { readonly kind: 'enrol'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string }

/**
 * A check run before a session is minted, in addition to the credential the
 * core has already verified.
 *
 * A list, and every gate must admit. Gates decide whether *this* authentication
 * is enough, never who the person is or what they may see: one runs only after
 * a password has been verified or a refresh token spent, so it can subtract a
 * session and can never grant one. That is why more than one is coherent and
 * why the default — no gates — is the open core issuing a session for every
 * credential it verifies, exactly as it did before this point existed.
 *
 * An organization policy requiring a second factor is the first user: a
 * commercial gate that reads the policy and answers `enrol` for an account that
 * has none.
 *
 * **SSO needs no gate and cannot have one.** An `AuthProvider` principal
 * presents the identity provider's assertion as its credential on every
 * request and never mints a session here, so a policy of the form "a second
 * factor, or sign in through your identity provider" is satisfied by
 * construction on its second half: the SSO door does not pass this way, and the
 * password door is the one a gate closes.
 */
export interface SignInGate {
  readonly name: string
  check(context: SignInContext): Promise<SignInVerdict>
}

interface Registry {
  resolver: { readonly module: string; readonly value: AuthzResolver } | undefined
  readonly providers: { module: string; value: AuthProvider }[]
  readonly sinks: { module: string; value: AuditSink }[]
  readonly routes: { module: string; value: AdminRoute }[]
  readonly gates: { module: string; value: IngestGate }[]
  readonly signIn: { module: string; value: SignInGate }[]
}

const registry: Registry = {
  resolver: undefined,
  providers: [],
  sinks: [],
  routes: [],
  gates: [],
  signIn: [],
}

/** Which module is registering, or `undefined` when registration is closed. */
let loading: string | undefined

class ExtensionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtensionError'
  }
}

function mustBeLoading(what: string): string {
  if (loading === undefined) {
    throw new ExtensionError(
      `${what} was registered outside module loading. Extensions are read once, ` +
        'when the surfaces are composed, so anything registered afterwards would ' +
        'be configured and never consulted. Register from the module body, which ' +
        'runs during loadModules().',
    )
  }
  return loading
}

export function registerAuthzResolver(resolver: AuthzResolver): void {
  const module = mustBeLoading('an authorization resolver')
  if (registry.resolver !== undefined) {
    // Refused rather than replaced. See the note at the top: the loser would
    // stay loaded and appear to be in force.
    throw new ExtensionError(
      `two authorization resolvers were registered — ${registry.resolver.module} ` +
        `and ${module}. There is one answer to who decides access and no order ` +
        'of precedence worth inventing. Load one.',
    )
  }
  registry.resolver = { module, value: resolver }
}

export function registerAuthProvider(provider: AuthProvider): void {
  registry.providers.push({ module: mustBeLoading('an auth provider'), value: provider })
}

export function registerAuditSink(sink: AuditSink): void {
  registry.sinks.push({ module: mustBeLoading('an audit sink'), value: sink })
}

export function registerIngestGate(gate: IngestGate): void {
  registry.gates.push({ module: mustBeLoading('an ingest gate'), value: gate })
}

export function registerSignInGate(gate: SignInGate): void {
  registry.signIn.push({ module: mustBeLoading('a sign-in gate'), value: gate })
}

export const ADMIN_PREFIX = '/v1/admin/'

/**
 * Paths the pattern is asked about directly.
 *
 * Not a proof and not meant as one — the anchor check above is the guarantee.
 * This catches the thing the anchor check cannot see, which is a top-level
 * alternation: `^/v1/admin/x|^/v1/search` starts with the right prefix and
 * matches a documented surface anyway. The list is the surfaces where being
 * wrong costs the most, plus the two near misses on the prefix itself.
 */
const MUST_NOT_MATCH = [
  '/v1/search',
  '/v1/documents/00000000-0000-0000-0000-000000000000',
  '/v1/grants',
  '/v1/layers',
  '/v1/workspaces',
  '/v1/audit',
  '/v1/auth/login',
  '/v1/health',
  '/.well-known/jwks.json',
  '/v1/admin',
  '/v1/adminish/things',
]

export function mountAdminRoutes(...routes: readonly AdminRoute[]): void {
  const module = mustBeLoading('admin routes')
  for (const route of routes) {
    // Checked here rather than trusted. A route outside the prefix would be a
    // module replacing a documented surface rather than adding to one, and the
    // dispatcher would happily serve it.
    //
    // Anchored, not merely containing: `/v1/admin/x` without the `^` matches
    // `/v1/search?q=/v1/admin/x` shaped paths as readily as the intended one,
    // and the whole value of the prefix is that it is a prefix.
    //
    // `\/` is unescaped first, because `/^\/v1\/admin\/x$/.source` is
    // `^\/v1\/admin\/x$` while `new RegExp('^/v1/admin/x').source` is
    // `^/v1/admin/x` — the same pattern, two spellings. A check on the raw
    // source accepts one and refuses the other, which makes it a check on how
    // the author escaped rather than on what the pattern matches. `\/` in a
    // pattern means the character `/` and nothing else, so this rewrite is
    // exact rather than a guess.
    // `g` and `y` make a pattern stateful: `test` and `exec` advance
    // `lastIndex` and the next call starts from there, so the same request
    // path matches or does not depending on what was dispatched before it.
    // Refused rather than worked around by resetting, because a route that
    // only works because the dispatcher remembers to clear a field is a route
    // that breaks the first time someone matches it somewhere else.
    if (route.pattern.global || route.pattern.sticky) {
      throw new ExtensionError(
        `${module} mounted a route whose pattern carries the ` +
          `${route.pattern.global ? 'g' : 'y'} flag: ${String(route.pattern)}. ` +
          'A stateful pattern matches or does not depending on what was ' +
          'matched before it. Drop the flag.',
      )
    }
    const source = route.pattern.source.replaceAll('\\/', '/')
    if (!source.startsWith(`^${ADMIN_PREFIX}`)) {
      throw new ExtensionError(
        `${module} mounted a route whose pattern is not anchored under ` +
          `${ADMIN_PREFIX}: ${route.pattern.source}. Modules extend the admin ` +
          'surface; they do not replace the documented ones.',
      )
    }
    for (const path of MUST_NOT_MATCH) {
      if (route.pattern.test(path)) {
        throw new ExtensionError(
          `${module} mounted a route anchored under ${ADMIN_PREFIX} that also ` +
            `matches ${path}. A pattern can leave the prefix through a ` +
            'top-level alternation; this one does. Mount one route per path.',
        )
      }
    }
  }
  // Every route checked before any is kept, so a refused batch mounts none of
  // itself. A partial mount would be a module half in force, which is the state
  // this file refuses everywhere else.
  for (const route of routes) registry.routes.push({ module, value: route })
}

/**
 * Import the named modules and let them register, then close registration.
 *
 * Dynamic by name, from configuration, which is what keeps the enterprise
 * package's name out of this repository's source — the `boundary` job greps for
 * it, and a static import would be the leak that job exists to catch.
 *
 * A module that cannot be imported is a startup failure, not a warning. The
 * whole point of naming one is that a deployment is paying for what it does,
 * and starting without it would silently be a different product.
 */
export async function loadModules(
  names: readonly string[],
  importer: (name: string) => Promise<unknown> = (name) => import(/* @vite-ignore */ name),
): Promise<void> {
  for (const name of names) {
    loading = name
    try {
      await importer(name)
    } catch (cause) {
      throw new ExtensionError(`module ${name} could not be loaded: ${String(cause)}`)
    } finally {
      loading = undefined
    }
  }
}

/**
 * The resolver in force.
 *
 * The built-in one unless a module replaced it, which is what makes the core
 * complete with nothing plugged in. Read per call rather than captured, so
 * there is no window in which a surface holds a stale one.
 */
export function activeResolver(): AuthzResolver {
  return registry.resolver?.value ?? { resolve: builtInResolve }
}

export const authProviders = (): readonly AuthProvider[] => registry.providers.map((p) => p.value)
export const auditSinks = (): readonly AuditSink[] => registry.sinks.map((s) => s.value)
export const adminRoutes = (): readonly AdminRoute[] => registry.routes.map((r) => r.value)

/** A refused ingest, as `admitIngest` reports it. */
export interface IngestRefusal {
  readonly module: string
  readonly status: number
  readonly reason: string
}

/**
 * Run every gate, in order, and report the first refusal.
 *
 * `undefined` is admission: no gates registered, or every one admitted, which
 * is why the open core accepts what a caller may write. The first deny stops the
 * rest — a document refused by one gate is refused, and asking the others would
 * be work whose answer cannot change the outcome. The default status is `403`,
 * so a gate that only sets a reason still refuses with a status a caller with
 * access can act on rather than a `404` that would hide the layer it just wrote
 * a check against.
 */
export async function admitIngest(context: IngestContext): Promise<IngestRefusal | undefined> {
  for (const gate of registry.gates) {
    const verdict = await gate.value.admit(context)
    if (!verdict.admit) {
      return { module: gate.value.name, status: verdict.status ?? 403, reason: verdict.reason }
    }
  }
  return undefined
}

/** A gate's non-admission, as `admitSignIn` reports it. */
export interface SignInRefusal {
  readonly module: string
  readonly kind: 'enrol' | 'refuse'
  readonly reason: string
}

/**
 * Run every gate and report the strongest non-admission.
 *
 * `undefined` is admission: no gates registered, or every one admitted, which
 * is why the open core mints a session for every credential it verifies.
 *
 * **This does not short-circuit on the first non-admission, and `admitIngest`
 * beside it does.** That is a real difference rather than an inconsistency. An
 * ingest verdict is admit or refuse, so the first refusal is the answer and
 * asking the rest is work whose result cannot change it. Here there are two
 * ways to say no and one is stronger: `refuse` is "nothing you can do gets you
 * a session" and `enrol` is "a session, but only far enough to add a factor".
 * A gate answering `enrol` while a later one would refuse must not hand out the
 * weaker outcome, so every gate is asked and `refuse` wins.
 *
 * A `refuse` does stop the scan, because nothing outranks it.
 */
export async function admitSignIn(context: SignInContext): Promise<SignInRefusal | undefined> {
  let weakest: SignInRefusal | undefined
  for (const gate of registry.signIn) {
    const verdict = await gate.value.check(context)
    if (verdict.kind === 'refuse') {
      return { module: gate.value.name, kind: 'refuse', reason: verdict.reason }
    }
    if (verdict.kind === 'enrol' && weakest === undefined) {
      weakest = { module: gate.value.name, kind: 'enrol', reason: verdict.reason }
    }
  }
  return weakest
}

/** Anything that records an event. Structurally the API's `audit` port. */
export interface AuditWriter {
  write(event: AuditEvent): Promise<void>
}

const FANNED_OUT = Symbol.for('nacre.auditSinksApplied')

/**
 * Record the event, then hand it to every sink.
 *
 * A decorator over the port rather than something the Postgres adapter does,
 * which is where it started and which put it one layer too low: forwarding is a
 * property of *an event having been recorded*, not of which adapter recorded it.
 * A second adapter — or a surface handed a different port — would have been a
 * SIEM silently missing a class of events, with nothing to notice it by.
 *
 * The table first and never the reverse. The journal is what an auditor reads
 * and what the append-only grant protects, so a forwarder must not be able to
 * make a row conditional on a network hop succeeding.
 *
 * A sink that throws does not fail the request. It is a copy of something
 * already durably recorded, and turning a collector outage into a 500 on every
 * authenticated call would take the installation down to protect a duplicate.
 *
 * Applying it twice is a no-op, so a construction site that wraps a port
 * already wrapped does not double every event in the deployment's SIEM.
 */
export function withAuditSinks<T extends AuditWriter>(
  port: T,
  onError: (sink: string, event: AuditEvent, error: unknown) => void = () => {},
): T {
  if ((port as Record<symbol, unknown>)[FANNED_OUT] === true) return port
  const wrapped: AuditWriter = {
    write: async (event) => {
      await port.write(event)
      for (const sink of auditSinks()) {
        try {
          await sink.write(event)
        } catch (error) {
          onError(sink.name, event, error)
        }
      }
    },
  }
  return Object.assign(Object.create(port as object) as T, wrapped, { [FANNED_OUT]: true })
}

/** What was loaded, for the startup line. An operator needs to see it. */
export function loadedExtensions(): {
  resolver: string | null
  providers: string[]
  sinks: string[]
  routes: number
  gates: string[]
  signIn: string[]
} {
  return {
    resolver: registry.resolver?.module ?? null,
    providers: registry.providers.map((p) => `${p.module}:${p.value.name}`),
    sinks: registry.sinks.map((s) => `${s.module}:${s.value.name}`),
    routes: registry.routes.length,
    gates: registry.gates.map((g) => `${g.module}:${g.value.name}`),
    signIn: registry.signIn.map((g) => `${g.module}:${g.value.name}`),
  }
}

/**
 * Empty the registry. **Tests only**, and named so that is unmistakable.
 *
 * A process does not unload a module, so there is no production reason to call
 * this — but a test file that registered one would otherwise leak it into every
 * test after it, which is exactly the shape of failure a global registry earns
 * if nobody gives it a way out.
 */
export function resetExtensionsForTests(): void {
  registry.resolver = undefined
  registry.providers.length = 0
  registry.sinks.length = 0
  registry.routes.length = 0
  registry.gates.length = 0
  registry.signIn.length = 0
  loading = undefined
}

/** Open registration without importing anything. **Tests only.** */
export function withLoadingModuleForTests<T>(name: string, fn: () => T): T {
  loading = name
  try {
    return fn()
  } finally {
    loading = undefined
  }
}
