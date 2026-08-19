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
| `@nacre.work/core`, `@nacre.work/api`, `@nacre.work/mcp`, `@nacre.work/sdk`, `@nacre.work/cli` | npm, at the same version |
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

### When a release changes what a point carries

A migration moves the schema and the migrator is the thing that runs it. There
is no equivalent for the *index*: a release that changes what gets written into
a point changes it for documents written **after** the upgrade, and every
document already in the collection keeps whatever it was written with.

Nothing here breaks when that happens, and that is the difficulty — a filter, a
payload field or a vector slot that half the corpus lacks answers normally for
the half that has it. So the release note says so, and the remedy is always the
same command:

```bash
docker compose run --rm api rebuild-collection --org {slug}
```

It reads the collection name and the per-layer slots from Postgres, recreates
the collection and requeues every live document, so everything is written by the
build you are now running. It re-embeds, so it costs what the original ingest
cost — plan it like a reindex rather than like a restart, and note that search
keeps answering from the old collection until it completes.

The one release so far that asks for it is the one that made search hybrid: the
`bm25` slot is filled at ingest, so until a rebuild the lexical half of every
query sees only documents ingested since the upgrade. Dense retrieval is
unaffected and no result is wrong; what a rebuild buys is that exact-term
matching covers the whole corpus rather than the recent end of it.

---

## Per-version notes

Each section says what the version asked of an operator. A release that asked
nothing says so.

### 0.23.9 — two things in the console, seen by looking at it

**Nothing to do.** No variable, no schema, no route.

A `<select>` that asks you to choose said `pick a organization…`. The article was
built by hand from the noun, which is wrong for every noun beginning with a
vowel — and computing it from the first letter would fix that and break `user`,
which the same control takes. There is no article now: the label beside the
control already names the thing.

And a **disabled button looked exactly like a working one**. There was no
`:disabled` rule in the console's stylesheet at all, so a disabled primary
button rendered in full teal and a press did nothing. The rule it breaks is
written three lines away, about a select with one option — *"a control that
cannot be operated still invites operating it"* — and nothing held it for a
button.

Both were found by rendering a screen and looking at it, in a console from
another repository that loads this one's `extensions.js`, and both are held by
`lint:admin-layout` now.

### 0.23.8 — the object-storage client tries again

**Nothing to do.** No variable, no schema, no route.

Every request to object storage is now retried on a transport failure, on a
`5xx` and on a `429` — three more attempts inside a thirty-second budget, with
full jitter on the wait and `Retry-After` honoured where the store sends one.
Nothing else is retried: a `403` re-signs with the same inputs and arrives at
the same refusal, a `404` is an answer, and `501` means the store does not have
the operation.

**What this changes for you is a restore that survives a blip.** The client had
no retries on a stated argument — that its callers, the ingest queue and the
collector, already retry whole units of work. That was true of them and stopped
being true when `backup`'s `verify` and `restore` arrived: those read an archive
part by part, so a 1.6 GB artifact is two hundred requests, and one transient
`503` from a real cloud store ended the whole run — the operation somebody runs
when the database is already gone.

A readiness probe is the one caller that opts out and still makes exactly one
attempt. Retrying inside `/v1/ready` would turn "the bucket is not answering"
into no answer at all, which an orchestrator reads as a pod to kill rather than
as a dependency that is down.

If a deployment watches its logs, expect a new `warn` line — `s3 request
retried`, with the status, the attempt and the wait. A retry that happened
silently is a system that got slower for a reason nothing recorded.

### 0.23.7 — object storage on Node 24

**Nothing to do on Node 22, and this is the release that makes Node 24 work.**

The S3 client set `content-length` on every PUT and put it in the signature.
That is a **forbidden request header**: the Fetch standard has the runtime
compute it from the body, and undici 7 stopped tolerating one set by hand —
`InvalidArgumentError: invalid content-length header`, thrown before the request
leaves the process. Node 22 ships undici 6 and accepted it. **Node 24 ships
undici 7**, so on that runtime every write to object storage failed: an ingest
of a PDF, and every backup written to a bucket.

Nothing was signed away with it. What binds the body is `x-amz-content-sha256`,
which is in the canonical request either way — a body that changes in flight
still fails the signature rather than being stored. SigV4 never required
`content-length` among the signed headers.

Found by running the client under a runtime that had already moved rather than
by reading a changelog: a test harness that brings its own undici 7 failed where
a plain `node` script passed.

### 0.23.6 — the object-storage client can list

**Nothing to do.** One method on an internal client, used by nothing the open
half ships.

`packages/core/s3.ts` said in its own header that listing was deliberately
absent, *"because nothing needs to enumerate a bucket"*. Something does: the
commercial `backup` module's archive reader refuses a part its manifest does
not name, and an archive written to a bucket must not lose a refusal an archive
on a disk has. A reason that has stopped being true is corrected rather than
worked around at the caller — the alternative was that check holding for one
destination and not its sibling.

The signer gained a real canonical query string with it, which had been an
unconditional empty line. That is a change to how **every** request is signed,
so it was driven against a real MinIO: put, get, remove and a listing, a key
containing `!'()*`, and 1200 objects to force a continuation token — 1200
listed, no duplicates, nothing missing, nothing extra.

### 0.23.5 — the enrolment QR named a URL, not an account

**Nothing to do, and nothing to re-enrol.** An authenticator that already holds
a code keeps working: a TOTP code is `HMAC(secret, step)` and the label is not
an input to it. What changes is the label a **new** enrolment writes.

`otpauth://` labels are `issuer:account`, so the colon is the separator, and the
API was passing `NACRE_JWT_ISSUER` — a URL — as the issuer. An app that decodes
the path before splitting therefore read `https` as the issuer and the rest of
the URL as the account name, and showed

```
https://playground.nacre.work: //playground.nacre….
```

on the one screen whose job is to say which account you are looking at. The
issuer is `NACRE_CANONICAL_URL`'s **hostname** now — the same value the WebAuthn
relying party has always used, three lines further down the same object and for
the same reason.

`otpauthUrl` refuses a colon in either half outright rather than stripping it,
and `SecondFactors` makes that call once when it is constructed — so a
deployment that reintroduces a URL there is a container that does not start,
by name, rather than a label somebody has to live with for as long as that
authenticator exists.

