# @nacre.work/core

The data model, the permission resolver and the shared types behind
[Nacre](https://nacre.work) — a self-hosted knowledge index with fine-grained
access control.

**Most people do not install this.** Applications install
[`@nacre.work/sdk`](https://www.npmjs.com/package/@nacre.work/sdk), people run
[`@nacre.work/cli`](https://www.npmjs.com/package/@nacre.work/cli), and
operators run the container. This package is here because the API, the MCP
server and the worker all depend on it — and because a commercial module has to
resolve **the host's copy** of it, which needs it on the registry.

## What is in it

The permission resolver and its reference implementation, the schema and its
forward-only migrations, the Qdrant filter builder, the BM25 producer both sides
of search share, configuration loading, the extension registry, and the types
everything else is written against.

## The part worth knowing before depending on it

Six invariants hold across every consumer, and breaking one is a security
incident rather than a bug:

1. **The organization comes from the token** — never from a body, path or header.
2. **Access filtering is a pre-filter, never a post-filter.** The filter goes
   inside the index traversal, so `top_k` returns k *permitted* results.
3. **A failure to evaluate permissions denies access.** There is no
   "couldn't compute it, let it through" path.
4. **"No permission" and "no such object" are indistinguishable** — `404`, never
   `403`, including the wording.
5. **A deleted document is never returned**, including before collection.
6. **`write` does not imply `read`.** `admin` implies both. This is the opposite
   of most permission systems and is not a thing to fix.

## Extension points

A commercial module registers into these from its module body while
`loadModules` is running:

```ts
registerAuthProvider(provider)
registerAuthzResolver(resolver)
registerAuditSink(sink)
registerIngestGate(gate)
mountAdminRoutes(...routes)
```

The registry is module-level state, so it belongs to whichever *copy* of this
package was loaded. A module that resolves a second copy registers into a
registry the host never reads — which is why every module declares this as a
**peer** dependency rather than an ordinary one.

## Versioning

`0.x`, and the packages ship together referencing each other by exact version.
A minor bump can move an interface; the
[extension contract](https://github.com/nacre-work/nacre/blob/main/docs/extensions.md)
says which parts are load-bearing for a module author.

Apache 2.0. The permission model in full:
[github.com/nacre-work/nacre](https://github.com/nacre-work/nacre/blob/main/docs/authz.md).
