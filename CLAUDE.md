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
packages/cli         the `nacre` command, over the SDK
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
on the next search while its vectors are still in the index — the permitted set
is computed per request, so there is nothing to wait for.

Deleting a document takes it out of results immediately — the points are
flagged before the row is written, in that order, because the reverse fails
unrecoverably. A collector reclaims them afterwards and nothing depends on when
it runs. A worker that dies mid-document has its claim reclaimed by a lease
rather than leaving the document stuck in `parsing` forever.

`packages/sdk` is the TypeScript client and `packages/admin` is the community
admin UI; both are written, and the admin UI has been driven in a browser
against the running API.

**There is a `nacre` command now**, and the reason it exists is that
`docs/quickstart.md`'s path from a clean clone to a first search was four `curl`
invocations with hand-assembled JSON, a workspace id copied out of `init`'s
output and a token good for an hour. The documented metric — under thirty
minutes to a first search — was never measurable because nobody could plausibly
be asked to do it twice. It is a thin wrapper over the SDK, so it holds no
second idea of what the API is: `login`, `whoami`, `layers`, `layers create`,
`grant`, `ingest` (with `--watch`), `search` and `eval`.

Three defects came out of running it, none of which any suite could see. The
password prompt **printed the password** — readline with `terminal: true` echoes
what it reads, and the private `_writeToOutput` interception did not hold on a
pipe, which is the path a script and a demo both take. An ingest where **every
document failed exited 0**, so a nightly pass checking the exit code would have
reported a healthy corpus with an empty index. And `search` returned an **empty
document id** through the SDK and therefore through the admin UI: the client
read `hit.document_id` where the contract and the server say `doc_id`, and
`?? ''` turned the miss into an empty string, so a result could not be turned
into `documents.get(id)`. That test's fixture also said `document_id` — it
proved the mapper against a response no server sends, which is the shape a
fixture written to match the code always has.

`nacre eval` scores a layer's reference queries from outside the worker —
recall@k, averaged per query, `--floor` to make it a gate. Writing it found that
**`external_id` was write-only**: ingest is idempotent on `(layer, external_id)`
and no response carried one, so a client could name a document and never ask
about it by that name again, and nothing outside the worker could score recall
at all. It is on `Document` now, in the contract, the handler and the SDK.

`--watch` never deletes, and that is not caution. A file disappearing is
indistinguishable from the first half of how every editor saves — write a
temporary file, rename it over the original — so removing a document on an
unlink event would delete documents on save, intermittently, depending on the
editor.

Adding the package is also what found `lint:config` naming three files. It read
`packages/core/config.ts` and two entry points, which was right until there was
a fourth package: `NACRE_API_URL` and `NACRE_TOKEN` were read by shipped code
and documented nowhere. The same defect as `NACRE_PARSER_ALLOW_PRIVATE_URLS`,
which that check missed because it knew only about TypeScript and the sidecar is
Python — and the same repair. It discovers its readers now, and went from three
files to fifty-nine variables.

The SDK reaches **every** operation in `docs/openapi.yaml` now, and
`packages/sdk/src/__tests__/coverage.test.ts` is what keeps that true — it had
fallen nine operations behind with nothing comparing the two, which is the same
shape as a variable accepted and never read. Adding a path to the contract and
not to the client fails, and the fix is a method or a written reason; the two
`/.well-known` documents are the written reasons.

It asks the other direction now, and that is what found
`/v1/embedding-providers`: served by the API, reachable from the SDK, and
absent from `docs/openapi.yaml`, which is normative here. Every assertion in
that file started from the contract, so a client reaching *more* than the
contract describes was invisible to all of them — the same defect as an SDK
falling behind, arriving from the other side. The `EmbeddingProvider` schema
was already in the document, referenced by no operation, so the route to a
second embedding model was the one thing a self-hoster could not find by
reading the contract. Which is the reader this product has.

The admin UI signs in with an email and a password. It said "there is no login
yet" in three places and asked an operator to paste a JWT that expires in an
hour — months after sign-in landed. A session renews itself through the SDK's
`fetch` seam rather than a wrapper around fourteen call sites, so no view knows
it can be renewed, and signing out revokes the refresh token instead of only
forgetting it. Pasting a token is still offered, because signing in as a service
account is how an administrator checks what an agent can actually see.

Moving a layer onto a different model is on that screen now too, with the
reference query set beside it — until then the recall gate could only be set up
by hand against the API. Two things there were found by looking at a screenshot
rather than by a test. The progress bar rendered **full for every migration**,
because the page's CSP is `style-src 'self'` and the browser dropped the inline
`style="width:…"`; it is a `<progress>` now, which puts the width in the
stylesheet and brings its own ARIA. And "No recall gate" sat directly above a
saved reference query, because `check: null` means both "no set" and "not scored
yet" and only the second was true — the panel already loads the set, so it can
tell them apart and now does.

**The console has been rendered at 1440 and at 390**, every view and every
dialog, and four defects came out of it that no suite could see — three of them
only on a phone, which is the width nobody develops at.

`.row` aligns `flex-end`, which aligns **margin** boxes: `.field` carried
`margin-bottom` and a bare button in the same row carried none, so every row
mixing the two hung the button exactly that far below the control beside it.
The action column wrapped, because five of the six action cells used `.right`
and the sixth used `.row-end`, and only `.row-end` said `nowrap` — three
actions on one row stacked onto three lines and took a People row from 58px to
153px. The `copy` control beside every id was the word `copy` at 39×19, under
half a touch target, and it was `opacity: 0` until its row was hovered — so on
a phone, which reports `hover: none`, it was invisible with no gesture that
revealed it, and `shortId` truncates the id it copies. Every id on those
screens was unreachable on the device half of them are read on.

`lint:admin-layout` is the repair rather than the four edits: a flex container
aligned on an edge has children with no margin on that edge, and a control
revealed on hover is behind `@media (hover: hover)`.

Its first version **passed with the defect restored**, and that is the part
worth keeping. It looked for a rule whose selector carried the margin under the
container — `.row > .field { margin-bottom: 12px }`, the spelling the fix had
just removed — while the margin actually lives on a bare `.field` and only the
cancellation kept it off the row. Deleting one line brought the crooked buttons
back and the check stayed green: it had learned the shape of the edit rather
than the property. The cancellation is `> *` now instead of naming a class,
which closes the same hole one step later, and the check requires that reset on
every edge-aligned container. Six breaks, including the two that defeated the
first version.