**If you enrolled before this release** and want the corrected label, remove the
authenticator under `/v1/me` and add it again. Nothing forces that, and an
installation that leaves it alone is not broken in any way — the entry is
mislabelled and the codes are right.

### 0.23.4 — the access log's two columns

**Nothing to do**, and one screen reads differently.

The Result column's three pills were three *widths* — one size fixed the type in
0.23.3 and left the boxes ragged, which down a column reads as the values
meaning different amounts of something. They are one width now, taken from the
longest value, and `allow` is ringed rather than bare so the three read as one
control with three states. The same rule reached the Grants screen's Permission
column, which had the same ragged edge between `read` and `write`.

And the **Actor** column named nobody: it rendered `audit_events.actor_label`,
which every writer of an event builds as `` `${type}:${id}` `` — so a whole uuid
sat above a shortened one where an operator expects an address. The id is
resolved to an email or a service account's name now, and where it cannot be —
a deleted account, or a `platform_admin`, whom `GET /v1/users` refuses — the
fallback is the actor's kind as a word.

**No API change and no migration.** `actor.label` is still in the response and
still means what it meant; the console simply stopped treating it as a name.
An operator reading the log through `GET /v1/audit` directly sees exactly what
they saw before.

### 0.23.3 — one column, one size

**Nothing to do**, and one screen looks different. The access log's Result
column rendered its three values at three type sizes — `allow` at the table's
own sans, `deny` inside a chip, `error` inside a tag — which a reader going down
the column sees as three kinds of thing rather than as three values of one
field. It is one control at one size now; only the fill differs, and an `allow`
still carries none, because it is what almost every row says.

Nothing about the log itself changed: the same events, the same filters, the
same two roles seeing two different logs.

**A console extension is unaffected.** The contract is still 2 and no member
moved; `chip` on the kit is the *permission* chip and answers exactly the four
it always did. The two classes this column needed are stylesheet-only, and the
view that uses them builds its class directly, because a log's result is not a
permission.

### 0.23.2 — the console's extension contract is 2

**Nothing to do on the open image**, and nothing changed on any screen. The
extension file it ships is the same stub registering the same nothing.

`ConsoleKit` gained `copyControl` — the control that takes a value, for a value
shown once. It is there because the first screen written against this contract
was one that hands a generated password over, and the kit could only offer the
`copyText` primitive: assembling a button around that is a second control with
the same job, which is how one of them gets the clipboard fallback, the
checkmark timing or the accessible name wrong.

**An additive change moves the number**, deliberately. An extension built
against 2 and loaded by a console at 1 finds `undefined` where it expected a
helper, which is a screen that draws nothing with an error in nobody's log. So
an image carrying console extensions has to be built for this core — which its
tag already says, and which the console says out loud if it is not.

### 0.23.1 — one sentence, on the screen a platform administrator lands on

**Nothing to do.** The message a `platform_admin` sees in a tenant's console
called the access log "the one exception", which is a claim about the whole
navigation — and an image that adds screens through 0.23.0's extension file
makes it read as a miscount. It names what that role reaches *in this
organization* now, which is a statement nothing outside the console can
falsify. No behaviour changed and no screen moved.

### 0.23.0 — an access log on a screen, and a console a commercial image can add to

**No migration, no new variables, and nothing to do.** Both changes are surfaces;
neither asks a deployment for anything it does not already have.

**The access log has a screen.** `GET /v1/audit` has been readable, cursor-paged
and exportable since the journal landed, and nothing in the product showed it —
the only way to start the investigation `docs/audit.md` opens with was `curl`
with an `Accept` header, or `psql`. The console has an **Access log** view now,
at `#/audit`, with filters for the action, the result and a date range.

It offers **no field for an actor's id**, deliberately: nobody knows a uuid, and
a mistyped one comes back as an empty log, which reads as *nothing happened*.
Pressing an actor in the log narrows to that actor instead.

An `org_admin` and a `platform_admin` see the two different logs they have always
seen — the second is shown administrative actions and never which documents were
read — and the screen now *says which*, because a log with no document reads in
it is indistinguishable from an organization where nobody read anything.

There is still no export button. The endpoint serves JSONL and CSV by content
negotiation, a browser cannot set `Accept` on a link, and fetching a whole
journal into a tab's memory to hand it back as a file is not an improvement.
`nacre audit` is the route for that.

**A commercial image can put a screen in this console.** The `web` image now
ships one file, `extensions.js`, that registers nothing; an image built `FROM`
it may replace that file to add views. **On the open image nothing changes** —
the file is there, it registers nothing, and the console is exactly what it was.

