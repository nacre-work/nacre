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

**A third rule joined it, and it is the action column's defect one cell over.**
"204 days ago" is three words and one value, and a table cell will break it
across three lines — measured in Chromium at 390, a People row carrying that
string was **89px** while the rows beside it reading "7 days ago" and "1 day
ago" were 66px, and all three are 58px now. The column is as wide as its widest
entry, so the oldest row deforms only itself, which reads as a rendering glitch
rather than as a wrapped word. Service accounts had it twice in one row.

`ago()` is rendered into a `<td>` in three views and five places, every one of
which had to remember, with nothing that knew there were five — so the repair is
`agoCell`, which writes the class, and the check asks both halves: that the
class actually nowraps, and that no view builds such a cell by hand. It takes
the cell's other classes rather than assuming them, because three of the five
are `muted` and two are not, and a layout fix that recolours two views is a
layout fix nobody asked for.

What it deliberately did **not** do is chase the rest of the height. A service
account row is still 66px because `support-agent` breaks at its hyphen, and a
connection's row is 156px because one cell holds a sentence. Both are content of
unbounded length, where wrapping is the correct behaviour and `nowrap` would
buy a row height with a horizontal scroll. The rule is for values that are one
thing.

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

**Two more were sitting beside it, and the widened case still could not see
them.** `capabilities` was compared by no case at all, so Streamable HTTP
answered `{ tools: {} }` and STDIO `{ tools: { listChanged: false } }` — one
server telling two clients two different things about what it supports. And the
`tools/list` case projects `r.tools`, so the *wrapper* went unasked: HTTP
carried `ttlMs` and `cacheScope` and STDIO carried neither, leaving a STDIO
client with no cache hint for the one result here that is per caller. Each
transport's own suite was green, because this file asserted this server and that
file asserted that one, with nothing asking whether they were the same server.

So the repair is `results.ts` rather than a third pair of edits: `initialize`,
`server/discover` and `tools/list` are the protocol's results and the transport
is not one of their inputs, so they are built once and both dispatchers return
what they are given. A divergence now needs a second call site. `listChanged:
false` is the unification because both readings are correct in the specification
and only one of them is a *statement*; `ttlMs` and `cacheScope` go on both
because `server/discover` already carried them on both, which is what makes the
asymmetry an oversight rather than a decision.

And the parity suite compares the **whole result** now, field for field, for
every method in its table — the slices stay for their failure messages. A field
that must genuinely differ belongs in an exemption with its reason; there is
none. Both divergences were restored afterwards and the new case caught each
while every slice stayed green, which is the measurement that says the slices
were never going to.

**A browser could never reach the MCP transport, whatever the allow-list said.**
`Origin` was validated — a MUST, and the DNS-rebinding rule the specification
names — but validating an origin and *admitting* one are two halves, and only
the first was built. There was no preflight handler and no
`Access-Control-Allow-Origin` on any reply, so `NACRE_MCP_ALLOWED_ORIGINS` could
turn a `403` into a response the browser then discarded. `docs/config.md` said
to set it "only if a browser talks to this transport directly", which nothing
could do.

Found by sending a preflight at a deployed stand rather than by reading:
`403 Origin not allowed`, with no `Access-Control-*` header on it. The same
shape as a variable accepted and read by nothing, one step along — read, and
insufficient.

`WWW-Authenticate` is exposed, and that is the part worth keeping: a browser
client reads the RFC 9728 pointer out of the `401` and cannot begin discovery
without it, so a transport that admits the origin and hides that header has
admitted a client that can only ever be unauthorized. Credentials are never
allowed — the token is a header and never a cookie, so credentialed CORS would
buy nothing and would let a page on an allowed origin act as whoever is signed
in there.

**Nothing changes with the list empty**, which is the default and what every
existing deployment has: no header is emitted and a preflight is refused
exactly as before. A case asserts that, beside the four that assert the browser
half, and each was checked by restoring the defect.

**The API needed the same half**, and that is why the implementation is one
module rather than a second copy. A browser MCP client reads the `401`, finds
the authorization server, and then registers and exchanges its code on the
*API* — both by `fetch` from a page on another origin — so a transport that
admits a browser while the API does not is a walk that stops one step after it
starts, with the failure in a browser console and in nobody's log.
`NACRE_API_ALLOWED_ORIGINS` is that list, empty by default because the admin
console is served from the API's own origin and has never needed one.

`*` is refused at startup on either list. Nothing treats it as a wildcard — an
origin is admitted by exact match — so it would be a list matching nothing while
reading as one that opened the surface to everybody, and on an authorization
boundary that is the dangerous direction to be wrong in. Checked by running
`loadConfig` three ways: `*` refused by name, a real origin accepted, unset
empty.

The first version of that also shipped a `parseAllowedOrigins` nothing called,
because the config reader has its own list parser — an exported function with no
caller, in the same commit as a check about variables read by nothing. Deleted
rather than wired up.

**And the two surfaces then wrote their own header lists, so the API refused the
one header every MCP client sends.** `Access-Control-Allow-Headers` was a string
literal on each side; the MCP transport's had `mcp-protocol-version` and the
API's did not — and the API is what serves both `/.well-known` documents a
browser MCP client reads. The preflight admitted the origin and refused the
header, so the browser cancelled discovery before it left.

Nothing failed. The MCP SDK retries discovery without the header, so the walk
finished and what a deployment saw was two `net::ERR_FAILED` lines in a console
and a flow that worked anyway. A client that does not retry gets no metadata at
all, which is the same "admitted a client that can only ever be unauthorized"
shape that put `WWW-Authenticate` in the exposed list one paragraph up — arriving
on the request side.

The shared set is a constant both surfaces build their list from now, each
adding only what it alone reads, and the two suites ask it from that constant
rather than spelling it out — a case that names its own headers is a case that
passes on the ones the surface kept. Found by driving a deployed page in a real
browser and reading the failed requests' *headers*: `curl` gets a `200` from
both documents, because `curl` sends no preflight.

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

**And the reranker the profiles ship refused every batch the product sends.**
`HttpReranker` posts the whole candidate set in one call —
`NACRE_RERANK_CANDIDATES`, 50 by default and 500 at most — and Text Embeddings
Inference's `--max-client-batch-size` defaults to **32**. So `full` and
`airgapped` answered `413 batch size 50 > maximum allowed batch size 32` to
every search with more than 32 candidates, from the day reranking landed.

Nothing failed, and that is the whole difficulty: reranking fails **open** by
design, so a search whose reranker refuses degrades to fusion order with a
counter and a log line. A deployment that configured a reranker got searches
that answered, ranked by fusion, forever. The embedding batch defect exactly —
declared, wired, and refused by the server at a bound nobody had asked it for —
and found the same way, by sending the shipped default to a real one rather
than by reading.

**Splitting is the wrong repair and that is not a matter of taste.** A reranker
is not promised to score each text independently of the others in the call, so
two calls produce two sets of scores that cannot be compared — a wrong
*ordering*, with no symptom at all, which is worse than the refusal. That is
already written down for the adapter, and it is why `embedInBatches` does not
carry over. So the server is told to accept what the product can send.

Which makes it two numbers with nothing that knows there are two, and the
repair is `lint:rerank-batch` rather than the one-line edit. **Both are
discovered**: the ceiling out of `config.ts`'s own validator and the limit out
of the compose service's own command, so raising the configurable maximum
without raising the server's fails there rather than in somebody's results.
Five refusals, each produced — including the shipped state, which names itself.

`docs/config.md` carried the sentence that made this invisible: *"the limit is
far above anything a search sends"*, true of the adapter's 512 and false of the
TEI those profiles run. It says which is which now.

**And `HttpReranker` had only ever been asked of a stubbed `fetch`.** Every case
in `rerank.test.ts` replaces `globalThis.fetch` and answers with a `Response`
the test wrote, so what they prove is that the client agrees with itself — the
fixture-written-to-match-the-code shape, on the path where being wrong is
silent. `scripts/ci/rerank-live.mjs` asks a real one, in a job of its own
rather than in the unit suite, which is arithmetic: four workflows run that
suite, so a live case there is four model loads on every pull request.

It drives `dist` and not the source, it starts the server with **the flag the
compose file passes** — read out of that file, since a second copy of the number
is the defect one file over — and it uses a smaller cross-encoder than the
profiles ship, on the e2e smoke's own argument: what is under test is the wire
and the bound, neither of which is a property of the weights.

Two things it says that no stub could. The server answers **sorted by score and
not in input order** — measured, `[0, 2, 1]` for three texts — which is why the
mapping is by `index` and why trusting arrival would attach the wrong score to
the wrong chunk. And the shipped defect reproduces: run against a TEI started
the old way, three of its five assertions fail naming the 413 while the two
about the contract stay green, which is the signature that says the contract
was always right and the bound never was.

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