Two things that were not layout came out of the same pass. `lint:tokens` was
named in `admin.css`'s own header — "Nothing here invents a hex value, and
`lint:tokens` fails the build if one appears" — and **did not exist**, in
`package.json`, in a workflow or in `scripts/`. The property held, which is
what made it invisible; a claim that a check exists is worse than a comment
asking for one, because a reader stops looking. It exists now.

And `scripts/screenshots.mjs` could photograph the wrong screen without saying
so. It had no `GET /v1/me` fixture, so `me()` got the 500 an unstubbed call
gets, the console left the caller a member, hid every admin-only route and fell
back to the first allowed view — a run asking for `#/grants` writes a picture
of Search over `grants.png` and carries on. It had recorded the missing fixture
as a failure, and then died on a control that was not there before printing it,
with the images already on disk.

**The committed images were never wrong**, and the first version of this
paragraph said they were. That claim came from running `md5sum` on the working
tree *after* a failed run of this script had already overwritten two of them —
measuring damage this session caused and attributing it to the repository,
without checking `git show origin/main:` first. The three hashes differ there
and always did. A defect blamed on the tree is a claim about the tree, and the
place to check one is the tree.

The guard is that a shot asserts it is a picture of the screen it is named
after, read from the **rendered nav** and not from `location.hash`: the router
deliberately leaves the address alone so a member's bookmark survives, which
makes the hash a check that can never fail. It throws rather than collecting,
because by the time the summary prints the wrong picture is on disk.

**And the redaction that change added went on one of the two surfaces.**
`/v1/jobs/{id}` and `ingest_status` put the stored failure through
`withoutHosts`; `GET /v1/documents/{id}` handed back `documents.error` verbatim,
and so did `get_document`, an MCP tool resolving `read` — which is reached by a
delegation, so its caller can be a third party an operator connected. That is
the exact caller `classifyIngestFailure`'s own header names, receiving
`http://embedder.internal:8080/embeddings` through the other door. The most
repeated defect here, committed by the change that wrote the cure. The test
that pinned it asserted the raw string, which is what a test written beside the
code always does. `lint:stored-error` asks every surface that returns that
column, and refuses if it finds none — a check with nothing to hold must not
report green.

**And the redaction itself held for the example and not for the deployment.**
The rule needed a dot and a two-letter tail, so it covered `embedder.internal`
— written in that module's own header — and none of the service names this
product ships with, every one of which is a single label: `embedder`, `qdrant`,
`parser`. The way one survived is the lesson: the URL *was* removed, and undici
then appended its cause verbatim, leaving `getaddrinfo ENOTFOUND embedder` at
the end of an otherwise clean sentence. IPv6 was untouched entirely. A host is
recognised by **where it can be** now — after a scheme, in brackets, as
`name:port`, after a DNS or socket code, after the phrases this repository
writes itself — because those are positions a machine puts one in, and a
token's shape is shared with everything a person wrote. Eleven strings this
stack actually produces are pinned as tests, and the six that must survive
beside them.

Over-redaction stays in one place and is written down rather than fixed:
`contract.pdf` and `example.com` are the same string with a different tail, a
list of extensions goes stale, and of the two ways to be wrong only one leaks.

**And the two transports answered `tools/list` with different objects.**
`permission` is this repository's own bookkeeping — MCP's `Tool` has no such
member — and Streamable HTTP stripped it while STDIO returned it, for the whole
life of both. `transport-parity.test.ts` exists against exactly that and was
green, because its case compared the tool *names*: a parity case whose
projection is narrow enough is a parity case that cannot fail, which is the
same defect as reading `location.hash` from a router that never rewrites it.
One function both transports call, and the case compares the keys.

Rate limiting, `Idempotency-Key` and cursor pagination are in, which is also
what Redis is finally for — it had been required configuration, and in every
Compose profile with the API waiting on its healthcheck, since before anything
connected to it. Both fail **open**, deliberately and against the grain of
invariant 3: neither is an authorization control, and failing closed would turn
a cache restart into an outage.

**Search is hybrid, which it had only ever said it was.** `docs/architecture.md`
described "dense vector plus sparse BM25, fused with Reciprocal Rank Fusion"
from before there was a server, `collectionConfig` created every collection with
a `bm25` sparse slot, `buildHybridQuery` accepted a `SparseBranch` and the ACL
prefilter suite passed one through — and **nothing ever produced a sparse
vector**. Not the worker on ingest, not the search path. The slot was empty on
every point of every collection and every query was dense-only, for the entire
life of the project.

Nothing could have failed. A slot with no writer is not an error at ingest; a
branch never built is not an error at query time; and a test that hands the
builder a sparse branch proves the builder, not that anybody calls it. Every
piece was individually correct, which is why this is the same shape as
`NACRE_ACL_CACHE_TTL` and the propagation gauge rather than a new one —
declared, accepted, read by nothing.

`packages/core/text/bm25.ts` is the missing producer and it is one module
because the two sides have to agree on every token: a term hashing one way at
ingest and another at query time is a branch that never matches, silently. The
document side writes term frequency only and IDF is Qdrant's, from
`modifier: 'idf'` on the slot — an IDF stored at ingest freezes each chunk's
idea of how rare a word is at the moment it was written. No stopword list,
because IDF already scores a ubiquitous term near zero without one to maintain
per language; no stemmer, because it needs language detection and works against
what this branch is for, which is the class of term dense retrieval handles
worst: error codes, contract numbers, `NACRE_*` variables, surnames. An
identifier is indexed whole and in parts, so `s3` finds a chunk that only writes
`NACRE_S3_ENDPOINT`.

One lexical branch however many models the organization runs, and no
`onlyLayers` on it: BM25 has no model, so confining it would drop points the
caller may see for no reason. `lint:sparse` is the repair rather than the two
edits — every slot the collection declares has to have a producer on each side,
which is the question none of the individually-correct pieces was asking.

Driven against a real Qdrant, because the parts that were left were the
database's: `hybrid-live.test.ts` asserts the slot and the modifier, the point
carrying both vectors, the identifier ranking first, the lexical branch not
reaching an excluded layer, Cyrillic, and a pre-upgrade point with no sparse
data failing to match rather than erroring the query for everybody else.

The IDF case is the one worth keeping, because it failed first and the failure
was the test's. It asserted that a rare term outscores a common one over a
corpus where both had a document frequency of two, so what it measured was
length normalisation — 1.4008 against 1.4084 — and it would have been just as
green if the modifier did nothing. A claim about IDF needs a control: the same
points in a second collection whose slot has no modifier, and a corpus where
term frequency alone favours the *common* term. Raw, `access` wins; with the
modifier, `sqlstate` does.

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
caller key can never collide with `org_id`, `deleted` or `doc_id`, because
`meta.deleted` is a different field. And a filter is a **narrowing**, the same
mechanism `layers` uses — every entry becomes a `must` beside the permission
constraint, so there is still no path by which a caller-assembled filter reaches
the index. No negation, no ranges, no disjunction across keys: each is a way to
widen if composed wrongly, and none is needed to answer "only documents from
this source".

