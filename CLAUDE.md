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
- Ask for a larger `top_k` and trim **on permission** — that is a post-filter
  that also costs more. Trimming on relevance over an already-permitted
  candidate set is what reranking is, and it is allowed; the test is whether
  the answer can end up smaller than the number of permitted matches.
- Skip the ACL filter in one branch of a hybrid query. Every prefetch branch
  carries it; one omission is a leak.
- Query outside `withOrg` without saying which mechanism permits it. There are
  two, and only two: `whileAuthenticating` for resolving a credential, and
  `acrossOrganizations` for the worker's queue. A raw `pool.connect()` that
  reads a tenant table is a query that works in development and raises in
  production, because development connects as a superuser and the policies do
  not apply to one.

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

Deleting a document takes it out of results immediately — the points are
flagged before the row is written, in that order, because the reverse fails
unrecoverably. A collector reclaims them afterwards and nothing depends on when
it runs. A worker that dies mid-document has its claim reclaimed by a lease
rather than leaving the document stuck in `parsing` forever.

`packages/sdk` is the TypeScript client and `packages/admin` is the community
admin UI; both are written, and the admin UI has been driven in a browser
against the running API.

Rate limiting, `Idempotency-Key` and cursor pagination are in, which is also
what Redis is finally for — it had been required configuration, and in every
Compose profile with the API waiting on its healthcheck, since before anything
connected to it. Both fail **open**, deliberately and against the grain of
invariant 3: neither is an authorization control, and failing closed would turn
a cache restart into an outage.

Reranking is on the search path, off unless a deployment configures a reranker.
It fetches `NACRE_RERANK_CANDIDATES` from the index and returns the best
`top_k`, which is **not** the over-fetch invariant 2 forbids: every candidate
has already passed the permission filter inside the index traversal, so the trim
is on relevance and changes which permitted results come back, never how many.
See `packages/api/src/rerank.ts` — the argument is in the code because the next
person to read the search path will see the widening and reach for the rule.

Email and password sign-in is in, with rotating refresh tokens: replaying a
used one revokes the whole family, because the legitimate holder has already
exchanged it and there is no way to tell which of the two holders is genuine.
Passwords use scrypt at OWASP's minimum, with the parameters carried in the
stored record so the cost can be raised later without invalidating every one.

Both surfaces are limited by the same buckets: `NACRE_RATE_*` used to apply to
REST only, so a client out of search budget could point at the MCP port and
carry on. MCP has its own `/metrics` now too — it had none, which made every
latency and denial claim in `docs/config.md` true of REST and silent on the
transport the product is for.

Sign-in is bounded three ways, because the per-address limit alone bounds
nothing an attacker actually does: per address, per client (`NACRE_TRUST_PROXY`
decides what a client is, and neither default is safe), and by a cap on
concurrent scrypt calls — that one holds whoever is calling and whatever Redis
is doing, because scrypt runs on libuv's four-thread pool alongside DNS, so an
unbounded login endpoint stops the rest of the API on a name lookup.

`refresh_tokens` and `audit_events` are pruned. Both were documented as swept
and neither was; `NACRE_AUDIT_RETENTION_DAYS` had been validated at startup and
read by nothing since it was added. Retention goes through a `SECURITY DEFINER`
function that takes a number of days and never a predicate, so it can expire a
window past a 30-day floor and can never erase a chosen event — which is what
the append-only grant was protecting.

Search finally honours `layers` and `include_content`, and **refuses** `filters`
rather than ignoring it. All three were in the contract from before there was a
server and read by nothing: a client scoping a search to one layer searched all
of them and believed otherwise.

The access log is readable — `GET /v1/audit`, newest first, cursor-paged, as
JSON, JSONL or CSV by content negotiation. `org_admin` sees which documents were
read; `platform_admin` sees administrative actions and never that, which is rule
2 applied to the journal and is set by the handler rather than being a parameter
a caller could drop. Reading the log is recorded as `audit.read`.

Not built: OAuth discovery and dynamic client registration, multipart upload on
ingest, layer reindex, and filtering on document metadata — the worker writes no metadata to
the vector payload, which is why `filters` answers `400` rather than being a
silent no-op.

**`docker compose --profile minimal up` has now been run from a clean clone**,
and the whole loop driven through it: init, layer, ingest, indexed, search,
grant, revoke. It found four more things, one of them a regression from the
sweep lease two commits earlier — `sweep_claimed_at` was set on claim and never
released, so after one retag a document was locked out of the loop for the full
`NACRE_INDEX_LEASE`. Fifteen minutes against a documented sixty-second SLA, with
the alerted gauge climbing the whole time and the worker log silent after one
success. Every test passed throughout.

The docs are still normative rather than descriptive, and in places still ahead
of the code. Where one disagrees with the tree, that is a bug in one of them —
say which.

**All 15 cases from docs/authz.md run** against real services, plus the truth
table, a property-based comparison against the reference implementation, and a
round trip that puts the worker and the search path against each other.
`acl-invariants` is a gate on what that document specifies — and only on that.
A leak nobody thought to write down is still unguarded, and adding a case to
`test-plan.ts` is how that changes.

**Test what you write by running it, not only by testing it.** Twelve of the
worst defects found so far were each invisible to a green suite and obvious
within a minute of starting the processes: the worker indexing nothing at all,
layers naming a vector that did not exist, MCP answering in a shape no client
can parse, a propagation gauge that could never fire, a retag loop that starved
garbage collection entirely, a document stranded in `parsing` with no error
anywhere, `migrate()` throwing ENOENT from the built package, search returning
no text at all — because every test asserted on the payload, which *was* the
response — a duplicate service account name answering 500, the worker erasing a
document's title, which was visible only in a screenshot, a service account key
sitting in the idempotency cache in plaintext for 24 hours, found with
`redis-cli GET`, re-indexing leaving every previous point in the index, found
by noticing that a search for five results returned four, and two whole
subsystems that only ever worked because development connects to Postgres as a
superuser — service account keys answered 500 and the worker indexed nothing
the moment an operator followed the rule in `docs/config.md` about not doing
that.

Two more, found by reading rather than by running, and both invisible to a green
suite for the same reason: they are about *scale*, and the suite runs one of
everything. Both background sweeps selected the same rows on every replica, so
scaling the worker out — the documented response to a climbing propagation alert
— did nothing at all. And a `/metrics` scrape cost three queries per tenant with
no cache and no authentication, so a scrape loop was a denial of service that
looked like monitoring.

## Conventions

- **English everywhere** — code, comments, commits, branches, issues, PRs, docs.
- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`.
- Squash merge, linear history. One PR, one topic.
- **CLA, not a DCO.** [CLA.md](./CLA.md), signed by a pull request adding you to
  `.github/cla/signatures.json`. Enforced by the `cla` job, which compares commit
  author and committer emails against that list — read from the *base* branch, so
  a pull request cannot sign itself. List every address you commit from.
- Changes under `packages/core/authz` need **two maintainer approvals** and
  tests.
- Don't optimize `authz/reference.ts` when it exists. Its whole value is being
  obviously correct so the property test can catch drift in the fast path.

## Skills

`.claude/skills/` carries the checklists for work that touches the model:
`authz-change`, `mcp-tool`, `api-endpoint`, `db-migration`, `audit-event`,
`config-var`, `open-core-boundary`. They load themselves when relevant.