**It is five operations now, and the fifth is what found the other two.** That
paragraph said four and the header above it said "no listing, because nothing
needs to enumerate a bucket" — true of every caller the core has, and the
commercial `backup` module is not one of them: an archive whose `verify` refuses
a part the manifest does not name has to be able to ask what is there. So
`list` went in, with continuation-token pagination, a bound on how many pages it
will follow, and a refusal for a response that says truncated and carries no
token — an unbounded loop against somebody else's endpoint is a process that
never returns.

Two defects came out of driving it against a real MinIO, and neither is about
listing. The client put **`content-length` among the headers it signs**, and
`Content-Length` is a *forbidden request header* in the Fetch standard: undici 7,
which is Node 24's, throws `invalid content-length header` where undici 6 simply
dropped it. So every `put` this client makes would have failed on a current
runtime, on a line that had been correct for the runtime it was written on. The
repair is an absence, so the test pins the absence — from the headers and from
`SignedHeaders`, because a signature over a header the runtime then sets is a
`403` naming none of its inputs.

And the XML decoder knew `&apos;` and not `&#39;`, which is what **MinIO
actually sends** for an apostrophe in a key. A key it appears in came back
mis-decoded, so a `get` would `404` and `backup`'s `verify` would condemn a good
archive. Numeric references — decimal and hex — are decoded now, and `&amp;`
last, or a key containing `&amp;#39;` decodes twice.

**And the reason it had no retries stopped being true the same way.** The header
said the callers already retry whole units of work — the ingest queue and the
collector — which was true of them and is not true of `verify` and `restore`:
those read an archive part by part, so a 1.6 GB artifact is two hundred
requests, and one transient `503` from a real cloud store ended the whole run.
The operation somebody runs when the database is already gone. Same shape as
`list`, one paragraph up: a stated argument that a later caller falsified, in
the same file, twice.

Three more attempts inside a thirty-second budget, and the judgement is the
whole of it. A transport failure, a `5xx` and a `429`; nothing else. A `403`
re-signs with the same inputs and arrives at the same refusal — the worst
version being `RequestTimeTooSkewed`, where four identical failures hide a
one-line diagnosis — a `404` is an answer, and `501` is the one status in the
5xx range that is permanent, so it is excluded by name rather than by falling
under `>= 500`.

**Full jitter over the whole window**, because the callers are a fleet: worker
replicas share a bucket, and a blip they all see is one they would all retry
from at the same instant. `Retry-After` overrides the formula and is capped, or
a mistaken value parks a restore for an hour. And there is a **budget** as well
as a count, checked before sleeping — attempts alone bound one request, and two
hundred parts × four attempts is a run that spends twenty minutes discovering
the store is down.

Every operation here is idempotent and that is a property rather than a hope: a
key is derived from identity, never from a sequence, and the body is a
`Uint8Array` this process still holds, so an attempt is replayable byte for
byte. A streaming client could not make that claim, which is why a streaming
rewrite would have to revisit this rather than inherit it.

The loop is **one function three call sites go through**, and that is the design
rather than tidiness: `#send`, `list` and `ready` each called `fetch` with
nothing that knew there were three, and a retry added to `#send` alone would
have left a restore's *listing* unretried — the request that decides whether an
archive's parts are all there, so the check that refuses a stray part becomes
the check that fails on a blip. `ready` is the one caller that opts out, at one
attempt: a readiness probe's job is to answer now, and retrying inside it turns
"the bucket is not answering" into no answer, which an orchestrator reads as a
pod to kill.

**And the file's own header claimed a check that did not exist.** It says every
property here is verified against a real MinIO before it is believed — true of
somebody running a script by hand, and false of CI, which had no object store at
all. The `lint:tokens` shape exactly: the property held, and that is what made
the absence invisible. `s3-live.test.ts` is six cases against a real store, and
four workflows run the unit suite so all four now start one.

`lint:workflows` is what knows there are four. It compares the `NACRE_*` every
job running that suite sets, by name and computed rather than listed, and
refuses outright if it finds no such job. Taking a variable out of
`flake-hunt.yml` names it — which is the case that matters, because a nightly
hunt going red at 3am for a fixture nobody changed is how a hunt stops being
read.

**Per job and not per file**, which the first version got wrong and which
porting it to `nacre-enterprise` is what exposed: two jobs in one workflow can
run different projects and legitimately need different services — that
repository's `acl-invariants` runs `test:acl` and has no object-storage case at
all — so a file-level union asks the wrong job for a fixture it has no use for.
Both repositories carry the same text now, which is what "a check is the safe
thing to copy" is worth only if the copies are actually the same.

**The live case written to prove the re-signing could not fail, and that was
measured rather than assumed.** Its first version said a client replaying the
first attempt's headers would be caught here. Restoring exactly that left the
file green: the backoff is stubbed to return immediately, so both attempts land
in the same second, and S3 refuses a stale signature only past fifteen minutes.
No suite that finishes in under fifteen minutes can show it. The re-signing is
pinned in the unit file, where the clock is a seam; the live file claims what
only a store can answer — that a retried write really lands — and says so.

**And the paragraph above about the SDK was wrong about its size.** It said
"tens of megabytes and hundreds of transitive packages"; `@aws-sdk/client-s3` at
3.1113.0 installs **26 packages and 22 MB** with `--omit=dev`, measured rather
than remembered — v3 consolidated its clients since that sentence was written.
The argument survives the correction and is smaller than it was. What the SDK
would genuinely buy is credential providers — IRSA, an instance role, SSO — and
if that is ever needed the shape is `@aws-sdk/credential-providers` feeding a
session token into this signer, not the whole client: the signing is the part
that is written and verified, and the credentials are the part that is not.

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

**`hosted` turned out not to need one, and saying so is the finding.** Its three
refusals — no routes, a routed vendor with no credential, an unknown vendor —
were already asked of `load_routes`, in the sidecar's own suite, in the
`sidecars` job. What a `ConfigError` case cannot see is the half a deployment
actually meets: `serve` catches that error, prints one JSON line and raises
`SystemExit(1)`, and if the `except` were narrowed or the status dropped the
process would come up, bind its port and answer every request with an error
from a service the orchestrator believes is healthy — worse than not starting,
because nothing restarts it and nothing says why.

That is the whole of what starting the profile in CI would add over the cases
already there, so it is asked directly: the module run as a **subprocess**, with
a broken environment and with `PATH` and `HOME` only so nothing an operator's
shell exports can configure it into starting. `assertRaises(SystemExit)` would
have proved the exception and not the status a shell sees, and the message has
to arrive on a stream `docker logs` shows. Both halves were restored — the exit
code and the stream — and each failed all three.

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

The third was inside one file and disagreed with itself. `/oauth/consent`'s
description said a signed-in person chooses which **service account** an
application acts as, and that the token "acts as that account and **never** as
the person who approved it. That is the design rather than a detail." Its own
request schema, six hundred lines earlier in the same document, says *"Omit it
to approve as yourself … naming nobody is a delegation, where the token acts as
the signed-in person"* — and the consent screen's default is exactly that case. So
the contract described the flow as the one thing it is not, in the document that
is normative here, while the schema beside it was right and so were
`docs/authz.md`, `docs/mcp.md` and `docs/upgrading.md`. Prose written before a
feature, in a file the feature only touched further down.

This is the class the file already names as resisting a check, arriving from a
new direction: not a claim repeated across documents but a claim contradicted by
a schema inside the same one. No mechanical rule was added, because the ones
that would have caught it — an operation's prose against its own schema's
requiredness — are narrow enough to be defeated by rewording, which is the
shape of check this repository keeps deleting. `grep` found the other three
copies, and they were correct.

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

**A second factor is in, and it is TOTP.** Everything that authenticated a
person here was one secret: a password, or an ID token from an issuer the
operator trusts. A password that leaks is an account, and on this product an
account is a set of documents somebody decided who may read.

The arithmetic is `packages/core/totp.ts` and is held against **RFC 6238's own
vectors** rather than against itself — a code generator tested on its own output
agrees with itself and with no authenticator anybody owns. SHA-1 deliberately:
the weakness it is retired for is collision resistance, which HMAC does not rest
on, and choosing SHA-256 would buy nothing measurable while meeting a person
whose app shows six digits that never work.

Everything else is what a database decides, so it was driven against a real
PostgreSQL: the replay bound, a recovery code spent by the UPDATE that finds it,
and the lock after five wrong codes. That run found the failure counter reading
one parameter twice — `SET failed_attempts = $2 … WHEN $2 >= $3` — which
Postgres refuses with `text versus integer` at run time and at no other time. It
type-checked, and it would have passed against a mock. The same mistake appeared
again in the test's own fixture an hour later, which is what made it worth a
comment rather than a fix.

**One variable seals it, and the file form was deleted before it shipped.**
`NACRE_2FA_KEY_REF` existed for a day beside `NACRE_2FA_KEY`, with a paragraph
arguing that a file is the better place for key material and a refusal for
setting both. The argument is true and is not worth a second variable: an
operator who wants the file writes `NACRE_2FA_KEY=$(cat /run/secrets/…)`, one
line, where the value is set — while the product would have carried two
spellings in `loadSecondFactorKey`, in `docs/config.md`, in `.env.example`, in
`docs/upgrading.md`, in the OpenAPI document and in the sentence the console
shows an operator who has configured neither, for as long as the product exists.