`PATCH /v1/documents/{id}` changes a document's tags without re-embedding it —
one `setPayload` over its points. Going through ingest instead re-parses and
re-embeds, because that is what ingest does; the difference is what a bulk
retagging pass costs. It answers `204` and
never the document, because rule 6 means a caller may hold `write` without
`read`.

**`/v1/ready` refuses while the schema is behind the image.** It reported that
Postgres, Qdrant, Redis and the bucket answer and said nothing about whether the
schema matches the code — so a pod started against a database the migrator had
not reached reported ready and then failed every request. Under an orchestrator
that is worse than an error: the rollout believes the answer and carries on
replacing working pods with broken ones. Found by writing `docs/upgrading.md`,
which is the second time an operator document has turned up a defect the tests
could not see — the first was the Helm chart's provisioning and the
superuser-only migrator.

A database that is **ahead** stays ready, which is the middle of a rolling
upgrade: the migrator has run for the newer build and the old replica has to
keep serving. Reporting it behind would take every old pod out of rotation at
the moment the schema moved.

Migration 0022 is what makes the check possible, and finding that out is the
part worth keeping. `schema_migrations` is created by the migrator and therefore
owned by the owning role, and `nacre_app` held **no privilege on it at all** —
so a readiness probe written without the grant would have reported every
correctly-split deployment as not ready, and worked fine in development, where
the connection is a superuser. That is the same defect as the two subsystems
found this way before, arriving from the other side. Checked against a real
PostgreSQL before a line of the check was written.

`SELECT` only: a process that could write the ledger could tell the next
migrator a migration had already run. And deliberately not granted to
`nacre_worker` — the worker has the same question and no surface to answer it
on, so the grant would be a privilege nothing reads, which is the shape this
repository keeps removing.

**A team can be onboarded.** `grants.principal_type` has admitted `user`,
`group` and `service_account` since migration 0001, and only the third could be
created through the API — so the documented way to give a colleague access was
to insert into `users` by hand, and the documented way to give a team access was
to insert into `groups` and `group_members` by hand. The same shape of hole the
workspace listing had: the model offers something the product gives no route to,
and the route people find instead is `psql`.

`/v1/users` and `/v1/groups` close it, at `org_admin` — not "admin on a scope",
because a principal belongs to the organization rather than to a workspace
inside it, and someone holding `admin` on one layer must not be able to mint one
any more than they can mint a key. Migration 0021 is the only schema change and
it is small: `groups` and `group_members` had no `created_at`, and every paged
collection here seeks on `(created_at, id)`, so neither could be listed by the
shared machinery at all.

A password is **generated and never accepted**, on `init`'s argument — an
argument ends up in a shell history — plus one more: a password an
administrator chose is one they know. `POST /v1/users/{id}/password` exists
because without it an administrator whose colleague lost theirs had no route
that did not go through the database, which is the gap this whole surface is
about. `platform_admin` is refused rather than downgraded: it spans tenants in
the multi-tenancy module, so minting one from an endpoint scoped to a single
organization would be an escalation out of it.

A user is **disabled** and a group is **deleted**, and the asymmetry is
structural rather than stylistic. The audit log names a user id and
`grants.created_by` references `users(id)` with no cascade, so a deleted
administrator is a foreign key violation and a deleted anyone is an
unresolvable reference in the one record that must not have them. Nothing
points at a group that way — but nothing removes its *grants* either, since
`principal_id` addresses three tables and is a bare uuid, so deleting one takes
them in the same transaction.

`DELETE` and `PATCH {"disabled": true}` go through one call, which is what makes
the last-administrator guard hold: an organization with no active `org_admin`
has no route back, because every endpoint that could appoint one is behind the
role that was just given up. Two entry points with one check between them is how
the guarded one gets walked around, and the count runs in the same transaction
as the update it guards, behind a `FOR UPDATE` — two administrators demoting
each other concurrently would otherwise both read a count of two.

The refusal that surfaces as `404` for a caller who is not an `org_admin`
writes a `deny` event. It is the easiest one to miss, because the code path
producing it is an early return that reads like routing.

**That surface guarded the role it set and not the role it replaced.** `POST
/v1/users` refuses to issue `platform_admin`, correctly and for a stated reason:
`/v1/users` is scoped to one organization, the role spans all of them, so
minting one there is an escalation out of the scope doing the minting. The
argument holds in the other direction with the same force and nothing enforced
it — an `org_admin` could take a platform administrator whose account happened
to live in their organization and demote them, disable them, delete them, or
**reset their password**. The last is not a demotion: the endpoint returns the
plaintext, so it is a takeover of the account that administers the installation,
performed by somebody who administers one tenant.

Four spellings of "act on this person", each of which had to remember, with
nothing that knew there were four — the shape this file already names. So the
repair is one helper every write to somebody else's row goes through, reading
the role `FOR UPDATE` in the same transaction, and
`check-platform-admin-target.mjs` refusing a write that does not. It reads the
guard's *own body* rather than the file, because the first version passed with
the comparison removed: `principals.ts` says `'platform_admin'` in a type and in
half a dozen sentences of prose, so a whole-file search was satisfied by the
documentation of the rule instead of the rule. The one exemption — the
scrypt-parameter rehash on the sign-in path, where the principal is its own
target — is written down with its reason and fails the check if the statement it
names changes.

`403`, in one wording, on all four. Not `404`: `GET /v1/users` lists that person
with their role, so the caller is looking straight at the row and invariant 4 is
about invisibility. Not `409` either — the last-administrator refusal beside it
is about the organization's state and goes away once there is a second
administrator, and this one never does. Nobody reaching those handlers is a
platform administrator themselves, since `administers(auth)` is `org_admin` and
nothing else, so the refusal is about what the endpoint is scoped to and has no
branch on the caller. What issues and revokes the role instead is a command
holding the database credentials, outside this surface entirely.

Found by writing that command, which is the fourth time an operator-facing piece
of work has turned up a defect no suite could see.

**A layer can be deleted, and it takes its documents with it.** Everything else
on the layers screen edits one — there was no way to remove a layer at all, so a
slug typed wrong was permanent and the only correction was a second layer beside
it. `DELETE /v1/layers/{id}` needs `admin` on the *workspace*, the same check
renaming makes and never `write`: an ingest-only service account is exactly the
principal that holds `write` into a layer and must not be able to remove it.

