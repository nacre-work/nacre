# Upgrading

What to do when a release comes out. The procedure is the same every time; what
changes is the per-version section at the bottom, and that is the part to read
first.

Pre-1.0, so **any `0.x` release may break something** — see
[SECURITY.md](../SECURITY.md). Security fixes ship only for the latest `0.x`, so
a deployment that stays behind stops receiving them. There is no long-term
branch to sit on yet.

## What a release is

A version is a string that every publishable `packages/*/package.json` agrees
on. Merging that agreement to `main` **is** the release — there is no tag to
push and no button to press. The pipeline publishes to npm first and writes the
`v{version}` tag and the GitHub release afterwards, so a tag that exists is a
tag whose artifacts exist.

What comes out of one release:

| Artifact | Where |
|---|---|
| `@nacre.work/core`, `@nacre.work/api`, `@nacre.work/mcp`, `@nacre.work/sdk` | npm, at the same version |
| `ghcr.io/nacre-work/nacre:{version}` and `:latest` | api, mcp, worker and the migrator — one image, four entry points |
| `ghcr.io/nacre-work/nacre-parser:{version}` and `:latest` | the Python sidecar |
| `ghcr.io/nacre-work/nacre-embedding-adapter:{version}` and `:latest` | the hosted-embeddings sidecar, `hosted` profile only |

`@nacre.work/worker` and `@nacre.work/admin` are `private` and deliberately not
on the registry: the worker is reached through the image's entry point and the
admin UI is a static bundle the `web` front door serves, so neither is something
an application installs. `@nacre.work/sdk` is the one an application does — it
moves with the rest, and a client older than the API is fine for anything the
contract did not change.

Commercial modules are released separately, from `nacre-enterprise`, as tarballs
on a GitHub Release there. They declare the core as a **peer** dependency at a
range — so the core and the modules move together, and a core outside that range
is a refusal at install time rather than a subtle failure at runtime.

## The short version

```bash
# Compose
git pull                              # or edit the image tag you pin
docker compose --profile full pull
docker compose --profile full up -d   # migrate runs first; api/mcp/worker wait
```

```bash
# Helm
helm upgrade nacre nacre/nacre -f values.yaml --set image.tag=0.4.0
# the migration Job is a pre-upgrade hook; it completes before any pod is replaced
```