It was removed at the only moment removing it is free: 0.18.0 had not been
published, so nothing was ever configured with it and there is no compatibility
to keep. A compatibility shim is cheap to add on the day and permanent
afterwards, which is the asymmetry worth acting on before a release rather than
after one.

`NACRE_JWT_PRIVATE_KEY_REF` beside it is file-only and is not the same shape:
there is one form there too, and it is the file because a private signing key
must not be in the environment at all. The rule both follow is one form per
thing, not one form for everything. `lint:config` is what keeps the deletion
honest — it holds every variable in both directions, so a resurrected reader
with no documentation and a documented variable nothing reads each fail — and a
case asks `loadSecondFactorKey` directly that the old name is not read, because
"unset" and "set under a name nobody reads" are the same answer and only one of
them is what an operator meant.

**Unconfigured is a supported state and the feature is simply absent.** With no
`NACRE_2FA_KEY` there is no key to seal a secret with, so enrolment is
refused, the console says why, and nothing stores a secret in the clear in the
meantime. A product that half-does a second factor is worse than one that does
none, because the operator believes something.

Three properties are worth naming because each is a way to get this wrong. A
**code is single-use** — the step it belonged to is stored, so a code read over
a shoulder is not worth a second use, and the visible cost is that enrolling and
immediately signing in means waiting for the next one. The **brute-force bound
is in Postgres**, against the grain of the rate limiter beside it: that one
fails open because it is not an authorization control, and this one is. And the
whole surface is **under `/v1/me`** — an administrator resets a password and
deliberately cannot touch a second factor, or it would stop being a thing the
person holds.

`login()` returns a union now rather than a nullable pair, which turned every
call site into a compile error until it said which outcome it meant. That is how
the CLI and the console got their second field: neither would have been noticed
by a type that let the challenge be ignored, and ignoring it means issuing a
session to somebody who never produced a code.

**A password can be recovered, and the whole feature is absent where no relay
is configured.** `POST /v1/users/{id}/password` has existed since there were
users and it is an *administrator* setting somebody else's; the person who
forgot theirs had no route, and on a single-administrator installation — which
the open core mostly is — neither did the administrator. The route people find
instead is `psql`, which is the shape this repository keeps closing.

**The token carries its organization**, `<org_id>.<secret>`, and that is the
design rather than a convenience. Resolving a credential outside `withOrg` has
exactly two mechanisms here, and migration 0008 says in its own words that
`users` gets neither "as a decision rather than an omission". A token that names
its tenant means redemption reads through `withOrg` like everything else, so the
one path a stranger reaches unauthenticated opens no cross-tenant lookup. The
organization id is not a secret from the person holding the link — it is in
their own `/v1/me` — and the half beside it is.

`204` whatever happened: no account, an address in two organizations, a disabled
account, a rate limit already met, a relay that refused. Anything else makes the
one endpoint needing no credential into the account-enumeration oracle that
sign-in is careful not to be.

**A reset does not touch a second factor**, or an email account would be a way
around one. It does end every other session, because a reset is what somebody
does when they think their password is known.

`nodemailer` is the second dependency this package has taken, and the argument
is the one the parser made in reverse: it has **no dependencies of its own**, and
the alternative is two hundred lines of SMTP here — dot-stuffing,
quoted-printable, and header encoding over addresses that come out of the
database. Header injection on that last one is a defect with a name, and trading
a zero-dependency package for the chance to write it myself is not a trade worth
making.

`GET /v1/auth/methods` exists so the console can leave the link **off the
screen** rather than showing one that answers `404`. A screen offering what the
server refuses is a defect this console has already shipped once, and the fix
was the same shape: ask, do not assume.

Wiring it turned that up again from the other side. `recovery` was spread into
the `Login` constructor instead of the server options and **nothing complained**
— an excess property in a spread is not checked — so the routes would have been
mounted nowhere while every gate stayed green. Found by reading the file rather
than by any check, which is the honest version of how it was found.

Redemption writes `users.password_hash` and is therefore the second written
exemption in `check-platform-admin-target.mjs`. It is a real exemption rather
than a routing change: the only way to reach that statement is to hold a
single-use secret emailed to the address on the row it writes, so the actor and
the target are one person and there is nobody to escalate over — and refusing a
platform administrator there would leave the account that administers the
installation as the one account whose only recovery is `psql`, which is the hole
this endpoint closes.

**A person can change their own password.** Everything that set one belonged to
somebody else: `POST /v1/users/{id}/password` is an administrator issuing a
generated one, and recovery is for a password that has been *forgotten*. The
ordinary case — you know your password and want a different one, because
somebody else knows it too — had no route at all, and on an installation with
no relay configured recovery is not there either, so the answer was `psql`.

It takes the current password and nothing else. A session is not enough, on the
same argument that makes removing a second factor take a current code: changing
the password is the first thing somebody holding a stolen session does. And a
second factor is deliberately **not** asked for, because it bounds sign-in —
demanding a code would mean somebody whose phone is lost cannot change a
password they know is compromised.

A wrong current password is **`403`**, and that choice is about clients rather
than about semantics. `401` is the obvious status and is the wrong one: on an
authenticated route it means "your session is over", and every client here
renews on it and replays — so a typo would spend a refresh token, fail again,
and arrive as two failures with a renewal between them. Not `404` either; the
caller is looking straight at their own account.

Every other session ends and this one is replaced, in that order inside one
transaction — the pair is inserted **after** the revocation, or the endpoint
answers `200` with a refresh token it has just revoked and the person is signed
out fifteen minutes after a change that worked. That ordering is what the live
case measures, by counting live tokens rather than asserting on each: swapping
the two statements leaves zero.

The console's Security screen grew the form, and writing it found that the whole
view **returned early** when no `NACRE_2FA_KEY` was configured — so on an
installation with no second factor, a message about TOTP would have hidden a
password control that works. Two panels rendered independently now, which is
the same "a screen must not refuse what the server allows" rule the message
beside it exists for, arriving from the other side.

Two more things came off running the console rather than testing it, which is
the rule this file keeps re-learning. `scripts/screenshots.mjs` had **no
`/v1/auth/methods` fixture**, so the call that decides whether a recovery link
exists got the 500 an unstubbed call gets and `sign-in.png` was a picture of a
screen with no link on it — the missing-`/v1/me` defect from the same script,
one release later and on the one screen rendered signed out. And every
committed image predated the Security view, so all twelve show a nav that is
missing an item; regenerating them is part of this rather than noise.

The link itself sat at **zero pixels** under the Sign in button — `.hint`
carries no top margin and `.btn-block` only a small one — so a mis-tap on a
full-width button lands on "forgotten your password".

**`screenshots.mjs` measures that now**, which is what turns it from an instance
into a repair. `lint:admin-layout` reads the stylesheet and this is geometry;
that script already opens every screen in a browser, so the question goes where
the browser is: for every control, how far is the nearest box that ends above it
and overlaps it horizontally. The general question rather than
control-against-control, because the sibling repository learned that the narrow
way round and its next instance was a control under a *paragraph*.

**Its first version reported thirty things across fourteen screens and named the
one real defect among them**, which is a check nobody reads. Three of the four
arrangements it flagged are ones where being close is the design: a field's own
label four pixels above its input, one table row's action against the next
row's, and an inline sibling on the same line whose box ends a pixel high
because the two are baseline-aligned. Each is excluded by name and with its
reason. The fourth was the check's own defect — a modal is a layer *over* the
page, so the New user dialog's Cancel button was measured against the users
table behind it, which is a fact about stacking. It measures one root at a time
now. Zero findings on a clean tree, and restoring the flush link names exactly
it.

**And the run itself is in CI**, as `console`, which is what stops this being a
gate somebody has to remember to run. Playwright is installed for the job rather
than becoming a dependency. The **images are not compared** and that is
deliberate: whether a layout fits is decided by whatever font the runner has, so
a byte comparison would be red on one machine and green on another for reasons
about neither the code nor the design. What is asserted is what a browser
decides — geometry, page errors, missing fixtures, and which view rendered.

That job is only possible because the clock is frozen. `accounts.png` and
`people.png` used to change on a wall-clock boundary with no code change — two
runs eleven minutes apart differed because a `created_at` crossed 181 days,
since the fixtures carry absolute dates and the views render relative times. A
regeneration that rewrites unrelated files is how a screenshot diff stops
meaning anything. `page.clock.setFixedTime` pins it, checked by rendering twice
and comparing bytes.

**The four rules those runs apply are a module now, and the reason is on the
other side of a boundary this repository cannot see.** `nacre-enterprise` ships
four commercial screens into a console it does not own: they are drawn by
*this* package's `dom.ts`, `pick.ts` and `admin.css`, through the extension seam
that exists precisely so there is not a second console over there. Every layout
defect those screens have had — six of them — was found by building the image
and looking at it, because the rules that catch exactly those lived inside
`screenshots.mjs` and were reachable only from here.