The index goes first and it is **one** call — a `setPayload` over a filter on
`layer_id`, so the cost does not grow with the number of documents — then the
document rows, then the layer, then the grants naming it. That order is the
document delete's order for the same reason: the reverse leaves a window where
the rows say deleted and the index still answers, and invariant 5 is about what
a query returns rather than about what is still on disk. The cascade underneath
is the collector's, on its own clock, and nothing a caller sees waits for it.

Removing the grants is the part that is not about permission. They would resolve
to nothing anyway, so no answer changes — what it avoids is `GET /v1/grants`
listing rows pointing at a scope no reader can look up.

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
`authorization_servers` names this installation's **API** by default, or
whatever `NACRE_OAUTH_AUTHORIZATION_SERVER` names. Never the MCP transport,
which verifies tokens and issues none. It was absent by default until the API
grew the consent flow, on the argument that a client sent to a token endpoint
that did not exist would find nothing — the argument was right and the endpoint
is what changed.

**An MCP client connects over the whole chain now, and that was checked by
running it** with the real SDK against a running API and a running transport:
`401` → the RFC 9728 document → RFC 8414 discovery → RFC 7591 registration →
`/oauth/authorize` → the consent screen in a browser → `/oauth/token` →
`initialize` → `tools/list`. Two defects only that walk could find, both of them
green in every suite.

`initialize` counter-offered `2026-07-28` — the newest revision this server
speaks — to any client proposing something not on its list, and `2025-11-25` was
not on that list. That is the newest revision the MCP SDK knows, so it is what
every shipping client proposes: each was handed a revision absent from its own
`SUPPORTED_PROTOCOL_VERSIONS` and failed with `Server's protocol version is not
supported`. The specification's compatibility matrix has the rule the code was
missing — a client arriving on `initialize` is *legacy*, and legacy clients have
no fall-forward mechanism, so a counter-offer must be a revision that generation
knows. The list gained `2025-11-25` and the counter-offer is now always the
newest **legacy** revision. STDIO had the same defect and worse: it answered
unconditionally, never reading the proposal. `server/discover`, a MUST in this
revision and the modern era's opening move, is served on both.

And `/oauth/authorize` sent the browser to a page with no way to approve
anything. `NACRE_OAUTH_CONSENT_URL` ends in `#/consent` — the admin UI is
hash-routed, so that fragment *is* the route — and the handler assigned the
fragment instead of appending to it, so the router saw no route and rendered the
default view with the whole request sitting in the URL. The consent screen's own
parser reads `#/consent?…`. Two halves written to different assumptions, with
nothing putting them side by side.

The JSON-RPC envelope also escaped its endpoint: every path the transport does
not route answered one, so a client falling back to `POST /register` on the MCP
origin got `{"jsonrpc":…,"error":{"code":-32601}}`, tried to read it as an RFC
6749 error and reported `Invalid OAuth error response: ZodError`. The envelope
belongs to `/mcp`; everything else answers `{ error, error_description }`.

**An application can act as the person who approved it.** OAuth exists so a
*person* can let an application act for them, and the consent flow could only
offer a service account — both listing and minting one are `org_admin`, so a
member who followed an MCP client's link reached an empty picker and a `404` on
Approve. Found by looking at a screenshot, which is the third defect that
arrived that way.

A **delegation** is deliberately not a fourth principal type. Nothing is granted
to one, so there is no second grant set and no intersection to compute, and
therefore no new way for the resolver to be wrong: `authority(delegation) =
resolve(delegating user)`, unchanged. The token carries the person's id and the
connection's, never a permitted set — a token carrying one would keep answering
with the access its holder had at consent, and every revocation would wait for
it to expire.

`disabled` gains a second meaning on this path and only on this path. It has
meant "cannot sign in" and not "cannot act", which was safe while every
authority either passed through sign-in or carried its own `revoked_at`; a
delegation is authority derived from a person, held by a third party, and
renewed without them present. So every delegated request makes one indexed read
before `resolve` — and it is deliberately **not** cached, because the
effective-principals cache keys on `groups_version`, which does not move on
`users`. Suspended, not revoked: the grant survives, and renewal refuses without
*spending* the refresh token, so re-enabling is a restoration rather than a
reconnection.

A person restricts a delegation in two dimensions, and the second is the one
they ask for first: a **permission ceiling**, so connecting a search client does
not hand it the ability to delete a document. A set rather than a level, because
rule 6 makes permissions unordered — `{write}` alone is an ingest client that
cannot read back what it wrote, and a ladder would have lost that case silently.

It is applied **before rule 3** in the resolver, which is the whole of T25
rather than a matter of style: an `org_admin` reaches everything by role and by
no grant at all, so a ceiling consulted after that line does not bound the one
principal it exists for. Checked by moving it after and watching a read-only
delegation of an administrator answer `all` on write.

**The ceiling is per layer now**, because the two questions the screen asked
were independent and what they could express together was their *product*. A
person does not mean a product: they mean "read the handbook, write to scratch",
and as a rectangle that costs `write` on the handbook.

The resolver did not change, and that is the design rather than luck.
`oauth_consents.permissions` stays the gate on everything the token may exercise
at all, applied before rule 3; a per-layer set is a **narrowing**, the same
mechanism `layers` already was. So the layer filter became a function of the
permission — `layers(p) = { L : p ∈ ceiling(L) }` — at the `must` inside the
index traversal and at each of the four paths where a layer id and a document
meet. `withinDelegation` takes the permission as a required argument, which
makes every existing call site a compile error until it says which one it means.

A per-layer set that the connection's ceiling excludes could never take effect,
so consent refuses it naming both sets rather than storing a control that does
nothing. And it never confers administration: `admin` inside one layer is not
authority over the organization holding it, so `administers` reads the
connection's ceiling and never a layer's.

`admin` is a ceiling value and is deliberately **not** on the consent screen.
The MCP surface has no administrative tool at all — its six tools resolve with
`read` or `write` — so the box would do nothing where the person is looking and
a great deal through REST, where they are not, which is worse than a control
that does nothing. It stays reachable through the API because it is not an
escalation: a ceiling cannot exceed what its person holds, so only an
`org_admin` can obtain one, and that is weaker than the service account they
could mint instead — a delegation stops when they are disabled and a key does
not. The contract says so, so the screen and the API do not quietly disagree.

And it bounds administration separately, because minting a user or a service
account is gated on the *role* rather than on a scope. Not by rewriting the role
to `member` — that would stop an `org_admin` reading the organization they came
to delegate. Role and ceiling stay two facts, `administers(auth)` asks both, and
`check-admin-gate.mjs` refuses the raw comparison it replaced so the tenth
handler cannot be written the old way. Writing it found two sites and one
resolve input that I had not counted.

