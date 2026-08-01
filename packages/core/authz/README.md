# authz — the permission resolver

**The most consequential module in the project.** Changes require two
maintainer approvals and must ship with tests.

Specification: [docs/authz.md](../../../docs/authz.md).

## Contents

```
resolve.ts          the algorithm from spec section 3.3
reference.ts        reference implementation: written straight from the
                    rules, slow, used only by property-based tests
principals.ts       effective principals, caching, invalidation
filter.ts           builds the vector-store pre-filter
__tests__/          T1-T15 and the property test
```

Do not optimize `reference.ts`. Its whole value is being obviously correct:
when the optimized `resolve.ts` drifts away from it, the property test
catches the drift.
