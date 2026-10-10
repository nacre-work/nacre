---
name: open-core-boundary
description: Use when deciding whether a feature belongs in this open-source repository or in the private nacre-enterprise one, when adding an extension point, or when a change touches multi-tenancy, SSO, SCIM, document-level deny rules, EMA/ID-JAG, the audit log, the global admin, or quotas. Triggers on "enterprise", "commercial", "open core", "which repo", "extension point", "boundary", "multi-tenancy", "SSO", "SCIM".
---

# Where does this code go?

`docs/licensing.md` has the full split. The decision reduces to one question.

## The question

**Does a security team pay for it, or a developer?**

If a single developer on a laptop needs it, it belongs here, in the Apache 2.0
core. If it exists because a regulated buyer's security or compliance function
requires it, it belongs in `nacre-enterprise`.

Blurring the line devalues both halves: the core stops being usable on its own,
and the commercial half stops being worth buying.

## Core, Apache 2.0

Data model · ingest · chunking · embeddings · hybrid search · reranking · the
MCP server · the REST API · basic RBAC · a single organization · email and
password authentication · Docker Compose · the Helm chart.

## Commercial, separate repository

Nine modules: `tenancy` (suspension, offboarding, quotas) · `sso` (OIDC sign-in
per organization and SCIM group-membership sync; not SAML, which goes through a
broker) · `acl-advanced` (*issuing* document-level grants and deny rules) · `ema`
(EMA and ID-JAG) · `audit` (SIEM forwarding) · `admin-global` (creating
organizations, the default embedding model, platform administrators) · `backup`
(one encrypted artifact for the whole installation, and restoring it) ·
`sign-in-policy` (an organization requiring a second factor) · `directory`
(filtered administration for installations too large to page through).

What sits beside those and is **core**: one vector collection per organization,
*evaluating* document grants and deny rules (`resolve` and `buildFilter`), and
the access log with `GET /v1/audit` and its JSONL/CSV export. The `airgapped`
Compose profile is core too.

## The mechanical rule

**The core must not know the private repository exists.** The `boundary` job in
CI fails the build if anything under `packages/` or `services/` references
`@nacre.work/enterprise`. The reverse direction is fine — over there,
`@nacre.work/core` is an ordinary dependency.

That job is the only automated part of this. Everything above it is judgement,
which is why it is worth stating in the PR rather than assuming.

## Extension points

Commercial modules plug into points **declared by the core**, in
`packages/core/extensions.ts`. The contract is [docs/extensions.md](../../../docs/extensions.md).

```ts
registerAuthProvider(provider)      // sso, ema
registerAuthzResolver(resolver)     // tenancy
registerAuditSink(sink)             // audit
registerIngestGate(gate)            // tenancy (max_documents)
mountAdminRoutes(...routes)         // most modules
registerSignInGate(gate)            // sign-in-policy
registerMcpTools('admin', ...tools) // acl-advanced
```

Plus one seam that is not a registry: the console loads `extensions.js`, which
the open `web` image ships registering nothing and `nacre-enterprise-web`
replaces (see "The console's extension file" in `docs/extensions.md`).

Adding another point is a core change and belongs here. Its *implementation*
may not. Design the point so the core is complete and correct with nothing
plugged in — if the core only works once a commercial module registers, the
boundary has already leaked, whatever the import graph says.

Two rules the registry enforces rather than documents, and both are about a
module that looks loaded and is not:

- **Registration is open only while `loadModules` is running.** Anything
  registered later would be configured, present in the startup line, and never
  consulted.
- **A second resolver is refused rather than preferred.** The loser would stay
  loaded and appear to be deciding access.

## A trap worth naming

`registerAuthzResolver` replaces permission evaluation. A commercial resolver
still obeys every invariant in `docs/authz.md` — it does not get to relax rule 6
or return `403` where the core returns `404`. The private repository does not
re-run T1–T44: its `acl-invariants` job gates *issuance* — who may issue a
grant or deny, and on what — and ends at `buildFilter`, asserting that a deny it
wrote arrives as a `must_not`.