The layer narrowing is a `must` on `layer_id` inside the index traversal, so `top_k` still returns k permitted results — and it is
enforced again on every path where a layer id and a document meet, because
fetching by id is exactly how a narrowing gets walked around otherwise.

`postgresVerification` is the answer to the wiring rather than a third copy of
it. Three processes verify tokens and each assembled `VerifyOptions` by hand; a
transport missing `delegations` does not crash, it refuses every delegated token
with the `401` a forged one gets, so the symptom would have been "this client
cannot connect", days later, with nothing in a log. The failure mode is why the
ports arrive as one object.

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

The superseded *vector slot* is reclaimed too, on the same window as the
collection. A completed reindex leaves every point in the layer carrying the
vector it used to be searched by — a float per dimension per point, in memory by
default — and nothing removed it. Qdrant cannot drop a named vector from a
collection's schema, which is the constraint the whole migration turns on, but
it can drop the *data* for one from a chosen set of points, which is all that
costs anything. Verified by asking it: the slot stays declared, a query on the
live slot is unaffected, and a point missing the queried vector does not error —
it simply does not match, which is why the selection refuses the slot the layer
is searching now.

**Client registration is not ours and no longer says it is.** `docs/mcp.md`
carried "the MCP server is a resource server, not an authorization server" and,
eleven lines later, "client registration is CIMD, DCR is kept as a legacy branch
behind a flag" — and CIMD and DCR are both transactions between a client and an
*authorization server*. `NACRE_OAUTH_CIMD_ENABLED` and `NACRE_OAUTH_DCR_ENABLED`
were removed rather than moved further down the "not built yet" list, which is a
different statement: a variable for a role the product has declined tells an
operator it has a knob it will never have, and they set it and believe
something. The whole OAuth surface a resource server has — the RFC 9728 document
and local validation of an audience-bound token — is built.

A reindex is gated on recall now, which was step 4 of the migration sequence in
`docs/architecture.md` and had been listed as not built since before there was a
reindex. Every other step checks that a write happened; this is the only one
that asks whether the new model can still answer — and a migration onto a
misconfigured provider succeeds at every mechanical step, so the wrong model
name behind the right endpoint moves `vector_name` and collapses retrieval with
no error anywhere.

Recall@10 against documents the deployment picked, averaged per reference query.
**Not agreement with the old model**, which would have needed nothing from
anyone and would have been the wrong measurement: a better model disagrees with
the worse one it replaces, so a gate on agreement blocks the migrations worth
making and passes a new model that reproduces the old one's mistakes. The set
lives in `reference_queries` and is written whole through
`PUT /v1/layers/{id}/reference-queries`; a layer without one has no gate, which
is the arrangement rather than an omission.

The gate is a predicate inside the switch statement, not a check in front of it
— the same reason the completeness predicate is there, so a reference set
written while the score was being computed blocks the switch rather than being
outrun by it. A stale set **fails without being scored**, because counting a
document that is not there as a miss would report a bad reference set as a bad
model. An unreachable embedder writes no verdict and is retried, since it says
nothing about recall either way.

Its retrieval carries `org_id`, `layer_id` and `deleted = false` and no ACL
filter, which anywhere else here would be the leak every other rule exists to
prevent. The reason it is allowed is structural rather than judged: there is no
principal, nothing calls it for a caller, and a ratio is what leaves it. The
port takes a layer and a vector and never a filter, so there is no argument
through which a caller-shaped query could reach the index.

Writing it turned up that `finishCopy` carried the same completeness predicate
three times, in three copies that had to agree and nothing made them.

A document can be uploaded as a form. `multipart/form-data` was in
`docs/openapi.yaml` from before there was a server and listed as not built for
just as long, and it is parsed here rather than by a library: this is
attacker-supplied bytes on the request path, which is the one place a
dependency's parser bugs become ours. The obligation that comes with that choice
is strictness — every bound is a refusal and not a truncation, because a
truncation is a silent disagreement between what was sent and what got stored.

The fields reduce to the same object a JSON body is, which is what keeps T2
holding: `rejectTenantOverride` scans the body before routing, so a multipart
request whose fields never became that body would be a second door into ingest
with the check on the other side of it — the shape of hole the rate limiter and
the metrics each had when MCP became a second surface. The file is deliberately
kept out of that object; a document body does not belong in something that gets
scanned, logged and put into error messages.

**A PDF can be uploaded, and any other binary format is still refused at the
edge.** That was an end-to-end change and the estimate was right about which
pieces it touched: the parser port grew a third form
(`{ content } | { url } | { bytes, contentType }`), the sidecar took its first
dependency ever — pure-Python `pypdf`, pinned, chosen for dependency surface
because it runs hostile input; **it is `pdf-inspector` since 0.5.8**, and the
reversal of "pure Python" is argued in `services/parser/requirements.txt` —
migration 0020 added `documents.content_type`,
and `content_hash` became `sha256` over the *uploaded bytes* for a binary
source while staying over the text for the others. Getting that last one wrong
would have been invisible: the API stores the hash when it accepts the file and
the worker recomputes it, so a worker hashing the extracted text instead would
make every identical re-upload miss the row and re-embed forever.

**Both signals must agree, and binary requires object storage.** The part must
declare `application/pdf` *and* the bytes must begin with `%PDF-`; either alone
is a refusal naming the other, because a declared type the bytes contradict is
the disagreement the multipart parser's strictness exists to refuse, and
sniffing alone would make the declared type decoration. A PDF's bytes have one
home — `documents.source_ref` is text and stays text — so a deployment without
`NACRE_S3_*` is refused on the request, naming the variables. The URL path
stays text-only on purpose: a response's declared type is an attacker's field.

The sidecar decoded with `errors="replace"` until the refusal went in, so it
replaced a real corruption rather than a hypothetical one — a 58-byte PDF
produced six replacement characters that would have been chunked, embedded,
stored as the document body and reported as `indexed`.

Proved by running it rather than only by testing it, which is the rule this
repository keeps re-learning: each of the four stages passed against a mock of
the next one, and mocks agree with whatever they were written to. The compose
e2e now generates a real one-page PDF, uploads it to the running stack, drives
it to `indexed`, and asserts the extracted phrase comes back out of a search —
with a constant-vector stub embedder, so relevance decides nothing and the
phrase is there only if it came out of the PDF.

