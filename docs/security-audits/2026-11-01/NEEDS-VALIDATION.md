# Needs Validation — nacre (core)

Nine source-grounded boundary hypotheses from the run documented in `REPORT.md` that could not be resolved to `confirmed` or `rejected` inside the sandbox. Run `nacre-run-1`, commit `f1806fef282e1e8e3f316a8ebc5e3c3c00ec8a84`. **No severity is assigned to anything in this file** — per the skill's own rule, `needs_validation` means a specific hypothesis is blocked, not a low-confidence vulnerability. List order is alphabetical by fingerprint, not priority.

Each entry already went through one independent fresh-verifier pass (not a second Phase-5 pass — see REPORT.md section 0): the verifier re-read the relevant source, attempted to resolve the hypothesis locally inside the sandbox, and recorded exactly why it could not.

---

## A Postgres restore rolls groups_version back, so the version-keyed principals cache in Redis can serve group memberships from the discarded timeline

<a id="core-authz-cache-ts-principalscachekey-groups-version-rollback-on-restore"></a>

**Fingerprint:** `core/authz/cache.ts:principalsCacheKey:groups_version-rollback-on-restore`

### Description

The effective-principals cache stores a principal's transitive group set (the user plus every group it belongs to) in Redis under acl:principals:{org}:{type}:{id}:v{groups_version}. On a hit it returns that set without any other check. Its design says staleness is impossible because a membership change bumps organizations.groups_version, so every later read builds a different key. That only holds while the version never goes down. A pg_restore puts groups_version back to the value in the dump. Redis is not part of the restore. The Compose profile persists it on a named volume (--save 60 1), the runbook stops only worker, api and mcp, and nothing in the repository deletes or namespaces acl:principals:* keys. So the first trigger-driven change after the restore (any group, group_members or grants write) moves the version onto a number the discarded timeline already used. If an entry for that version is still within NACRE_ACL_CACHE_TTL (default 60 s, max 3600 s), a principal gets the cached memberships from before the restore. Grants are reloaded from the database, but a cached group that the restored database says the user is not in still contributes that group's grants. Example: a user added to a group after the snapshot (for instance an intruder adding themselves, which is a reason to restore) keeps that group's layers until the entry expires. The hunter reproduced this locally against real Postgres with the real trigger, modelling the restore by writing the snapshot rows back with triggers off. Whether it happens in a real deployment depends on how long passes between the last pre-restore cache write and the first post-restore request, which source cannot settle.

### Claimed root cause

principalsCacheKey (packages/core/authz/cache.ts:85-87) uses organizations.groups_version as its only freshness token. That counter lives in the restorable database: it is incremented only by the trigger in 0003_groups_version.sql:21 and read by loadGroupsVersion (store.ts:149-154), so a restore can move it backwards. The cache store is Redis, which is outside the restore and persisted, and has no per-database epoch or restore marker. A version number can therefore come back meaning a different membership state, and cachedEffectivePrincipals (cache.ts:116-121) returns the old entry with no other check.

### Trace

  - **entrypoint** — `docs/operations/restore-from-backup.md:125` (Step 2. Restore Postgres)
    The operator runs pg_restore --clean, which puts organizations back as dumped, groups_version included. Step 1 (line 105) stops worker, api and mcp but leaves Redis running with its contents. No step mentions Redis.
  - **propagation** — `packages/core/migrations/0003_groups_version.sql:21` (bump_groups_version)
    After the restore, the next INSERT, UPDATE or DELETE on groups, group_members or grants adds one to the restored value, landing on a version number the discarded timeline already used and cached.
  - **propagation** — `packages/api/src/adapters.ts:1711` (principalsFor)
    Each request reads the current groups_version from the restored database and passes it to cachedEffectivePrincipals with the shared RedisCache (main.ts:125).
  - **propagation** — `packages/core/authz/cache.ts:114` (cachedEffectivePrincipals)
    The key is built from org, principal type, principal id and version only, so it is identical to the key written before the restore.
  - **sink** — `packages/core/authz/cache.ts:121` (cachedEffectivePrincipals)
    The cached principal set is returned as authoritative, and the group graph is not loaded. Grants are then matched against groups the restored group_members no longer holds.

### Evidence

  - `packages/core/authz/cache.ts:12` — The design claims staleness is impossible because the version is in the key. That is true only if the version never repeats with a different meaning.
  - `packages/core/authz/cache.ts:86` — The key acl:principals:{org}:{type}:{id}:v{groupsVersion} has no epoch, instance or restore-specific part.
  - `packages/core/authz/store.ts:149` — The version is read straight from organizations.groups_version, a column in the restorable database.
  - `packages/core/config.ts:1203` — NACRE_ACL_CACHE_TTL defaults to 60 seconds, with a maximum of 3600. It is the only bound on the window.
  - `docker-compose.yml:311` — Redis runs with --save 60 1 on a named volume (line 312), so its keys survive a restart and nothing restores them alongside Postgres.
  - `docs/operations/restore-from-backup.md:334` — The runbook says the permitted set is exactly as correct as the restored grants and has no step that flushes Redis or the acl:principals namespace. No code in the repository deletes those keys either.

### Blockers

- Whether a post-restore request can arrive within NACRE_ACL_CACHE_TTL of a pre-restore cache write for the same re-used version depends on the deployment's TTL and restore procedure. With the 60 s default and the runbook's manual stop, restore and rebuild it is unlikely. It is plausible with a raised TTL, or with a restore onto a running installation such as the commercial backup module's screen restore, whose code is not in this repository.
- Whether the deployment's Redis survives the Postgres restore unflushed is not visible in source: an operator procedure or a module-side step may flush it. The shipped Compose file does persist it.
- The local reproduction (agents/h14-collections/artifacts/result.txt) modelled pg_restore by writing the snapshot rows back with triggers disabled, and drove cachedEffectivePrincipals plus resolve directly rather than the HTTP API. It did not run pg_dump/pg_restore or a real Redis through the API path.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
In a sandbox with Postgres 17 (all migrations), pg_dump/pg_restore and Redis: provision a dummy organization with a group G that holds a read grant on layer L, and a dummy user U who is not in G. Take a pg_dump. Add U to G (the version goes from v to v+1) and run one search as U through the API so Redis holds acl:principals:{org}:user:{U}:v{v+1}. Run pg_restore --clean --if-exists as the owning role, without touching Redis. Create an unrelated group (the version returns to v+1). Within NACRE_ACL_CACHE_TTL, search as U. Results from L while group_members holds no U-G row confirm it. Then repeat with redis-cli DEL on acl:principals:* after the restore and confirm U gets nothing.

**Owner-observed (needs a real deployment or external system):**
The owner checks whether their restore procedure (the open runbook or the commercial screen restore) flushes Redis or deletes acl:principals:* keys before api and mcp serve again; whether NACRE_ACL_CACHE_TTL is raised above 60; and, for a restore onto a running installation, how much time passes between the last API or MCP request before the restore and the first one after it. This is a read-only check of configuration and procedure; no restore needs to be run against production.

---

## Release publishing is not bound to main

<a id="github-workflows-release-yml-publish-authority-not-bound-to-main"></a>

**Fingerprint:** `github/workflows/release.yml:publish:authority-not-bound-to-main`

### Description

release.yml's workflow_dispatch trigger (line 30) takes no `branches:` restriction and no `environment:` gate at the trigger level. Every job then checks out code with a bare `actions/checkout@v4` and no `ref:` (lines 73, 129, 366, 482), which defaults to whatever ref the caller dispatched. The `decide` job's publish/tag/images outputs are computed purely from registry and tag state (scripts/release-plan.mjs), never from which branch was checked out, and none of `npm` (id-token: write, line 89), `tag` (contents: write, line 364) or `containers` (packages: write, line 480) is bound to a GitHub `environment:` or guarded by an `if: github.ref == 'refs/heads/main'` check. So anyone able to trigger workflow_dispatch (GitHub requires Write access to the repository for that, which is a repository-permission fact, not a source fact) can point the whole pipeline at any branch they can push to, and it will build, test and publish that branch's code to the public npm registry under OIDC trusted publishing, push container images to ghcr.io/Docker Hub, and write a git tag and GitHub release for it — all without main's required review ever applying.

### Claimed root cause