A second copy of "a control needs eight pixels of headroom" in the other
repository is this file's first paragraph at the largest scale it is available
in: **a property in two places, across a boundary where no check can read both
sides.** So they are `scripts/layout-rules.mjs`, which that repository fetches
at the version its image is built `FROM` — its own technique for the console
contract, pointed at one more file.

Two things make that possible and both are constraints on anyone editing it.
The failure sink is an **argument** and not a module-level array: two callers
report differently, and a rule that closes over one of them has chosen. And
nothing there imports playwright — a rule only ever calls `page.evaluate` — so
the file can be fetched and imported without installing anything of ours.

`RULES` is the export that matters, and `shot` iterates it rather than naming
four functions. A caller that lists the rules is a caller that forgets the
fifth, and the fifth would otherwise reach one console and not the other, which
is the whole defect one paragraph up. Moving them changed no behaviour and that
was measured rather than argued: the same twenty screens, images **byte for
byte** identical, and the rules still fail through the new path — restoring
`.under-action { margin-top: 0 }` names `sign-in: "Forgotten your password?"
sits 1px under "Sign in"`, which is the instance this file already records.

It paid immediately. The first run of the other repository's pass named two
classes this stylesheet does not define, in screens that had shipped with
them.

**And three of the four routes that hash answered `500` under load.**
`core/passwords.ts` bounds how many scrypt calls run at once — the pool is
libuv's and is shared with DNS, so an unbounded one stops the rest of the API on
a name lookup — and its own header says "the caller answers 503, which is the
honest response to 'this process cannot verify a password right now'". Sign-in
caught it beside the call. Creating a user, an administrator resetting a
password, and redeeming a recovery link each turned a loaded process into an
internal error, which a client reports as a broken server and an operator
investigates as a bug.

A rule stated in a comment and held in one of four places, which is the shape
this file names twice already — and the count moved twice on the way in: the
fourth route was password recovery and the fifth is the change above. The repair is one problem builder and one
`handledTooBusy`, called from the **two** error boundaries there are. Two rather
than one because authentication splits the request path: sign-in and recovery
are reached without a credential and run before the section that has one, so a
single `catch` cannot cover both, and saying so beside them is what puts the
next hashing route in one of the two.

The check is the four routes driven end to end. Each half of the defect was
restored and each named exactly its two.

**The second exemption is what made the mechanism matter.** Exemptions are keyed
by file, so a second method in the same file writing the same statement text was
waved through by an argument written about the first one — a write nobody argued
for, admitted by a check whose whole subject is arguing for writes. Each
exemption now has to match **exactly one** section: zero is the stale entry it
already refused, and two is the new hole. Both branches were checked by
producing them.

**A second factor you cannot be phished out of.** TOTP bounds a stolen password
and does not bound a convincing page: six digits typed into a site that looks
like this one work exactly as well there as here, and the person who typed them
has no way to know. WebAuthn is the kind whose signature covers the origin, so
an assertion produced for the wrong site does not verify at the right one — that
is the whole reason to carry a second kind rather than more of the first.

It needs **no configuration at all**, and that asymmetry is the feature rather
than a convenience. A TOTP secret is shared, so it has to be kept and therefore
sealed, which is what `NACRE_2FA_KEY` is for; a WebAuthn credential leaves a
public key here and nothing else, so a database dump hands over nothing that can
produce an assertion. The relying party is `NACRE_CANONICAL_URL`'s hostname and
the origins are that URL's plus `NACRE_API_ALLOWED_ORIGINS` — a `NACRE_WEBAUTHN_*`
variable would be a second answer to a question the deployment has answered
twice. So the installation with **no** key now offers the *stronger* of the two
and not the weaker one, which is most of them.

`packages/core/webauthn.ts` has no dependency and needs none: `node:crypto`
imports a **JWK** directly, and COSE and JWK are the same parameters under
different names, so the conversion is a field mapping rather than ASN.1. The
CBOR decoder is a subset — CTAP2 requires canonical encoding, so every
indefinite length, every tag and every non-canonical integer is a refusal rather
than a branch, and the bounds are depth, entries and bytes.

The fixtures are **genuine bytes from Chrome's virtual authenticator**, driven
through the Chrome DevTools Protocol by `scripts/webauthn-fixtures.mjs` and
regenerable. Hand-encoding them would have proved the verifier against whatever
the encoder believed, which is the fixture-written-to-match-the-code shape this
file already names twice. ES256, RS256 and EdDSA, and the refusals beside them.

Three properties are the ones a verifier gets wrong. The origin is compared by
**equality** and never by suffix, because `https://evil-nacre.work` ends with
`nacre.work`. A challenge is **single-use**, spent by the `UPDATE` that finds it
— an assertion captured on the wire is replayable for exactly as long as its
challenge is, and nothing else in the ceremony stops that. And a challenge
issued for an *enrolment* cannot be spent on a sign-in, which is in the `WHERE`
clause rather than checked after: enrolment is asked for by somebody already
signed in, and one pool would let a session mint the input to a ceremony it is
not in.

**The first version of the counter test could not fail.** It asserted
`sign_count > 0`, which the registration already satisfies, so removing the
write left it green. It compares against the counter read out of the assertion's
own authenticator data now.

Writing the routes found **two defects that shipped in 0.18.0**, and both are the
same shape: a path nothing had ever asked the *server* for.

`DELETE /v1/me/second-factor/{id}` answered `404` from the day it was written.
Its condition was `!rest.includes('/')` over a `rest` that is `/{id}` — false for
every id, always — so **a second factor could be enrolled and never removed**, on
the one surface an administrator deliberately cannot reach on somebody's behalf.
The store's own live case calls `remove` directly and passed throughout, because
the store was never the broken half.

`GET /v1/auth/methods` answered `404` too, because `handleAuth` refused anything
but `POST`: every route there produces a credential and takes a body, and this
one is a read. So the endpoint that exists **so the console can leave the
recovery link off the screen** never answered, and the console — reading
`password_reset` off a problem document — hid the link on every deployment,
including the ones with a relay configured. The feature did the exact opposite of
its purpose, in the file whose header explains why it is there.

`contract-surface.test.ts` is the repair rather than the second fix. It excluded
`/auth/*` **by prefix**, on the argument that those are all POSTs whose bodies it
does not construct — true when it was written, and it silently stopped covering
the one `GET` added later. A blanket exclusion is a check that shrinks without
saying so; the condition is `op.method === 'GET'`, which is what the argument
actually was. It names exactly this defect when the refusal is restored.

And a **recovery code could not be spent where there is no sealing key**:
`verify` opened with `if (key === undefined) return false`, which is right about
TOTP and wrong about the sheet of codes redeemed by the same method. The guard
sits below the redemption now, and the select it guards asks for `kind = 'totp'`
— which also stops a mixed account trying to open a `NULL` secret.

**The whole ceremony is driven in a real browser against a real database**, by
`scripts/webauthn-e2e.mjs`, and that is what says the wiring works rather than
each half separately: Chrome's virtual authenticator over CDP on one end and
Postgres on the other, with the console's encoding, the routes, the store and
the verifier in between and nothing stubbed. Fourteen assertions — the panel
offering one kind and not two on an installation with no key, ten recovery
codes, the JWK and the algorithm in the row, a sign-in on the key alone, the
counter moving, a forged challenge refused, and the factor removed on an
assertion.

That last one is the 0.18.0 `DELETE` defect by name, and restoring it turns the
run red — which is the measurement that says this check would have caught what
every green suite missed. It runs in the `console` job, which grew a Postgres
service rather than becoming a job of its own: the expensive half, installing a
browser, was already paid for there.

**And the screenshot pass photographed a bundle that was two commits old and
reported success.** A `pnpm build` had failed on a type error, leaving the
previous `dist` in place; the run rendered every screen, found no page error and
no missing fixture, and none of the changed code was in the page at all. "Test
what you write by running it" has a corollary — run the artifact the source
produces *now* — so the script compares the newest file under `packages/admin/src`
against the newest under `dist` and refuses rather than rendering. Checked by
touching a source file and watching it refuse.

**A flake failed the 0.19.0 release, and the response is two checks rather than
one fix.** `second-factor-live.test.ts` read the wall clock three times across
one case — confirm, sign in, replay — and a TOTP step is thirty seconds while
the case takes two. So about one run in fifteen crossed a boundary between the
second read and the third, computed a code for a step that had never been
spent, and watched the server correctly accept it. The assertion said "a spent
code is refused"; what it asked was "these three clock reads landed in the same
window". Green on the pull request, red on the merge that **was** the release:
nothing published, nothing tagged, four images unbuilt.

The worse half is that the class had already been diagnosed **in the same
session**. `hybrid-live.test.ts` was found to be a coin flip an hour earlier,
fixed, and its commit message names the property in as many words — a test
whose claim depends on something it does not control. Finding one instance is
not a licence to repair the instance, which this file has said twice; the sweep
did not happen and the release paid for it.