**A generated password comes from one list, and the number is computed.** There
were two implementations of the same six-words-and-a-number generator, each with
its own word list — 60 words beside `init` and 28 beside the user endpoints — so
the product minted credentials at two strengths depending on which door they
came through. The weaker one, 35.3 bits, is the door an administrator onboards a
colleague through and resets a lost password with. The stronger one described
itself as "roughly 70 bits" and was 41.9.

One list now, the union of the two at 71 words, and `PASSWORD_ENTROPY_BITS` is
derived from it rather than written down — so a comment cannot go on claiming a
number the list stopped supporting. `lint:password` refuses a second word list
or a second generator, matched on content rather than on a variable name,
because the name is the part somebody writing one would change.

**Provisioning an organization is one function, in the core.** `initialize`
lived beside the `init` CLI, and the CLI is one caller rather than the
definition — a control plane minting tenants through an API is another, and two
implementations of "what a new organization is made of" would be two answers
about `organizations.vector_collection`, which every read and write on the
search path depends on.

Moving it found a defect that had been reachable since an organization could be
the second one. The installation default is a `NULL`-`org_id` provider created
once and reused, so `initialize` ignored the endpoint, model and dimensions it
was handed whenever one existed — and `main` then built the collection's named
vector out of **its own configuration**. A second organization created after
somebody changed `NACRE_DEFAULT_EMBEDDING_MODEL` therefore got a collection with
a slot no layer would ever write to: the worker derives the name from
`layers.provider_id`, so every document failed forever while the API answered
`queued`. That is the "layers naming a vector that did not exist" defect,
arriving from the other side.

`provisionOrganization` returns the provider it actually resolved and names the
slot after that. Reproduced first against a real PostgreSQL and a real Qdrant —
two organizations either side of a model change, reporting `MISMATCH` — then
re-run against the fix. It also picks the *newest* NULL-org provider, which is
what `admin-global`'s read already documented and what a bare `LIMIT 1` did not
do: there can be several, since changing the default removes only the
unreferenced old ones.

**Embeddings can come from a hosted API, and nothing about that is a default.**
A self-hoster on a laptop has no good embedder — bge-m3 under emulation blows
the worker's 120 s budget — and the alternative is somebody else's GPU. The
vendor differences live in a sidecar rather than in the worker: a `protocol`
column and a three-way branch would put a vendor credential's name in Postgres
and therefore in every dump, grow the least observable loop in the system by
three response shapes, and make the next vendor a migration.

Routing needs no schema at all. The request already carries `model`, and
`embedding_providers.model` is a string an operator already fills in, so that is
the routing key — two organizations on two vendors with nothing new. Point a
provider's `endpoint` at the adapter.

The rules it is held to are the whole of the feature. No default vendor, no
default endpoint, no route that nobody wrote; an unrouted model is refused by
name and never falls through to whichever vendor happens to be configured; with
no routes at all the container refuses to start. It is **absent from the
`airgapped` profile** rather than disabled in it, because a service that is not
there cannot connect to anything and a runtime check on a URL is a check that
has to be right — `lint:compose` asserts the absence, against the expected
service list as well as the rendered one, so moving it in fails even with the
list updated to match. And `docs/config.md` states the trade in those words:
**the text of your documents leaves your installation.**

Standard library only, which is the argument that keeps the parser at one
dependency: this process sees every document's text and there is one operation
here. LiteLLM in front of the existing endpoint stays the documented escape
hatch, since anything OpenAI-shaped already needs no code from us.

**The same sidecar reranks now, and the core still needs no code for it.**
`HttpReranker` speaks Text Embeddings Inference's `/rerank`, so a deployment
with no GPU had nowhere to point `NACRE_RERANKER_ENDPOINT`; the adapter answers
that shape rather than one of its own, which is the whole point — a second
protocol in the API would be a second thing to keep in step with the first.
Cloudflare, Cohere, Jina and Voyage, and the refusal for an unknown vendor says
that OpenAI, Anthropic and Google publish no reranking API rather than only
listing the four, because a bare list reads as "yours was forgotten".

One reranker per adapter rather than a routing table, and that asymmetry with
embeddings is forced rather than chosen: TEI's request carries a query and its
texts and **no model name**, so there is no routing key in it to dispatch on. A
batch too large is refused rather than split, which is the opposite of the
embeddings path and for a reason — a vendor that normalizes scores across the
documents it was given in one call would return two sets that cannot be
compared, and a silently wrong ordering is the failure this file exists against.

A route may also name the vendor's own spelling —
`bge-m3=cloudflare:@cf/baai/bge-m3` — and that is not sugar. A layer's named
vector is derived from the model, so moving an installation onto a vendor's copy
of identical weights would otherwise mean renaming the model, which is a
different slot and therefore a collection replaced and every point copied to
move vectors that did not need to move.

Adding all of it found that the vendor tables were copied into two documents
with nothing holding them: `lint:config` compares the `NACRE_EMBED_*` and
`NACRE_RERANK_*` literals against `docs/config.md` and does not read the
adapter's README at all. The sidecar's own suite holds both tables against
`VENDORS` and `RERANKERS` now — from Python, because a check in another language
would have to parse the file it is checking.

Writing it found that `lint:config` could see half the code it applied to. The
check knew about TypeScript readers and the sidecars are Python, so
`NACRE_PARSER_ALLOW_PRIVATE_URLS` — which decides whether an authenticated
tenant can point that service at the cloud metadata endpoint — had been read by
a shipped container and documented nowhere since the day it was added. It reads
the sidecars now, and the `parser` CI job became `sidecars`, discovering them
rather than naming one: a hard-coded name becomes a component with no tests
running at exactly the moment a second one exists.

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
released, so after one pass a document was locked out of the loop for the full
`NACRE_INDEX_LEASE`. Fifteen minutes, with the worker log silent after one
success. Every test passed throughout.

**Every profile has now been started, and two of them are in CI.** `demo` was
driven on a real bge-small to the three-answers demonstration — an administrator
reaching the contract number, an engineer the same question without
`contracts`, a contractor the handbook alone; `full` took a real PDF through
MinIO to `indexed` and back out of a search, and refused the same bytes declared
`text/plain`; `hosted` gave all three of the adapter's refusals — no routes, no
credential for a routed vendor, an unknown vendor; and `airgapped`'s property
was shown by running its embedder with `--network none` off a seeded volume.

`lint:compose` pins what each profile *contains*, which is a different question
from whether it starts — so `demo` has a job of its own now, beside `e2e`. It is
the profile `docs/quickstart.md` tells a reader to run and the one that produced
four defects the last time somebody ran it by hand, and it tests what `minimal`
structurally cannot: that stub embedder returns a constant vector, so relevance
decides nothing there. The job asserts the demonstration itself, and the two
refusals are the half no unit test can prove, because a unit test builds the
permission plan it then asserts against. Checked by granting the contractor
`read` on `contracts` and watching it go red, then revoking it.

