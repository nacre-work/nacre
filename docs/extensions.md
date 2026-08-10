# Extension points

Normative. Five points a module outside this repository plugs into, the loader
that gets it in, and what the core refuses.

This document exists because the points did not. `nacre-enterprise` has named
`registerAuthProvider`, `registerAuthzResolver`, `registerAuditSink` and
`mountAdminRoutes` since before there was a module to write, described as
"points declared by `@nacre.work/core`", and nothing here declared them.

## Why a registry rather than an import

The `boundary` job in this repository's CI fails if anything under `packages/`
or `services/` mentions the enterprise package by name. That check is what keeps
the open half honest — it cannot depend on the closed half even by accident.

So a module cannot be wired in by `main.ts` importing it. It is named in
configuration, imported dynamically by name, and registers itself. The registry
is not a style preference; it is the only shape that satisfies *the core must
not know that repository exists* while still letting a deployment run both
halves in one process.

## Loading

`NACRE_MODULES` is a comma-separated list of package names. The API and both MCP
transports call `loadModules` after logging is configured and before anything is
composed.

The worker does not, and that is deliberate rather than an oversight: it
consults no extension point. Loading a module there would import it and never
ask it anything, which is the exact failure everything below refuses.

A module that cannot be imported is a startup failure. A deployment that names
one is paying for what it does, and starting without it is silently a different
product.

### Registration is only open while modules load

`loadModules` opens registration, imports, and closes it again — including when
the import throws. Anything that registers afterwards throws.

This is the rule the rest of the design hangs on. A module registering after the
surfaces are composed would be loaded, present in the configuration, apparently
in force, and never consulted. That is the same shape as a variable accepted and
never read, and this repository has found enough of those to write it down.

Register from the module body, which runs during the import.

### The startup line reports what loading produced

Not what was named. The resolver, the providers by module and name, the sinks,
and the route count:

```
api listening port=8080 extensions={"resolver":"@nacre.work/enterprise-tenancy",
  "providers":["@nacre.work/enterprise-sso:oidc"],"sinks":[],"routes":4}
```

A module that imports cleanly and registers nothing is the failure worth seeing,
and it is invisible everywhere else.

## `registerAuthzResolver(resolver)`

Replaces permission evaluation.

**This is the only interface in this repository that can break the six
invariants from outside it.** A resolver that implements it takes over the
question every other rule depends on. It obeys `docs/authz.md` as written: it
does not relax rule 6, it does not return `403` where the core returns `404`,
and its answer is still a plan the caller turns into a pre-filter rather than a
predicate applied to results.

```ts
interface AuthzResolver {
  resolve(input: ResolveInput, permission: Permission): AccessPlan
}
```

The signature is the built-in one on purpose. A resolver needing extra inputs is
a change to `ResolveInput` **here**, in the open half, reviewed like any other
change to the model — not a private extension of it.

**One resolver.** A second is refused, naming both modules, rather than
replacing the first. Two answers to "who decides access" is not something to
settle by precedence: the loser stays loaded, appears to be in force, and is
not. Same argument `loadJwtKeys` makes about a secret and a key reference.

The default is the built-in resolver, which is what makes this repository
complete with nothing plugged in — and is why the T1–T15 suite still tests the
model rather than a stub.

## `registerAuthProvider(provider)`

A credential type the core does not understand.

```ts
interface AuthProvider {
  readonly name: string
  authenticate(credential: string): Promise<ResolvedPrincipal | undefined>
}
```

Consulted only after the built-in paths decline — so a provider cannot shadow a
JWT this deployment can verify, and cannot shadow a `nacre_sk_` key.

`undefined` means "not mine". It is **not** "invalid", and the distinction never
reaches a caller: every refusal ends in the one `401` with the one message,
because distinguishing them is what invariant 4 forbids one level down. A
provider that throws is treated as `undefined` for the same reason invariant 3
exists — a failure to evaluate denies.

`ResolvedPrincipal` carries `orgId`, and that value is invariant 1: it comes
from the credential, never from the request.

## `registerAuditSink(sink)`

Somewhere an event goes **in addition to** the table.

```ts
interface AuditSink {
  readonly name: string
  write(event: AuditEvent): Promise<void>
}
```

Never instead of it. The journal is append-only and is what an auditor reads; a
forwarder that could replace it would make the guarantee depend on a network
hop. The SIEM export in `docs/audit.md` is this.