So `lint:test-clock` closes the mechanism and `scripts/flake-hunt.mjs` closes
the class. The first **discovers** its subject rather than naming `totpStep` —
every export whose instant defaults to `new Date()`, of which there is one, so
the next helper written that way is covered on the day it exists. It refuses
outright if it finds none, because a check with nothing to hold must not report
green. It deliberately does **not** ban `new Date()` in tests: twenty of the
twenty-five clock reads here are an expiry sixty seconds out used within
milliseconds, and flagging those would report twenty things and name none of
them.

The hunt is the part no static rule can do, because the hazard is the ratio
between a window and a duration. It runs the suite N times and reports any case
that failed **sometimes** — every time is a broken test the ordinary suite
already catches. Nightly rather than per pull request: a flake is a property of
`main`, so it is looked for on `main`'s clock, and a find is a red scheduled run
somebody reads in the morning rather than a release nobody can undo.

**And the first hunt reported a second flake that did not exist.** Eight cases
failed in runs 11 and 12 of a twenty-run background pass — and those runs were
executing against a tree being edited at the time, since the release's defect
had been injected into that same file to demonstrate the hunt. The failures
were contamination cascading through a shared database. That is this file's own
recorded mistake — measuring damage this session caused and attributing it to
the repository — arriving a second time, and it was one report away from being
written down as a finding. Twenty-five runs on a clean tree: no case failed in
any of them.

**An organization can require a second factor, and the core's half of that is a
sixth extension point.** Both kinds are individually opt-in — a person enrols
one because they decided to — and an `org_admin` had no way to require one at
all. The model-offers-it-and-the-product-gives-no-route shape, on the surface
that decides whether a stolen password is an account.

`registerSignInGate` is that point and the policy is a module, on the boundary's
own test: a single developer on a laptop does not need to force themselves to
use a second factor, and an organization mandating one is what a security team
buys.

**It is consulted inside `issue`, which is the one place a session is minted.**
There are four paths from a verified credential to a session — a password with
no factor asked for, a completed second factor, a spent refresh token, and a
password change — and a check placed beside them is a check the fifth forgets.
That is this file's most repeated defect, so the gate goes where all four
already arrive and `issue` returns a union, which turned every call site into a
compile error until it said what it does with a refusal. A **renewal** is gated
deliberately: without it a policy turned on while people are signed in does
nothing for any of them for as long as they keep renewing, which is the same
case a delegation's `disabled` check exists for.

**`enrol` is the verdict that makes such a policy usable, and it is most of the
work.** Enrolment lives under `/v1/me` and needs authority, so a gate that could
only refuse would lock out everybody who had not enrolled on the day it was
turned on, with `psql` as the route back. So the core answers with an
**enrolment challenge**: audience-separated from an access token exactly as the
sign-in challenge is, carrying a purpose claim neither can spend as the other,
and reaching four routes rather than the seven a session reaches. Not the
listing, because a caller who has proved nothing is not owed an inventory of the
account; not the removal, because taking a factor off under a mandate to add one
is what somebody holding a stolen password would do. Confirming through it hands
back the recovery codes **and** a session, because being made to enrol and then
asked to sign in again is the moment a person gives up.

The door sits **behind** `authenticate` rather than in front of it, and both
reasons are worth keeping. Running it in front made every ordinary request to
that path pay a JWT verification for a token it was not carrying — found by
running the suite, not by reading. And behind it the door can only ever be
reached by a credential the API has already refused, so a route that forgets it
answers `401` and never `200`. A design that instead minted a real access token
and asked every other route to refuse it would fail the other way, and on an
authorization boundary that is the dangerous direction.

`admitSignIn` deliberately does **not** short-circuit the way `admitIngest`
does. There, one refusal is the answer and asking the rest cannot change it;
here `refuse` outranks `enrol`, so a gate answering the weaker verdict while a
later one would refuse must not be what the caller acts on. Every gate is asked,
and a `refuse` stops the scan because nothing outranks one.

**And the half about SSO needed no code, which is the finding rather than the
feature.** "Require a second factor **or** SSO" reads like two things to build.
An `AuthProvider` principal presents the identity provider's assertion as its
credential on every request and never mints a session here — checked by reading
`auth.ts`, where providers are consulted on the *request* path — so a gate on
`issue` cannot see them and does not need to. The second half holds by
construction, and the honest response was to write that down rather than build a
branch for it.

**A case written to prove the purpose separation could not fail.** It asserted
that an enrolment challenge is refused by `completeSecondFactor`, on a `Login`
constructed with no second-factor store — so the method returned on its
`gate === undefined` guard one line before it read the challenge at all, and the
case stayed green with the purpose comparison deleted. The projection was narrow
enough that it could only ever pass, which is the transport-parity defect and
the `location.hash` defect arriving in a case written this same day. It is asked
of a `Login` that has a store now, in both directions, and both restorations
were measured: the old version green, the new one red.

**And the console had to learn the answer, or the point would have been a
surface nothing could act on.** That is the defect `GET /v1/auth/methods` exists
to prevent — a screen offering what the server refuses — arriving from the other
side: a server offering what the screen cannot use. So the outcome runs the
whole way out, and every step of that was a compile error rather than a choice.

The SDK carries it on **four** methods, and `enrolmentFrom` is one reader
because four copies of the same three fields is four chances to read
`access_token` off a body that has none and store the string `undefined` as a
session. `#renew` is where that would have been silent: a renewal answered by a
gate carries no tokens, so the seam drops the refresh token, tells
`onSignInGate`, and lets the `401` surface — the session really is over, and the
spent token is not redeemable.

`confirm` and `finishWebAuthn` return `{ recoveryCodes, tokens }` now rather
than a bare list. `tokens` is present only through the enrolment door, and
making it an object turned both call sites into compile errors instead of
adding a field every existing caller would ignore.

**Two different `403`s reach `POST /v1/me/password` now**, and the SDK matches
on the problem **type** rather than the status. It swallowed every `403` as
"wrong current password", so a policy refusal would have been reported as a typo
and the person would have retyped a password that was correct. A status is too
coarse to carry two facts; a stable `type` is what RFC 9457 has for it.

The console's screen shows the gate's own words, offers whichever kinds the
installation has, and — the part worth naming — **shows the recovery codes
before the console opens**. They are printed once, and signing somebody straight
in would have thrown away the only thing that gets them back after a lost phone,
which an administrator deliberately cannot undo.

`scripts/sign-in-gate-e2e.mjs` is what says this works, and it registers a
**real gate** rather than stubbing a response: password, enrolment step, secret,
code, ten codes, Continue, console — with the core's `issue`, the challenge, the
narrow door, the SDK and the screen all real. Every suite under it proves one
half against a stub of the next, and mocks agree with whatever they were written
to. Deleting the console's one branch reproduces 0.19.0's state exactly and the
run names it.

Two of its own assertions were wrong first, and both are the harness failing in
the shapes the product does: it read `nacre.token` where the console writes
`nacre.admin.token`, reporting no session on a console that had plainly opened;
and it cleared `sessionStorage` without reloading, so the signed-in screen
stayed up and the sign-in form it then looked for was never going to exist.

**A published credential could take itself away from everybody who holds it,
and that was live on the public stand.** The two demo logins the front door
prints could each enrol a second factor and change their own password — which is
the password on the page. Either locks out every other visitor **permanently**:
an administrator deliberately cannot remove somebody's second factor, so the
only repair is to reissue the credential. Found by asking the running stand
rather than by reading: `GET /v1/me/second-factor` answered `200` with both
kinds, and `POST /v1/me/password` answered `403 the current password is not
correct`, which is a live route waiting for the password that is printed.

Until 0.19.0 a deployment had an accidental guard — no `NACRE_2FA_KEY` meant the
whole surface answered `404`. WebAuthn needs no key, so it went away, and
`docs/upgrading.md` said in as many words that a switch to turn the feature off
would be "a switch whose only effect is to make accounts easier to take over".
That is true of an installation and false of an account: the thing being
protected here is already public by design. So the property is a column on the
row it is about — `users.shared`, migration 0032 — and not a setting.

A shared account has **no `/v1/me` credential surface**: no second factor, no
password change, no reset link, all `404` like a service account and a
delegation there. An administrator still sets its password, which is how
whoever published one rotates it — the credentials are *administered* rather
than held, which is the whole of what the column says. It cannot be cleared
afterwards, because clearing it on an account whose password is public reopens
the surface to whoever holds that password.

Three things hold it, and they are deliberately not three copies of one check.
A **trigger** on `user_second_factors` refuses the row whichever surface issued
it, so a route added later and written without the check is a `500` rather than
a lockout. `Login.changePassword` refuses **before** verifying the current
password — checking it first would make the endpoint say whether the published
password is still current, and the point is that it is public. And the routes
answer the `404` a caller can read, through one predicate rather than two
spellings: `holdsOwnCredentials` is the same question a service account and a
delegation were already being asked, with a third class added to it.

