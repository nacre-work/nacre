# Extension points

Normative. Six points a module outside this repository plugs into, the loader
that gets it in, one seam in the console that is not a registry at all, and what
the core refuses.

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
  "providers":["@nacre.work/enterprise-sso:oidc"],"sinks":[],"routes":4,
  "gates":[],"signIn":["@nacre.work/enterprise-tenancy:second-factor"]}
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
complete with nothing plugged in — and is why the T1–T25 suite still tests the
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

## `registerSignInGate(gate)`

A check run before a **session** is minted, in addition to the credential the
core has already verified.

```ts
interface SignInContext {
  readonly orgId: string
  readonly userId: string
  readonly role: OrgRole
  readonly path: 'password' | 'second-factor' | 'refresh' | 'password-change'
  readonly secondFactor: 'totp' | 'webauthn' | undefined
  readonly enrolled: boolean
  readonly holdsOwnCredentials: boolean
}

type SignInVerdict =
  | { readonly kind: 'admit' }
  | { readonly kind: 'enrol'; readonly reason: string }
  | { readonly kind: 'refuse'; readonly reason: string }

interface SignInGate {
  readonly name: string
  check(context: SignInContext): Promise<SignInVerdict>
}
```

A list, and every gate must admit. A gate decides whether *this authentication*
is enough — never who the person is or what they may see. It runs only after a
password has been verified or a refresh token spent, so it can subtract a
session and can never grant one, which is why more than one is coherent.

**It runs at the one point a session is minted**, which is four paths: a
password with no factor asked for, a completed second factor, a spent refresh
token, and a password change. A gate wired beside three of the four is a policy
an operator turned on and a door it never closed. A **renewal** is gated
deliberately: without that, a policy turned on while people are signed in does
nothing for any of them for as long as they keep renewing.

`secondFactor` is what was proved *on this request* and `enrolled` is what the
account *holds*. They are two fields because a refresh proves neither and the
account may still have a factor; collapsing them would make a renewal
indistinguishable from a password-only sign-in.

`holdsOwnCredentials` is a third fact and the one a gate is most likely to
forget. `false` is a **shared** account — a login several people hold, published
or handed round a team — whose whole `/v1/me` credential surface answers `404`:
no second factor, no password change, no reset link. A gate that answers `enrol`
for one is sending somebody to routes that refuse them, with no route back,
produced by the one verdict that exists so a policy *has* a route back. It
cannot be inferred from `enrolled`, which reads `false` for a shared account and
for a person who simply has not enrolled yet.

It is the same fact `GET /v1/me` reports as `holds_own_credentials`, under the
same name. What a gate does with it is the gate's decision — admitting is the
usual answer, since such an account's credentials are administered rather than
held — but it must be a decision rather than an oversight.

### `enrol` is what makes such a policy usable

Enrolment lives under `/v1/me` and therefore needs authority. A gate that could
only refuse would lock out everybody who had not already enrolled on the day the
policy was turned on, with no route back that does not go through the database.

So a gate may answer `enrol`, and the core hands the person an **enrolment
challenge** instead of a session. It is a JWT whose audience is deliberately not
the API's — so `authenticate` refuses it everywhere, and a route that forgets it
answers `401` rather than `200`. It carries a purpose claim that a *sign-in*
challenge does not, so neither can be spent as the other.

It reaches four routes and no others: `POST /v1/me/second-factor`,
`POST /v1/me/second-factor/webauthn`, `POST /v1/me/second-factor/webauthn/finish`
and `POST /v1/me/second-factor/{id}/confirm`. Not the listing, because a caller
who has proved nothing is not owed an inventory of the account; not the removal,
because taking a factor off under a mandate to add one is what somebody holding
a stolen password would do.

Confirming a factor through that door answers with the recovery codes **and** a
session, because it is the end of a sign-in as well as the end of an enrolment.
The gates are asked again at that moment — a gate that wanted a particular kind
is entitled to refuse the one just added.

### Precedence, which differs from `registerIngestGate`

`admitIngest` stops at the first refusal, because there is one way to say no and
asking the rest cannot change the answer. Here there are two and one is
stronger, so **every gate is asked** and `refuse` wins wherever it appears. A
`refuse` does stop the scan, because nothing outranks it.

`refuse` answers **403**, not `401`: the credential was correct, and every client
here renews on a `401` and replays, so a policy refusal spelled that way would
spend a refresh token and arrive as two failures. Not `404` either — the caller
is looking straight at their own account. `enrol` answers **200**, like the
second-factor challenge beside it, because nothing was refused: the client is
being asked for something more and told where to send it.

### SSO needs no gate and cannot have one

An `AuthProvider` principal presents the identity provider's assertion as its
credential on **every request** and never mints a session here. So a policy of
the form "a second factor, or sign in through your identity provider" is
satisfied by construction on its second half: the SSO door does not pass this
way, and the password door is the one a gate closes.

With no module loaded there are no gates, and the open core mints a session for
every credential it verifies, exactly as it did before this point existed.