`full`, `hosted` and `airgapped` are still started by nobody on a pull request.
Each wants something CI would have to be given — a bucket and a reranker, a
vendor credential, a seeded model volume — so the honest statement is that they
are covered by `lint:compose` and by hand, and not that they are covered.

**The ACL tag cache is gone** (migration 0016). `docs/authz.md` specified
`acl_tags` in the vector payload as a second filter beside the layer bound, and
the whole subsystem was built — the retag sweep, its lease, `acl_version`, the
8-byte hashes, `nacre_acl_propagation_lag_seconds` and its alert — while
`buildFilter`, the only filter builder, never emitted the clause. It kept a
payload field fresh that no query read, and paged an operator about it.

Removed rather than finished, on two grounds. It saved nothing: the resolver
computes the whole permitted set from `grants` per request, so the join it was
avoiding does not happen. And it could not express what the product now sells —
the tags were per *layer*, from allow-only grants, so applied as the specified
`must` a caller reaching a document through a document-scoped grant would have
been filtered out. Making them per-document would fix that and leave the
remaining cost: intersecting a live plan with a cached tag set delays *grants*
while doing nothing for *revocations*.

Invariant I4 is unchanged and stronger. It is structural now rather than
temporal — nothing sits between a grant change and the next request — and the
T11 cases assert it against a real database on every run, which is a better
guarantee than a gauge reading zero.

The docs are still normative rather than descriptive, and in places still ahead
of the code. Where one disagrees with the tree, that is a bug in one of them —
say which, and nothing is currently outstanding.

The two that were: **`workspace_admin`** was in `users.role`'s CHECK and in
nothing else — migration 0017 removed it, because "administers a workspace" is a
grant on a workspace scope and not an organization-wide role, and the model
already said so better. And **an `org_admin` could issue a grant naming any
uuid**, because `referenceAllows` returns true for the role before the scope is
placed; `PostgresGrants.issue` checks existence now. Neither was a leak — the
pre-filter's unconditional `must: org_id` held in both cases — and both made
`404` stop meaning what invariant 4 says it means.

**All 25 cases from docs/authz.md run** against real services, plus the truth
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
The TTL bounds memory and nothing else, which is why the refusal that compared
it against a propagation SLA went away with the SLA.

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

`GET /v1/documents/{id}` carries a presigned `source_url` where a deployment
stores bytes in object storage, and `NACRE_PRESIGN_TTL` is finally read. Minted
after the permission check and only for a caller holding `read`, so rule 6 keeps
it away from `write` alone — and absent entirely for an inline document, for one
ingested by URL, and for a deployment with no bucket.

The search response does **not** carry one, which is a deliberate deviation from
what `docs/mcp.md` and the OpenAPI document said, raised rather than absorbed. A
presigned URL is a bearer capability that outlives the check which minted it, so
answering a question about relevance by issuing one per hit hands out ten
capabilities where the caller wanted an ordering, most never followed. Both
documents now say so.

Every property of the signing was checked against a real MinIO, including the
ones that must fail: no signature, one character of the signature flipped, the
link repointed at another key, the expiry rewritten in the URL, and the window
elapsed — 403 for all five, 200 for the untouched link. The first attempt at
that check reported a pass on a tampered signature; the tamper had not applied,
because the regex assumed a one-character signature and it is sixty-four.

**Tokens can be signed with an Ed25519 key.** `NACRE_JWT_PRIVATE_KEY_REF` was in
`docs/config.md` from the beginning, read by nothing, with `loadJwtKeys`'s own
comment saying "until that lands". What it buys is that **the key which verifies
is not the key which signs**: with a shared secret every process that can check
a token can also mint one, and reading a container's environment gets an
attacker from "can check tokens" to "can act as any administrator in any
organization". The public half is published at `/.well-known/jwks.json`, which
`404`s on a secret-based deployment — a shared secret has no publishable half,
and an endpoint that produced one would be publishing the signing key.

And a process that only verifies is now configured with the public key alone.
`loadJwtKeys` separated `signing` from `verification` in its return, but its only
input was `NACRE_JWT_PRIVATE_KEY_REF` — so the MCP transport, a resource server
that never signs, still had to be handed the private key to derive the public
one, and the blast-radius argument was true of the type and not of the
deployment. `loadJwtVerification` closes that: `NACRE_JWT_PUBLIC_KEY_REF` (with
`NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF` for the rotation overlap) gives a verifier
the public half and nothing else. It refuses a file that contains private
material outright, because the whole point is that the signing key is nowhere
near the process — and a token signed with the private key was checked, by
running it, to verify against a verifier loaded from only the public one, while
a forgery from another key was rejected.

`file://` only, and Ed25519 only. Every platform with a secret store presents
one as a file, and a `vault://` scheme would put a network client on the startup
path; RSA needs a size and a padding choice and EC a curve mapping, while
Ed25519 has no parameters to be wrong about. Both refusals are at startup, by
name. Setting a secret and a key ref together is refused too: two answers to
"what signs a token", and resolving it by precedence leaves the other one
configured, apparently in use, and ignored.

The verification algorithm is pinned rather than taken from the token header.
That changes nothing observable today and the check confirmed it — `jose`
already refuses an HS256 token offered against an asymmetric `KeyObject`, and
the forgery was tried three ways against a running server with the pin removed
and refused every time. It is there because "the library happens to stop it" is
not the same statement as "this deployment accepts one algorithm", and only the
second survives a dependency upgrade.

`init` no longer prints a password that does not work. The upsert has always
kept an existing hash — a re-run must not let whoever can run the command lock
out the person who did — but the output did not know that, so a second run
generated a plaintext, printed it under "a password for signing in, which is not
printed again", and the database kept the old one. Found by running it twice and
trying both. It reports whether *this run* set it, and says so instead when it
did not. `docs/quickstart.md` had the matching hole: it said "proper token
issuance is not built yet" next to a token that expires in an hour, months after
email and password sign-in landed, so the documented path ran out at hour two.

**A fix applied in one place and not in its sibling is the most repeated defect
here, and the response is a check rather than a second fix.** One day produced
six instances of it: `initialize` negotiated on Streamable HTTP and announced on
STDIO; `server/discover` was added to one transport and not the other;
`$http_host` was needed in four nginx locations; `.env.example` seeded a variable
`docker-compose.yml` explained at length it deliberately omits, and `env_file` on
the shared anchor delivered it anyway; `workflow_dispatch` was on three workflows
out of four, and on none in a sibling repository; and `serverVersion` was carried
by two transports and passed by neither entry point.