`lint:me-credentials` is the repair rather than the two edits. It **discovers**
the `/v1/me` credential routes rather than listing them, so the next one is
covered on the day it is written, and refuses outright if it finds none. Both
refusals were produced: a route that stops asking names that route, and a
surface that moves out from under the pattern says so instead of passing.

`GET /v1/me` carries `holds_own_credentials` so the console can leave those
controls **off** rather than drawing ones that answer `404` — `GET
/v1/auth/methods`'s rule applied to the account instead of to the installation.
The Security screen's "not available on this installation" message would
otherwise have blamed the deployment for a property of the account, sending
whoever read it to check a key that is set.

**And the console could not make one**, which is the same hole one surface
along: the column, the endpoint, the SDK and `nacre users create` all carried
`shared`, and the New user dialog sent three fields that did not include it —
so an administrator's route to a published credential was a command line or
`curl`. The box is on that dialog now, and what it says is written in terms of
what goes wrong without it rather than in terms of the column.

`shared` is in the **listing** too, beside `sso` and `disabled`, and that is
not decoration: it is fixed at creation, so an administrator who ticked it has
no other way to see it again — and it decides whether the person on the other
end can hold a second factor at all, which is exactly the kind of thing a
screen has to be able to say.

**The one screen that hands a value over had no way to hand it over.** "Add an
authenticator" printed a thirty-two character base32 secret in a box with
nothing to press — `user-select: all` is a selection and not a copy, and it
wants a keystroke the person holding a phone does not have — and truncated the
`otpauth://` link to 48 characters with the rest in a `title`, which is a
tooltip and needs a pointer, on the one string whose whole purpose is to be
opened *on a phone*. Every id on every other screen has had a copy control
since the console was rendered at 390.

There is a **QR code** on it now, and it is encoded here.
`packages/admin/src/qr.ts` is byte mode, error correction level M, versions 1
to 40 by capacity, and no dependency: this package's one runtime dependency is
the SDK, the page is `script-src 'self'` so a CDN is not an option, and the
thing being drawn is a credential. The obligation that comes with writing one
is checking it against something that did not come from here — `jsqr`, pinned,
a dev-only dependency of a private package, fed the matrix as pixels with its
quiet zone. Asserting on the matrix would have pinned whatever the encoder
produced on the day it was written.

It found three defects before the first symbol was scannable, and one of them
would have shipped a picture no phone could read at exactly the length this
feature uses. The format-information strip was placed with x and y swapped, and
was written without being *reserved*, so data was laid into it and then masked.
And the alignment patterns were excluded by "this module is already spoken for"
rather than by index — position 6 is the timing line, so from version 7 every
legitimate pattern sitting on it was skipped, and an `otpauth://` URL is
version 7. Restoring that one fails the otpauth case and every case above 120
bytes while the short ones stay green, which is the measurement that says it is
about alignment.

Black on white is the one deliberate exception to `lint:tokens`: a QR is read
by a camera and a threshold, so its two values are a scanning requirement, and
inverting it for a dark theme is how a symbol stops working.

The recovery codes can be **saved** as well as read. They are printed once and
an administrator deliberately cannot restore them, so that dialog is the only
moment they exist outside a hash. The file goes through Web Share where the
browser has it — the public stand learned from an iPhone that Safari does not
save an `<a download>`, it *navigates* to the blob, and here a reload does not
bring the codes back.

Two checks came out of that work and neither is about QR codes. **A dialog
whose action you cannot reach is a dialog you cannot finish**, and that dialog
now carries a picture, a secret, a link and a field before Confirm — a
`<dialog>` scrolls only because the user-agent stylesheet says so, and a
`max-height` written here would take it away. The check's first version set
`scrollTop` and measured, and `overflow: hidden` still honours a *programmatic*
scroll: restoring that rule left every button comfortably inside the viewport
and the check green. It had measured a scroll no thumb can perform, which is
the narrow-projection defect this file names three times, produced inside a
check written the same hour.

**And the stale-bundle guard knew about one of two inputs.** It read
`packages/admin/src`, so `packages/admin/public/admin.css` was invisible to it
— and the stylesheet is where every layout defect that script exists to find
lives. Found by falling into it: a rule added to `.dialog` to prove the new
check could fail changed nothing, because `dist/` still carried the old
stylesheet. What counts as source is discovered now, out of the bundle's own
sourcemap, so the SDK's sources are covered without being named, and a missing
map is a refusal.

**The messages this product sends are in the brand, and both parts come from
one description.** They were plain text, on an argument written in
`mail.ts`'s own header: that each is one sentence and one link, that an HTML
part doubles what has to be escaped, and that a link in an HTML mail is the
shape a phishing filter and a suspicious reader both distrust.

Only the last was ever about the reader, and it is answered rather than avoided
— **the link is shown as its own URL**, beside the button, so somebody can see
where it goes before pressing it. That is more than the plain-text version
offered, where the link was the only thing on its line and nothing said where
it went. The first two are answered by there being one description and one
escaper: a `Message` is a list of blocks and `message()` renders both parts.

A `Message` carries a brand only that module can apply, so a message cannot be
assembled by hand with one part missing — it does not typecheck. That is what
found the **fifth** message while the paragraph claiming there were four was
being written: the count had come from `mailer.send` call sites rather than
from the messages. `packages/api/src/messages.ts` is all of them in one file
now, which is also what lets the preview render the real ones rather than
retyping them.

`lint:mail-palette` is the repair for the one thing an email cannot do. A mail
client resolves no custom property, so those colours are literals — the only
ones in this repository — and the check reads them back out of the brand mirror
the console ships, following one level of `var()`. A colour that moved in the
brand fails here rather than sending last year's teal to everybody who forgets
a password. Each of its three refusals was produced: a drifted value, a colour
naming no token, and the palette moving out from under it.

The renderer is asked what it **computes to**, not only what it says.
`scripts/mail-preview.mjs` renders the product's own list at 390 and reads the
paragraph's colour, size and leading back out of a browser — which is what
caught the defect a string assertion never would have: the brand's font stacks
are spelled with double quotes, and interpolated into `style="…"` that closes
the attribute at the first character of the family name. Every declaration
after `font-family` was dropped. The markup still parsed and nothing threw;
what was lost was the size, the leading and the colour of every paragraph. It
runs in the `console` job, where a browser is already installed.

Writing it also turned up the console's `.warn` reaching for `--n-deny`, which
the brand reserves for one of four permission semantics and says not to
reassign. `--n-error` is the same hex, so the correction is zero pixels and one
fewer place where a permission colour means something else.

**And the harness that was parked has landed.** 0.22.0's pull request said the
seed's four-state check "hangs, and a check that cannot run must not be
committed", and that it would be finished separately. It is `lint:demo-seed`
now, and what was wrong with it is worth more than the check.

It served the stub API with `createServer` in the same process that ran the
seed with `execFileSync` — which **blocks the event loop**, so the child asked
`/v1/ready` and nothing was ever going to answer. Every run died on `waiting for
the API to be ready`, which is the harness *accusing the script* of a fault
entirely its own. That is the shape this file records twice already: a smoke
test that never sent its document and then failed accusing the product, and a
stand check that could not parse a page and reported the deployment down. The
stub is a process of its own now and prints the port it chose rather than being
given one.

The script under test is a **copy** with two substitutions — the two absolute
paths the seed invokes point at stubs — and both are required to apply. A
rename in the seed fails the check by name rather than leaving the stubs
uncalled and every assertion passing against a script that ran nothing, which is
the blanket-exclusion shape `contract-surface.test.ts` was fixed for.

Four states: fresh with a failing ingest, a resume, an already-seeded run that
must call nothing at all, and the ordinary path. Restoring the shipped defect —
the summary written after `load_corpus` rather than before it — fails the first
two and prints the old `Start over: down -v` in the output, which is the
measurement that says this would have caught what the `demo` job could not.
That job runs a real embedder against a real corpus; it cannot ask what is left
behind when the ingest inside it fails.

**The console offered a platform administrator three screens that answer
`404`.** `administers(auth)` in the API is `org_admin` and nothing else — a
`platform_admin` administers the *installation*, and every endpoint scoped to
one organization refuses that role in both directions, which this file already
says. The console decided what to draw with `role === 'org_admin' || role ===
'platform_admin'`, which is the obvious derivation and is the wrong one, so
Grants, People and Service accounts were in the nav for exactly the person most
likely to sign in to check something.

Found by photographing it. The fixture is a `/v1/me` answering `platform_admin`
and the picture is the whole finding — the fourth defect this console has
surfaced that way.

`GET /v1/me` reports **`administers`** now, and it is not a second copy of the
predicate: it *is* the predicate, the one every gated handler calls, saying what
it will do. Same rule as `GET /v1/auth/methods` and `holds_own_credentials` —
ask what the server will do rather than re-deriving it in a browser. The SDK
falls back to `role === 'org_admin'` against an older API, which is the
conservative half of the derivation it replaces and never the half that offered
too much.