## The console's extension file

The six points above are for the API process. This one is for the browser, and
it is deliberately not a registry: the console is a static bundle in a different
image, so nothing a module registers in the API process can reach it.

`packages/admin` is the community console and is single-organization — every
screen it draws is behind `administers(auth)`, which is `org_admin` and nothing
else. The commercial modules mount routes under `/v1/admin/*`, and until this
seam existed there was no screen for any of them on either side of the boundary:
a customer who bought multi-tenancy administered it with `curl`. That is the
model-offers-it-and-the-product-gives-no-route shape, arriving in the paid half.

**The console loads one file and an image replaces it.** The open `web` image
ships `extensions.js` registering nothing; `nacre-enterprise-web` is built
`FROM` that image with the file replaced. The same shape `NACRE_MODULES` gives
the API, expressed in the only unit a static bundle has.

```js
// extensions.js
export default function register(kit) {
  return {
    contract: kit.contract,
    views: [
      {
        hash: '#/organizations',
        label: 'Organizations',
        shows: (viewer) => viewer.platformAdmin,
        render: (root, viewer) => { /* … */ },
      },
    ],
  }
}
```

**The contract is a function, not an import.** An extension is handed everything
it may use — `kit` — rather than importing it. That is what makes this possible
without publishing a package: nothing in the extension's bundle resolves
`@nacre.work/*`, so there is no second copy of anything, no npm name to own, and
no `admin.css` living in two repositories with nothing that knows there are two.
It is also what makes the surface countable: `ConsoleKit` in
`packages/admin/src/extensions.ts` is the whole of it, and a helper that is not
on that object is not part of the contract.

`kit.request` is the session, not a second client. The SDK covers
`docs/openapi.yaml`, which is the core's contract and does not describe
`/v1/admin/*`; `request` is one authorized, renewing call that rejects with the
same `NacreError` the SDK does, so `kit.explain` reads it and a `404` is still
"absent, or not yours".

`viewer` is what the server said — `administers` from `GET /v1/me`, and
`platformAdmin` for `administersTenants(auth)`, which is the role and has no
ceiling question. An extension asks the same question a core screen asks.

**A mismatch is said out loud.** `kit.contract` is a number, an extension
declares which one it was built against, and a console that does not speak it
draws a message naming both rather than a nav that is silently shorter than the
installation paid for. A hash colliding with a core route is dropped for the
same reason in the other direction: a module must not be able to replace Grants
with a screen of its own.

`scripts/check-console-extensions.mjs` drives all of that in a browser, because
every part of it is a browser's business — a dynamic import of a same-origin URL
under `script-src 'self'`, a bundler that must not inline the file an image
replaces, and a nav that has to gain an item. A stub of `import()` would agree
with whatever it was written to.

## A module's own schema

A module that needs a table applies it with the core's runner, pointed at the
module's own ledger:

```ts
import { loadMigrations, migrate } from '@nacre.work/core'

await migrate(process.env.NACRE_PG_URL, loadMigrations(here('../migrations')), {
  ledgerTable: 'enterprise_migrations',
  // Only if none of this module's SQL reads a core table. See below.
  requirePrivileges: false,
})
```

**Not `schema_migrations`.** That is the core's history and only the core's: a
module writing rows into it would make the open half's migration state depend on
which modules a deployment bought, and `/v1/ready` reads that table to decide
whether the schema matches the image.

**Not at load, either.** DDL on a process start races every other replica
starting beside it, and `CREATE TABLE IF NOT EXISTS` does not make that safe —
it can still raise a unique violation on the catalog. A module ships a command
and **refuses to load without its table**, because "no table" and "no rows" are
the same empty set to every line after it and only one of them is a working
deployment.

`requirePrivileges` decides whether the runner refuses up front unless the
connected role can finish. It defaults to `true`, which is right for the core:
several of its migrations read a tenant table, every tenant table is `FORCE`d,
and a plain owner fails five migrations in with a message naming a GUC. A module
touching only its own table needs no `BYPASSRLS` and passing `false` says so —
and is wrong the moment one of its migrations reads a core table.

The option exists because the alternative was a **second copy of the runner**
beside the module: a checksum comparison, a ledger backfill and a
transaction-per-migration that had to stay in step with this one, with nothing
that knew there were two.

Two things it does that a hand-written runner tends not to. An applied file is
checksummed and re-checked, so editing one that has already run is refused
rather than silently diverging from every database that ran the old text — and
that includes comments, since the digest is over the whole file. And a ledger
from an older runner whose `checksum` column is nullable is **backfilled**
rather than read as a mismatch, so switching an existing module onto this does
not refuse every installation older than the check.

## Testing a module against these rules

The T1–T25 suite in `docs/authz.md` is written against the model, not against
the built-in implementation. A module registering a resolver runs it — from
this repository's version of the file, not a copy — because a resolver reaching
the same guarantees down different code paths is exactly the thing a copied test
stops checking.
