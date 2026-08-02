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

A layer can be moved onto a different embedding model. Qdrant cannot add a named
vector to a live collection — checked by asking it, not by reading — so the
collection is not altered but replaced: a new one carrying both slots, every
point copied across unchanged with **no embeddings computed**, the
`organizations.vector_collection` pointer switched in one statement, and then
re-embedding one layer at a time into the new slot. The cheap half is org-wide
and happens once; the expensive half is per layer and incremental.

Search stays available throughout and stays one query. It carries one dense
branch per model among the layers in scope, each confined to those layers and
each embedded by that layer's own provider — the confinement is a `must`
appended to the permission filter, never a filter of its own.

That work found four things it did not set out to find, all the same root cause:
`organizations.vector_collection` was written once at init and read by nothing,
so every read and write derived `org_${slug}` instead; the search path took its
named vector and its query model from `NACRE_EMBEDDING_MODEL` for every layer in
every organization; the worker's ingest path did the same; and
`finishReindexIfDone` moved `vector_name` without `provider_id`. Together they
meant **an organization could never run two embedding models**, which the schema
has offered since 0001 — `embedding_providers.org_id`, documented "NULL = global
default". Adding a second provider and creating a layer on it accepted documents
and failed every one of them in the worker, forever, while the API answered
`queued`.

Search filters on document metadata. `metadata` was declared on ingest with no
caveat and dropped by the handler, and the worker then overwrote the column with
the parser's derived facts — the title bug again, with a tag disappearing rather
than a name. It is stored now, written into the payload of every point under a
reserved `meta` namespace, and read back by `filters`.

Those fields are indexed now, which `PAYLOAD_INDEXES` structurally could not do
— it lists the permission filter's fields, and a caller's keys are not knowable
in advance. They are built where the keys first appear, on ingest and on the
`PATCH`, and carried across when a reindex replaces the collection, which is
where they would otherwise have been silently dropped. Bounded at 64 per
collection and allowed to fail: a filter on an unindexed field returns exactly
the points an indexed one would, so this is latency and never an answer.

The namespace is the security property and it is structural, not a check: a
caller key can never collide with `org_id`, `deleted` or `acl_tags`, because
`meta.deleted` is a different field. And a filter is a **narrowing**, the same
mechanism `layers` uses — every entry becomes a `must` beside the permission
constraint, so there is still no path by which a caller-assembled filter reaches
the index. No negation, no ranges, no disjunction across keys: each is a way to
widen if composed wrongly, and none is needed to answer "only documents from
this source".

`PATCH /v1/documents/{id}` changes a document's tags without re-embedding it —
one `setPayload` over its points, the same call the ACL retag sweep makes. Going
through ingest instead re-parses and re-embeds, because that is what ingest
does; the difference is what a bulk retagging pass costs. It answers `204` and
never the document, because rule 6 means a caller may hold `write` without
`read`.

`GET`/`POST /v1/workspaces` and `PATCH /v1/layers/{id}` close the last two paths
the contract described and the server answered `404` for. The workspace listing
is the one that mattered: creating a layer takes a `workspace_id` and the only
way to have one was the line `init` printed, so a second administrator had no
route that did not go through the database. Its first implementation reproduced
exactly the deadlock it was added to break — `resolve` flattens a grant set to
the layers it reaches, so an administrator of an *empty* workspace resolves to
`none`, and an early return on that left them seeing nothing. Found by running
it.

`/.well-known/oauth-protected-resource` is served, by both the API and the MCP
transport, from one document built once. Every `401` from MCP had named that
path in `WWW-Authenticate` since the transport existed and nothing served it.
`authorization_servers` is absent unless a deployment names one and is
deliberately never pointed at Nacre: this is a resource server, and a client
sent here for a token endpoint would find nothing.