`check-admin-gate.mjs` had `packages/admin/src` in its roots the whole time and
could not see this. Its pattern is bound to `auth.` — correctly, and for a
reason written at it: `fields.role !== 'member'` is validating a value, not
gating a request. The console's caller is called `me`, so the one instance it
covered a browser for was the one spelling it could not match. Widening it to
any `.role ===` would flag the People screen legitimately reading a `<select>`,
which is how a check becomes something people work around.

So the second question is asked of the one thing that matters — **what `isAdmin`
is assigned from** — by reading the assignment rather than the file, which is
the technique `check-platform-admin-target.mjs` had to learn when a whole-file
search was satisfied by the prose describing the rule. Both refusals were
produced: the shipped derivation restored, and the gate renamed away.

The console still reads `me.role` on purpose, to choose which *sentence* to
show. `administers: false` cannot tell a member from a platform administrator,
and the screens being absent is worth explaining rather than leaving as a nav
that is simply shorter than expected.

That message sits **outside `main`**, and the first version did not — every view
opens with `clear(root)`, so the screen wiped it on the same turn and the
picture showed the corrected nav with nothing explaining it. Half a fix, caught
by looking at the render rather than by the type checker.

**The access log is on a screen**, which it had not been since the journal
landed. `GET /v1/audit` has been readable, cursor-paged and exportable that
whole time, and `docs/audit.md` opens on "show me which documents your agent
read last quarter" — while the only way to ask was `curl` with an `Accept`
header, or `psql`. The model-offers-it-and-the-product-gives-no-route shape, on
the one surface whose subject is proving what happened.

Core rather than commercial on the boundary's own test: reading your own
organization's log is what a single developer needs the day something looks
wrong, and forwarding it to a SIEM is what a security team buys.

**The nav's `adminOnly` boolean is what the screen broke.** Every screen there
was behind one flag meaning `administers`, which was true of all of them until
this one — `/v1/audit` admits `administers(auth) || administersTenants(auth)`,
two roles seeing two different logs. Under a boolean the screen is either
hidden from a platform administrator the server would have answered, or offered
to a member it would not, and hiding what the server allows is the same defect
as offering what it refuses arriving from the other side. Each route carries the
server's own rule now, as a predicate over what `GET /v1/me` said.

That is also what made the platform administrator's banner wrong the moment it
was written: it said this organization's administrative screens are not here,
and one of them now is.

`actor_id` is deliberately **not a field**, and that is `check-id-fields.mjs`
holding a rule this console already argued. Nobody knows a uuid; a person who
has one copied it out of the list above, which means the list had the answer.
A log is the strongest form of that, because the list *is* the log — every actor
worth filtering on is already on the screen. So pressing an actor narrows to
that actor. The failure mode a field would have had is worse here than the `404`
the rule was written against: a mistyped id returns an empty log, which reads as
"nothing happened".

The control is the **whole** actor, name and id together, and both reasons were
measured rather than reasoned. A second control in that cell would be a 28px
target six pixels from another one, whose grown hit areas overlap — the defect
the sibling stand shipped and had reported from a phone. And making the id alone
pressable put a control 2px under the name above it, which the console's own
headroom pass named by exactly that distance.

**The Result column shipped at three sizes, one per value.** `allow` was the
table's own 15px sans, `deny` a 12px mono chip, and `error` a 10px uppercase
tag — three type sizes for three values of one field. A table is read *down*, so
that reads as three kinds of thing rather than as three values, and it was
reported by somebody looking at the screen. It is one control at one size now,
and only the fill differs: an `allow` still carries none, because it is what
almost every row says and fifty filled pills carry no information while making
the few denials harder to find — and teal is `read` in the permission palette,
which the brand says carries a meaning rather than a mood. An `error` is
`--n-error` rather than `--n-deny`, the same hex and a different statement,
since a deny is the permission model working and an error is this system
failing.

The repair is the check rather than the three edits, and it was **run before the
fix**: `columnValuesAgree` asks of every column of every table on every screen
whether the cells' largest text size agrees. It named exactly the three audit
shots and nothing across the other sixteen screens, which is what says it is a
rule and not a source of noise. Per column rather than per cell, because that is
the comparison a reader makes, and the *largest* size in a cell because a name
with a small `sso` badge beside it is a value and an annotation — the annotation
being smaller is the point of it.

The fixture gained an `error` row in the same change, and that is not decoration:
a fixture carrying two of the three values is a column whose third size nothing
measures.

**And then the pills were three widths.** One size fixed the type and left the
boxes ragged, which is the same defect one step along: a reader going down the
column sees the right edge move and takes it for the values meaning different
amounts of something, when all that differs is how many letters each has. So the
box is as wide as the **longest** value in the set — a decision about the set
rather than about any one value — and `allow` is ringed rather than bare, since
the frame is what makes three states read as one control. Its ring is
`--n-border-color`, because a neutral outcome must not borrow a colour that
carries a meaning.

The width is `calc(5ch + 2 * var(--n-chip-pad))`, and both halves of that are
the point. `ch` is one character in the chip's own mono face, so the number
follows the vocabulary instead of being measured off a screenshot; the padding
is **added** because everything here is `border-box`, and the first version was
a bare `5ch` — narrower than the shortest pill already drew, so it bound on
nothing and the three stayed exactly as ragged while the stylesheet looked like
it had an opinion. Found by measuring in a browser rather than by reading it
back.

`columnChipsAgree` is the check, and it earned itself immediately: it named the
**Grants** screen, which nobody had asked about and which has the same ragged
edge between `read` and `write`. That is the doctrine paying out rather than
being quoted — a general check finding the instance nobody reported.

Fixing that one is what settled the selector. A class the view applies is a
class the next view forgets, so the rule is `.table td > .chip`: **a chip in a
table cell is part of a column**, which the structure already says. It is also
what keeps the width off the two places a chip is not a column — `consent.ts`
sets one inline in a sentence, where a minimum width opens gaps in prose, and a
grant's detail list renders one in a `<dd>`. Neither is reachable by that
selector, which is a fact about the markup rather than an exemption.

The Grants fixture carried two `read` grants, so that column had one width and
nothing to disagree about — the missing-`error`-row gap again, one screen over,
and found the same way: by widening the fixture and watching the check go red
before the rule was written.

**And the Actor column showed a uuid twice and no name.** Reported from the
running stand with the cell circled: `user:172f5522-4f4d-4782-bf03-a3b21313a805`
on one line and `172f55…a805` on the next — the same value in two spellings,
where a person expects an address.

`actor.label` looks like the answer and is not. **Every** writer of an event
builds it as `` `${type}:${id}` `` — checked at each call site rather than
assumed — so that column carries nothing the `type` and `id` beside it do not
already say, and the console was rendering it as the primary line. So the id is
resolved to an email or a service account's name, and where it cannot be — a
deleted account, or a `platform_admin`, whom `GET /v1/users` refuses — the
fallback is the actor's *kind* as a word. Deliberately never the stored label:
falling back to it puts the uuid back exactly where the name was missing, which
is the case this exists for.

**The fixture is the defect rather than a detail of it.** It said
`label: 'dana@example.com'`, a value no server sends, and its actor ids matched
no row in the users listing beside it — so the committed picture showed a
resolved name while every deployment showed hex. That is the
fixture-written-to-match-the-code shape this file names three times, and it
survived a change whose whole subject was that column. It carries what the
server actually writes now, and ids the listings actually contain.

The same untruth was one shot over: `audit-platform-admin` answered
`GET /v1/users` for a role the server refuses it to, so it photographed names
that role never sees. It refuses those three listings now, which is also the
only way the fallback is in a picture at all.

`grants.ts` had the resolver privately and a second view needed it, so it is
`packages/admin/src/names.ts` — a module rather than a copy, because two
resolvers are two chances to disagree about what a disabled account is called.

Three shots, because two of the three states are the argument: the log, the log
narrowed by a press, and the administrative-only log a platform administrator
gets. The middle one is what says the interaction works, which a picture of the
default view structurally cannot.

**The enrolment QR named a URL where an account should be.** An authenticator
showed `https://playground.nacre.work: //playground.nacre….` — the issuer, a
colon, and then the *tail of a URL* standing in for the address, on the one
screen whose whole job is to say which account you are looking at. Reported from
a phone with the app's own list in the picture.

`otpauth://` labels are `issuer:account`, so the colon is the separator and the
key-uri format says neither half may contain one. Percent-encoding is not a way
round it: an app that decodes the path before splitting sees the colon again,
which is what shipped. The API passed `NACRE_JWT_ISSUER`, correctly a URL, into
a field that must be a name.

The argument was already written **three lines further down the same object**:
the WebAuthn relying party takes `canonical.hostname` and says why — "a scheme
or a port in it is a credential no authenticator will make". Two fields with one
rule between them and nothing that knew there were two, which is this file's
first paragraph.