Then read [the checks](#after) below. If either command's migration step fails,
**stop** — the section on [when a migration fails](#when-a-migration-fails) is
the one that matters, and starting the new code anyway is the mistake this
document exists to prevent.

## Migrations run first, and nothing checks that they did

Both deployment shapes enforce the order structurally:

- **Compose** — `migrate` is a one-shot service in every profile, and api, mcp
  and worker each carry `condition: service_completed_successfully` on it. It is
  a separate service rather than a step inside the API on purpose: three
  replicas racing to migrate means two of them report a failure that is not one.
- **Helm** — the migration Job is annotated `helm.sh/hook: pre-install,pre-upgrade`
  at `hook-weight: "-5"`, so it runs and completes before any Deployment is
  updated. `hook-delete-policy: before-hook-creation` removes the previous Job so
  an upgrade is not blocked by an immutable object; a **failed** Job is
  deliberately kept, because `kubectl logs` on it is the whole diagnosis.

Outside those two shapes the order is yours to enforce, and there is now one
safety net:

> **`/v1/ready` refuses while the schema is behind the image.** It compares the
> migrations this build ships against `schema_migrations` and reports
> `schema: false` — so a pod started against an unmigrated database is `503`
> and never enters rotation, instead of reporting ready and failing every
> request. Under an orchestrator that is the difference between a rollout that
> halts and one that replaces working pods with broken ones.

A database that is **ahead** stays ready, which is the middle of a rolling
upgrade: the migrator has run for the newer build and the old replica has to
keep serving. Only what the running build ships and the database lacks counts.

The missing migration's name goes to the log and never into the response —
`/v1/ready` is unauthenticated, and a probe does not need to be told which
migration a deployment is missing.

This is a check, not a handshake: it says the schema is at least as new as the
code, and nothing stops you starting an old build against a new schema. The
per-version notes below say which releases that is safe for.

## What the migrator does

`node packages/core/dist/migrate-main.js`, the same image as everything else.

- **Forward-only. There is no down path** — no `--down`, no revert file, no
  generated inverse. Getting back to a previous schema is a restore, which is
  why [rolling back](#rolling-back) is a section about backups rather than about
  a command.
- **Idempotent.** Every already-recorded file is skipped; a re-run on an
  up-to-date database applies nothing and prints
  `{"msg":"migrations complete","applied":0,...}`.
- **Each migration and its ledger row commit together.** A failure rolls that
  one back and stops, so the database is never left holding a migration the
  ledger does not know about.
- **An applied migration cannot be edited.** The text is checksummed; changing a
  file that has run anywhere is refused by name, because the databases that
  already ran the old text would never receive the change.
- **`lock_timeout` is 10 s per migration**, so a migration needing an
  `ACCESS EXCLUSIVE` lock waits behind a long-running transaction for ten
  seconds and then gives up rather than queueing behind it and blocking every
  reader in the meantime. A `55P03` is not a broken migration — it is a lock it
  could not get, and re-running once the holder is gone is the whole remedy.
  `statement_timeout` is deliberately not set: a migration that legitimately
  takes minutes should be allowed to.

### The role, and why a wrong one only bites at upgrade time

The migrator connects as the role in `NACRE_PG_URL`, and that role must be a
**superuser or hold `BYPASSRLS`**. Several migrations read tenant tables; every
tenant table is `FORCE ROW LEVEL SECURITY`, which applies the policy to the
table's *owner* too, and the policy reads `app.current_org` — unset during a
migration.

The migrator refuses up front, naming the provisioning it needs. It is worth
knowing exactly when that refusal happens:

> **The privilege check runs only when there is something to apply.** A re-run
> against an up-to-date database is a no-op whatever role it connects as. So a
> deployment provisioned with the wrong role can migrate cleanly for months and
> fail on the first release that adds a migration.

If you are seeing that refusal for the first time during an upgrade, nothing is
broken and nothing has been half-applied — the check is before the first
statement. Provision the role and re-run:

```sql
ALTER ROLE <the role in NACRE_PG_URL> BYPASSRLS;
CREATE ROLE nacre_worker NOLOGIN BYPASSRLS;              -- if it does not exist
GRANT nacre_worker TO <the role in NACRE_PG_URL> WITH ADMIN OPTION;
```

`WITH ADMIN OPTION` is required and plain membership is not: migration `0008`
grants `nacre_worker` onward to `nacre_app`, and only a member holding ADMIN may
do that.

This is **not** the role the application connects as. The three roles and what
each may do are in [config.md](./config.md); the short form is owner → migrations
only, `nacre_app` → API and MCP with RLS applying, `nacre_worker` → the worker's
queue. In Helm the Job takes `postgres.migrations` and the workloads take
`postgres`, and the chart refuses if the Job is enabled and the second is unset.
Deployments with one role for both set `reuseApplicationCredential=true`
explicitly — it is an opt-in, never a fallback.

### When a migration fails

1. Read the message. It names the migration and says whether it was rolled back.
2. `55P03` — a lock it could not get. Find the holder
   (`SELECT * FROM pg_stat_activity WHERE state <> 'idle'`), let it finish,
   re-run. Nothing was applied.
3. The privilege refusal — provision the role above and re-run. Nothing was
   applied.
4. Anything else — the failing migration is rolled back, the ones before it are
   committed and recorded. **Do not start the new code.** The previous version's
   code against a partially-migrated schema is the state with the fewest
   guarantees. Roll the image tag back to the running version, which is safe as
   long as the migrations that did apply are additive, and open an issue with
   the message.

In Helm the failed Job is kept on purpose; `kubectl logs job/<release>-migrate`
is the message. `backoffLimit` is 3 and there is no `activeDeadlineSeconds`, so
a genuinely slow migration is not killed for being slow.

## Rolling back

**Rolling the schema back is a restore, not a command.** Take the backup
[backup.md](./backup.md) describes before an upgrade, not after it goes wrong.
That page also says the part that is not obvious: the database is dumped
*before* the bucket is copied, because ingest writes a document's bytes before
its row.

Rolling the *code* back while leaving the schema forward is safe **only** where
every migration in between was additive. This is a per-release fact and it is in
the per-version notes below; the shape to look for is a migration that drops a
column, tightens a `CHECK` or a unique constraint, or adds a `RESTRICTIVE` RLS
policy. Old code meets those as errors, not as missing features.

Three things move on a clock rather than on your command, and each closes a door
behind it:

- **`NACRE_COLLECTION_RETENTION_DAYS`** (default 7) is a *rollback window*, not
  a tidiness delay. The cheap way back from a layer reindex is moving
  `organizations.vector_collection` to the previous collection, and that works
  only while the previous collection still exists. The worker also reclaims the
  superseded vector slot inside the surviving collection on the same window, and
  that half is not reversible. See the reindex rollback runbook for the four
  states.
- **`NACRE_GC_GRACE`** (default 3600) is how long a deleted document's points
  survive before the collector purges them. A code rollback during a purge
  backlog is fine; the purge itself is not undone.
- **`NACRE_AUDIT_RETENTION_DAYS`** (default 400, floor 30) prunes the access
  log hourly. Deletion is irreversible and the retention floor is refused at
  startup rather than clamped.

## Mixed versions during the rollout

In Helm, api and mcp roll normally, so **two versions of the API answer requests
at the same time** for the length of the rollout. That is fine for an additive
release and is the thing to think about for one that changes a response shape —
a client can see both.

The worker uses `strategy: Recreate` deliberately: a rolling update would
briefly run two versions claiming from one queue.

In Compose there is no rollout — `up -d` replaces containers.

## After

```bash
curl -fsS localhost:8080/v1/health          # liveness, touches no dependency
curl -fsS localhost:8080/v1/ready           # postgres, qdrant, redis, s3
docker compose logs migrate | tail -1       # {"msg":"migrations complete",...}
```

Then drive one real thing rather than trusting the checks: a search that returns
a known document, and an ingest that reaches `indexed`. Both surfaces —
`/v1/search` and the MCP tool — because they are two code paths and a release
has broken one of them before.

`/v1/ready` returning 200 now covers the schema as well as the dependencies,
which is most of what used to make it weak. It still cannot tell you that a
release behaves the way you expect — that is what driving one real search and
one real ingest is for.

---

## Per-version notes

Each section says what the version asked of an operator. A release that asked
nothing says so.

### 0.12.0 — three documents moved in the contract, not in the server

**Nothing to do**, no migration and no new configuration. 0.11.0 runs against
this database, so rolling back is safe. Nothing the server does changed.

What changed is `docs/openapi.yaml`, and it is worth a line because a generated
client may have been wrong. The contract declares one server,
`https://nacre.work/v1`, and `/metrics` and both `/.well-known` documents are
served at the **origin root** — with no per-path override, a client generated
from the contract asked for `/v1/.well-known/jwks.json`, which is under the
authenticated surface and answers `401`. Not 404: the address exists as far as
the auth gate is concerned, and it demands a credential.

If you generate a client from this file, regenerate it. If you fetch those
three by hand, you were already using the right addresses — they are what the
`WWW-Authenticate` header on every 401 has always named, and what RFC 8615
fixes for a well-known document.

### 0.11.0 — the hosted-embeddings sidecar has an image

**Nothing to do**, no migration and no new configuration. 0.10.0 runs against
this database, so rolling back is safe.

`ghcr.io/nacre-work/nacre-embedding-adapter` is published from this release
onwards. The service shipped in 0.8.0 and its Dockerfile was built by CI on both
architectures from the day it was written — and named by no release step, so
there was no artifact to pull. `docker compose --profile hosted` built it from
source and hid that; anything not building from source could not have hosted
embeddings at all.

Nothing about the service changed. If you are on the `hosted` Compose profile
you can keep building it or start pulling it; if you deploy any other way, this
is the release that makes the profile available to you.

`lint:images` is what stops the next Dockerfile arriving the same way: every one
under `docker/` must be named by a step that pushes, and every image pushed must
be in the loop that reads its manifest back and asserts both architectures.

### 0.10.0 — nothing to do, and generated passwords got stronger

**No migration and no new configuration.** 0.9.0 runs against this database, so
rolling back is safe.

**Every password this product generates is stronger, and existing ones are
unaffected.** There were two generators — one beside `init` and one behind
`POST /v1/users` and `POST /v1/users/{id}/password` — with two different word
lists, so the same product minted credentials at two strengths depending on
which door they came through:

| | words | strength |
|---|---|---|
| `init` | 60 | 41.9 bits |
| the user endpoints | 28 | **35.3 bits** |

The weaker one is the door an administrator onboards a colleague through. There
is one list now, at 71 words and 43.4 bits, and the number is computed from the
list rather than written in a comment — the old comment claimed "roughly 70".

**Nothing to do.** A password already in use keeps working: this changes what
new ones are drawn from, not how any of them are stored or checked. Online
guessing was bounded three ways already — per address, per client, and by the
cap on concurrent scrypt calls — so 35 bits was not a live hole; the number that
improved is the offline one, against a stolen `password_hash` column.

If you would rather not wait for the next rotation, `POST /v1/users/{id}/password`
issues a new one at the new strength.

**An organization slug is checked in one more place**, and it is a place a
self-hosted installation never reached: `provisionOrganization` refuses a slug
that is not 2–40 lowercase characters before it writes anything. `init` already
refused those, so nothing that worked stops working — the check moved so that a
caller which is not a CLI cannot skip it. Uppercase is the case that mattered:
`organizations.slug` is `citext` and the collection name is not, so `ACME` over
an existing `acme` would have found the row and left a second, empty collection
behind.

### 0.9.0 — nothing to do, and one defect worth knowing about

**No migration, no new configuration, and no behaviour an existing installation
will notice.** 0.8.0 runs against this database, so rolling back is safe.

What changed is where provisioning lives: creating an organization is one
function in `@nacre.work/core` now, and the `init` command is a caller rather
than the definition. The command's arguments, output and idempotency are
unchanged.

**The defect that move found affects installations with more than one
organization.** The installation default embedding provider — the
`embedding_providers` row with a `NULL` `org_id` — is created once and reused
by every organization after it. `init` was ignoring the model it was handed
whenever one existed, but still building the new organization's Qdrant
collection out of `NACRE_DEFAULT_EMBEDDING_MODEL` and
`NACRE_DEFAULT_EMBEDDING_DIM`.

So if you changed either of those between running `init` for one organization
and running it for another, the second organization has a collection whose
named vector no layer will ever write to. The worker takes that name from
`layers.provider_id`, so **every document in that organization fails in the
worker forever while the API reports `queued`**.

Whether you are affected:

```sql
SELECT o.slug, o.vector_collection, p.model, p.dimensions
  FROM organizations o
  JOIN layers l ON l.org_id = o.id AND l.deleted_at IS NULL
  JOIN embedding_providers p ON p.id = l.provider_id
 WHERE o.deleted_at IS NULL
 GROUP BY 1,2,3,4;
```

Then ask Qdrant which named vectors each of those collections actually has —
`GET /collections/{name}` — and compare against `v_{model}_{dimensions}` with
every character outside `[A-Za-z0-9]` replaced by an underscore. A collection
missing the slot its layers name is the case.

The repair is `rebuild-collection --org {slug}`, which reads the real collection
name and the per-layer slots from Postgres, recreates the collection with them,
and requeues every live document. It re-embeds, so it costs what a first ingest
of that organization cost.

**It refuses while the collection is still there**, deliberately — rebuilding
over a live one deletes every vector in it, and that refusal is what stops the
command being run against a healthy organization by mistake. Here the collection
does exist and holds nothing worth keeping, since no document in it was ever
indexed, so drop it first:

```bash
curl -X DELETE "$NACRE_QDRANT_URL/collections/$(psql "$NACRE_PG_URL" -tAc \
  "SELECT vector_collection FROM organizations WHERE slug = 'the-slug'")"
node packages/api/dist/rebuild-collection.js --org the-slug
```

Stop the worker first, as `runbooks` say for every rebuild: a running worker and
a recreated collection is a race.

New organizations created from 0.9.0 onward get a collection named after the
provider they actually resolved, and `init` now says so out loud when the
installation default differs from what the configuration asked for.

### 0.8.0 — embeddings from a hosted API, and a collection that can be sharded

**No migration.** The schema is unchanged, and 0.7.0 runs against this database,
so rolling back is safe.

**Nothing is required.** Both of this release's features are off unless a
deployment asks for them, and an installation that changes nothing behaves
exactly as it did.

**`NACRE_QDRANT_SHARDS` and `NACRE_QDRANT_REPLICATION_FACTOR`**, both defaulting
to `1`, are what a Qdrant collection is created with. They are **fixed at
creation** — a collection cannot be resharded — so they decide the shape a
deployment lives with, and changing either afterwards means building a new
collection and copying every point into it. That is not impossible: the copy is
what a model migration already does, moving every point without recomputing
embeddings. It costs an organization-wide copy and the disk to hold both
collections at once.

Left at `1` they are omitted from the request entirely, so a collection this
version creates is byte for byte what 0.7.0 created. Set them when the cluster
exists and not in anticipation of one: shards above 1 on a single node buys
segments and no parallelism, and a replication factor above the number of nodes
cannot be met — Qdrant accepts the number and the collection stays
under-replicated.

They apply to what the process **creates** — a new organization's collection, a
model migration's target, a `rebuild-collection` — and to nothing it reads. So
raising them affects the next collection and never an existing one.

**A new Compose profile, `hosted`,** is `minimal` plus an adapter that routes
embeddings to a vendor's API — for a laptop with no GPU, where the honest
alternative was "run one".

Read this part before turning it on: **routing a model there means the text of
your documents leaves your installation.** That is the opposite of what this
product otherwise is, so it is never on by accident. There is no default vendor
and no default endpoint; an unrouted model is refused by name rather than
falling through to whichever vendor happens to be configured; with no routes at
all the container refuses to start; and it is **absent from the `airgapped`
profile** rather than disabled in it, so that profile keeps its rule by
construction. `docs/config.md` has the whole surface.

Routing needs no schema change: the request already carries `model`, and
`embedding_providers.model` is the routing key. Point a provider's `endpoint` at
`http://embedding-adapter:8091`. Two organizations can sit on two vendors with
nothing new.

You may not need it at all — anything already speaking OpenAI's embeddings
contract works by pointing `embedding_providers.endpoint` straight at it, and
always has.

**`NACRE_PARSER_ALLOW_PRIVATE_URLS` is documented for the first time**, and it
has existed and been read by the parser since binary ingest. It is off unless
literally `true`, and it decides whether ingest-by-URL may reach a private
address — so where it is set, any tenant who can call `POST /v1/documents` can
make that container read the cloud metadata endpoint or the API beside it.
Nothing changed in its behaviour; it was invisible because the check holding
`docs/config.md` against the code could not see Python. Worth confirming you did
not set it.

### 0.7.0 — a delegation can be restricted to reading

**Run the migrator.** Migration 0026 adds one nullable column to
`oauth_consents` with two CHECKs. Nothing existing changes meaning: `NULL` is
"no ceiling", which is what every delegation written by 0.6.0 has.

**The consent screen now asks what an application may do**, not only which
layers it may reach. Two tick boxes, and only *Search and read documents* is
ticked — a person connecting an MCP client means "let it search", and a screen
whose default is everything is a screen nobody reads.

Anyone who connected an application under 0.6.0 keeps what they had: no ceiling,
so the delegation reaches every verb its person holds. Re-approving the same
application replaces the answer rather than adding to it, so reconnecting is how
somebody narrows a connection they already made.

**The two are a set, not a level.** `write` does not imply `read` anywhere in
this model, so a delegation restricted to writing can ingest and cannot search
what it ingested. That is deliberate and it is what rule 6 exists to express.

**`admin` is a ceiling value and is not on the screen.** The MCP surface has no
administrative tool, so the choice would do nothing where the person is looking
and a great deal through the REST API, where they are not. It stays available
through `POST /v1/oauth/consent` for an `org_admin` who deliberately wants an
administrative delegation — it is not an escalation, since a ceiling cannot
exceed what its person already holds, and it stops when they are disabled, which
a service account key does not. `docs/openapi.yaml` says both halves.

**`initialize` now carries `instructions`**, the MCP field for "how to use this
server". Nothing to configure. A client that ignores the field is unaffected;
one that reads it hands its model the things worth knowing — that `404` here is
deliberate, that an empty search result is an answer rather than an error, and
that a delegated connection may have been narrowed by the person who approved
it.

**If you build against the SDK**, `Connection` gained `permissions` and
`consent()` gained an optional `permissions`. Both are additive.

### 0.6.0 — an application can act as the person who approved it

**Run the migrator.** Migration 0025 adds one column to `oauth_consents` and to
`oauth_authorizations`, relaxes a `NOT NULL` on each, and creates
`oauth_consent_layers`. Nothing existing changes meaning: `acts_as` defaults to
`service_account`, which is what every connection written before this release
is.

**Nothing else to do**, and nothing you have stops working. Every existing
connection keeps acting as its agent, every issued token keeps verifying, and
every refresh token keeps rotating.

**What is new is that a member can now complete the consent flow.** It used to
offer only a service account, and both listing and minting one are `org_admin`
— so anybody else who followed an MCP client's link reached a screen they could
not use. Approving as yourself is now the default: the application acts as you
and reaches exactly what you reach, recomputed from `grants` on every request. A
person may restrict it to chosen layers at consent.

**One behaviour changes for an operator, and it is worth knowing before you
need it.** `disabled` has meant "cannot sign in" and not "cannot act". On this
path it now means both: disabling a person suspends every delegation they have
approved, with `401`, on the next request. It is a **suspension** and not a
revocation — the grants survive, the refresh tokens are not spent, and
re-enabling them restores every connection without anybody reconnecting.

So disabling a departing colleague now also stops the applications they had
connected, which is almost certainly what you wanted it to do already. Service
accounts are unaffected: an agent belongs to the organization, not to a person.

**If you build against the SDK**, `Connection.serviceAccountId` and
`serviceAccountName` are `string | null` — a delegation names no agent — and
`Connection` gained `actsAs` and `layers`. `consent()`'s `serviceAccountId` is
optional now; omitting it is what makes the approval a delegation.

**If you run a split deployment**, nothing to configure. The MCP transport
verifies delegated tokens through the same code path as the API, from the same
database, and needs no key it did not already have.

### 0.5.8 — a scanned PDF stops reporting success

**Nothing to do**, unless you have documents that were accepted and index
nothing — see below.

**A PDF with no text layer is refused now.** It used to be accepted: the
extractor returned an empty string, the chunker made nothing of it, the worker
wrote no points, and the job reported `indexed`. The document was in the
database, returned by no search, and the only trace was a `chunk_count` of zero
that nothing reads. It now lands in `failed` with a reason that says it is a
scan and that this build does no OCR — because the remedy is not a re-upload.

**Look for the ones already in.** A document that reports `indexed` with
`chunk_count: 0` is either an empty file or one of these:

```sql
SELECT id, external_id, title FROM documents
WHERE deleted_at IS NULL AND chunk_count = 0;
```

Re-ingesting one now gives the refusal instead of the silence. Nothing is
migrated automatically: the rows are not wrong, they are just empty, and
deciding what to do with a scan somebody uploaded six months ago is not a
choice this release should make for you.

**The parser sidecar's one dependency changed**, from `pypdf` to
`pdf-inspector`, and the argument is in `services/parser/requirements.txt`
rather than only in a commit message. It reverses a stated position — that file
had "pure Python, no native parsers" as its first line — so it is worth reading
before the next person is surprised by it. In short: it is a compiled Rust
extension, a memory-safe parser fails by panicking rather than by corrupting a
heap, and it answers the question pypdf structurally cannot. Both were run
against the same inputs first, including the shapes the old pin was about, and
nothing the parser relied on was given up.

**`metadata` on a PDF gains `pdf_type` and `pages_needing_ocr`.** The second is
what makes the partial case visible: a fifty-page document with forty scanned
pages extracts the other ten and would otherwise report success with four fifths
of it missing.

**A parse failure now carries the sidecar's reason** into the job's `error`
column. It carried the status alone — `the parser answered 422` — which is a
refusal nobody can act on. If anything of yours parses job errors, the string is
longer and ends with `(parser answered NNN)`.

### 0.5.7 — one address instead of three

**Compose now serves everything on the `web` port**, `8082` by default: the
console, `/v1`, `/oauth`, `/.well-known` and `/mcp`. The API and MCP ports stay
published and keep working, so nothing breaks — this adds an address that works
rather than removing ones that did.

**What it is for.** 0.5.6 documented three values that have to name a reachable
host, and two of them could not be derived from a request: the OAuth issuer is a
value, and the consent redirect knows the host a browser used but not the port
the console is published on. Each failed at a different step of the same flow
with a different unhelpful message, and one of them sent the *browser* to the
operator's own machine. Behind one origin all three are the same string, so
there is nothing left to get out of step. It is also what the Helm chart's
ingress has always done — the Compose stack was the odd one out.

**For a Compose deployment**, after `docker compose pull && docker compose up -d`:

- Point `NACRE_CANONICAL_URL` at the **web** port rather than the API's:
  `http://your-host:8082`. This is the one value that has to be right.
- **Remove `NACRE_OAUTH_CONSENT_URL`.** It now defaults to `/#/consent` on the
  canonical URL, which is the same origin that serves the console. The stack no
  longer sets it either.
- Leave `NACRE_MCP_CANONICAL_URL` unset, as in 0.5.6.
- An MCP client can move from `http://your-host:8081/mcp` to
  `http://your-host:8082/mcp`. Both work; the second is the one where discovery,
  the token endpoint and the consent screen are all on the origin the client
  already reached.

**For Helm: nothing to do.** The ingress already routed `/mcp` ahead of `/`. The
chart passes `NACRE_MCP_UPSTREAM` to the console pod now so the image behaves the
same everywhere — relevant only to a deployment fronting that Service itself
rather than through this ingress, where the route would otherwise proxy to a
Compose service name.

**If you front the stack with your own proxy**, `/oauth` and `/mcp` join `/v1`
and `/.well-known` as paths that have to reach the right process.
`docker/nginx.conf.template` is the worked example.

### 0.5.6 — one line to remove from `.env`, if you copied the example

**No image changed.** The code is 0.5.5's; this release exists because the fix
is in a file an operator copies rather than in one they pull, so upgrading the
containers does not deliver it.

**Remove `NACRE_MCP_CANONICAL_URL` from your `.env`** unless a proxy rewrites
`Host` and the public name is one the server cannot see. `.env.example` seeded
it as `http://localhost:8081`, and every deployment that started from
`cp .env.example .env` has it.

Pinned, the MCP transport names that value as the `resource` in its RFC 9728
document. RFC 9728 has the client compare the identifier against the URL it
actually connected to, so anybody reaching the stack at `10.8.0.1` or a hostname
is refused — **before** a token is sent, which reads as a broken server rather
than as a misconfiguration. Unset, the document follows the `Host` each client
used, which is what the identifier is for.

`docker-compose.yml` sets no `NACRE_MCP_CANONICAL_URL` on the `mcp` service and
explains at length that the absence is the fix. That was true of the service
block and false of the stack: `env_file: .env` is on the shared anchor, so the
line arrived anyway. `pnpm lint:compose` now renders the stack with
`.env.example` in place as `.env` and fails if the variable reaches the
container, because the previous guarantee was a comment.

While you are in that file, two addresses have to be reachable from somewhere
other than the server, and `localhost` is right for neither once a client is
elsewhere:

- **`NACRE_CANONICAL_URL`** — the OAuth issuer, and so what the discovery
  document names as the authorization server. A client told `localhost` looks on
  its own machine and finds nothing.
- **`NACRE_OAUTH_CONSENT_URL`** — where `/oauth/authorize` redirects the
  *browser* to pick the agent. Compose defaults it to
  `http://localhost:8082/#/consent` and cannot do better: the redirect knows the
  host the browser used but not the port the admin UI is published on. It is the
  one step of the flow that no amount of `Host` derivation fixes, and the
  easiest to miss because a browser follows it rather than a client.

Both are one edit each and both fail the same way — a step of the OAuth flow
that lands on the operator's own machine.

### 0.5.5 — an MCP client can actually connect, and the admin UI is an image you can deploy

**Nothing to do.** No migration, no new variable, no changed default. Everything
below is a defect fixed in place; upgrade the images and the client that could
not connect will.

**The MCP handshake offered a revision no client speaks.** `initialize`
answered with the newest revision this server knows — `2026-07-28` — whenever
the client proposed anything not on its list, and `2025-11-25` was not on that
list. `2025-11-25` is the newest revision the MCP SDK knows, so it is what every
shipping client proposes: each one was handed `2026-07-28`, found it absent from
its own `SUPPORTED_PROTOCOL_VERSIONS`, and failed with
`Server's protocol version is not supported: 2026-07-28`.

Two things were wrong and both are fixed. `2025-11-25` is in the supported list,
so the common case is now an echo rather than a counter-offer. And a
counter-offer is now always a **legacy** revision: anything arriving on
`initialize` is a legacy client by definition, and the specification's own
compatibility matrix says that generation has no fall-forward mechanism — it
speaks what it is told or it fails. Offering it the newest revision was offering
something it could not take.

The STDIO transport had the same defect one step further along: it answered the
newest revision unconditionally, without reading the proposal at all.

**`server/discover` is served, on both transports.** It is a MUST in
`2026-07-28` and the modern era's opening move — a client that sends no
`initialize` learns the version list and the capabilities from it instead. On
stdio it is also the probe a dual-era client uses to tell the two eras apart, so
a server without it reads as legacy.

**A path the MCP transport does not serve now answers HTTP, not JSON-RPC.** A
client with no token reads the protected-resource document; if it finds no
authorization server named there it falls back to treating the MCP origin as
one and posts a registration request to `/register`. That got a JSON-RPC
envelope, which is not an RFC 6749 error, and the client surfaced
`HTTP 404: Invalid OAuth error response: ZodError: …` — a parser complaint in
place of an explanation. Those paths now answer `{ error, error_description }`,
and the description names where the authorization server actually is.

**`/oauth/authorize` sent the browser to a page with no way to approve
anything.** `NACRE_OAUTH_CONSENT_URL` ends in `#/consent` — the admin UI is
hash-routed, so that fragment *is* the route — and the handler assigned the
fragment rather than appending to it. The browser arrived at
`#response_type=code&…`, the router saw no route, and the person got the default
view with the whole authorization request intact in the URL. The consent
screen's own parser reads `#/consent?…`; the two halves were written to
different assumptions and nothing put them side by side until the flow was run
end to end with a real client.

**`serverInfo.version` reported `0.0.0`.** Both transports carried the field,
threaded it through an option, and neither entry point ever passed a value.

**A third image: `ghcr.io/nacre-work/nacre-web`.** `docker/Dockerfile` has had a
`web` stage — nginx serving the built admin bundle and proxying `/v1` to the API
— since the Compose stack grew a front door. Compose built it locally; the
release workflow built the file with no `target`, so it pushed the node runtime
and nothing else, and the image never existed.

That is why the Helm chart did not deploy the console. The reason recorded in
the chart's README was that a deployment might reasonably front it differently —
true of the API too, which the chart does deploy. An omission wearing a
rationale.

**Nothing to do for a Compose deployment**, which builds the stage locally and
always did.

**For Helm**: the chart deploys it now, `web.enabled` defaults to true, and the
ingress routes `/` at the console rather than at the API — the console proxies
`/v1` and `/.well-known` onward, which is what makes the browser's requests
same-origin. With `web.enabled=false` the ingress routes `/` at the API exactly
as before, so a deployment that serves the bundle itself is unaffected.

**The nginx config became a template, and that is the part to know if you had
copied it.** It hardcoded `proxy_pass http://api:8080` — a Compose service name
— and `listen 80`, which a container that does not run as root cannot bind.
Neither survives leaving Compose. It now reads `NACRE_API_UPSTREAM` and
`NGINX_PORT`, both defaulted in the image to the Compose shape, and
`NGINX_ENVSUBST_FILTER` is set so the entrypoint substitutes only those two —
without it, nginx's own `$host`, `$scheme` and `$uri` would render as empty
strings.

### 0.5.4 — a connection you can see, and end

**Migration 0024.** It adds `oauth_consents`, `oauth_refresh_tokens` and a
nullable `consent_id` on `oauth_authorizations`. Nothing is dropped and nothing
is rewritten, so 0.5.3 runs unchanged against the upgraded database.

0.5.3 built the OAuth flow and stopped one step short. It recorded an
authorization *code* — ninety seconds long, consumed on exchange — and nothing
that outlived it. So after an application connected there was no record it had,
nothing could list what was connected, and **the token could not be taken
back**: it is a JWT verified locally against a key, valid until it expires, and
nothing consults a table.

Now a connection is a row, the token endpoint issues a **refresh token** against
it, and ending the connection deletes that token.

**What "ended" means, exactly.** The application cannot renew, immediately. An
access token it already holds keeps working until it expires — at most
`NACRE_ACCESS_TOKEN_TTL`, fifteen minutes by default. The API reports that
number in the response and the admin screen shows it, because a screen that said
"ended" without it would be overstating what happened. To stop an agent *now*,
revoke the agent; that is a different and larger act, and it is on the Service
accounts screen.

The alternative was a denylist of live tokens consulted on every request, which
would undo local verification to reverse something that happens rarely. That
trade is stated here rather than left implicit.

**Clients that connected under 0.5.3 get no refresh token**, because their
authorization rows carry no connection. They keep working until their access
token expires and then have to be approved again — once. Nothing to do about it
and nothing lost.

**`Connections` is a new screen** and is not administrative: approving a
connection is the same permission as issuing the grant that makes the agent
worth anything, so ending one is too. A member sees the ones they approved; an
`org_admin` sees the organization's, because an agent belongs to the
organization and somebody has to be able to end a connection whose approver has
left.

### 0.5.3 — an MCP client can connect, and consent names an agent

**Migration 0023, and it is the first schema change since 0.5.0.** It adds
`service_accounts.created_by`, two tables for the authorization server, and a
unique constraint on `service_accounts (id, org_id)` so a cross-tenant foreign
key can reference it. Nothing is dropped and nothing is rewritten, so 0.5.2 runs
unchanged against the upgraded database and rolling back is safe.

One thing to know before you run it: **`created_by` references `users(id)`, so
whoever creates a service account must be a real user row.** In a deployment
that is always true — the id comes from a token's subject. It is worth stating
because a fixture or a script that fabricates a principal id will now be refused
by the database rather than quietly writing a row nobody owns.

**No standard MCP client had ever connected over Streamable HTTP**, and two
defects on the first POST are why. There was no `initialize` — the dispatcher
knew `tools/list` and `tools/call` and nothing else — and the required-header
check demanded `MCP-Protocol-Version` on a request that cannot carry one,
because that request is what negotiates the version. Both are fixed; see
[mcp-conformance.md](./mcp-conformance.md) for the full reading against the
2026-07-28 binding.

**The mirrored headers are no longer demanded, only compared.** If you have a
client that was sending them, nothing changes. If you have an intermediary that
*strips* them, requests now succeed where they used to fail with `-32020`.

**There is an authorization server.** A client discovers it, registers, and
completes the authorization code flow with PKCE — and the token it gets acts as
whatever the person chose: as **them**, reaching exactly what they reach and
recomputed on every request, or as an **agent** with its own grants.
`/oauth/consent` is the only part inside the authenticated surface, because that
is where a signed-in person makes that choice.

Two consequences for an existing deployment:

- **`authorization_servers` in the RFC 9728 document now names your API**, where
  before it was absent. If you had already set `NACRE_OAUTH_AUTHORIZATION_SERVER`
  to your own identity provider, that still wins and nothing changes for you.
- **`NACRE_OAUTH_CONSENT_URL`** defaults to `/#/consent` on
  `NACRE_CANONICAL_URL`, which is right wherever an ingress serves the admin
  bundle on the API's origin. Set it if your admin UI is somewhere else — the
  Compose stack publishes it on its own port and sets this for you.

**`GET /v1/me`** is new and needs nothing from an operator. The admin UI uses it
to stop offering administrative screens to a member: there was no way to ask who
the caller was, so it drew everything and a member pressing a button got the
`404` invariant 4 requires, which reads as a broken application.

**The copy buttons in the admin UI work on a plain-HTTP origin now.**
`navigator.clipboard` exists only in a secure context, so every one of them was
dead at `http://10.8.0.1:8082` and fine at `localhost`.

### 0.5.2 — arm64, and an endpoint that keeps its path

Fixes and packaging. No schema change, no new required configuration, and 0.5.1
runs unchanged against this database — so rolling back is safe.

**The images are built for linux/arm64 as well as linux/amd64.** Every tag up to
and including 0.5.1 carried one architecture, checked against the registry
rather than inferred: `ghcr.io/nacre-work/nacre:0.5.1` and `-parser:0.5.1` are
`linux/amd64` and nothing else. Anything that *pulls* one on arm64 ran it
emulated — a Helm deployment, whose chart names those tags in its defaults; a
`docker pull`; an arm64 node or CI runner. That is a slow container rather than
an error, so nothing reported it.

**Compose is not affected and never was.** No service in `docker-compose.yml`
has an `image:` key: all six build from the Dockerfiles into locally tagged
images, and a local build is a build for the machine doing it. `docker compose
up` on an Apple Silicon Mac has always produced arm64. Saying otherwise is a
correction to the first version of these notes.

Nothing to do beyond moving the tag, and only where a tag is what you run. A pod
already running 0.5.1 on arm64 keeps the emulated image until it pulls the new
one; `image.tag` (or `:latest`) forward is the whole action, and the improvement
is latency rather than behaviour.

If you pin digests, note that a multi-architecture tag's digest is an index and
not an image — pin the index digest and the node resolves its own architecture
from it.

**A path on a model endpoint is no longer discarded.** The embedder and reranker
calls built their route with `new URL('/embeddings', endpoint)`, which is
origin-relative, so everything after the host was thrown away:
`https://api.openai.com/v1` called `https://api.openai.com/embeddings` and got a
404 that named no cause. The route resolves under the configured path now.

**Check this before upgrading if you worked around it**, because the workaround
becomes the bug. A deployment that stripped the `/v1` to make the old code reach
the right route — configuring `https://api.openai.com` and relying on the append
— now calls `https://api.openai.com/embeddings` for real, and gets the 404 it
was avoiding. Put the path back:

```sql
SELECT id, name, endpoint FROM embedding_providers;
```

An endpoint with no path that worked before still works: `http://embedder:80`
resolves to `/embeddings` exactly as it did, which is why the `full` and
`airgapped` profiles are unaffected and why this went unnoticed.

`NACRE_DEFAULT_EMBEDDING_ENDPOINT` seeds `embedding_providers` at `init` and is
not read again, so for an installation past its first run the row is what
matters and the variable is not.

**[apple-silicon.md](./apple-silicon.md)** is new, with
`docker-compose.apple-silicon.yml` beside it. The one part of the stack that is
still not arm64 is the embedder and reranker image — Text Embeddings Inference
publishes no arm64 build — so `full` and `airgapped` run those two emulated on
that architecture, and the page has the arrangement that avoids it.

### 0.5.1 — what a real client and a real operator ran into

Fixes only. No schema change, no new required configuration, and 0.5.0 runs
unchanged against this database — so rolling back is safe.

**The MCP transport was not reachable by a real client.** Four things, all found
by pointing one at it:

- `Mcp-Name` was required on every request. The specification requires it only
  on `tools/call`, `resources/read` and `prompts/get` — so `tools/list` was
  refused, and no client can list tools any other way.
- A missing or wrong header answered JSON-RPC `-32600` instead of `-32020`
  (`HeaderMismatch`). A client reads that code to decide whether it is talking
  to a modern server; the wrong one sends it into a fallback this transport does
  not speak.
- The mirrored headers were demanded and never compared with the body — which
  is the entire reason they exist, and is a stated security property.
- `GET` and `DELETE` on the endpoint answered `404`; the specification says
  `405`, and `404` is another signal that sends a client to the deprecated
  transport.

**`Origin` is now validated**, which is a MUST and was absent. A present origin
outside `NACRE_MCP_ALLOWED_ORIGINS` is `403`; an absent one is allowed, because
an agent sends none and the attack — DNS rebinding — is by definition a browser.
**The default list is empty**, so a browser that talks to this transport
directly stops working until you name its origin. Nothing that sends no `Origin`
is affected.

**`NACRE_MCP_CANONICAL_URL`**, for a deployment that publishes the API and MCP
on different origins. The discovery document names one resource identifier and
RFC 9728 has the client check it against the URL it reached — so a client
pointed at the MCP port was told the resource was the API's and refused before
sending a request. That was the Compose default, and Compose now sets this. It
moves the discovery document only; `NACRE_JWT_ISSUER` and `NACRE_JWT_AUDIENCE`
decide what a token is checked against and must stay identical on both
processes.

**A grant now names two things that both have to exist.** Issuance checked the
scope and not the principal, so a grant could name any uuid as its principal — a
row that permits nothing and never can. `principal_type` and `principal_id` are
two fields, and choosing `user` while pasting a service account's id inserted
cleanly and did nothing. A revoked service account is refused too; a disabled
user is not, because disabling is reversible.

Nothing to do for either. If a grant in `GET /v1/grants` names a principal you
cannot look up, it was already inert — this stops more being written.

**The API answers `404` on paths it does not serve**, instead of demanding a
credential first. `/register` and the OAuth discovery documents an MCP client
probes for are not routes here; `401` said they were.

### 0.5.0 — onboarding a team, and a readiness probe that means it

**Nothing removed and nothing renamed**, so rolling the code back to 0.4.x is
safe: both migrations here are additive, and 0.4.x runs unchanged against this
schema. No new environment variables.

**`/v1/ready` now reports the schema.** A pod on a database this build's
migrations have not reached answers `503` rather than reporting ready and
failing per request. Nothing to do — but if a readiness probe starts failing
right after an upgrade with every dependency healthy, this is what it is telling
you, and `migrate` is the answer.

Migration `0022` grants the application role `SELECT` on `schema_migrations`,
which is what makes that check possible: the ledger is created by the migrator
and `nacre_app` held no privilege on it at all. Read-only, and it is not tenant
data.

Migration `0021` adds `created_at` to `groups` and `group_members`. It
**rewrites both tables** — `now()` is volatile, so the column is not a
metadata-only add — under an `ACCESS EXCLUSIVE` lock bounded by the 10 s
`lock_timeout`. On a large directory sync that is the one migration so far worth
scheduling rather than running at any moment.

Additive for old code. `/v1/users`, `/v1/groups` and `DELETE /v1/layers/{id}`
are new endpoints; nothing existing changes shape.

The `full` Compose profile gains a `minio-init` one-shot that creates the
bucket. api and worker depend on it with `required: false`, so the other
profiles are unaffected.

### 0.4.0 — binary ingest

- **New parser dependency, and the pin is a security decision.** `pypdf` is
  pinned exactly, at a version chosen for its DoS fixes, because it runs
  attacker-supplied bytes. A deployment building the sidecar itself must take
  the pin rather than a range.
- **A PDF upload requires object storage.** With `NACRE_S3_*` unset the API
  refuses a binary upload on the request, naming the variables — so `s3.enabled`
  stopped being only a question of how much you store. Text-only deployments are
  unaffected and remain the default.
- Migration `0020` adds `documents.content_type` with a default. Additive.
- No new environment variables.

### 0.3.0 — breaking

The one release so far that removes things.

- **The ACL tag cache is gone.** Migration `0016` drops
  `documents.acl_version` and `documents.acl_tagged_at`. Code from 0.2.x reads
  and writes those columns, so **0.2.x cannot run against a 0.3.0 schema** —
  this is the upgrade to take a backup before.
- **Variables removed**: `NACRE_ACL_PROPAGATION_SLA` and
  `NACRE_ACL_TAG_HASH_BYTES`. The `nacre_acl_propagation_lag_seconds` metric and
  its alert are gone with them; the replacement alert watches
  `nacre_tombstones_pending_total`.
- **Variables added**: `NACRE_MODULES`, `NACRE_REINDEX_MIN_RECALL`.
- `NACRE_S3_*` moved to commented-out in `.env.example` — setting
  `NACRE_S3_ENDPOINT` is what turns object storage on.
- Migration `0017` rewrites any `users.role = 'workspace_admin'` to `member` and
  narrows the CHECK. `0018` deletes duplicate `group_members` rows before
  replacing the unique constraint. `0019` adds `RESTRICTIVE` write policies on
  `embedding_providers`. All three refuse writes that the previous version
  allowed.
- **The `BYPASSRLS` requirement shipped here**, with the up-front refusal. This
  is the change most likely to stop an existing upgrade job that had been
  working — see [the role](#the-role-and-why-a-wrong-one-only-bites-at-upgrade-time).
- The `web` front door (nginx serving the admin UI and proxying `/v1`) was added
  to Compose.

### 0.2.0 — object storage wired

- **New variable**: `NACRE_COLLECTION_RETENTION_DAYS` (default 7).
- **`NACRE_S3_*` reaches configuration validation for the first time.** The
  `minio` service had existed in the `full` profile since 0.1.0 and was talking
  to nobody. From here a wrong endpoint or a missing credential is a **startup
  refusal**, and the four values are validated as a group — all four or none. A
  deployment that had them set to something approximate finds out at boot.
- Migration `0014` adds `retired_collections`. Additive.
- Backups gained a second part: with object storage on, Postgres alone no longer
  restores a working deployment.

### 0.1.0

First release.