The collection a reindex replaces is reclaimed. Every migration used to leave a
full copy of the organization's vectors behind forever, and the runbook's manual
cleanup was the wrong rule as well as a manual one: "every collection Qdrant has
that nothing points at" describes the *target* of a copy still running, so
running it mid-migration deleted the migration. Candidates come from a table
written by the same transaction that moves the pointer, and the pointer is
checked again before each delete — so a collection rolled back onto is dropped
from the list rather than from disk. `NACRE_COLLECTION_RETENTION_DAYS` is the
rollback window, not a tidiness delay: moving the pointer back is the cheap
rollback and it works only while the old collection exists.

Not built: OAuth dynamic client registration and CIMD, multipart upload on
ingest, the recall check against a reference query set on a reindex, and
dropping the old *named vector* from a collection after a rollback window —
which is a different job from dropping the collection, and the cheaper half is
the one still missing.

**Object storage is wired.** `NACRE_S3_*` spent its whole life in
`docs/config.md` and in the `full` Compose profile while `loadConfig` did not
mention it, so a wrong endpoint or a missing credential was silent and MinIO sat
there talking to nobody. Configured, ingest writes the bytes to the bucket
*before* it writes the row — the reverse strands a document the worker fails on
forever while the API answered `queued` — `source_type` becomes `s3`, the worker
fetches from the bucket, and the collector removes the object when it purges the
vectors. Unconfigured is still supported and is the default: bytes stay in
`documents.source_ref`.

The client is SigV4 by hand rather than `@aws-sdk/client-s3`: four operations
against a container whose job is reading other people's documents, and every one
of them verified against a real MinIO, because a signing bug is a `403` that
names none of its six inputs. The configuration is validated as a group — all
four of endpoint, bucket, access key and secret key, or none — since an endpoint
with no credential parses and fails later. Writing that check is what turned up
`NACRE_S3_ENDPOINT=minio:9000` being accepted by `new URL`, as the scheme
`minio:` with an empty host.

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

The effective-principals cache is wired in. `NACRE_ACL_CACHE_TTL` had been
validated at startup and read by nothing, and the cache itself was written *and
tested* — seven cases in `propagation.test.ts` exercising a function no request
path called, so every request recomputed the transitive group closure and the
suite proved a code path that did not run. A cache tested and never called is
the same shape as a variable accepted and never read.

Caching a permission input is safe here for a structural reason rather than a
temporal one: the key carries `organizations.groups_version`, which triggers bump
on every change to `groups`, `group_members` and `grants`. A revoked grant is not
served stale — the next request composes a different key and the old entry is
never asked for again. Verified against a running database (create a group, add
a member, remove one, grant, revoke, delete the group: the version moved for
every one) and pinned by two tests that ask the *adapter* rather than the module.
The TTL bounds memory, which is why the refusal of a TTL above the propagation
SLA now says so instead of claiming it delays a revocation.

`NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` are honoured. Both were validated at
startup and read by nothing, so every process wrote JSON at one level whatever
the deployment asked for — and they are among the first variables anyone sets.
Configuration errors and the output of `init` and `migrate` deliberately stay
outside it: the first happens before there is a level to consult, and the second
is program output a person ran the command to read.

The one that would have been a bug: the MCP STDIO transport now points the
logger at stderr, because the default writer sends `info` to stdout and stdout
there carries JSON-RPC frames. A log line in the middle of the stream is a frame
the client cannot parse — checked by running it and confirming stdout stayed at
zero bytes. `installGuards` also stopped reporting a clean shutdown as an error,
which is what turned every deploy into a line a dashboard counts.

A search leaves a `query_hash` in the journal, and the query itself where
`NACRE_AUDIT_QUERY_TEXT` says so. `docs/audit.md` promised both — "a query hash
is stored instead", and the flag for deployments that decide otherwise — and the
event carried a count. So the hash the document calls "enough to investigate an
incident" did not exist, and the flag was a third variable read by nothing. The
hash is unconditional and always of the whole query even when the stored text is
truncated, or two records of one long query would not match each other, which is
the comparison an investigation makes. `latency_ms` went in beside it: the
number was already measured for the histogram and never reached the journal.

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