So the issuer is the hostname now, and the repair is a refusal rather than the
one edit: `otpauthUrl` throws on a colon in either half, and `SecondFactors`
makes that call once **when it is constructed** — a deployment that reintroduces
a URL is a container that does not start, by name, rather than a label somebody
lives with for as long as that authenticator exists. Checked by constructing it
both ways: refused on the URL, accepted on the hostname — and then by CI, which
is where it earned itself. It named **five** call sites still carrying a URL:
the three live suites that construct a `SecondFactors`, and both end-to-end
scripts, every one of them written to the wiring as it was. A fixture agrees
with whatever it was written to, and here that was a defect.

The case that existed passed `issuer: 'Nacre'`, a value no deployment produces —
a fixture written to the shape somebody imagined rather than to the one the
wiring sends, which is the defect this file already names three times. It is
asked of the URL and of the hostname now.

Nothing has to be re-enrolled: a code is `HMAC(secret, step)` and the label is
not an input to it. An authenticator enrolled before this keeps working and
keeps its mislabelled entry until somebody removes and re-adds it.

**The console has an extension file, and it is the sixth-and-a-half point.**
`packages/admin` is single-organization by construction — every screen is behind
`administers(auth)`, which is `org_admin` and nothing else — while the
commercial modules mount routes under `/v1/admin/*`. There was no screen for any
of them on either side of the boundary, so a customer who bought multi-tenancy
administered it with `curl`: the model-offers-it-and-the-product-gives-no-route
shape, arriving in the paid half.

Three ways to close it and two are wrong. The core could grow those screens
behind a probe, which puts commercial UI in the open repository and would pass
the `boundary` job, since that job looks for a package name. The other
repository could ship a console of its own, which is a second copy of
`admin.css`, of `dom.ts`, of `pick.ts` and of every layout rule this console
learned by rendering itself in a browser — with nothing that knows there are
two, across a boundary where no check can see both sides. This file's most
repeated defect, at the largest scale it has been available in.

So the console loads **one file** and an image replaces it, which is the shape
`NACRE_MODULES` already gives the API expressed in the only unit a static bundle
has. The open `web` image ships `extensions.js` registering nothing;
`nacre-enterprise-web` is built `FROM` it with that file replaced.

**The contract is a function, not an import**, and that is what makes it
possible with no package published. An extension is *handed* everything it may
use, so nothing in its bundle resolves `@nacre.work/*` — no second copy of
anything, no npm name to own, and no human step before a release. It also makes
the surface countable: `ConsoleKit` is the whole of it. `kit.request` is the
session rather than a second client, rejecting with the same `NacreError` the
SDK does so `explain` still refuses to turn a `404` into "forbidden".

A contract number an extension declares is compared and a mismatch is **said out
loud**, because a nav that is silently shorter than the installation paid for is
the "hiding what the server allows" defect with nothing on the screen to be
wrong about. A hash colliding with a core route is dropped, in the other
direction: a module must not replace Grants with a screen of its own.

**The number earned its keep on the first real change.** `ConsoleKit` was
written from what looked useful, and the first screen written against it — one
that hands a generated password over once — found that `copyControl` was not on
it. Assembling a button around `copyText` would have been a second control with
the same job, which that function's own header says is how one of them gets the
clipboard fallback, the checkmark timing or the accessible name wrong. Found by
rendering the screen and reading the picture: the password came out **truncated
with no visible control beside it**, which is this console's own 0.17 defect in
a new repository. So the contract is 2, and an *additive* change moves it —
an extension built for 2 on a host at 1 finds `undefined` where it expected a
helper, which is the silent failure the number exists to turn into a sentence.

The stub's own number is held against the constant beside the type, because two
literals in one repository with nothing that knows there are two is this file's
first paragraph — and that one fails quietly in the worst way available: the
open image would refuse its own stub and show a self-hoster a banner about
console extensions they do not have.

`check-console-extensions.mjs` drives four states in a browser, because every
part of this is a browser's business — a dynamic import of a same-origin URL
under `script-src 'self'`, a bundler that must not inline the file an image
replaces, and a nav that has to gain an item. A stub of `import()` agrees with
whatever it was written to.

**Its own first version could not fail**, and the way that was found is the part
worth keeping. It asked whether `dist/app.js` contained the stub's body spelled
the way the source spells it — and the build minifies, so that string is never
in the output. The run that was supposed to prove it could fail reported a
different defect entirely, and the reason was that the build in that state had
**failed silently** and left the previous bundle in place: a measurement taken
against an artifact the source did not produce, which is this file's own
stale-bundle lesson arriving inside the check written to hold a bundling
property. It asks the browser whether `/extensions.js` was fetched now. Five
refusals, each produced.

**Two things in the console were found by rendering a screen that is not in this
repository.** The enterprise console loads the `extensions.js` this one ships,
so its screens are drawn by this console's `dom.ts`, `pick.ts` and `admin.css` —
and putting a new one in front of a browser is what showed both.

A `<select>` asking you to choose said `pick a organization…`. The article was
built by hand from the noun, and `organization` is the first vowel-initial noun
any caller passed. Computing it from the first letter would fix that and break
`user`, which the same control takes: `an user`. English articles are not a
function of spelling, so there is no article — the label beside the control
already names the thing.

And a **disabled button looked exactly like a working one**: there was no
`:disabled` rule in `admin.css` at all, so a disabled primary button rendered in
full teal and a press did nothing. The rule that breaks is written three lines
above `.picked` and is about a select with one option — *"a control that cannot
be operated still invites operating it"* — held in one place and nowhere else,
which is this file's first paragraph.

`lint:admin-layout` gained a fourth rule for it, and it asks **every** `.btn`
variant rather than the base class: a variant that paints its own background and
brightens on hover needs the disabled form to win there too, so the check pairs
each `:hover` that paints with a `:disabled:hover` that covers it. Both refusals
were produced — the rule removed entirely, and the hover half removed alone,
which names all three variants.

**Writing it exposed that rule 2 could not fail.** The hover-reveal rule
collected every `:hover` rule with a non-zero opacity and never asked whether
anything was hidden — and no `:hover` rule in this stylesheet set an opacity, so
the list was always empty. The first legitimate one, `.btn:disabled:hover`, was
reported as a control a phone can never reveal. It requires a matching
`opacity: 0` rule now, which is the relationship the other half of the same rule
already used. The narrow-projection shape this file names three times, in a
check written against it.

**A second full audit swept the tree, and the worst of it was on the paths a
suite structurally cannot see.** The refresh path could deadlock the whole API:
`issue`, inside the transaction the refresh and password-change paths hand it,
awaited a `required()` that opened a second pool connection — and `createPool`
sets no `connectionTimeoutMillis`, so twenty concurrent refreshes each held one
connection and waited forever for a twenty-first. The connection is threaded
now, and a `max: 1`-pool test proves a refresh completes where it used to hang.
Delete → re-ingest identical content left a live document invisible forever —
resurrection matched no requeue predicate, so the row went back to `indexed`
while its points kept the tombstone's `deleted: true`, invariant 5's mirror
image answering `unchanged: true`; resurrection always requeues now, and resets
the collector's columns, or the next delete of a once-purged document never
reached the sweep. `source_type` moves with `source_ref` — written once at
INSERT, a document re-sent as a different kind was dispatched as the old one,
up to indexing an object key as the document body. The collection copy had no
claim: every replica's tick started the same copy, which begins by deleting its
target — it is a lease plus a fencing token now, renewed from the copy's own
progress, `finishCopy` refuses a token that is no longer the holder's, the
embedding pass holds during a copy like ingest does, and `repairAfterCopy`
requeues or re-tombstones what moved under the scroll. The background clocks
tick while the queue is busy — they lived only in the idle branch, so a
sustained backlog starved reaping, collection, the reindex an operator watches,
and retention.

The password-reset endpoint was a timing oracle — it awaited the SMTP round
trip before its `204`, so the one route needing no credential told an attacker
which addresses have accounts; the answer now comes before the work, proved by
a stub whose send never resolves. A locked TOTP factor renewed its own lock on
every attempt, the correct code included. A malformed percent-escape in any
path segment was a `500` and a spurious `error` audit row; segments decode
inside `pathMatch`, eslint refuses a bare `decodeURIComponent`, and a
contract-wide case drives `%ZZ` through every parameterised operation. A
cursor from one collection pasted into another died in a type cast; the id
shape is a required argument now.

**And `ping` was answered on STDIO and 404'd on Streamable HTTP for the whole
life of both**, because the parity suite's table guard compared `SHARED`
against a literal — nothing in the file ever read either dispatcher, and the
literal even pinned the table shut: adding `ping`, the fix, made the guard red
until the literal moved too. The guard reads both dispatch switches' own case
arms now, the hand-built `CallToolResult` copies became one builder in
`results.ts`, and `check-test-clock` matches the inline `new Date()` spelling
that behaved exactly like the flake it exists against. The screenshot pass's
`/v1/me` fixture was a body no server sends, and nothing anywhere held the
SDK's `administers` mapping in the one direction where the field and the
legacy derivation disagree — `client.test.ts` pins both directions now,
because no screenshot can separate them where they agree.

Every fix in that round was measured red with the defect restored and green
with it in place — including two checks whose own first versions could not
fail and were caught the same way, in the same session that wrote them.

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