The shape is always the same: **a property that has to hold in N places, with
nothing that knows N.** So the rule is that finding one instance is not a licence
to repair it — the repair is a check that asks all N. That is what
`lint:config`, `lint:publish`, `lint:legal`, `lint:compose`, `check-upgrading`
and the SDK's `coverage.test.ts` already are, and what
`transport-parity.test.ts` and `lint:workflows` were added as: the two
transports are driven from **one table**, so a case is asked of both and a method
implemented on one is a failure; and every workflow that gates a pull request is
required to be startable by hand, because that rule had been living in a comment
and a comment does not travel to the next file, let alone the next repository.

The two that resist mechanising are worth naming rather than pretending
otherwise. A **claim repeated across documents** — `authorization_servers` was
described as "absent and deliberately never pointed at Nacre" in four files and
became wrong in all four at once — has no check; the answer is that correcting
one is not done until `grep` has found the others. And a **rule stated only in a
comment** is the one that produced `workflow_dispatch`: if a comment explains why
something must be true, that is the signal it wants to be a check.

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

**A document over 22 KB never indexed, and the layer went on answering.** Both
embedding clients sent a document's whole chunk list as one `input` array with
no bound of their own. An endpoint does not split a batch that is too large — it
**refuses** it, and Text Embeddings Inference, which every profile here starts,
answers `413` above `--max-client-batch-size`, default 32. A chunk is 800
characters, so anything past roughly 22 KB produced more than 32 of them and
failed permanently: nothing retries `failed`.

Nothing looked wrong. The layer kept answering searches out of the documents
that *had* indexed, so retrieval was quietly worse with no error anywhere a
person looks — found on a running stand at twenty-six failures out of fifty,
where the successes in the same log are all `chunks: 2` and `chunks: 3`, which
reads as bad luck rather than as a threshold. It is the two-clients-with-nothing-
making-them-agree shape again, and the repair is `embedInBatches` plus
`lint:embed-batch` asking every file that posts to that route.

Three more came out of the branch, and the order they arrived in is the lesson.
The helper **skipped its own count check on the single-batch path** — almost
every call, since a document under the limit is one batch and a query is one
text — so a short answer misaligned a document instead of raising; a test that
predates the batching caught it, which is the argument for one path rather than
a fast one beside it. Then the smoke test turned out **never to have sent its
document**: `python3 - … < big.txt` with the program on a heredoc makes the
heredoc stdin, so the content was the empty string, the document reached
`indexed` with zero chunks, and the assertion failed *accusing the product*. And
the same section then broke the PDF one by leaving eighty-six chunks of filler
in the layer, which is a test failing somewhere other than where the fault is.
A harness is code, and it fails in the same shapes.

**Cursor pagination did not advance.** `timestamptz` holds microseconds and a
JavaScript `Date` holds milliseconds, so a cursor built from
`created_at.toISOString()` is truncated — and a truncated bound is *strictly
less* than the row it came from, so `(created_at, id) > (bound, id)` matches
that row again. `GET /v1/layers?limit=1` returned the first layer eight times in
a row against a real database, and a client following `next_cursor` looped
forever. `GET /v1/audit` had the mirror image: it orders descending, so the same
truncation **skipped** every event between the bound and the real value — a
record silently missing from the one surface that promises a precise answer.
Every listing carries `created_at::text` now.

Found in the same test: **`GET /v1/workspaces` did not paginate at all.** The
statement had no seek clause and no `LIMIT` — it fetched every workspace,
filtered in application code, and handed the whole list to `pageOf`, which then
reported another page because the list was at least as long as the limit. Every
page was the complete list and there was always a next one.

Neither was visible to a green suite, and for a reason worth naming: a test that
asks for one page checks that a page comes back. Only walking the collection to
its end catches a cursor that does not move, and nothing walked one.

**Migrations could not run as anything but a superuser**, which is the third
subsystem found this way and was discovered by writing the Helm chart's
provisioning rather than by any test. Every tenant table is `FORCE`d, and
`FORCE` is exactly what makes a policy apply to the table's *owner* — so the
four migrations that read a tenant table (`0006` duplicate layer slugs, `0007` a
lease backfill, `0017` a role rewrite, `0018` a group-member dedupe) each
evaluated `current_setting('app.current_org')`, unset during a migration, and
failed. `0001`–`0005` applied first, so the database was left half-built with a
message naming a GUC and nothing about roles.

`docs/config.md` had it backwards in a table — "the owner … applies (tables are
`FORCE`d)" — which is the configuration that cannot work. The owning role needs
`BYPASSRLS`; the application role must not have it, and still does not.

The migrator refuses up front now, with the whole provisioning block, and only
when there is something to apply — so a re-run on an up-to-date database stays a
no-op whatever role it connects as. The block includes `WITH ADMIN OPTION`,
which `0008` needs to grant `nacre_worker` onward to `nacre_app` and which plain
membership does not confer. `0008`'s own hint says to grant membership, and
following it exactly still fails; that migration is applied everywhere and its
text is checksummed, so the correct remedy could only go in the runner.

Verified by provisioning each shape against a real PostgreSQL and running the
real migrator: a plain owner refused before touching the schema, a superuser
applying every migration, a `BYPASSRLS` owner applying every migration, and
`nacre_app` afterwards still unable to create a table, still subject to every
policy, and still holding only `INSERT, SELECT` on `audit_events`. Counts stood
here and in two other files, and each went stale on the next migration.

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
- **Say when a change needs a human to do something outside this repository**,
  in the pull request body and when reporting the work — not once it has
  failed. The list is short and every entry on it fails *after* a merge, on the
  commit that is already the release: configuring trusted publishing for a new
  npm package, a DNS record, a registry entry, an npm or GitHub setting, a
  credential that has to exist before a workflow can use it. A change that is
  green in CI and inert in production because nobody was told to press
  something is the worst version of "done".
  `@nacre.work/cli` is the instance that produced this rule.
- **Adding a publishable package is not only code.** Five things, and the
  fifth is the one above: see [docs/releasing.md](./docs/releasing.md), which
  `lint:publish` holds against the manifests so it cannot be skipped. The count
  is held too — it was written in both files and moved in one.
- Don't optimize `authz/reference.ts` when it exists. Its whole value is being
  obviously correct so the property test can catch drift in the fast path.

## Skills

`.claude/skills/` carries the checklists for work that touches the model:
`authz-change`, `mcp-tool`, `api-endpoint`, `db-migration`, `audit-event`,
`config-var`, `open-core-boundary`. They load themselves when relevant.