Sinks are called after the row is written and each failure is logged and
swallowed. A sink that raised would take down the request whose event it was
forwarding, which trades the durable record for the unreliable one.

More than one is fine. None decides access.

## `mountAdminRoutes(...routes)`

Routes under `/v1/admin/`.

```ts
interface AdminRoute {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  readonly pattern: RegExp
  handle(request: AdminRequest): Promise<AdminResponse>
}
```

Confined to that prefix by the mounter rather than by convention: a module able
to mount `/v1/search` would be replacing a surface the open half documents and
tests, which is a different thing from extending it. Three refusals:

- **A pattern not anchored under `/v1/admin/`.** `\/` is unescaped before the
  check, because `/^\/v1\/admin\/x$/.source` and
  `new RegExp('^/v1/admin/x').source` are the same pattern spelled two ways —
  checking the raw text would be checking how the author escaped.
- **A pattern that leaves the prefix through a top-level alternation.**
  `^/v1/admin/x|^/v1/search` passes the anchor check and matches a documented
  surface. Each pattern is asked directly about a list of paths it must not
  match.
- **A `g` or `y` flag.** Those make a pattern stateful — `test` and `exec`
  advance `lastIndex` — so the same path matches or does not depending on what
  was dispatched before it. Refused rather than worked around by resetting: a
  route that works only because the dispatcher remembers to clear a field
  breaks the first time it is matched somewhere else.

A refused batch mounts none of itself.

### What a route is handed

`AdminRequest` arrives **after** authentication and after `rejectTenantOverride`
has scanned the body. A module gets an already-authenticated principal and a
body already checked for a tenant override, so invariants 1 and 2 hold for its
routes without it having to know they exist. It cannot opt out of either,
because it never sees the request earlier than this.

`platform_admin` and `org_admin` only, checked before the route is looked up.
There is no module-supplied role check to get wrong. A member reaching an
administrative surface would be a widening decided in the closed half, and both
the role refusal and "nothing mounted" answer the same `404` — a deployment
without the module is not distinguishable from one where the path is wrong.

Every call is journalled as `admin.<method>` with `surface: 'admin'`, by the
dispatcher rather than by the module.

## `registerIngestGate(gate)`

A check run before a document is accepted, in addition to the permission check
the core already does.

```ts
interface IngestContext {
  readonly orgId: string
  readonly layerId: string
  readonly principal: Principal
  readonly role: OrgRole
  readonly externalId: string
  readonly bytes: number
}

type IngestVerdict =
  | { readonly admit: true }
  | { readonly admit: false; readonly status?: number; readonly reason: string }

interface IngestGate {
  readonly name: string
  admit(context: IngestContext): Promise<IngestVerdict>
}
```

A list, and every gate must admit — one deny refuses the ingest with that gate's
reason. It runs **after** `write` on the layer has been established and **before**
anything is stored, so a refusal leaves neither a row nor an object behind, and a
gate cannot grant an ingest the permission model would refuse — it can only
subtract. It is handed metadata, never the bytes, the same discipline
`rejectTenantOverride` follows.

A refusal is **not** a `404`. The write check returns `404` for a layer that is
absent and one that is unpermitted alike, because telling them apart is an
enumeration oracle. By the time a gate runs the caller has been shown to hold
`write`, so the layer's existence is not a secret the gate hides — a quota or a
suspension is a real answer they are entitled to. It defaults to `403` and
carries a reason; a gate may choose another 4xx (`429` for a rate-shaped limit).

It runs in the **shared** ingest path, so it holds on REST and on MCP both — a
quota a caller could dodge by switching ports would be the shape of hole the rate
limiter and the metrics each had when MCP became a second surface.

The first user is `max_documents`, which the schema has carried since `0001` and
nothing enforced: a commercial `tenancy` gate that counts a tenant's live
documents and refuses over the quota. With no module loaded there are no gates,
and the open core accepts every document a caller may write, exactly as it did
before this point existed.

## Testing a module against these rules

The T1–T15 suite in `docs/authz.md` is written against the model, not against
the built-in implementation. A module registering a resolver runs it — from
this repository's version of the file, not a copy — because a resolver reaching
the same guarantees down different code paths is exactly the thing a copied test
stops checking.
