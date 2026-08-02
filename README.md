<div align="center">
  <img src="docs/assets/nacre-mark-dense.svg" width="72" alt="Nacre">
  <h1>Nacre</h1>
  <p><strong>Your index. Your access rules. Your perimeter.<br>
  Agents see exactly what they're allowed to see.</strong></p>
  <p>
    <a href="https://nacre.work">nacre.work</a> ·
    <a href="./docs">Docs</a> ·
    <a href="./docs/quickstart.md">Quickstart</a> ·
    <a href="https://github.com/nacre-work/nacre/discussions">Discussions</a>
  </p>
</div>

---

Nacre is a self-hosted knowledge index with fine-grained access control.
Agents reach it over MCP, applications over a REST API. No chat interface,
no company assistant — just the context layer underneath them.

## Why

Vector search is a solved problem. What isn't solved: making sure an agent
querying a company index sees exactly the documents the requesting user is
cleared for — and being able to prove it to an auditor.

- **Permissions that inherit.** Workspaces → layers, with `read`/`write`/`admin`
  inherited top-down. `write` does not imply `read`; `admin` implies both.
  Document-level grants and deny rules are commercial — this build refuses them
  and says so, rather than accepting a rule it cannot propagate.
- **Filtering happens inside the index.** Access filters are applied during
  HNSW traversal, not after ranking, so `top_k` returns k permitted results
  rather than k minus whatever got stripped out.
- **MCP as a first-class surface.** Streamable HTTP per the 2026-07-28 spec,
  and local STDIO for developer agents. Agents authenticate with a service
  account key today; OAuth discovery is specified and not built.
- **Bring your own models.** Embeddings through any OpenAI-compatible
  endpoint, bound per layer. Changing the model on an existing layer needs a
  reindex, which is specified and not built.
- **Stays inside your network.** Docker Compose, no phone-home.

## Quickstart

```bash
git clone https://github.com/nacre-work/nacre && cd nacre
cp .env.example .env
docker compose --profile minimal up -d
```

Full walkthrough: [docs/quickstart.md](./docs/quickstart.md).

## Layout

```
packages/api        REST API and authorization service
packages/mcp        MCP server (Streamable HTTP + STDIO)
packages/worker     indexing pipeline: parse, chunk, embed
packages/core       data model, permission resolver, shared types
packages/sdk        TypeScript SDK
packages/admin      community admin UI
services/parser     Python sidecar: bytes → {text, blocks, metadata}
docs/               specifications — normative, and ahead of the code
```

## State

Early, and it runs. The loop works end to end and has been driven by hand
against a real PostgreSQL and a real Qdrant: create an organization, create a
layer, grant someone `read`, ingest a document, poll the job to `indexed`,
search and get the chunk back — and search as someone without the grant and get
nothing while the vectors are still sitting in the index. Both surfaces work,
REST and MCP over Streamable HTTP and STDIO alike. Revoking a grant removes the
document from results, and the recomputation that refreshes the index tags runs
in the worker with a metric on how far behind it is.

Search is rate limited per organization, unsafe methods take an
`Idempotency-Key`, collections page by cursor, and reranking runs on the search
path when a deployment configures a reranker. Tombstoned vectors are collected,
and the SDK and the admin UI are written.

Signing in works: email and password, with rotating refresh tokens that end the
session if one is replayed. `init` creates the first administrator and prints a
generated password once. SSO is a commercial module.

The access log is readable: `GET /v1/audit`, newest first, cursor-paged, as
JSON, JSONL or CSV. `org_admin` sees which documents were read — the question
an audit log exists to answer — and `platform_admin` sees administrative actions
and never that, which is rule 2 applied to the journal.

What is not built, all of it described in `docs/` because that is the contract
it will be built to: `POST /v1/layers/{id}/reindex`, OAuth discovery and dynamic
client registration, and multipart upload on ingest. The reindex sequence in
`docs/architecture.md` cannot be built as written — Qdrant will not add a named
vector to an existing collection — and that document now says so, along with
what the corrected design costs. `docker compose up` has not been run from a clean
checkout, though its profiles are validated in CI.

`docs/` is the specification, and it still runs ahead of the code in places —
start with [docs/authz.md](./docs/authz.md), which everything else depends on.

## Invariants

Six rules. Breaking any of them is a security incident, not a bug.
Details in [docs/authz.md](./docs/authz.md).

1. The organization comes from the token and nowhere else.
2. Access filtering is a pre-filter, never a post-filter.
3. A failure to evaluate permissions denies access.
4. "No permission" and "no such object" return identical responses.
5. A deleted document is never returned, including before garbage collection.
6. `write` does not imply `read`.

## License

Apache 2.0 — all of it. Everything above is in this repository and stays there.

Multi-tenancy, SSO/SCIM, document-level deny rules, EMA and SIEM export are
planned as commercial modules and **none of them is written yet**; there is
nothing to buy today. Where this build meets one of them it refuses in the
open — a `deny` rule or a document-scoped grant is answered `400` with the
reason, rather than accepted and silently not enforced.

The Nacre name and mark are trademarks; see [TRADEMARK.md](./TRADEMARK.md).