Two consequences worth knowing if you build your own front door. The console
fetches `/extensions.js` at start-up, so a proxy or a CDN in front of it must
serve that path from the same directory as `app.js` rather than falling through
to `index.html`; and the file is loaded under `script-src 'self'`, so it must be
same-origin. The contract is documented in
[extensions.md](./extensions.md#the-consoles-extension-file).

### 0.22.0 — the console hands its secret over, and the mail is in the brand

**No migration, no new variables, and nothing to do.** Everything here is what a
person sees; nothing changes what a deployment has to be given.

**The enrolment dialog can hand its values over.** A TOTP secret is thirty-two
base32 characters and had to be retyped by hand: there is a **QR code** on that
screen now, the secret has a copy control beside it, and the `otpauth://` link
is shown in full rather than truncated into a tooltip a phone has no pointer
for. The recovery codes can be copied and saved as a file from the one dialog
they will ever appear in.

The QR code is encoded in the console and needs nothing from the deployment: no
image is fetched, no service is called, and the page's `script-src 'self'` is
unchanged. It is drawn black on white whatever theme the browser asks for,
because that is a scanning requirement rather than a palette choice.

**The messages this installation sends are now `multipart/alternative`.** The
same words in plain text, plus an HTML part in the product's own palette. Both
parts are rendered from one description, so a client that refuses HTML — or a
person who has turned it off — reads exactly what the other reads.

There is nothing to configure. `NACRE_SMTP_URL` and `NACRE_MAIL_FROM` are what
they were, an installation with neither still sends nothing and still hides the
recovery link, and no message fetches an image or carries a tracking pixel.
Anything that filtered or archived on the text part goes on working, because the
text part is still there and still first.

A message that asks for an action now shows the link **as its own URL** beside
the button, so a reader taught to check a link before pressing it can. If your
relay rewrites links for click tracking, that rewriting will be visible to the
recipient — which is the correct outcome and worth knowing before somebody asks.

**A provisioning race is fixed**, and it is worth reading if you script tenant
creation. Two organizations provisioned *at the same moment* on an installation
with no default embedding provider row could both try to insert one, and since
0.8.0's `NULLS NOT DISTINCT` constraint (migration 0028) the loser failed outright with
`duplicate key value violates unique constraint "embedding_providers_org_name"`
— no organization created, and the error naming a constraint rather than a race.
It is an `ON CONFLICT` now. Nothing to do on an existing installation: a
deployment that already has a default provider row was never reachable by it.

### 0.21.0 — two additions for module authors, and nothing for an operator

**No migration, no new variables, and nothing to do.** Both changes are to
interfaces a commercial module implements; an installation running none is
unaffected, and one running a module upgrades the module the way it always does.

`SignInContext` gains **`holdsOwnCredentials`**, which is `false` for a shared
account — the property 0.20.0 added. A gate that answers `enrol` without reading
it would send somebody to enrolment routes that answer `404` to them, which is a
lockout with no route back, produced by the one verdict that exists so a policy
*has* a route back. It cannot be inferred from `enrolled`: that reads `false`
for a shared account and for a person who has simply not enrolled yet.

`migrate()` takes an options object, so a module can apply its own schema with
the core's runner instead of shipping a second copy of it. `ledgerTable` names
the module's own history — never `schema_migrations`, which `/v1/ready` reads to
decide whether the schema matches the image — and `requirePrivileges: false`
says the module's SQL touches only its own table and therefore needs no
`BYPASSRLS`. See [extensions.md](./extensions.md).

Both are additive. Existing calls compile and behave identically.

### 0.20.0 — a module can require a second factor, and a shared account cannot

**One migration, no new variables.** `0032` adds `users.shared` — `false` for
every existing row, so nothing changes for any account that belongs to somebody
— and a trigger that refuses a second factor on one.

#### If you publish a login, mark it shared

This is the half to act on. An account **more than one person holds** — a demo
login printed on a page, a shared read-only account handed round a team — could
until now enrol a second factor and change its own password. The first holder to
do either **locks out every other one**, and an administrator deliberately
cannot remove somebody's second factor, so the only repair is to reissue the
credential and tell everybody.

Until 0.19.0 a deployment had an accidental guard: with no `NACRE_2FA_KEY` the
whole surface answered `404`. WebAuthn needs no key, so that guard is gone —
correctly, because it was installation-wide and this property is not. An
installation may have one shared account and a hundred people.

Mark such an account when you create it:

```
nacre users create demo@example.com --shared
```

or `{"shared": true}` on `POST /v1/users`. It then has no `/v1/me` credential
surface at all — no second factor, no password change, no reset link — while
`POST /v1/users/{id}/password` still sets its password, which is how you rotate
a published one. It cannot be changed afterwards; a new account is cheap.

**There is no migration for an account you have already published.** The column
defaults to `false` and nothing can guess which of your accounts are shared. If
somebody has already enrolled a factor on one, that account is not recoverable
as itself — create a replacement with `--shared` and publish that.

`GET /v1/me` gains `holds_own_credentials`, which is what the console reads to
leave those controls off rather than drawing ones that answer `404`.

The `demo` Compose profile marks its two logins shared, so a stand started from
this release is closed by default.

#### The extension point

**No migration, no new variables, and nothing changes on a deployment running
no commercial module.** `registerSignInGate` is a sixth extension point; the
open core registers none, so every credential it verifies still mints a session
exactly as before.

What it asks of an operator is nothing. What it asks of anybody **writing a
client** is one thing, and it applies whether or not you run a module today:
`POST /v1/auth/login`, `POST /v1/auth/second-factor`, `POST /v1/auth/refresh`
and `POST /v1/me/password` can now answer `200` with
`{second_factor_enrolment_required: true, challenge, expires_in, reason}`
instead of tokens, and `403` where a gate refuses outright. A client that reads
a `200` from those endpoints as "tokens are in the body" will read `undefined`
for an access token the first time a customer turns a policy on.

The four are four because a gate runs where a session is minted, and there are
four such paths. A **renewal** is one of them deliberately: without that, a
policy turned on while people are signed in would do nothing for any of them for
as long as they kept renewing.

On `POST /v1/me/password` the password **is** changed when this is answered.
The statement commits before the session is minted, so it is a person with a new
password and no session rather than a change that failed — report it that way or
they will go on trying the old one.

The enrolment challenge is not a session and is refused everywhere an access
token is accepted. It reaches four routes, listed in
[extensions.md](./extensions.md), and confirming a factor through it answers
with the recovery codes **and** a session.

**The SDK and the console handle all of this**, so a deployment running the
shipped admin UI needs nothing. Two changes are visible to anybody writing
against `@nacre.work/sdk`:

- `secondFactor.confirm` and `secondFactor.finishWebAuthn` return
  `{ recoveryCodes, tokens }` rather than a bare list of codes. `tokens` is
  present only where the enrolment was reached with an enrolment challenge.
- `changePassword` distinguishes its two `403`s by the problem **type**. If you
  match on the status alone, a policy refusal will read as a wrong password.

`onSignInGate` is a new client option: it fires when a **renewal** is answered
by a gate. Without it the only signal is the `401` every request afterwards
gets, which looks exactly like an expired session.

### 0.19.0 — a second factor you cannot be phished out of

**One migration, no new variables, and nothing to configure.** WebAuthn needs
only `NACRE_CANONICAL_URL`, which every deployment already sets: its hostname is
the relying party id and its origin is what an assertion is checked against,
plus whatever `NACRE_API_ALLOWED_ORIGINS` already admits. A second variable
would have been a second answer to a question the deployment has answered twice.

Migration 0031 widens `user_second_factors` and adds `webauthn_challenges`. Run
the migrator as usual; existing TOTP rows are untouched and every one of them
goes on working.

**What changes without you doing anything** is that installations with no
`NACRE_2FA_KEY` — which is most of them — now offer a second factor where they
offered none. That is deliberate: a security key stores a public key here and no
secret, so there is nothing to seal and nothing a database dump could use.
Nobody is required to enrol one; the Security screen simply has a control it did
not have.

**If you want no second factor at all**, that is now a deployment with no
canonical URL, which is not a deployment this product supports. There is no flag
to turn it off, and adding one would be a switch whose only effect is to make
accounts easier to take over.

#### Two defects fixed here that shipped in 0.18.0

`DELETE /v1/me/second-factor/{id}` answered `404` for every id, so **a second
factor could be enrolled and never removed**. If somebody on 0.18.0 is stuck
with a factor they cannot take off, upgrading is the fix; there is nothing to
run.

`GET /v1/auth/methods` answered `404` as well, because the sign-in surface
accepted only `POST`. The console reads that endpoint to decide whether to show
the "forgotten your password" link, so **the link was hidden on every
deployment**, including the ones with `NACRE_SMTP_URL` configured. If password
recovery looked like it was not working, it was working and unreachable from
the console; `POST /v1/auth/password-reset` was correct throughout.

And on an installation with no `NACRE_2FA_KEY`, a **recovery code could not be
spent**. That path could not be reached before this release, since there was no
factor to enrol without a key — it is listed because the fix is in the same
place and an operator reading the code will see it.

### 0.18.0 — three ways to hold an account, and two of them are optional

**Two migrations and two optional groups of variables**, and doing nothing is a
supported answer for both: without them the surfaces answer `404` and sign-in is
exactly what it was.

The third — changing your own password — needs nothing configured at all and is
described further down. It is the one recovery path every installation has,
which is why it is not behind a variable.

Migration `0030` adds `password_reset_tokens`, and recovery is offered where the
installation names a relay and a sender:

```
NACRE_SMTP_URL=smtps://nacre%40example.com:secret@smtp.example.com:465
NACRE_MAIL_FROM=Nacre <nacre@example.com>
```

Both or neither — a relay with no sender parses and then fails on the first
message, which is a log line rather than a refusal you would notice. Without
them, `GET /v1/auth/methods` reports `password_reset: false` and the console
leaves the link off its sign-in screen rather than showing one that cannot work.

The link a message carries is built from `NACRE_CANONICAL_URL`, never from a
`Host` header — a recovery link built from a request header points wherever the
requester said. If that variable names something a person cannot open in a
browser, the link will not be openable either.

Two things worth knowing before you turn it on. A reset **ends every other
session** for that account, which is the point rather than a side effect. And a
reset **does not touch a second factor**: if it did, an email account would be a
way around one.

Migration `0029` adds `user_second_factors` and `user_recovery_codes`. It
creates two tables and grants the application role on them; it reads nothing
and rewrites nothing, so it applies to a live database in the ordinary way and
an older replica serving beside it is unaffected.

To offer a second factor, generate a key and name it:

```
NACRE_2FA_KEY=$(openssl rand -base64 32)
```

Base64 or hex and **exactly 32 bytes**. An arbitrary string is refused rather
than stretched, or every sealed secret would be worth whatever somebody typed.

**One variable, and there is no file form.** A file is the better place for key
material — an environment variable is readable through `docker inspect` and
`/proc/<pid>/environ` — and where your platform mounts one, that is a line of
shell in whatever sets the variable:

```
NACRE_2FA_KEY=$(cat /run/secrets/nacre_2fa.key)
```

rather than a second variable this product carries for good. `NACRE_JWT_SECRET`
beside it is a plain value too; `NACRE_JWT_PRIVATE_KEY_REF` is file-only for the
opposite reason and is likewise one form, because a private signing key must not
be in the environment at all.

The API is the only process that needs it: the MCP transport verifies tokens and
never issues one.

**There is no mode that stores a TOTP secret in the clear.** Unset the variable
and enrolment is refused rather than degraded; a product that half-does a second
factor is worse than one that does none, because the operator believes
something.

**Back the key up where you back up the signing key.** Losing it makes every
enrolled authenticator useless — the secrets are sealed with it and nothing else
can open them. That is what recovery codes are for: ten per person, minted at
enrolment and printed once, and they work while a factor is locked. Somebody who
has lost their phone cannot ask for them afterwards, which is why they are
issued at the one moment the product has their attention.

**Removing the variable later** leaves the rows in place and stops offering the
feature: enrolled people sign in with a password alone, and putting the same key
back makes their authenticators work again. Putting a *different* key back does
not, and the failure is a refusal rather than a message about keys — treat it as
losing the key.

Nothing about permissions changed. A second factor decides whether a session
starts and grants nothing; the permitted set is still computed per request from
`grants`, and a token minted after a correct code reaches exactly what the same
token reaches without one.

One thing to expect on the day you enrol: **the code that confirms an enrolment
is spent by confirming it**, so signing in immediately afterwards waits for the
next one. That is the replay bound working, not a fault.

**A person can change their own password**, at `POST /v1/me/password`, and the
console's Security screen has the form. No migration and no variable — it needs
nothing configured, and it works on an installation with no relay and no
second-factor key, which is what makes it the one recovery path every deployment
has. Changing a password ends every other session for that account and returns
the pair that replaces the caller's own, so a client written against this must
adopt what comes back; the SDK's `changePassword` and the console do.

**Two operations that used to answer `500` under load now answer `503`**, and
the two new ones join them. `POST /v1/users` generates a password and
`POST /v1/users/{id}/password` sets one; the number of scrypt calls running at
once is bounded inside the process, and past the bound the call is refused
rather than queued further. Only sign-in translated that into a `503` with
`Retry-After` — the others surfaced it as an internal error, which is what a
client reports as a broken server and an operator investigates as a bug.
Nothing about the bound changed, only the answer. If you alert on `5xx` by
class you will see the same volume; if you alert on `500` specifically, some of
it moves.

### 0.17.5 — a browser MCP client can read this installation's metadata

**Take the `nacre` image**, and nothing else. No migration, no new variable, and
nothing to do afterwards. A deployment with both allow-lists empty — which is
the default and what most installations have — is unaffected either way.

If you did name an origin in 0.17.4, one request of the OAuth walk was being
refused and you would not have noticed. `Access-Control-Allow-Headers` was
written out by hand on each surface; the MCP transport's carried
`mcp-protocol-version` and the API's did not — and the API is what serves both
`/.well-known` documents a browser MCP client reads. The preflight admitted the
origin and refused the header, so the browser cancelled discovery before it was
sent.

Nothing broke, which is why this needed finding rather than reporting. The MCP
SDK retries discovery without the header, so the walk finished and what a
deployment saw was two `net::ERR_FAILED` lines in a browser console and a flow
that worked anyway. A client that does not retry gets no metadata at all.

`curl` sees none of it, because `curl` sends no preflight: both documents answer
`200` with the right `Access-Control-Allow-Origin`. If you want to check your own
installation, send an `OPTIONS` with `Access-Control-Request-Headers:
mcp-protocol-version` and look for that name in the answer.

### 0.17.4 — a browser can reach this installation, if you name its origin

**Nothing is required.** Both allow-lists are empty by default, which is what
every existing deployment has, and an empty list emits no CORS header and
refuses a preflight exactly as before this release.

What changed is that naming an origin now works. `NACRE_MCP_ALLOWED_ORIGINS`
made the transport stop refusing a browser and did not make it answer one —
there was no preflight handler and no `Access-Control-Allow-Origin`, so the
browser discarded a reply it had been allowed to receive. Setting it did nothing
you could observe.

Set `NACRE_MCP_ALLOWED_ORIGINS` **and** `NACRE_API_ALLOWED_ORIGINS` if a browser
client talks to this installation: it reads the `401` from the transport and
then registers and exchanges its authorization code on the API, so admitting it
on one surface and not the other is a walk that stops one step after it starts.

`*` is refused at startup on either list. Nothing here treats it as a wildcard —
an origin is admitted by exact match — so a deployment that sets one gets a
configuration error naming the variable rather than a list that quietly matches
nothing.

### 0.17.3 — a document's failure stops naming your infrastructure

**Take the `nacre` image**, and nothing else. No migration, no new variable, no
new service, and nothing to do afterwards.

Two things a caller could see that it should not have, and both are on the path
a failed document leaves behind.

`GET /v1/documents/{id}` returned `documents.error` **verbatim** — and so did
`get_document` over MCP, which resolves `read` and is therefore reachable by a
third party acting through a delegation somebody approved. That column holds
whatever went wrong, written by the worker for an operator reading a log: the
embedding endpoint's address, the parser's, and whatever a sidecar put in its
message. `/v1/jobs/{id}` had taken those out since 0.17.2; this endpoint had
not.

And the redaction itself held for a hostname with a dot in it and for nothing
this product ships with. Service names in the Compose files and in the Helm
chart are single-label — `embedder`, `qdrant`, `parser`, `minio` — so the rule
covered the example in its own documentation and missed every deployed
configuration. The way one survived is worth recognising if you have looked at
one of these messages: the URL *was* removed, and then the HTTP client appended
its cause, leaving `getaddrinfo ENOTFOUND embedder` at the end of an otherwise
clean sentence. IPv6 was not redacted in any form.

A host is now recognised by where it can appear rather than by what it looks
like: after a scheme, inside brackets, as `name:port`, after a DNS or socket
error code, and after the phrases this product writes itself.

**What this costs you.** A filename in a parser's message is redacted too —
`could not extract text from contract.pdf` reads `… from [host]`. That is
deliberate: `contract.pdf` and `example.com` are the same shape, a list of file
extensions goes stale, and of the two ways to be wrong only one of them leaks.
The unredacted text is unchanged in `documents.error` and in the worker's log,
which is where an operator already is. `SELECT error FROM documents WHERE
status = 'failed'` still tells you the filename.

**Nothing is retroactive and nothing needs re-ingesting.** The redaction happens
when the row is read, so upgrading is enough — documents that failed before this
release answer the same way as documents that fail after it.

Also in this release, and asking nothing of an operator: the admin console's
layout at phone widths, where the control that copies an id was invisible on a
touch device and unreachable as a result; and both MCP transports now answer
`tools/list` with the same object, where STDIO had been returning an extra
`permission` field that is not part of MCP's `Tool`.

### 0.17.2 — a document over 22 KB indexes, and the ones that failed need re-ingesting

**Take the `nacre` image** — it carries the API and the worker, and the defect
was in both — and then **re-ingest anything that failed**, which is the part no
upgrade does for you.

Both embedding clients sent a document's whole chunk list as one request. An
endpoint does not split a batch that is too large; it refuses it. Text
Embeddings Inference, which every Compose profile here starts and which most
self-hosted deployments run, answers `413` above `--max-client-batch-size`, and
that defaults to **32**. A chunk is 800 characters, so anything past roughly
**22 KB of text** produced more than 32 chunks and failed.

Those documents stayed failed. Nothing retries `failed`, and the layer went on
answering searches out of the documents that had indexed — so the symptom is
not an error anywhere a person looks, it is retrieval quietly missing your
longest documents. It was found on a running stand with **twenty-six failures
out of fifty**.

To find yours:

```sql
SELECT l.slug, d.external_id, d.error
  FROM documents d JOIN layers l ON l.id = d.layer_id
 WHERE d.status = 'failed' AND d.deleted_at IS NULL
 ORDER BY l.slug, d.external_id;
```

An `error` mentioning `413` or `maximum allowed batch size` is this defect.
Re-ingesting is enough — ingest is idempotent on `(layer, external_id)`, and a
document whose content has not changed is re-embedded rather than duplicated.
`nacre ingest <path> --layer <slug>` re-sends a directory; the API and MCP
ingest paths do the same thing.

`NACRE_EMBED_BATCH` is new and defaults to 32, which is not a guess at
throughput: it is the limit the most common self-hosted embedder enforces. Raise
it if your endpoint takes more — a hosted vendor usually takes far more — and
nothing needs setting to get the fix.

No migration, no new service, and no change to the permission model.

### 0.17.1 — the front door stops overwriting the client's scheme

**Take the `nacre-web` image**, and nothing else. No migration, no new variable,
no new service, and no change to the API, the transports or the worker.

If your console sits behind anything that terminates TLS — an ingress
controller, `nginx-proxy`, Traefik, Caddy — this release is worth taking, and
the symptom it fixes is one you may have already met without recognising it.

Every proxying `location` in that image sent `X-Forwarded-Proto $scheme`, and
`$scheme` is the scheme of the connection *into* the container, which behind a
TLS terminator is plaintext. So the front door replaced the outer proxy's
correct `https` with `http`. The MCP transport builds its RFC 9728 identifier
from the request unless `NACRE_MCP_CANONICAL_URL` is pinned, so an
unauthenticated `POST /mcp` answered:

```
www-authenticate: Bearer resource_metadata="http://your-host/.well-known/oauth-protected-resource"
```

while the document at that URL correctly said `"resource":"https://your-host"`.
One installation disagreeing with itself about its own scheme, and a client sent
to a plaintext URL for an OAuth discovery document — refused outright by some
clients and reached only through a redirect by the rest.

A `map` now preserves what an outer proxy sent and falls back to `$scheme` only
where nothing is in front, which is the one case it was ever right for. Two
consequences worth knowing:

- **A client talking to the container directly can now claim `https`** on a
  plaintext connection, and will be handed links it cannot follow. That is
  self-inflicted and affects only that client; the old behaviour broke every
  correctly-deployed one.
- **Pinning `NACRE_MCP_CANONICAL_URL` remains the stronger answer** where the
  address is known, because it consults no header at all. A deployment behind
  two proxies should prefer it.

`pnpm lint:nginx` holds every proxying location to this and to `Host
$http_host`, and the end-to-end smoke asserts both branches — no header keeps
the connection's own scheme and port, `X-Forwarded-Proto: https` comes back
`https://`.

The other change in this release is `--profile demo` only:
`NACRE_DEMO_EMAIL_DOMAIN` sets the domain of the seeded identities, defaulting
to the `${ORG}.local` it always was. Nothing to do unless you want to change it.

### 0.17.0 — a platform administrator cannot be touched from inside an organization

**Nothing to do**, unless a `platform_admin` account of yours lives in an
organization that has other administrators. Then read the last paragraph.

No migration, no new variable, no new service. One behaviour change, and it is a
refusal that was missing.

`POST /v1/users` has always refused to *issue* `platform_admin`: that surface is
scoped to one organization and the role spans all of them, so minting one there
would be an escalation out of the scope doing the minting. Nothing enforced the
same argument in the other direction. An `org_admin` could take a platform
administrator whose account happened to be in *their* organization and:

| Request | What it did |
|---|---|
| `PATCH /v1/users/{id}` `{"role":"member"}` | demote them |
| `PATCH /v1/users/{id}` `{"disabled":true}` | disable them |
| `DELETE /v1/users/{id}` | the same call, the same effect |
| `POST /v1/users/{id}/password` | **reset the password and read the plaintext back** |

The last one is not a demotion. That endpoint returns the new password in the
response, so it was a takeover of the account that administers the installation,
performed by somebody who administers one tenant.

All four now answer **`403`** when the target holds `platform_admin`, in one
wording. Not `404`: `GET /v1/users` lists that person with their role, so the
caller is looking straight at the row and there is nothing invisible to protect.
Not `409` either — the last-administrator refusal beside it goes away once there
is a second administrator, and this one never does.

**What might break for you.** A script that disables leavers by walking
`GET /v1/users` and calling `DELETE` on each will now get a `403` for a platform
administrator it used to disable silently. That is the fix working; skip that
row. Nothing else on this surface changed, and every path still administers
everybody else exactly as before.

**Who can still change the role.** Nobody, through the API — by design. It is
issued and revoked by a command holding the database credentials. If you run the
commercial modules, `admin-global` ships one; if you do not, you have one
`platform_admin` at most and `init` never made it.

**Worth doing once, whatever else you do.** Give your platform administrator an
organization of their own. It was the arrangement that avoided all four of the
above before this release, and it stays the one that makes the question moot.

### 0.16.0 — the CLI administers an organization

**Nothing to do.** No migration, no new variable, no new service, and no server
change at all — this release is the `nacre` command reaching a surface the API
has served since 0.12.0 and the admin UI since 0.13.0.

```bash
npx @nacre.work/cli@0.16.0 users
npx @nacre.work/cli@0.16.0 audit --result deny --limit 100
```

`users`, `groups`, `service-accounts` and `audit`, all of them `org_admin`. If
you have been onboarding colleagues with `curl` against `/v1/users`, this is the
same endpoints with the argument parsing and the slug resolution in front of
them. A password is still generated and never accepted, and a service account
key is still shown once.

Two notes for anyone scripting against it:

- **`audit --limit` counts records, not pages.** It follows the cursor to the
  end of what you asked for, so a nightly export gets what it asked for rather
  than the first page repeated or truncated.
- A record carries both a `target` and a `detail` object and which one is filled
  depends on the event — `audit.read` fills the first, administrative events
  fill the second. `--json` gives you both verbatim; the human rendering merges
  them. If you already parse this endpoint, read both.

The npm pages for `@nacre.work/core`, `api`, `mcp` and `sdk` are also real pages
from this release rather than a title and one sentence. That changes nothing you
run.

### 0.15.0 — search is hybrid, and there is a `nacre` command

**One thing to do, and only if you want the change to reach documents you
already have.** No new variable, no migration, no service.

Search now carries the lexical branch it has always been described as carrying.
The `bm25` slot was created on every collection from the first release and
nothing ever wrote to it, so every query was dense-only; the worker fills it at
ingest now and the search path asks it.

That means **the lexical half sees documents ingested from 0.15.0 onwards**. A
collection built before this has the slot and no data in it, so nothing is
wrong and nothing is worse — dense retrieval is untouched, no result changes,
no query errors. What you do not get, until you say so, is exact-term matching
over the documents already there.

```bash
docker compose run --rm api rebuild-collection --org {slug}
```

It recreates the collection and requeues every live document, so everything is
written by the build you are now running. **It re-embeds**, so it costs what the
original ingest cost — plan it like a reindex, not like a restart. Search keeps
answering from the old collection until it completes.

A deployment that skips it keeps working indefinitely. This is a quality
improvement with a backfill, not a correctness fix.

**New artifact: `@nacre.work/cli`**, the `nacre` command — `login`, `layers`,
`grant`, `ingest` (with `--watch`), `search` and `eval`. Nothing installs it on
your behalf and no deployment changes because of it; it is what a person or a
pipeline runs against an installation. `npx @nacre.work/cli`.

> **`@nacre.work/cli@0.14.3` on npm is broken and this release replaces it.** It
> was published by hand with a bare `npm publish`, which does not rewrite
> `workspace:*` into a concrete version, so its manifest names a dependency npm
> cannot resolve and `npm i` fails. It is deprecated on the registry. Nothing
> else was affected — every other package at 0.14.3 was published by the
> pipeline, which packs with pnpm. See [releasing.md](./releasing.md).

`GET /v1/documents/{id}` gains `external_id`, the identifier you ingested the
document under. Additive, and it follows the document's own permission like
every other field there.

### 0.14.3 — the adapter says which credential it is holding

**Nothing to do**, no migration and no new configuration. Only relevant if you
route embeddings or reranking through the embedding adapter.

0.14.2 named the variable. The question that leaves is the one an operator
cannot answer from outside: **a rotated token and a redeployed container fail
identically whether the new token is wrong or the old one is still in the
environment.** Same 401, same message. A `docker compose` `environment:` entry
overriding an `env_file:`, or a Deployment that did not roll, both produce the
second.

The adapter now reports a fingerprint of each credential it loaded — never the
credential — at startup, in `GET /health`, and in the refusal:

```
cloudflare answered 401, rejecting this adapter's credential sha256:1d4bedd426ab
from NACRE_EMBED_CLOUDFLARE_API_KEY[_FILE]
```

`printf %s "$TOKEN" | sha256sum | cut -c1-12` on the token you deployed answers
it. This is the shape the core already logs for the JWT signing key, and the
argument is the same: anyone who can read this log can read the environment it
came from, so it grants nothing that was not already granted.

`GET /health` gained a `credentials` object and its `rerank` object gained a
`credential` field. Both are fingerprints. If you parse `/health`, nothing was
removed.

**A credential the container cannot use is now refused at startup**, which is
the other half of the same incident. `NACRE_..._API_KEY="cf-token"` — quoted
where the quoting is not removed, as a Kubernetes manifest value or a secret
store round-tripping JSON both do — sent `Authorization: Bearer "cf-token"` and
got a `401` from a token that was correct. So did one carrying a line break
from a paste, which failed inside the HTTP client several layers from the
variable holding it. Both are refused by name now, and neither is repaired:
stripping the quotes would hide the deployment that added them.

If your credential is quoted and has been working, it has not been — the
container would be failing every request. If it is quoted and this refusal is
new to you, remove the quotes before upgrading.

**And 0.14.2's message was too long for its own reader.** The core bounds an
endpoint's reason at 200 characters, because a vendor's error can quote the
input it rejected — a bound that applies to the adapter's messages too, since
nothing on that side can tell whose message it is. The credential refusal was
337 characters for `cloudflare` and 250 for `openai-compatible`, so its tail was
cut. It is 145 at worst now, and the guidance that used to be prose is a
structured field on the adapter's own log line, which has no bound. A test holds
every entry in both vendor tables against the bound read out of the core, so
the next variable name long enough to overflow fails there rather than in
somebody's log.

### 0.14.2 — a vendor's 401 names the variable that holds the credential

**Nothing to do**, no migration and no new configuration. Only useful if you
route embeddings or reranking through the embedding adapter to a hosted vendor.

0.14.1 made a vendor's refusal travel, and the first thing it surfaced was
`cloudflare answered 401` — accurate, and one step short. A 401 from a *vendor*
means the credential the adapter holds was rejected, which is the **opposite**
of the 401 an endpoint you pointed at directly gives: that one means it wants a
credential and Nacre sends none. The two read alike and point opposite ways.

The message now says which, and names the pair of variables that could hold it:

```
cloudflare answered 401 — it rejected the credential this adapter holds, rather
than refusing the request. Check NACRE_EMBED_CLOUDFLARE_API_KEY or
NACRE_EMBED_CLOUDFLARE_API_KEY_FILE …
```

The pair is carried from the table entry that resolved the credential rather
than looked up by vendor name, because `cloudflare` is in **both** the embedding
and the reranking tables under different variables — a rerank failure naming
`NACRE_EMBED_CLOUDFLARE_API_KEY` sends you to a variable that is not in play.

Only 401 and 403. A 429 is a quota and a 5xx is the vendor's own outage; those
keep the bare status, because a paragraph about credentials on either is noise
on a failure nobody at your end can fix. `docs/config.md` has the table.

### 0.14.1 — a refusal says why, in the log

**Nothing to do**, no migration and no new configuration. 0.14.0 runs against
this database, so rolling back is safe. Both changes are about what a log holds
when something refuses, and neither changes what goes on the wire.

**A model endpoint's own reason now travels.** A vendor refusing reached you as
`the embedding endpoint at http://embedding-adapter:8091/embeddings answered
502` — which names the one process in the chain that did not decide anything.
502 is the embedding adapter's word for "somebody else's service failed", and
which vendor and what it said were in its response body, which the core
discarded. The message now carries it:

```
… answered 502: cloudflare answered 429
```

**And the adapter logs its refusals.** Its whole log was the line it printed at
startup, so a container answering 502 to every request looked healthy in
`docker logs`. Every refusal is a line now — `"level":"error"` for 5xx,
`"level":"warn"` for a request that was the caller's mistake, and still nothing
at all on success. If your deployment does not route through the adapter this
changes nothing you will see.

Neither ever carries the vendor's response body. A vendor's error can quote the
input it rejected and the input is document text, so the adapter forwards only
its own sentence and the core takes one declared field, bounded at 200
characters.

**Authentication refusals say why in the log too.** The 401 on the wire is
unchanged and stays unchanged deliberately — invariant 4 makes "no permission"
and "no such object" indistinguishable, and a 401 that explained itself would
be a probing oracle. The log now carries the reason with the request id, so
"this client cannot connect" is answerable from the server side. A missing
bearer and an unverifiable token log at `debug`, so a scanner on a public port
does not fill a disk; raise `NACRE_LOG_LEVEL` to `debug` to see those two.

### 0.14.0 — disabling somebody is reversible on the wire, and the connections list says who

**Nothing to do**, no migration and no new configuration. 0.13.0 runs against
this database, so rolling back is safe.

Both changes came out of one report: an MCP client that never recovered from
*connect → the person is disabled → the person is re-enabled*.

**A suspended person is now a retryable refusal.** Disabling somebody suspends
the connections they approved and deliberately does not spend their refresh
tokens, so re-enabling is a restoration rather than a reconnection —
`docs/authz.md` has said so since delegations existed, and the promise stopped
at the table. The refusal reached the client as `400 invalid_grant`, which RFC
6749 defines as *this grant is dead*, so every conforming client discarded the
token the server had gone out of its way to keep. `/oauth/token` answers **503
with `Retry-After: 60` and `temporarily_unavailable`** for that one case now.
Every other refusal — expired, revoked, unknown, replayed — is unchanged and
still `invalid_grant`.

Worth knowing if you have ever disabled somebody and found their applications
never came back: they could not, and re-approving through the consent screen was
the only route. It is not any more. A client that has never heard of
`temporarily_unavailable` still reads 503 with `Retry-After` as "ask again",
which is the whole reason the status carries the behaviour rather than the code.

**The connections list names the person.** "Acts as" read `the person who
approved it` on every delegation row — a constant, which on an administrator's
list withheld the one fact the column exists for. `GET /v1/oauth/consents`
returns **`approved_by_email`** and **`approver_disabled`**, both `required` in
the contract, and the screen reads `you` for your own and the address for
anyone else's. The second field is the one that matters after the paragraph
above: a delegation of a disabled person is refused on every request and its
renewal is refused too, so a connection that looks live and answers nothing now
says why on its own row.

If you generate a client from `docs/openapi.yaml`, regenerate it. Nothing was
removed, so an existing client keeps working.

### 0.13.0 — one command on every platform, and reranking through a vendor

**No migration.** 0.12.1 runs against this database, so rolling back is safe.
There is **one thing to remove** before upgrading, and it applies to exactly one
kind of deployment.

**Remove `COMPOSE_FILE` from `.env` if it names `docker-compose.apple-silicon.yml`.**
That overlay is deleted in this release, and Compose exits on a file it cannot
open — before it starts anything, so the failure is at least immediate and names
the path. The two keys the overlay carried are in `docker-compose.yml`
unconditionally now: `host.docker.internal` on the application services, and
`platform: linux/amd64` on the two Text Embeddings Inference services, which
publish no arm64 image. Both are inert where they are not needed, so
`docker compose --profile minimal up -d` is the whole command on macOS and Linux
alike. If you set `COMPOSE_FILE` for any other reason, see "Local overrides" in
[config.md](./config.md) — naming it turns off the automatic `docker-compose.override.yml`,
silently, and that is unchanged.

`.env.example` is regrouped, and if you copy a fresh one there is one difference
worth knowing: the embedder is now **three commented choices** rather than a
half-filled default. Uncomment one — a host-native endpoint, the `full`
profile's own TEI, or the adapter — because there is no endpoint worth shipping
as a default and `init` refuses by name until there is one. Your existing `.env`
is unaffected.

**The API and the worker no longer require `NACRE_DEFAULT_EMBEDDING_ENDPOINT`
and `NACRE_DEFAULT_EMBEDDING_MODEL` to start.** Only `init` does, which is the
one command that has to decide what a *new* organization's first provider is;
every other process resolves an embedder out of `embedding_providers` in
Postgres and always did. Nothing you have set stops working — this only removes
a refusal that had nothing behind it, and it is what lets a deployment run
entirely on providers created through `/v1/embedding-providers`.

New, and off unless you configure it:

- **Reranking through a hosted vendor.** `HttpReranker` speaks Text Embeddings
  Inference's `/rerank`, so a deployment with no GPU had nowhere to point
  `NACRE_RERANKER_ENDPOINT`. The embedding adapter answers that shape now, which
  means **the core needs no code**: point `NACRE_RERANKER_ENDPOINT` at the
  adapter instead of at a TEI container and nothing else changes. Vendors are
  `cloudflare`, `cohere`, `jina` and `voyage`, one per adapter, chosen with
  `NACRE_RERANK_VENDOR` and `NACRE_RERANK_MODEL`. Credentials are separate from
  the embedding ones even where the vendor is the same, because an adapter that
  only reranks must not have to set an embedding variable.
- **`voyage` as an embedding vendor.** Its wire format is OpenAI's and it still
  has its own entry, because Anthropic publishes no embeddings API and points at
  Voyage — so that is where "embeddings from Anthropic" has to land, and it
  should not require knowing a URL.
- **A route may name the vendor's own spelling of the model**:
  `NACRE_EMBED_ROUTES=bge-m3=cloudflare:@cf/baai/bge-m3`. The left-hand side
  stays the routing key and stays what a caller sends. This is what lets an
  installation already indexed against `bge-m3` move onto a vendor's copy of the
  same weights **without a reindex** — a layer's named vector is derived from the
  model, so renaming the model is a different slot and therefore a collection
  replaced and every point copied, to move vectors that did not need to move.
  Every existing `model=vendor` is exactly what it was; a trailing colon is
  refused rather than read as "no substitution", and `GET /health` reports the
  substitution so a typo surfaces before a vendor answers 400.

Both of those are in the adapter, which is `--profile hosted` and is absent from
`minimal`, `full` and `airgapped` rather than switched off in them. Routing a
model through it means the text of your documents leaves your installation, and
that is not something a profile name should hand you.

Three fixes worth knowing about:

- **The `web` front door resolves its upstreams per request.** nginx resolves a
  literal `proxy_pass` name once at load and caches it forever, so restarting
  `api` or `mcp` — anything that changes a container's address — left the
  console proxying to an address nothing was on, until `web` was restarted too.
- **Re-sending a document that failed retries it.** The ingest upsert compared
  only the content hash, so a document that failed for a transient reason — an
  embedder that was down — was answered `queued` and never re-queued. Sending
  the identical bytes again is the obvious thing to try and it did nothing.
- **A reindex with nothing to re-embed finishes.** A layer whose documents were
  all already on the target model left the migration in progress forever,
  because the completion check only ran after a claim and there was never
  anything to claim.

### 0.12.1 — a 401 from a model endpoint explains itself

**Nothing to do**, no migration and no new configuration. 0.12.0 runs against
this database, so rolling back is safe. No behaviour changed: the same requests
succeed and the same ones fail.

What changed is what a failure *says*. An embedder or reranker endpoint
answering `401` or `403` now explains that it wants a credential, that Nacre
sends none and structurally cannot — `embedding_providers` has no column for
one, deliberately, since a vendor key there would reach every database dump —
and that the embedding adapter is the way to reach a hosted vendor. Other
statuses are unchanged.

Worth knowing if you have ever tried pointing an endpoint straight at OpenAI or
another hosted API and could not work out why it refused: that is the case, it
never could work, and `docs/config.md` previously implied otherwise. Both that
paragraph and `docs/apple-silicon.md` are corrected.

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
