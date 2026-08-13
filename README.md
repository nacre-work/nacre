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
  account key; OAuth discovery is served (RFC 9728), and client registration is
  the authorization server's business rather than ours.
- **Hybrid retrieval, because agents ask for identifiers.** Dense vectors and
  BM25 fused with reciprocal rank fusion, plus a cross-encoder rerank where a
  deployment configures one. Not offered as a differentiator — the line above
  is the honest one — but an agent searching for `SQLSTATE 23505`, an invoice
  number or a variable name needs the literal match, and a dense-only index
  does not reliably return it.
- **Bring your own models.** Embeddings through any OpenAI-compatible
  endpoint, bound per layer. Changing the model on an existing layer is a
  reindex that keeps search answering throughout, and it is gated on recall
  against a query set you supply before it switches over.
- **A command line client.** `npx @nacre.work/cli` signs in, creates a layer,
  walks a directory into it and searches — the four `curl` invocations the
  quickstart spells out, for when you want the result rather than the contract.
  A document that fails to index is a non-zero exit, so a nightly ingest cannot
  report success having indexed nothing.
- **Stays inside your network.** Docker Compose, no phone-home.

## Quickstart

```bash
git clone https://github.com/nacre-work/nacre && cd nacre
cp .env.example .env
docker compose --profile minimal up -d
```

Full walkthrough: [docs/quickstart.md](./docs/quickstart.md).

On an Apple Silicon Mac, read
[docs/apple-silicon.md](./docs/apple-silicon.md) first — the images are arm64 and
the stack is native, but the embedder is the one piece you run on the host.

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

A layer can be moved onto a different embedding model. Qdrant will not add a
named vector to a collection that exists, so the collection is replaced rather
than altered: every point copied across with no embeddings computed, one
statement to switch the pointer, then re-embedding one layer at a time. Search
stays available and stays one query throughout. Before a layer switches, its
reference query set is scored against the new model and a migration that lost
recall stops instead of going live — that gate is off until you write a set,
because it needs documents only you can pick.

A document can be uploaded as a form as well as sent as JSON, and a **PDF** is
extracted by the parser sidecar. Both signals have to agree — the part declares
`application/pdf` and the bytes begin with `%PDF-` — because a declared type the
bytes contradict is a disagreement, and sniffing alone would make the declared
type decoration. Any other binary format is still refused at the edge, and a
scanned PDF with no text layer is refused rather than indexed as nothing.

Tokens can be signed with an Ed25519 key instead of a shared secret, in which
case the public half is published at `/.well-known/jwks.json` and only the
process issuing tokens holds the private one.

**`docker compose --profile minimal up` has been run from a clean clone**, and
the whole loop driven through it.

What is not built is what a commercial licence covers, and `docs/licensing.md`
lists it: multi-tenancy, SSO, document-level permissions and deny rules,
ID-JAG, SIEM export, a global admin, quotas, and HA Helm charts.

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

Multi-tenancy, SSO/SCIM, document-level deny rules, EMA, SIEM export, global
admin and backup are commercial modules. They live in a separate private
repository under a separate license and are not distributed with this one — see
[docs/licensing.md](./docs/licensing.md) for the line between the two and the
one question that decides it.

Where this build meets one of them it refuses in the open: a `deny` rule or a
document-scoped grant is answered `400` with the reason, rather than accepted
and silently not enforced.

The Nacre name and mark are trademarks; see [TRADEMARK.md](./TRADEMARK.md).

## Supporting this

There is no hosted tier, no seat count and nothing metered here, so the open
half earns nothing by being used — which is the point, and also why it is worth
saying who pays for it. The commercial modules do, and they are for the
organizations that need them; a developer running this on a laptop is never the
person being asked.

If it saved you a week, the Sponsor button at the top of this repository is the
other way to say so. Nothing in this repository is behind it, and nothing will
be.