No job in release.yml carries an `environment:` key or a ref/branch guard, so the privileged jobs (npm publish via OIDC, the git tag/release, and the ghcr.io/Docker Hub image push) are gated only on the registry/tag state the dispatched ref happens to produce, never on that ref being `main`. docs/releasing.md's trusted-publisher setup (line 122) names only the repository and the workflow filename, with no mention of pinning an Environment name, which is the one additional constraint npm's trusted-publisher configuration offers for exactly this case.

### Trace

  - **entrypoint** — `.github/workflows/release.yml:30` (on.workflow_dispatch)
    workflow_dispatch accepts the event from any ref; there is no `branches:` filter and the trigger carries no `environment:` gate, only free-text `packages`/`dry_run` inputs.
  - **propagation** — `.github/workflows/release.yml:73` (decide job: actions/checkout@v4)
    No `ref:` is given, so this (and the identical checkouts at lines 129, 366 and 482) defaults to `github.ref` — whichever ref the caller dispatched against — and `node scripts/release-plan.mjs` (line 77) decides `publish`/`tag`/`images` purely from the manifests on that ref versus the registry; release-plan.mjs contains no check of the ref or branch name (confirmed by source read, no `github.ref`/`refs/heads` reference in that script).
  - **propagation** — `.github/workflows/release.yml:89` (npm job permissions)
    `id-token: write` (the OIDC credential npm's trusted-publisher exchange consumes) is granted to this job whenever `decide.outputs.publish == 'true'` (line 82), with no `environment:` key anywhere in the file restricting which ref may hold that grant.
  - **sink** — `.github/workflows/release.yml:339` (npm job: publish step)
    `npm publish --loglevel verbose "$tarball"` runs against a tarball packed (line ~320) from whatever tree was checked out — i.e. the dispatched ref — authenticated by the OIDC-exchanged trusted-publisher credential.

### Evidence

  - `docs/releasing.md:122` — "Then open the package on npmjs.com and add the trusted publisher for this repository and the release workflow." Binding is stated as (repository, workflow file) only; no step mentions an Environment name, which is the field npm's trusted-publisher UI offers to additionally pin a ref/branch policy.
  - `.github/workflows/release.yml:84` — `permissions:` block for the npm job grants `id-token: write` with no accompanying `environment:` key; a repository-wide search of this file for `environment:` finds zero matches, so none of the npm, tag or containers jobs is bound to a protected environment.
  - `CODEOWNERS:19` — `.github/workflows/` itself requires @nacre-work/maintainers review to change — consistent with `main` being treated as the branch that gates a release (the workflow's own header says "Shipping is a consequence of what is on main, so main is what decides") — which is the premise the missing ref/environment guard on workflow_dispatch does not actually enforce.

### Blockers

- Whether any GitHub account holds Write access to nacre-work/nacre without also being able to merge to `main` unreviewed (i.e. whether branch protection on `main` is the only thing standing between a collaborator and a privileged release, while that same collaborator could push to a non-main branch and dispatch this workflow against it) is a repository/organization permission setting that is not represented in this source export.
- Whether the npm trusted-publisher entries actually configured for @nacre.work/core, /api, /mcp, /sdk and /cli pin an Environment name (which would make GitHub's OIDC claim's environment field, present only when the job sets `environment:`, part of what npm checks) is configured on npmjs.com's own settings pages and is not visible in source or fully specified by docs/releasing.md.
- The sandbox here has no network access and cannot dispatch a real GitHub Actions run, query the GitHub REST API for repository collaborators/rulesets, or query npmjs.com for trusted-publisher configuration, so this cannot be exercised or observed locally; doing any of that from here would also mean contacting a deployed/external service, which is out of scope for this verification.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Already performed by static read: confirmed via `grep -n "environment:" .github/workflows/release.yml` (zero matches) and via `grep -n "ref:"` on the same file (zero matches, so every `actions/checkout@v4` defaults to the dispatched ref) that no job-level environment gate or ref/branch guard exists anywhere in the npm, tag or containers jobs, and via `grep -n "ref\|branch\|refs/heads"` on scripts/release-plan.mjs that the decide step's publish/tag/images decision never inspects which ref it was run against. No further local reproduction is possible without the GitHub platform and npm registry.

**Owner-observed (needs a real deployment or external system):**
Repository owner opens Settings → Branches/Rules for nacre-work/nacre and lists every account with Write (not just Maintain/Admin) access, and confirms whether `main`'s required-review protection is the only thing distinguishing a trusted release from a collaborator pushing to any other branch and using 'Run workflow' (or the API) to dispatch release.yml against it. Separately, for each of the five published packages, open npmjs.com → package Settings → Trusted Publisher and check whether an Environment name is set. If write access is broader than main-merge rights and no environment is pinned, add an `environment:` (bound to a GitHub Environment whose deployment-branch policy allows only `main`) to the npm, tag and containers jobs — or add `if: github.ref == 'refs/heads/main'` to each — and configure the matching Environment name on each npm trusted publisher; update docs/releasing.md's five-step checklist to require it.

---

## REST layer name and description have no length bound, so the per-request MCP search tool description has no size bound for anyone who may read the layer

<a id="layer-text-unbounded-in-mcp-search-tool-description"></a>

**Fingerprint:** `layer-text-unbounded-in-mcp-search-tool-description`

### Description

A principal with admin on a workspace can set a layer's name (POST or PATCH /v1/layers) or description (PATCH /v1/layers/{id}) to any string. The REST handlers check only typeof string, and nothing below them bounds the value: the adapter stores it with a plain INSERT/COALESCE UPDATE, migration 0001 has no CHECK, and the only limit is the request body cap, NACRE_MAX_DOCUMENT_BYTES (50 MB by default). The admin MCP door caps the same fields at 200/2000. On every Streamable HTTP MCP request, buildServer reads up to 13 layers the caller may read and searchDescription puts each name and description in full into the search tool description. That description is built for every principal who can read the layer, including an org_admin by role, and is sent on every tools/list. CATALOG_SAMPLE was added to keep this description from growing to megabytes, and it bounds only the number of layers, not the length of each one, so a single stored value undoes that bound. The writer can also drive the cost themselves, since they can read their own layer. Verifier correction: the prompt-injection framing is hardening, not a boundary crossing. The schema comment declares layer description to be the user-facing copy this description is built from, so putting it in the description is by design. A workspace admin can already put equivalent text into documents in the same layer, and docs/mcp.md accepts that text as untrusted input to the calling model. Every tool call is still authorized in its handler, so the metadata grants nothing. The part still open is availability: one bounded write is retained, then re-read and serialized on every MCP request by other principals and possibly on a process shared between organizations. Its shared effect depends on deployed limits.

### Claimed root cause

POST /v1/layers (server.ts:5545-5570) and PATCH /v1/layers/{id} (server.ts:5719-5747) validate name and description only as strings. PostgresLayers.create (adapters.ts:2196) and updateLayer (adapters.ts:2701) store them unbounded, and layers.name/description (0001_init.sql:107,110) carry no CHECK. searchDescription (tools.ts:139-165) caps the number of layers at CATALOG_SAMPLE but not the length of each, after trim() only. buildServer (factory.ts:202-206) rebuilds it per request from layerCatalog.forCaller (services.ts:153-176) and registers it unchanged (factory.ts:251). The admin MCP door bounds the same fields (admin-writes.ts:622,690), so the two write doors do not share one rule.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:5720` (PATCH /v1/layers/{id})
    An authenticated principal's name and description are accepted after typeof-string checks only (lines 5722-5731), with no length bound beyond the request body cap
  - **propagation** — `packages/api/src/adapters.ts:2692` (PostgresLayers.update)
    Authorized by referenceAllows(workspace, admin) and withinDelegation, then written by COALESCE at 2701 with no length check; create at 2196 stores slug and name the same way
  - **propagation** — `packages/mcp/src/services.ts:153` (layerCatalog.forCaller)
    Reads full l.slug, l.name and l.description for a bounded page of layers the caller may read
  - **propagation** — `packages/mcp/src/factory.ts:203` (buildServer)
    Called per Streamable HTTP request through the ordinary factory (packages/mcp/src/server.ts:403-410) with limit CATALOG_SAMPLE, so the stored text is re-read and re-serialized on every request
  - **propagation** — `packages/mcp/src/tools.ts:157` (searchDescription)
    Each layer's name and description are joined into the text after trim() only, and the slug is prefixed at line 160; only the layer count is bounded (slice to CATALOG_SAMPLE)
  - **sink** — `packages/mcp/src/factory.ts:251` (buildServer tool registration)
    The generated string becomes the search tool's description, served in tools/list to each reading principal's client

### Evidence

  - `packages/api/src/admin-writes.ts:690` — The sibling admin MCP door caps the description at 2000 and the name at 200 (line 622), so the REST door is not equivalent
  - `packages/core/migrations/0001_init.sql:110` — layers.description is unconstrained text. The comment at 108-109 says it is the user-facing copy the MCP search description is built from, so putting it into the description is intended; its length is not bounded
  - `packages/mcp/src/tools.ts:137` — CATALOG_SAMPLE was introduced because interpolating every layer made 'a megabytes-long tool description'. It bounds the count but not each entry, so one stored value restores the size the comment set out to prevent
  - `packages/core/config.ts:1267` — The effective cap is NACRE_MAX_DOCUMENT_BYTES, default 52428800, applied as the body limit for every JSON request (server.ts:4307-4312)
  - `docs/mcp.md:710` — Retrieved text is documented as untrusted input to the calling model. The same workspace admin can put equivalent text into layer documents, so the injection angle grants no new authority and is hardening (labeling), not a finding
  - `packages/mcp/src/admin-tools.ts:72` — AUTHORED_NOTICE labels layer text as authored data on the admin surface; the ordinary surface's tool description carries no such label (hardening)
  - `packages/mcp/src/tools.ts:139` — Hunter's local check (agents/h18-mcp-meta/artifacts/result.txt, re-read): a 100000-char dummy description produced a 100207-char search description, and the REST PATCH with a stub port answered 204 and forwarded 100059 chars unchanged

### Blockers

- Whether the stored size reaches a harmful shared effect depends on deployed facts outside source: whether the API port is reachable other than through the web nginx (its template sets no client_max_body_size, so the nginx default is 1 MB), the configured NACRE_MAX_DOCUMENT_BYTES, the MCP container's memory limit, and whether one MCP process serves several organizations. Showing the effect would take availability or load testing, which the validation rules forbid
- Prompt-injection steering of another principal's agent through tool metadata depends on model and host behavior and cannot be observed locally. It is recorded as hardening only, because the writer already has an equivalent documented-untrusted channel (document text) and every tool call is re-authorized

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
In the sandbox with --postgres, use the real PostgresLayers and a dummy member holding admin on one workspace. PATCH a layer description of a few hundred KB (inert dummy text). As a second dummy member with read on that layer, call buildServer through the ordinary factory with layerCatalog twice. Confirm that each built search description contains the full value, and record its byte length and the process's heapUsed delta per build, keeping sizes small. Then confirm that the admin MCP update_layer proposal refuses the same value above 2000 chars. Do not run load or availability tests.

**Owner-observed (needs a real deployment or external system):**
The owner records whether the API is reachable other than through the web nginx and the effective request body limit on that path, the value of NACRE_MAX_DOCUMENT_BYTES, the MCP container's memory limit, and whether one MCP process serves several organizations. If an upload of several MB reaches PATCH /v1/layers/{id}, the owner decides from those limits whether the per-request re-serialization is a shared-availability defect or a same-organization nuisance. Either way, the fix is to bound name, slug and description in PostgresLayers.create and update at the admin door's 200/2000, with a matching DB CHECK and OpenAPI maxLength, and to truncate each entry inside searchDescription.

---

## Model-endpoint responses (embedder, reranker) are buffered with no per-response byte cap, so a tenant-steered embedding endpoint can exhaust the shared worker's heap

<a id="model-endpoint-response-body-no-byte-cap"></a>

**Fingerprint:** `model-endpoint-response-body-no-byte-cap`

### Description

Every model-endpoint response is read with `await response.json()`. There is no application byte limit, and the undici Agent in egress-fetch.ts sets no `maxResponseSize`. The only bound is the request timeout: 120 s for the worker, 15 s for the API embedder and 3 s for the reranker. The embedding endpoint can be steered by a tenant. An org_admin stores any public http(s) `endpoint` through POST /v1/embedding-providers. admitEmbeddingEndpoint (adapters.ts:2348) refuses only private and internal addresses, and NACRE_EMBED_TENANT_PROVIDERS defaults to true (config.ts:1144). When the worker embeds that tenant's documents, sendBatch buffers and JSON-parses the whole response. Local measurement through the real egressFetch transport: a 40 MiB response made of a JSON array of zeros became 20,971,521 elements, 213 MiB of heap and about 521 MiB RSS, where the legitimate answer for one input is a few KB. With the heap capped at 96 MiB, the same body killed the process with `FATAL ERROR: Reached heap limit … JavaScript heap out of memory` (exit 134). That kill is a V8 abort that no try/catch handles, not a caught error. The worker is one serial loop (`while (running)`, main.ts:838) that claims documents across every organization. An OOM kill therefore stops ingestion for every tenant on that replica until it restarts. The claimed document is then reclaimed after NACRE_INDEX_LEASE (900 s by default). Correction to the hunter's wording: this is not an unbounded crash-loop. The claim UPDATE increments `attempts` (claim.ts:118), and reapOnce marks a document failed once `attempts >= NACRE_INDEX_MAX_ATTEMPTS` (reap.ts:63, default 5). Each attacker document can therefore cost at most about five worker kills. A sustained effect needs the attacker to keep ingesting new documents. The same unbounded read exists in the multi-tenant API process (HttpEmbedder.send adapters.ts:1156, used for query embedding) and in HttpReranker.rank (rerank.ts:100). The reranker endpoint is configured by the operator, so it is a lower-severity instance. endpointReason (endpoint.ts:120) also calls response.json() without a bound on the error path.

### Claimed root cause

No per-response byte cap is applied to model-endpoint reads. The worker's sendBatch (main.ts:363), the API's HttpEmbedder.send (adapters.ts:1156), HttpReranker.rank (rerank.ts:100) and endpointReason (endpoint.ts:120) all call `response.json()` directly. egressFetch's guardedAgent (egress-fetch.ts:125/130) builds `new Agent({ connect: { lookup } })` with no `maxResponseSize`. A body from a tenant-chosen public host is therefore limited only by the time budget, the attacker's bandwidth and V8 limits. JSON.parse then turns it into a heap object graph several times larger than the body (about 5x for an array of numbers).

### Trace

  - **entrypoint** — `packages/api/src/server.ts:5253` (POST /v1/embedding-providers)
    An authenticated org_admin creates an embedding provider. The handler checks only that the endpoint parses as an absolute http(s) URL (5276-5286) and then calls embeddingProviders.create (5302), whose admitEmbeddingEndpoint refuses only private and internal addresses. Any public host is stored. The route exists while NACRE_EMBED_TENANT_PROVIDERS is true, which is the default.
  - **propagation** — `packages/worker/src/main.ts:329` (embedderFor/sendBatch)
    The serial worker resolves the layer's provider row and POSTs chunk text to the stored endpoint through egressFetch, with signal AbortSignal.timeout(EMBED_TIMEOUT_MS = 120_000).
  - **propagation** — `packages/core/egress-fetch.ts:125` (guardedAgent)
    The undici Agent is built with only a connect-time lookup guard and no maxResponseSize, so the transport puts no limit on body size.
  - **sink** — `packages/worker/src/main.ts:363` (sendBatch response handling)
    `await response.json()` buffers and parses the whole attacker-sized body in the cross-organization worker process. Locally, a 40 MiB body became a 213 MiB heap object graph, and under a 96 MiB heap cap it was an uncatchable fatal OOM (exit 134).

### Evidence

  - `packages/worker/src/main.ts:363` — `const body = (await response.json()) as { data?: ... }`: the embedder response is read with no size bound. Only the surrounding egressFetch call is time-bounded (line 338, EMBED_TIMEOUT_MS).
  - `packages/worker/src/adapters.ts:1968` — `export const EMBED_TIMEOUT_MS = 120_000`: a two-minute window in which the attacker can stream body bytes.
  - `packages/core/egress-fetch.ts:125` — `systemAgent ??= new Agent({ connect: { lookup: publicOnlyLookup() } })`, and the same at line 130: no maxResponseSize. A grep of packages finds no maxResponseSize anywhere.
  - `packages/api/src/adapters.ts:1156` — The API query and reindex embedder: `const body = (await response.json())` with no size bound, inside the multi-tenant API process.
  - `packages/api/src/rerank.ts:100` — Reranker: `const body = (await response.json()) as unknown` with no size bound. The endpoint is configured by the operator, so this is a lower-severity instance.
  - `packages/core/endpoint.ts:120` — endpointReason calls `await response.json()` on a non-2xx body from the same endpoint with no bound, before it truncates the extracted text.
  - `packages/api/src/adapters.ts:2348` — admitEmbeddingEndpoint is the only network control on a tenant endpoint. It decides where a request may go and says nothing about how much may come back.
  - `packages/core/config.ts:1144` — `embedTenantProviders: r.boolean('NACRE_EMBED_TENANT_PROVIDERS', true)`: the tenant-steerable surface is on by default.
  - `packages/worker/src/main.ts:838` — `while (running)` single serial loop. claimNext takes one document at a time across all organizations, so a kill or a stall stops ingestion for every tenant on that replica.
  - `packages/worker/src/claim.ts:118` — The claim UPDATE sets `attempts = attempts + 1`. A document that kills the worker is still counted, and reapOnce (reap.ts:63) fails it past NACRE_INDEX_MAX_ATTEMPTS (default 5, config.ts:1214) after the NACRE_INDEX_LEASE window (default 900 s, config.ts:1213). This bounds each document to a few kills and refutes the hunter's claim of an unbounded crash-loop.
  - `agents/v07/artifacts/result.txt:1` — Sandbox run (net=none, mem=1536m) through the real egressFetch with a loopback trusted origin and a 40 MiB `[0,0,...]` body. With a 1024 MiB heap: exit 0, 20,971,521 elements, heapUsed 213 MiB, RSS 521 MiB. With the heap capped at 96 MiB: exit 134, `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`.
  - `agents/v07/artifacts/result2.txt:1` — The exact probe source (child.ts and the runner) used for result.txt.

### Blockers

- The deployed worker and API container memory limits, and the resulting V8 heap size, are not in the repository. They decide how large a body, delivered within the 120 s worker window, the attacker needs before the process is killed. Locally the heap amplification is about 5x the body for a numeric JSON array.
- Cross-tenant impact requires a multi-tenant installation (several organizations, for example with the enterprise tenancy module) in which org_admins are not the operator, with NACRE_EMBED_TENANT_PROVIDERS=true, which is the default. On a single-organization open-core install the org_admin is the operator and the effect is self-inflicted.
- Recovery depends on the supervisor and the replica count, which are deployment facts: how fast a killed worker restarts, and whether other worker replicas keep claiming other tenants' documents. Source bounds each malicious document to NACRE_INDEX_MAX_ATTEMPTS claims (default 5), each separated by NACRE_INDEX_LEASE (default 900 s). Whether per-tenant document quotas or ingest rate limits bound the number of such documents depends on the deployment.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Already observed: through the real egressFetch transport, a 40 MiB numeric JSON body becomes about 213 MiB of heap and kills a process capped at a 96 MiB heap with a fatal, uncatchable OOM (agents/v07/artifacts/result.txt). To finish the local half, run the real worker loop in the sandbox with --postgres. Seed two organizations, give org A a layer whose provider endpoint is a trusted loopback origin serving the large body, and give org B an ordinary document. Run the worker with NODE_OPTIONS=--max-old-space-size set small. Observe that the worker dies on A's document, that B's document stays pending until restart, and that A's document increments `attempts` per claim and ends failed after NACRE_INDEX_MAX_ATTEMPTS (use a small NACRE_INDEX_LEASE, minimum 60). Keep bodies at 64 MiB or less, within the sandbox limits.

**Owner-observed (needs a real deployment or external system):**
An operator, on a non-production multi-tenant stand with NACRE_EMBED_TENANT_PROVIDERS=true: as a test tenant's org_admin, create an embedding provider pointing at an operator-controlled public test server that answers /embeddings with a JSON array streamed to roughly (worker heap / 4) bytes. Then ingest one document into a layer on that provider. Record the worker container's memory limit and its effective heap, whether the worker is OOM-killed (exit 134 or 137), the restart time, whether another tenant's ingest stalls during the window, and the document's `attempts` and final status. Stop after the first kill is observed.

---

## Re-ingest by external_id overwrites a document the writer is explicitly denied

<a id="packages-api-src-adapters-ts-nacreingest-queue-upsert-ignores-denieddocs"></a>

**Fingerprint:** `packages/api/src/adapters.ts:NacreIngest.queue-upsert-ignores-deniedDocs`

### Description

PostgresDocuments.retry, PostgresDocuments.updateMetadata and NacreIngest.remove all refuse a document listed in plan.deniedDocs. Ingest does not. NacreIngest.queue (reached from REST POST /v1/documents, from upload-ticket redemption and from MCP ingest_document) only checks that the layer is writable, then runs INSERT ... ON CONFLICT (layer_id, external_id) DO UPDATE on the existing row. A principal that holds write on the layer and a document-scoped write/admin deny on one document can therefore replace that document's source, title, metadata and status, and requeue it under the same id; the response also returns the denied document's id. This was observed locally against a throwaway Postgres as nacre_app: remove() and updateMetadata() returned false for the denied document, while queue() with the same external_id rewrote the row (same id, new source_ref, title, metadata and hash, status pending). Whether this is reachable in a real deployment depends on how the commercial acl-advanced module issues document-scoped denies. The open core refuses to issue them (server.ts parseGrant), and that module is not in this repository.

### Claimed root cause

NacreIngest.writableLayer resolves 'write' and returns the layer id when plan.kind is 'all' or plan.layers includes it. It never consults plan.deniedDocs. NacreIngest.queue then upserts on (layer_id, external_id) and rewrites the existing row (including deleted_at = NULL) whatever denies name that document. The other write paths do the deniedDocs check that this one omits.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:4692` (POST /v1/documents handler)
    An authenticated caller's ingest request (layer slug, external_id, content, title, metadata) is passed to options.ingest.queue. Upload-ticket redemption (server.ts:3585) and MCP ingest_document (packages/mcp/src/services.ts:408) reach the same method.
  - **propagation** — `packages/api/src/adapters.ts:1248` (NacreIngest.writableLayer)
    Returns the layer id when plan.layers includes it (or plan.kind is 'all'); deniedDocs is never consulted, and the document that will be hit is not yet known at this point.
  - **propagation** — `packages/api/src/adapters.ts:1359` (NacreIngest.queue upsert)
    INSERT ... ON CONFLICT (layer_id, external_id) DO UPDATE replaces source_ref, source_type, title, content_hash, metadata, content_type and status of the existing document.
  - **sink** — `packages/api/src/adapters.ts:1440` (NacreIngest.queue upsert)
    The existing row keeps its id, is set deleted_at = NULL and requeued, and its id is returned to the caller (adapters.ts:1460); the worker then re-indexes the replacement content under that document id.

### Evidence

  - `packages/api/src/adapters.ts:1520` — remove() refuses a document in plan.deniedDocs. Its comment says that checking only layers was the write path drifting from rule 5.
  - `packages/api/src/adapters.ts:450` — updateMetadata() refuses a document in plan.deniedDocs, citing the same rule.
  - `packages/api/src/adapters.ts:390` — retry() refuses a document in plan.deniedDocs.
  - `packages/core/authz/resolve.ts:150` — resolve() puts every document-scoped deny that satisfies the requested permission into deniedDocs, while still returning the layer in plan.layers. A write or admin deny on a document therefore leaves the layer writable.
  - `docs/authz.md:143` — Rule 5: deny beats allow at any level.
  - `packages/api/src/server.ts:1425` — The core's parseGrant refuses document-scoped grants and deny effects, so the precondition cannot be created through any open-core route; only a module (acl-advanced) can issue such a deny.
  - `agents/v12/artifacts/result.txt:1` — Local run with a throwaway Postgres as nacre_app. Fixture: carol has layer write allow plus a document admin deny. Results: remove(denied doc) => false; updateMetadata(denied doc) => false; queue(same external_id) => {documentId: denied doc id, unchanged: false}; row afterwards has source_ref 'REPLACED BY DENIED WRITER', title 'Replaced title', a new hash, metadata {x:'1'}, status pending, same id.
  - `agents/v12/artifacts/result2.txt:1` — Migration output (44 applied) and the vitest run of the observing case (1 passed).

### Blockers

- Document-scoped deny grants cannot be issued by the open core: parseGrant refuses scope_type 'document' and effect 'deny', and the local fixture inserted the deny row directly. The only issuer is the commercial acl-advanced module (issue_deny / POST /v1/admin/grants), which is not in the target repository. Whether it allows a write or admin deny on a document inside a layer the principal may write, and whether that deny is meant to stop re-ingest by external_id, cannot be settled from this source.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Already observed (agents/v12/artifacts/result.txt). With migrations applied and a deny row inserted directly, NacreIngest.remove and PostgresDocuments.updateMetadata return false for the denied document, while NacreIngest.queue with its external_id rewrites the same row. No further local step can remove the blocker, because the issuer is outside the repository.

**Owner-observed (needs a real deployment or external system):**
On a non-production install with acl-advanced loaded, the owner issues a dummy principal a layer write allow and then, through acl-advanced's issue_deny or POST /v1/admin/grants, a document-scoped write deny on a fixture document with a known external_id. The owner records whether the issue path accepts it, and confirms whether the product intends that deny to forbid re-ingest. As that principal, POST /v1/documents with the same layer and external_id and dummy content, then compare the response's document id and the row's content_hash/title with what they were before. DELETE /v1/documents/{id} for the same principal should answer 404, as a control.

---

## Search `layers` narrowing runs the query for an existing but unreadable layer when the caller holds a document-scoped grant, unlike an absent slug

<a id="packages-api-src-adapters-ts-nacresearchservice-search-layers-narrowing-not-intersected-with-extradocs-layers"></a>

**Fingerprint:** `packages/api/src/adapters.ts:NacreSearchService.search:layers-narrowing-not-intersected-with-extraDocs-layers`

### Description

NacreSearchService.search resolves the slugs a caller names in `layers` to ids for any existing layer in the organization (adapters.ts:865-883). It then intersects them with the caller's read plan only when the plan carries no individually granted documents (adapters.ts:639-642). When plan.extraDocs is non-empty, a slug for an existing layer the caller cannot read survives that step, and groupsInScope keeps a model group for it (adapters.ts:805). The service then embeds the query (adapters.ts:690) and sends a vector query (search.ts:629). A slug that does not exist returns [] at adapters.ts:648 with no downstream work. The filter cannot return anything (must layer_id=[unreadable] plus should doc_id=[granted docs]), so no document content leaks. What leaks is that the two cases take different paths, which is the separation the code's own comment (adapters.ts:624-634) says it removes so that invariant 4 / I4 cannot leak through a failing query path. Any failure on the query path makes the difference observable. parseFilters accepts finite non-integer numbers (metadata.ts:57-64), and buildFilter places them in match.value (filter.ts:165). If the vector store refuses such a value, a caller-chosen filter such as {"x":1.5} turns the existing-but-unreadable case into a 500 (REST) or a tool error (MCP), while the absent case stays 200 {items:[]}. Without a forced failure, the difference is an extra embedder round trip plus a vector query, observable as timing. Affected principal: a member, service account or delegation whose read plan includes at least one document-scoped allow. Protected fact: whether a layer with a given slug exists in the caller's organization.

### Claimed root cause

In NacreSearchService.search, `permitted` equals `resolved` unchanged whenever plan.extraDocs is non-empty (adapters.ts:639-642), and groupsInScope keeps every narrowed layer in that case (adapters.ts:805). Neither is intersected with the layers the plan actually reaches: plan.layers plus the layer of each extraDocs document. loadScopeTree (store.ts:85-93) already loads that layer in the same transaction, and resolve uses it at resolve.ts:131. Contributing: parseFilters/checkScalar (metadata.ts:57-64) accepts filter values, such as non-integer numbers, that the vector store's match may refuse, which gives the caller a way to force the query path to fail.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:4473` (POST /v1/search handler)
    An authenticated caller (member, service account or delegation) sends {query, layers:[slug], filters:{x:1.5}}. The MCP search tool (packages/mcp/src/services.ts:334) calls the same service with layers and filters.
  - **propagation** — `packages/core/metadata.ts:57` (checkScalar)
    A finite non-integer number is accepted as a filter value. Only NaN and the infinities are refused.
  - **propagation** — `packages/api/src/server.ts:4519` (POST /v1/search handler)
    layers and filters are passed to NacreSearchService.search.
  - **propagation** — `packages/core/authz/resolve.ts:138` (resolve)
    A document-scoped allow outside the caller's allowed layers is added to plan.extraDocs.
  - **propagation** — `packages/api/src/adapters.ts:621` (NacreSearchService.search)
    layerIds resolves the slug of any existing layer in the organization, readable or not. An absent slug resolves to nothing.
  - **propagation** — `packages/api/src/adapters.ts:640` (NacreSearchService.search)
    Because plan.extraDocs is non-empty, `permitted = resolved`, and the unreadable layer is not removed.
  - **propagation** — `packages/api/src/adapters.ts:648` (NacreSearchService.search)
    Only the absent slug returns [] here, before any downstream call.
  - **propagation** — `packages/api/src/adapters.ts:805` (NacreSearchService.groupsInScope)
    With extraDocs present, every narrowed layer is kept, so a model group exists for the unreadable layer.
  - **propagation** — `packages/api/src/adapters.ts:690` (NacreSearchService.search)
    The query is embedded with that layer's provider, an extra outbound round trip.
  - **propagation** — `packages/core/authz/filter.ts:165` (buildFilter)
    The caller's value becomes must meta.x match.value 1.5, beside must layer_id=[unreadable layer] and should doc_id=[granted docs].
  - **propagation** — `packages/core/vector/search.ts:629` (VectorStore.search)
    The query is sent to the vector store. A refused value raises here.
  - **sink** — `packages/api/src/server.ts:7473` (authenticated error boundary)
    The raise becomes a 500 internal problem, which can be told apart from the 200 {items:[]} an absent slug gets.

### Evidence

  - `packages/api/src/adapters.ts:628` — The code's own statement of intent: without intersection, an unreadable-but-existing layer runs the query and an absent one does not, so a failing query path separates them ('invariant I4 leaking through a dependency outage').
  - `packages/api/src/adapters.ts:635` — The stated exception that leaves the gap: no intersection when the plan carries extraDocs. The layers of those documents are known, so intersecting with plan.layers plus the layers of extraDocs would keep the correct answer and close the gap.
  - `packages/core/authz/store.ts:88` — loadScopeTree loads the layer_id of every document named in a grant inside the same transaction, so the reachable layer set can be computed without extra queries.
  - `packages/api/src/adapters.ts:866` — layerIds' own comment says unknown slugs are dropped so as not to separate 'does not exist' from 'you cannot see it', and its query returns any existing layer's id regardless of readability.
  - `packages/api/src/server.ts:1425` — The open core's parseGrant refuses scope_type 'document', so the precondition (non-empty plan.extraDocs) arises only where document grants exist, for example where the commercial acl-advanced module issues them.
  - `packages/core/metadata.ts:57` — Non-integer numbers are accepted as filter values. This is the candidate input for forcing a query-path error.
  - `packages/mcp/src/services.ts:334` — The MCP search tool calls the same NacreSearchService.search with layers and filters, so MCP callers reach the same difference.
  - `agents/v14/artifacts/result.txt:1` — Independent run in the sandbox, against the real NacreSearchService and resolver, with a fake pool, a stub embedder and a stub vector store that rejects. For alice (document grant only), layers:['board-minutes'] (exists, unreadable) made 1 embed call and 1 vector search, with narrow.layers=[board] and plan {layers:[], extraDocs:[doc]}, and threw. layers:['no-such-layer'] made 0 calls and returned []. For control bob (layer grant only), both slugs made 0 calls and returned [].

### Blockers

- The sandbox has no Qdrant, so whether a real Qdrant refuses a prefetch filter carrying match.value 1.5 has not been observed. Both local runs (this one and h04-read's) model that refusal with a stub. The deterministic REST 500-versus-200 result therefore rests on behaviour of the vector store that has not been observed.
- The open core refuses to issue document-scoped grants (server.ts:1425). The precondition, non-empty plan.extraDocs, depends on the commercial acl-advanced module or another writer of document-scope grant rows being deployed, and that module is not in this repository.
- Without a forced error, the difference is timing: an embedder round trip plus a vector query, compared with two Postgres transactions. Its size and reliability on a deployed stack have not been measured.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Re-run agents/v14/artifacts/result.txt's harness (packages/api/src/__tests__/v14-oracle.test.ts in a scratch copy), but construct NacreSearchService with a real VectorStore pointed at a local, network-isolated Qdrant, holding a collection created with collectionConfig for the dummy organization and a dense slot named vectorName('stub',4). Confirm whether Qdrant answers 400 to must meta.x match.value 1.5. Then, through createApi over REST, confirm that the document-grant holder gets 500 for layers:['board-minutes'] and 200 {items:[]} for layers:['no-such-layer'], and that the layer-grant control gets 200/200. Apply the fix: return tree-derived document layers from the withOrg context, intersect `resolved` with plan.layers ∪ layerOf(extraDocs), and use the same set in groupsInScope. Optionally refuse non-integer numbers and boolean or mixed lists in parseFilters. Confirm that both slugs then take the no-query path.

**Owner-observed (needs a real deployment or external system):**
Owner-observed, on a staging installation with acl-advanced loaded and dummy data only. Give a dummy member a document-scoped read grant on one dummy document, and create a dummy layer the member cannot read. Compare POST /v1/search {query:'x', layers:['<dummy-unreadable-slug>'], filters:{x:1.5}} with the same request naming a slug that does not exist. 500 versus 200 confirms the leak. Also compare the median latency of the two requests without the filter over a few hundred samples.

---

## The reindex recall gate gives a layer administrator an existence (and, pending Qdrant, relevance) oracle over documents they hold a document-scoped admin deny on

<a id="packages-worker-src-adapters-ts-recall-gate-scores-documents-denied-to-the-layer-admin"></a>

**Fingerprint:** `packages/worker/src/adapters.ts:recall-gate-scores-documents-denied-to-the-layer-admin`

### Description

A principal holding `admin` on layer L via a layer-scoped grant, who also carries a document-scoped `admin` deny on document D inside L, can still (1) pass PostgresReferenceQueries.administrable() and write a reference query naming D's external_id, and (2) have the worker's dueChecks() resolve that external_id against every live document in the layer with no ACL check at all, reporting D as resolved rather than missing. GET /v1/layers/{id}/reindex (readable at mere `read` on the layer) then returns check.unresolved and check.scores, which is purely a Postgres-level existence oracle today and would additionally be a per-query relevance oracle once retrieveDocuments() ranks D against the shadow vector (packages/worker/src/adapters.ts:512-534), which applies only org_id/layer_id/deleted and likewise never consults deniedDocs. I independently reproduced the existence half against a real PostgreSQL (44/44 migrations applied): with grant 1 {scope:layer L, admin, allow} and grant 2 {scope:document D, admin, deny} inserted directly into `grants`, PostgresReferenceQueries.replace()/list() admit the write and dueChecks() returns expected:[D] / missing:[] for D's external_id, against a missing:['no-such-doc'] control for a nonexistent one. I also confirmed, directly against resolve.ts/reference.ts, that this is exactly because resolve(..., 'admin') keeps L in plan.layers while only adding D to plan.deniedDocs — a field administrable() never reads. The decisive blocker I could not clear locally is not the SQL logic (now observed) but the precondition itself: I confirmed by source that no surface this repository exposes to any caller — not POST /v1/grants (packages/api/src/server.ts:1425-1429 refuses scope_type='document' and any non-'allow' effect by name) and not the MCP `issue_grant` tool (packages/api/src/admin-writes.ts:260 casts scopeType to 'layer'|'workspace' only, with no effect field) — can ever create the document-scoped deny row the whole chain depends on. docs/authz.md says so directly: 'a document scope is in the model ... and this build refuses to issue one.' The row can only exist via direct database access or via the private nacre-enterprise `acl-advanced` module (out of scope for this audit), which inserts such rows the same way the core's own admin-tools-live.test.ts fixture does, for the core's resolver/reference.ts/buildFilter to then evaluate correctly. The relevance half (ranking D in retrieveDocuments' top-k) additionally needs a real Qdrant collection, unavailable in this sandbox.

### Claimed root cause

PostgresReferenceQueries.administrable() (packages/api/src/adapters.ts:3617-3626) admits a layer administrator by checking only plan.kind/plan.layers, never plan.deniedDocs, so a document-scoped admin deny on D never blocks writing or reading reference queries that name D. The worker's dueChecks() (packages/worker/src/adapters.ts:1846-1926) then resolves a reference set's external ids against every live document in the layer with org_id/layer_id/deleted_at filters only — no grant/deny check of any kind — and retrieveDocuments() (packages/worker/src/adapters.ts:512-534) queries the shadow vector with the same bare org_id/layer_id/deleted filter. PostgresReindex.status() (packages/api/src/adapters.ts:3493-3502) returns the resulting check.scores/check.unresolved to any caller holding mere `read` on the layer. The gap is real and independently reproduced against resolve.ts/reference.ts and against a live PostgreSQL, but the document-scoped deny grant that triggers it cannot be created through any attacker-reachable surface of this repository alone (packages/api/src/server.ts's parseGrant and the MCP issue_grant tool both structurally refuse scope_type='document'); it requires either direct database access or the separate, private nacre-enterprise acl-advanced module.

### Trace

  - **entrypoint** — `packages/api/src/adapters.ts:3624` (PostgresReferenceQueries.administrable)
    Admits a caller whose resolve(admin) plan is 'scoped' and includes layer L in plan.layers; never reads plan.deniedDocs. Reproduced directly: with a layer-scoped admin allow plus a document-scoped admin deny on D, resolve() returns {kind:'scoped', layers:[L], deniedDocs:[D]} and this exact predicate still admits the caller.
  - **propagation** — `packages/worker/src/adapters.ts:1885` (dueChecks)
    `d.external_id = ANY(rq.expected) AND d.deleted_at IS NULL` resolves a reference set's external ids against every live document in the layer, with org_id/layer_id as the only other predicates — no grants/deniedDocs join. Reproduced against a real PostgreSQL: D resolves into expected with missing:[] despite the admin-deny grant naming it, while a nonexistent external id correctly comes back in missing.
  - **propagation** — `packages/worker/src/adapters.ts:531` (retrieveDocuments)
    Top-k query against the shadow vector filtered only by org_id, layer_id and deleted — confirmed by source reading; not run locally because the sandbox has no Qdrant, so the relevance (ranking) half of the oracle is unobserved.
  - **sink** — `packages/api/src/adapters.ts:3502` (PostgresReindex.status)
    resolve(..., 'read') gates this method, so check.scores (per-query recall) and check.unresolved (the external ids that did not resolve) reach any caller holding mere `read` on the layer, not only the `admin` who set up the reference set and not only the principal denied on D.

### Evidence

  - `packages/worker/src/recall.ts:1` — Header argument for omitting an ACL filter is 'no document, id, or text leaves it' — true of the retrieval call in isolation, but check.scores and check.unresolved (external ids) do leave, through PostgresReindex.status, which the header does not address.
  - `packages/core/authz/reference.ts:68` — referenceAllows's rule-5 deny-beats-allow check (confirmed by direct execution: referenceAllows({...}, {type:'document', id:D}, 'admin') returns false for the same grant set) is why the denied administrator cannot simply revoke their own deny through the grants API — the deny is meant to be binding on them specifically, which is exactly what administrable() does not honor for the reference-query surface.
  - `packages/api/src/server.ts:1425` — parseGrant refuses any grant naming scope_type 'document' with 400 ('Document-level grants are not available in this build'), and any effect other than 'allow' with a second 400 ('Deny rules are not available in this build') — confirming no caller of POST /v1/grants can ever create the precondition grant.
  - `packages/api/src/admin-writes.ts:260` — The MCP issue_grant tool's apply() casts scopeType to 'layer' | 'workspace' only, and its inputSchema carries no document or effect field at all — the second attacker-reachable grant-issuing surface likewise cannot create a document-scoped deny.
  - `docs/authz.md:441` — 'A document scope is in the model — grants.scope_type admits it — and this build refuses to issue one' — the core's own stated position that document-scoped grants are evaluated correctly by the shared resolver/reference/filter code but issued by no surface in this repository.

### Blockers

- The relevance half of the oracle (whether D ranks in the top-10 for a chosen query, via packages/worker/src/adapters.ts:512-534's retrieveDocuments against the shadow vector) requires a real Qdrant collection carrying the layer's shadow vector plus an embedder, neither of which exists in this sandbox; only the existence half (via dueChecks' missing/expected) was locally observable and has now been observed against a real PostgreSQL.
- The precondition — a document-scoped admin deny on D while the same principal holds an admin grant on the containing layer — cannot be created through any surface this repository (nacre core) exposes to any caller, including an org_admin: confirmed by source that both POST /v1/grants (server.ts parseGrant) and the MCP issue_grant tool structurally refuse scope_type='document' and any deny effect. The row can only arrive via direct database access (outside any attacker's reach) or via the private nacre-enterprise acl-advanced module, which is out of scope for this audit and was not available to load or test here.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Completed, for the Postgres-only existence half: see agents/v28/artifacts/result.txt (resolve.ts/reference.ts, in-memory, 3/3 passing — confirms deniedDocs is populated but plan.layers is unaffected, and administrable()'s exact predicate still admits the caller) and agents/v28/artifacts/result2.txt (a real PostgreSQL with all 44 migrations applied, 2/2 passing — PostgresReferenceQueries.administrable()/replace()/list() admit the write, and dueChecks() resolves D's external_id into expected with missing:[] despite the deny, against a missing:['no-such-doc'] control); agents/v28/artifacts/result3.txt is a plain-text narrative of both runs plus the exact source lines establishing the precondition cannot be created by this repository's own surfaces. What remains: against a real Qdrant collection seeded with the layer's shadow vector and a real or stub embedder, repeat the same grant setup, start a reindex into the embedding phase, run recallOnce()/dueChecks()/retrieveDocuments() for real, and read GET /v1/layers/{id}/reindex as the denied-but-layer-admin attacker to confirm check.scores for a query crafted to retrieve D differs measurably from one that does not — closing the relevance half the way the existence half is now closed.

**Owner-observed (needs a real deployment or external system):**
Owner decides two things. First, whether administrable()/dueChecks()/retrieveDocuments() should consult plan.deniedDocs the same way remove()/retry()/updateMetadata() and buildFilter() already do — independent of whether acl-advanced is loaded, since the core's own resolver and docs/authz.md already treat a document-scoped deny row as something every access-computing code path must honor once it exists, for whatever reason it exists. Second, and separately from this candidate's own root cause: the hunter's hardening note that check.scores/check.unresolved (and thus which external ids an administrator chose as reference queries) are visible to any caller with mere `read` on the layer, where PostgresReferenceQueries itself gates the same information at `admin` — worth the owner's attention even on an installation that never loads a document-ACL module.

---

## Session-issuing paths (refresh, second-factor completion, enrolment, password change) never re-check organizations.deleted_at, so a tombstoned organization's existing refresh tokens keep minting fresh sessions

<a id="refresh-path-skips-organization-tombstone"></a>

**Fingerprint:** `refresh-path-skips-organization-tombstone`

### Description

packages/api/src/login.ts resolves the organization through two different query shapes. Credential discovery for a fresh sign-in (Login.find -> orgIdForSlug at login.ts:691, allOrgIds at login.ts:704) and password recovery (recovery.ts:237) both filter `organizations WHERE deleted_at IS NULL`, so a tombstoned org refuses a brand-new sign-in or reset outright. Every path that mints a session from a credential already held does not apply that filter: Login.refresh() (login.ts:737-830) looks the user up by `id = $1 AND org_id = $2` with only a `disabled_at` guard (login.ts:801-807), and the identical helper `userById` (login.ts:627-641) backs completeSecondFactor, sessionAfterEnrolment and changePassword the same way. All four converge on Login.issue (login.ts:906-993), which mints a fresh access token and rotates in a new refresh token purely from `user.org_id`, with no join or subquery against `organizations.deleted_at` anywhere on that path. I independently reproduced this: against a real Postgres with the repository's own migrations 0001-0044 applied and the unmodified Login class, a sign-in succeeds, the organization is then tombstoned (`UPDATE organizations SET deleted_at = now()`), a second sign-in to that organization is refused (undefined), and the refresh token obtained before the tombstone still exchanges for a fresh {kind:'tokens'} pair with no re-authentication. I also confirmed by source that packages/api/src/auth.ts's authenticate() and the migration-0001 RLS policies (`org_isolation` on documents/chunks/grants/layers/workspaces) filter only on org_id, never on the organization's own deleted_at, so nothing downstream of token issuance would independently stop a token minted this way from continuing to authorize requests against that organization's data for its full lifetime.

### Claimed root cause

organizations.deleted_at is consulted only at the two credential-discovery queries (login.ts:691/:704) and at recovery.ts:237, never at the session-issuance step shared by refresh, second-factor completion, enrolment-completion and password-change. All four reach Login.issue through a user lookup scoped to (id, org_id) plus disabled_at, so a tombstone set after a session/refresh-token already exists is never re-evaluated before a new token is minted or rotated.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:3053` (handleAuth '/v1/auth/refresh')
    An unauthenticated POST presents a pre-existing refresh token for an organization whose organizations.deleted_at has since been set; the handler calls options.login.refresh(token) with no organization check of its own (verified by reading the surrounding handler, lines ~3044-3066).
  - **propagation** — `packages/api/src/login.ts:737` (Login.refresh)
    The refresh row is located by token_hash via whileAuthenticating; no query on this path reads organizations.deleted_at.
  - **propagation** — `packages/api/src/login.ts:801` (Login.refresh inner withOrg)
    The user is selected WHERE id = $1 AND org_id = $2 with a disabled_at check only (confirmed at line 807: `if (user === undefined || user.disabled_at !== null) return 'gone'`); the organization's tombstone is never consulted, and RLS does not fill the gap since org_isolation policies only test org_id.
  - **sink** — `packages/api/src/login.ts:947` (Login.issue)
    A new access token (org = user.org_id) is signed and a rotated refresh token is inserted (lines 967-992), extending the session for a tombstoned organization. Independently reproduced against a real Postgres: refresh() returns {kind:'tokens'} for a token belonging to a just-tombstoned org while login() for the same org returns undefined.

### Evidence

  - `packages/api/src/login.ts:691` — Sign-in slug resolution filters `organizations WHERE slug = $1 AND deleted_at IS NULL` -- the intended treatment of a tombstoned org at the sign-in door. Verified present in source.
  - `packages/api/src/login.ts:704` — No-slug sign-in enumerates `organizations WHERE deleted_at IS NULL`, so a tombstoned org cannot authenticate a new password sign-in. Verified present in source.
  - `packages/api/src/login.ts:801` — The refresh user select checks disabled_at but never organizations.deleted_at -- the asymmetry with the sign-in door. Verified present in source and by local reproduction (refresh still succeeds after the tombstone).
  - `packages/api/src/login.ts:627` — userById -- the shared helper behind completeSecondFactor, sessionAfterEnrolment and changePassword -- selects `WHERE org_id = $1 AND id = $2`, the same org_id-only scoping as the refresh path, so the same gap applies to all three by inspection.
  - `packages/api/src/recovery.ts:237` — Recovery also filters `organizations WHERE deleted_at IS NULL`, confirming that a tombstoned org is meant to be non-authenticatable at the discovery step.
  - `packages/api/src/auth.ts:606` — The only mention of `organizations` in auth.ts's authenticate() path is an unrelated comment about groups_version; there is no deleted_at check on the authenticated-request path either, so a token issued or renewed this way keeps authorizing requests for its full lifetime with no independent downstream check.
  - `packages/core/migrations/0001_init.sql:218` — The org_isolation RLS policies on documents/chunks/grants/layers/workspaces filter only on `org_id = current_setting('app.current_org')::uuid`, never on the organization's own deleted_at, so RLS does not independently block access for a tombstoned organization.

### Blockers

- The open core never writes organizations.deleted_at anywhere in this repository (confirmed by grepping every `UPDATE organizations` and every SQL write touching that table across packages/api, packages/core, packages/worker, packages/cli and packages/mcp: the only writes found are to vector_collection and groups_version in tests and worker code, never deleted_at). The column is defined in migration 0001 and is read at >20 sites, but within this repository alone the trigger condition -- an organization that is tombstoned at all -- cannot arise; it is set by the private nacre-enterprise `tenancy` module's offboarding route, which is outside this repository and outside this audit's scope.
- Whether a tenancy tombstone is intended to end existing sessions immediately, versus deliberately leaving them live during a reversible offboarding window (with session termination instead deferred to the module's separate, irreversible purge step, which cascades and removes the user/refresh-token rows entirely), is a product decision expressed only in the enterprise module's semantics, which are not source-visible in this repository and were not read as part of this audit.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Performed. With a throwaway Postgres and all 44 of the repository's own migrations applied via `tsx scripts/migrate.ts`, I inserted an organization and a password user through Login's own public API, called login() to obtain a baseline session and refresh token, set organizations.deleted_at = now() directly, then called login() again (returned undefined, confirming the sign-in door closed) and refresh() with the pre-tombstone token (returned {kind:'tokens'}, a fresh access+refresh pair). The test file and full vitest output are at agents/v29/artifacts/result.txt. This demonstrates the asymmetry is real, unconditional open-core behaviour; it does not by itself establish that it is unintended, which depends on the enterprise tombstone semantics named in the blockers.

**Owner-observed (needs a real deployment or external system):**
On an installation with the enterprise tenancy module loaded, tombstone a tenant with DELETE /v1/admin/tenancy/{orgId}, then exchange a refresh token minted before the tombstone at POST /v1/auth/refresh and confirm a usable access token is returned that still authorizes requests against that organization's data for up to NACRE_REFRESH_TOKEN_TTL; separately confirm with the product owner whether offboarding is meant to cut those sessions immediately or only to block new sign-ins during the tombstone's reversible window (as the module's own purge-is-the-irreversible-step design would suggest), since that determines whether this is a defect or working-as-designed.

---

## Parser URL guard accepts NAT64-embedded private/link-local addresses that the core egress guard decodes and refuses

<a id="services-parser-app-py--is-public-nat64-embedded-private"></a>

**Fingerprint:** `services/parser/app.py:_is_public:nat64-embedded-private`

### Description

The parser's _is_public (services/parser/app.py:127) judges every resolved address solely by ipaddress.ip_address(address).is_global. Independently reproduced in the sandbox's --python mode against the published nacre-parser image (CPython 3.13.16, the exact pinned runtime, via PYTHONPATH=/target importing services.parser.app): _is_public('64:ff9b::a9fe:a9fe') and _is_public('64:ff9b::a00:5') both return True. These are RFC 6052's well-known NAT64 prefix (64:ff9b::/96) embedding the cloud-metadata address 169.254.169.254 and an RFC1918 address respectively, so on this exact runtime the parser's guard judges both 'public'. The sibling control used for tenant embedding endpoints, packages/core/egress.ts's isGlobalAddress, explicitly decodes that same well-known prefix (egress.ts:210, among 6to4/IPv4-mapped/IPv4-compatible forms) to the embedded IPv4 and judges that address instead, correctly refusing both. The control case _is_public('64:ff9b:1::a9fe:a9fe') (RFC 8215's distinct 'local-use' NAT64 prefix) correctly returns False, matching the hunter's claim that CPython 3.13's private-network table lists 64:ff9b:1::/48 but not the RFC 6052 well-known 64:ff9b::/96 that the parser's code path actually reaches. The entrypoint-to-sink chain is real: a url-source document from POST /v1/documents is forwarded by packages/worker/src/adapters.ts's HttpParser as JSON to the sidecar's /parse, which calls parse_source -> fetch(url) -> _check_reachable -> _public_addresses -> _is_public (every resolved address, not just the first), and any address that passes is then dialed directly by _guarded_connection's socket.create_connection with no further check. What remains outside source and this offline, no-network sandbox is whether the parser's real egress path in any supported deployment ever includes a NAT64/DNS64 translator that forwards a non-global embedded IPv4 to its actual destination -- RFC 6052 §3.1 says a compliant translator must not -- and no shipped Compose profile or the Helm chart configures one: docker-compose.yml's own comment places the parser on a 'parsing' network shared with only the worker, with no translator present in that topology at all.

### Claimed root cause

_is_public relies on ipaddress.is_global, which on the pinned CPython 3.13 parser image (confirmed by direct execution in this verification, not assumed) does not treat the RFC 6052 well-known prefix 64:ff9b::/96 as non-global even when its embedded IPv4 is private or link-local. The parser does not decode embedded IPv4 the way packages/core/egress.ts's isGlobalAddress does, so the two sibling guards disagree on this one address class.

### Trace

  - **entrypoint** — `services/parser/app.py:478` (parse_source)
    A url source from a tenant's POST /v1/documents (forwarded by the worker's HttpParser as JSON to the sidecar's /parse) is fetched. Verified: line 478 is exactly `raw = fetch(url)` inside parse_source.
  - **propagation** — `services/parser/app.py:183` (_check_reachable)
    Every resolved address is checked by _public_addresses. Verified: line 183 is exactly the `_public_addresses(host, parts.port or (443 if parts.scheme == "https" else 80))` call inside _check_reachable.
  - **propagation** — `services/parser/app.py:127` (_is_public)
    The verdict is ip.is_global, with no NAT64 or 6to4 decoding. Verified: line 127 is exactly `return ip.is_global`, and this was executed against the pinned parser-image CPython 3.13.16 in this verification, returning True for 64:ff9b::a9fe:a9fe and 64:ff9b::a00:5.
  - **sink** — `services/parser/app.py:203` (_guarded_connection)
    The socket connects to the address judged public. Verified: line 203 is exactly `return socket.create_connection((sockaddr[0], port), timeout, source_address)`, reached once every address in _public_addresses' loop has passed _is_public.

### Evidence

  - `services/parser/app.py:123` — Comment confirming the guard deliberately uses one stdlib property (is_global) instead of an explicit CIDR list -- verified present at this line.
  - `packages/core/egress.ts:210` — The core egress guard's embeddedV4() decodes 64:ff9b::a.b.c.d (the well-known NAT64 prefix) and judges the embedded IPv4 -- the sibling control the parser lacks. Verified present at this line, with the surrounding isGlobalAddress function confirmed to route the decoded address through the same NON_GLOBAL_V4 BlockList used for literal IPv4 addresses.
  - `docker/Dockerfile.parser:7` — `FROM python:3.13-slim` -- verified present at this line, and the exact minor release (3.13.16) was confirmed live via the sandbox's --python mode, which runs the published nacre-parser image.

### Blockers

- Impact requires a NAT64 translator actually sitting on the parser's egress path that forwards a non-global embedded IPv4 destination to its real address -- RFC 6052 §3.1 states a compliant translator must drop such mappings rather than forward them, so exploitation depends on either a non-compliant translator or an operator-chosen topology (e.g. an IPv6-only/dual-stack cluster behind a cloud NAT64/DNS64 service) that this product does not ship or document. No shipped Compose profile or the Helm chart configures NAT64/DNS64 or any dual-stack networking; docker-compose.yml's own comment places the parser alone with the worker on an isolated 'parsing' network, with no translator present in that topology. This is a deployment-network fact outside the repository and outside what this offline, no-network sandbox can observe or construct.

### Validation plan

**Local (inside the sandbox, by anyone with this repository):**
Already executed independently in this verification using the sandbox's --python mode (the published nacre-parser image, CPython 3.13.16, PYTHONPATH=/target importing the real services.parser.app). _is_public('64:ff9b::a9fe:a9fe') and _is_public('64:ff9b::a00:5') (the well-known NAT64 prefix embedding 169.254.169.254 and 10.0.0.5) both returned True; _is_public('64:ff9b:1::a9fe:a9fe') (the distinct RFC 8215 local-use NAT64 prefix) and _is_public('169.254.169.254') both correctly returned False, as did a control decode of a NAT64-embedded public address (64:ff9b::808:808 -> True, correctly public). This confirms the sibling-guard disagreement on the exact pinned runtime rather than from CPython source knowledge alone. Full output saved at agents/v30/artifacts/result.txt.

**Owner-observed (needs a real deployment or external system):**
An owner should check whether any supported deployment of this product (a Kubernetes cluster, cloud VPC, or other network the parser container's egress actually traverses) is IPv6-only or dual-stack with a NAT64/DNS64 path reachable from the parser, and if so, whether that translator forwards 64:ff9b::/96 destinations whose embedded IPv4 is RFC1918, link-local, or loopback rather than dropping them per RFC 6052 §3.1. If no deployment the owner runs or supports has such a translator on the parser's path -- true of every shipped Compose profile and the Helm chart as published -- the guard disagreement, though real and now reproduced, has no exploitable network path and should be closed as hardening (decode the same IPv6 forms egress.ts decodes) rather than as an exploitable finding.

---

