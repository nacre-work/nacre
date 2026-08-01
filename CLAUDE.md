# Nacre — core

A self-hosted knowledge index with fine-grained access control. Agents reach it
over MCP, applications over a REST API. Apache 2.0; the commercial modules live
in a separate private repository.

**Read [docs/authz.md](./docs/authz.md) before writing anything.** Every other
subsystem depends on the permission model, and reworking it after search exists
is expensive. Work order is in [docs/README.md](./docs/README.md).

## The six invariants

Breaking one of these is a security incident, not a bug. They are not
negotiable in a PR.

1. **The organization comes from the token** — never from a body, path, or header.
2. **Access filtering is a pre-filter, never a post-filter.** The filter goes
   inside the index traversal so `top_k` returns k *permitted* results.
3. **A failure to evaluate permissions denies access.** There is no
   "couldn't compute it, let it through" path.
4. **"No permission" and "no such object" are indistinguishable** — `404`, never
   `403`, including the wording of the message.
5. **A deleted document is never returned**, including before garbage collection.
   `deleted = false` belongs in every query.
6. **`write` does not imply `read`.** `admin` implies both. This is the opposite
   of most permission systems; do not "fix" it.

## Never, in any change

- Filter search results after they come back from the vector database.
- Accept `org_id` from a request body, path, or header.
- Return `403` where the object is invisible.
- Log document contents or full query text.
- Ask for a larger `top_k` and trim — that is a post-filter that also costs more.
- Skip the ACL filter in one branch of a hybrid query. Every prefetch branch
  carries it; one omission is a leak.

## Commands

```bash
pnpm install
pnpm lint          # eslint
pnpm lint:openapi  # the REST contract, which runs ahead of the code
pnpm typecheck     # covers tests and config files, which the build does not
pnpm build         # tsc -b across the workspace
pnpm test:unit     # everything except authz
pnpm test:acl      # authz only — its own CI job on purpose
```

`test:acl` never passes with zero tests, at any level. If it reports green
having run nothing, that is the bug.

## Layout

```
packages/core        data model, permission resolver, shared types
  authz/             the resolver. Modules sit at the package root, not under src/
  migrations/        SQL, forward-only
packages/mcp         MCP server (Streamable HTTP + STDIO)
packages/api         REST API and authorization service
packages/worker      indexing pipeline: parse, chunk, embed
packages/sdk         TypeScript SDK
packages/admin       community admin UI, single organization
services/parser      Python sidecar: bytes -> {text, blocks, metadata}
docs/                specifications. These are normative, not descriptive
```

`packages/core/authz` is a directory inside `@nacre.work/core`, **not** a
workspace package. Do not add a `package.json` to it.

## State of the code

It runs. The whole loop has been driven by hand against a real PostgreSQL and a
real Qdrant: `init` creates an organization, `/v1/layers` and `/v1/grants` set
up access, ingest goes through the worker to the index, and search returns what
the caller is permitted to see and nothing else — over REST, over MCP Streamable
HTTP, and over MCP STDIO alike. Revoking a grant drops the document from results
while its vectors are still in the index, and the recomputation that refreshes
the payload tags runs in the worker with `nacre_acl_propagation_lag_seconds`
measuring how far behind it is.

Not built: no login (tokens come from `init`, service accounts from
`/v1/service-accounts`), no reranking on the search path, no garbage collection
for tombstoned vectors, and `packages/sdk` and `packages/admin` are empty.
`docker compose up` has not been run from a clean checkout — its profiles are
validated by `lint:compose` and nothing more.

The docs are still normative rather than descriptive, and in places still ahead
of the code. Where one disagrees with the tree, that is a bug in one of them —
say which.

**All 15 cases from docs/authz.md run** against real services, plus the truth
table, a property-based comparison against the reference implementation, and a
round trip that puts the worker and the search path against each other.
`acl-invariants` is a gate on what that document specifies — and only on that.
A leak nobody thought to write down is still unguarded, and adding a case to
`test-plan.ts` is how that changes.

**Test what you write by running it, not only by testing it.** Four of the worst
defects found so far — the worker indexing nothing at all, layers naming a
vector that did not exist, MCP answering in a shape no client can parse, and the
propagation gauge that could never fire — were each invisible to a green suite
and obvious within a minute of starting the processes.

## Conventions

- **English everywhere** — code, comments, commits, branches, issues, PRs, docs.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`.
- Squash merge, linear history. One PR, one topic.
- DCO, not a CLA: sign off with `git commit -s`.
- Changes under `packages/core/authz` need **two maintainer approvals** and
  tests.
- Don't optimize `authz/reference.ts` when it exists. Its whole value is being
  obviously correct so the property test can catch drift in the fast path.

## Skills

`.claude/skills/` carries the checklists for work that touches the model:
`authz-change`, `mcp-tool`, `api-endpoint`, `db-migration`, `audit-event`,
`config-var`, `open-core-boundary`. They load themselves when relevant.
