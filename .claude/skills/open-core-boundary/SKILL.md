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
password authentication · Docker Compose.

## Commercial, separate repository

Multi-tenancy and collection isolation · SSO (OIDC/SAML) and SCIM ·
document-level ACLs with deny rules · EMA and ID-JAG · the audit log, its export
and SIEM forwarding · the global admin · quotas · closed-network delivery · HA
Helm charts.

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
registerAuthProvider(provider)     // sso
registerAuthzResolver(resolver)    // acl-advanced, tenancy
registerAuditSink(sink)            // audit
mountAdminRoutes(...routes)        // admin-global
```

Adding a fifth is a core change and belongs here. Its *implementation* may not.
Design the point so the core is complete and correct with nothing plugged in —
if the core only works once a commercial module registers, the boundary has
already leaked, whatever the import graph says.

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
or return `403` where the core returns `404`. The enterprise suite runs the same
T1-T15 tests with multi-tenancy and deny rules enabled, precisely because it
takes different code paths to the same guarantees.
