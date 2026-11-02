# Findings Detail — nacre (core)

Full technical write-up for every `confirmed` finding at `medium` severity or above from the run documented in `REPORT.md`. Run `nacre-run-1`, commit `f1806fef282e1e8e3f316a8ebc5e3c3c00ec8a84`. **This run did not execute Phase 5** (see REPORT.md section 0) — each record below was independently re-derived from source once, by one fresh verifier distinct from its hunter(s), not twice.

Every reproduction here was executed only inside the skill's sandboxed, source-and-local-only harness (no deployed instance, no production or shared infrastructure, dummy principals and fixtures throughout). Code changes under "Fix" are the audit's own proposal for the smallest effective source change; they were not applied to the target.

---

## Published example JWT secret accepted at startup, including in production

<a id="packages-core-config-ts-loadjwtkeys-published-example-secret-accepted"></a>

**Severity: HIGH** (likelihood: medium — Requires an operator to follow the documented Compose 'First run' path and skip replacing NACRE_JWT_SECRET; the Helm chart forces an operator-supplied secret, and the demo path is explicitly marked ephemeral/local, so this is squarely a risk for self-hosted Compose deployments that go live on the quickstart default.; impact: critical — A forged token's role and org are entirely attacker-chosen and accepted with no further check (org_admin or platform_admin, any organization id), which breaks invariant 1 (org comes from the token) and every permission check downstream of authenticate() for that org.) · confidence {'score': 'high', 'reason': 'Independently reproduced end-to-end in the sandbox: production-mode config acceptance of the exact published secret, and a forged org_admin token verifying against the real key-derivation and verification path (same library, same algorithm, same key material authenticate() uses). Every trace and evidence line number was checked against the source at commit f1806fe and matches exactly.'}

**Fingerprint:** `packages/core/config.ts:loadJwtKeys:published-example-secret-accepted`

### Description

`.env.example` ships `NACRE_JWT_SECRET=development-only-not-a-secret-0123456789` (line 154). `loadJwtKeys` (packages/core/config.ts:726) validates only that the secret is >=32 bytes; it never compares the value against the published default, and no other startup check (including the `NACRE_ENV === 'production'` checks at config.ts:1365-1372) looks at the secret's value either. `docs/quickstart.md`'s documented 'First run' path (the path meant to lead to a real deployment, as opposed to the explicitly-ephemeral 'Two minutes' demo path a few lines above it) runs `cp .env.example .env` (quickstart.md:105) and never instructs the reader to regenerate `NACRE_JWT_SECRET` before going further. Anyone who has read the public repository therefore knows a value that, if still configured, lets them forge a JWT with an attacker-chosen `org`, `principal_type` and `role` (including `org_admin`) that the API's `authenticate()` accepts, because the role is taken directly from the verified claims (auth.ts:564) with no further check against a real session, user row, or grant.

### Root cause

loadJwtKeys (packages/core/config.ts:726) checks only `secret.length < 32`, never the secret's value, and loadConfig's production-only checks (config.ts:1365-1372) check `canonicalUrl` and never the JWT secret. Nothing in the startup path refuses a token-signing secret that is known/public.

### Intended behavior

Refuse a signing secret that is published in the repository (or otherwise a known value); have the operator generate a random one, as the 'Two minutes' demo path's own prose says is the reason a copy of `.env.example` is required at all.

### Trace

  - **entrypoint** — `.env.example:154` (example env)
    Published secret value `development-only-not-a-secret-0123456789`, 41 bytes, which satisfies the >=32-byte floor
  - **propagation** — `packages/core/config.ts:726` (loadJwtKeys)
    `if (secret === undefined || secret.length < 32)` — only the length is validated; the production-only checks elsewhere in loadConfig (lines 1365-1372) check canonicalUrl and never this value
  - **sink** — `packages/api/src/auth.ts:564` (authenticate)
    `const role = claims.role ?? 'member'` — the role granted to the request is taken verbatim from the verified JWT claims, which anyone holding the signing secret can set to `org_admin` (or `platform_admin`) for any `org`

### Evidence

  - `docs/quickstart.md:105` — The documented 'First run' path (`## First run`, line 101) runs `cp .env.example .env` and, unlike the 'Two minutes' demo section above it (which explicitly explains the copied secret is development-only), never tells the reader to regenerate NACRE_JWT_SECRET before configuring an embedding endpoint and starting the stack for real use

### Conditions

[{'kind': 'system_configuration', 'description': "The deployment followed the documented Compose quickstart path and kept the example NACRE_JWT_SECRET value rather than generating a new one; the Helm chart's `jwt.existingSecret` has no default and requires an operator-supplied Kubernetes Secret, so this exposure is specific to the Compose/`.env` path, not Helm"}]

### Reproduction

**Attacker/caller perspective:** An attacker who has read the public nacre repository (or any deployment's publicly-documented quickstart) knows the exact value shipped as NACRE_JWT_SECRET in .env.example. If a reachable deployment was brought up via the documented 'First run' Compose path without replacing that value, the attacker signs their own HS256 JWT with that secret, setting `org` to a target organization id, `principal_type: 'user'`, and `role: 'org_admin'`, and presents it as a Bearer token. The API's authenticate() verifies the signature against the same secret and returns an AuthContext carrying the attacker-chosen org and role, with no further check against any real session, user, or grant.

**Payload(s):**
- `see agents/v25/artifacts/result.txt`

**Steps:**
1. Independently reproduced in the sandbox (no network, dummy principals) rather than taken on faith: added a vitest test under packages/core/__tests__ in a throwaway copy of the repo (prepare-copy.sh) that (1) calls loadConfig with NACRE_ENV='production' and NACRE_JWT_SECRET set to the exact .env.example value plus the other production-required variables, and asserts it does not throw ConfigError; (2) calls loadJwtKeys with that same secret and confirms it returns an HS256 key with signing===verification; (3) uses `jose`'s SignJWT to forge a token with claims {org:'attacker-org', principal_type:'user', role:'org_admin'} signed with that key, then verifies it with jose's jwtVerify using the exact same key and algorithm (HS256) that authenticate() uses, and asserts the verified payload carries role:'org_admin' and the attacker-chosen org; (4) re-confirms loadJwtKeys does not throw on the published value outside production too. Ran via `tools/sandbox-run.sh v25 -- sh /scratch/run.sh`, which runs vitest against the unit project with no external network, no Qdrant/Postgres/Redis needed for this unit.
2. Also confirmed exact line numbers independently: .env.example:154 (secret value), config.ts:726 (length-only check, no value comparison anywhere in config.ts for NACRE_JWT_SECRET), auth.ts:564 (role taken verbatim from claims), quickstart.md:105 (`cp .env.example .env` inside the '## First run' section, which never mentions regenerating the JWT secret, unlike the demo section above it).

**Observed result:** All 4 tests passed (agents/v25/artifacts/result.txt): loadConfig accepted the published secret under NACRE_ENV=production without throwing; loadJwtKeys returned a usable HS256 key from the published secret; a JWT forged with that secret and role='org_admin'/org='attacker-org' verified successfully against the exact key material and algorithm authenticate() uses, yielding payload.role==='org_admin' and payload.org==='attacker-org'. This independently reproduces the hunter's claimed result without relying on their artifact.

### Fix

In loadJwtKeys and loadJwtVerification, refuse a small set of known-published secret values (at minimum the exact .env.example value) outright, with a message naming the variable and pointing at `openssl rand -base64 32`. Ship .env.example with NACRE_JWT_SECRET empty (as the embedding endpoint already is) rather than populated, and have the quickstart's 'First run' path generate one explicitly, the way the 'Two minutes' demo path already explains why its copy is acceptable there.

---

## Skill zip import repeats synchronous inflate over overlapping compressed entries, before authorization

<a id="packages-core-skill-ts-readskillzip-overlapping-compressed-input-before-authz"></a>

**Severity: HIGH** (likelihood: medium — Requires a valid credential (any authenticated role suffices; no special grant on the target layer is needed) and a deliberately crafted ZIP, but the construction is purely structural (standard ZIP central-directory duplication over a cheap, well-documented 'empty DEFLATE block' payload) and needs no knowledge of the target layer's contents or configuration.; impact: high — Independently measured: a single request can drive readSkillZip's synchronous inflate work roughly linearly with (entry count up to 256) x (shared blob size up to the configured body limit), extrapolating to on the order of seconds to ~15-20 seconds of fully synchronous CPU per request given the default 50 MiB REST body limit. Node's inflateRawSync blocks the whole single-threaded event loop for that duration (no cluster/worker-thread use found in packages/api), so every other request reaching that same process — including requests from other organizations sharing a replica — stalls until the call returns; readiness/liveness probes could also stall, risking orchestrator restarts. No data is disclosed or corrupted and the process recovers on its own once the call returns.) · confidence {'score': 'high', 'reason': "The missing-bound/no-overlap-check root cause and the pre-authorization call ordering were both confirmed by direct source reading on both the REST (server.ts:1745/1766, skills.ts:550) and MCP (services.ts:634/638-641) paths. The CPU-amplification mechanism was independently reproduced against the real, unmodified target function (readSkillZip imported directly from packages/core/skill.ts) inside the approved sandbox, with no network access and no modification to the target, at the code's own real-world parameter cap (256 entries, SKILL_LIMITS.files*4) and showed a ~129x amplification matching the claimed mechanism. The only extrapolated (not directly measured) figure is the full-scale, 50 MiB-body wall-clock duration, which was derived from a measured near-linear scaling law rather than assumed."}

**Fingerprint:** `packages/core/skill.ts:readSkillZip:overlapping-compressed-input-before-authz`

### Description

readSkillZip (packages/core/skill.ts) bounds each entry's declared uncompressed size against SKILL_LIMITS.fileBytes and the running sum of declared sizes against SKILL_LIMITS.totalBytes, but it never bounds, sums, or checks for overlap in the *compressed* byte range (`localOffset`..`localOffset+compressed`) that it hands to `inflateRawSync`. A central-directory entry can declare size=0/crc=0 (contributing nothing to the declared-size budget) while its `compressed` field spans up to the whole request body, and up to `SKILL_LIMITS.files*4` (256) such entries can all point at one shared compressed region. Each is inflated independently and synchronously, so total CPU work scales with (entry count) x (shared blob size) while the uploaded body only grows by the ~50-byte central-directory record per entry. On REST, `PUT /v1/skills/layers/{any-uuid}` with `Content-Type: application/zip` reads a body up to NACRE_MAX_DOCUMENT_BYTES (50 MiB default) and calls readSkillZip (server.ts:1745) before `skills.write`'s `gate()` (skills.ts:550) checks whether the layer exists, is visible, or is writable by the caller — so any authenticated principal, including a member with zero grants or a service account that cannot see the target layer, can trigger the full cost before being refused. MCP's `update_skill` (services.ts:634) has the identical ordering, bounded by the MCP transport's 1 MiB body cap (server.ts:203/266) rather than NACRE_MAX_DOCUMENT_BYTES.

### Root cause

readSkillZip accounts only declared (post-inflate) sizes; `compressed` is read from the central directory (skill.ts:310) and used only to slice the archive buffer for `inflateRawSync` (skill.ts:328-330,339), never bounded relative to the declared size and never checked against other entries for the same local-data range. `inflateRawSync`'s `maxOutputLength: size + 1` option only aborts on excess *output*, so a compressed region that is cheap to construct (e.g. a run of empty DEFLATE "stored" blocks) but decodes to 0 or few bytes is processed in full every time an entry references it, and nothing rejects two or more central-directory entries whose local-data ranges coincide. Both call sites that invoke readSkillZip (server.ts:1745 for REST, services.ts:634 for MCP) run before the handler resolves the target level and calls `skills.write`, whose private `gate()` (skills.ts:550) is the only place visibility and write-permission are checked.

### Intended behavior

A skill archive's declared size (<=256 KiB per file, <=1 MiB total, <=256 entries) is meant to bound the total decompression work readSkillZip performs on any caller's upload, and the per-level write authorization (`gate()`, reached only through `skills.write`) is meant to run before any decompression is wasted on a principal who may not write (or even see) the target level — so an unauthorized upload should cost at most what one compliant, correctly-declared skill archive costs before being refused.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:4309` (request body reading)
    application/zip bodies are read raw up to options.maxBodyBytes (NACRE_MAX_DOCUMENT_BYTES), after authentication but before any route authorization; verified in source (line reads exactly `if (isZip(req.headers['content-type'])) { zipped = await readRaw(req, limit) }`).
  - **propagation** — `packages/api/src/server.ts:1745` (handleSkills PUT)
    readSkillZip(zipped) is called for any layer uuid in the path before skills.write (line 1766) is even invoked; skills.write's private gate() (skills.ts:550) is what checks visibility and write permission, and it runs strictly after this parse. Verified in source.
  - **propagation** — `packages/core/skill.ts:297` (readSkillZip)
    entry count is capped at SKILL_LIMITS.files*4 = 256 (SKILL_LIMITS.files=64, read from skill.ts:25); the running `total` only sums each entry's declared uncompressed size (lines 323-325), never the compressed length. Verified in source and exercised directly: a crafted archive with 256 central-directory entries, each declaring size=0, was accepted (see artifact result3.txt).
  - **propagation** — `packages/core/skill.ts:328` (readSkillZip)
    each entry's compressed data range (`dataStart`..`dataStart+compressed`) is computed from its own localOffset and the central directory's `compressed` field, with no check against any other entry's range and no check that `compressed` bears any relation to the declared `size`. Confirmed in source: no overlap/dedup/sum-of-compressed-lengths logic exists anywhere in the function.
  - **sink** — `packages/core/skill.ts:339` (readSkillZip)
    inflateRawSync runs synchronously over the full compressed range for every entry, including entries whose range is identical to (overlaps) a previous entry's; maxOutputLength bounds only output length, not the input bytes processed. Independently reproduced: 256 central-directory entries all referencing the SAME 1,000,000-byte compressed region (itself built from cheap, valid, zero-output DEFLATE "stored" blocks) took readSkillZip ~394.9 ms versus ~3.1 ms for one such entry over the identical region — a ~129x amplification for ~13.6 KB of added request-body size (central-directory overhead only). See artifacts result2.txt and result3.txt.

### Evidence

  - `packages/core/skill.ts:310` — `const compressed = buf.readUInt32LE(at + 20)` — compressed length is read from the central directory and used only to slice the buffer (lines 329-330); it is never bounded relative to `size` and never summed across entries. Confirmed by direct reading.
  - `packages/core/skill.ts:324` — `total += size` — the cumulative budget accumulates the *declared uncompressed* size only, so an entry declaring size=0 adds nothing to the SKILL_LIMITS.totalBytes (1 MiB) budget regardless of how large or expensive its referenced compressed range is. Confirmed by direct reading and by the reproduction (256 size=0 entries accepted without tripping the budget).
  - `packages/core/config.ts:1267` — `maxDocumentBytes: r.number('NACRE_MAX_DOCUMENT_BYTES', 52_428_800, { min: 1024 })` — this is the same limit used for the REST zip body (server.ts: `options.maxBodyBytes ?? MAX_BODY_BYTES`, and readRaw(req, limit) at the zip branch), so the shared compressed region an attacker uploads once can be up to ~50 MiB on REST by default. Confirmed by direct reading.
  - `packages/mcp/src/services.ts:634` — `const read = readSkillZip(Buffer.from(zip, 'base64'))` runs before `skills.layerBySlug`/`skills.write` resolve or authorize the caller (lines 638-641); confirmed in source. The MCP transport's body cap is 1,000,000 bytes (packages/mcp/src/server.ts:203, enforced at line 266 and passed as `maxRequestBodySize` at line 452), confirmed in source, limiting (but not eliminating) the achievable multiple on this surface.
  - `packages/api/src/skills.ts:550` — `private async gate(...)` — visibility (`mayReadLevel`) then permission (`mayWriteLevel`) are checked here, and `gate()` is only reached from `insert`/`restore`, which are only reached from `write`/`restore` — both called strictly after readSkillZip has already run to completion (or thrown) in both the REST and MCP handlers. Confirmed in source.

### Conditions

[{'kind': 'authentication_level', 'description': "Requires only authentication, not authorization on the target: any valid bearer credential (service-account key, user access token, or an OAuth delegation whose ceiling includes 'skill' or 'admin') is sufficient to reach handleSkills for an arbitrary layer uuid, including one the caller cannot see or write — the visibility/permission check (gate()) runs after the costly parse, not before it."}, {'kind': 'system_configuration', 'description': "The size of the shared, repeatedly-decoded compressed region is bounded by NACRE_MAX_DOCUMENT_BYTES on REST (default 52,428,800 bytes) and by the MCP transport's fixed 1,000,000-byte cap on MCP; a deployment that lowers NACRE_MAX_DOCUMENT_BYTES shrinks the exploitable blob size and therefore the per-request CPU cost on the REST surface."}, {'kind': 'environmental_dependency', 'description': "Impact depends on the deployment's process topology: no clustering/worker-thread use was found in packages/api, so inflateRawSync's synchronous call blocks that Node process's single event loop for the full decode; other requests reaching the same process (potentially from other organizations on a shared replica) stall until the call returns. Rate limiting (admitRequest, server.ts:4374) runs before this parse and bounds how often a given principal can repeat the request, but does not bound the cost of a single admitted request."}]

### Reproduction

**Attacker/caller perspective:** An authenticated principal (a member with no grants on the target layer, or a service account, or any OAuth delegation permitted to call this surface) sends one PUT (REST) or one update_skill tool call (MCP) carrying a crafted ZIP whose central directory references the same local-file data block from many separate entries, each declaring a near-zero uncompressed size so none of them touch the declared-size budget. Reached and measured directly against the real target function (the same function both the REST handler at server.ts:1745 and the MCP handler at services.ts:634 call with these exact bytes), since the bounded sandbox has no live Postgres/Qdrant-backed HTTP server to send the HTTP request through end to end; the parsing step under test is identical either way.

**Payload(s):**
- `Baseline ZIP: one local file entry whose data is 200,000 concatenated 5-byte empty DEFLATE 'stored' blocks (byte0=0x00 except the final block's byte0=0x01, bytes1-4=0x00,0x00,0xFF,0xFF) — 1,000,000 bytes that decode to 0 output bytes under raw inflate — referenced by exactly 1 central-directory entry declaring size=0/crc=0.`
- `Amplified ZIP: the identical 1,000,000-byte local data block, referenced by 256 separate central-directory entries (the SKILL_LIMITS.files*4 cap), each declaring size=0/crc=0 and distinct names f0.md..f255.md, adding only ~13.6 KB of central-directory overhead to the uploaded body.`

**Steps:**
1. Built both ZIP buffers in the sandbox using the exact on-disk ZIP local/central/end-of-central-directory layout readSkillZip parses (verified field-for-field against packages/core/skill.ts).
2. Ran `/sa-tools/prepare-copy.sh` inside the sandbox-run.sh wrapper (SA_TARGET pointed at the read-only target checkout) to get a writable copy with linked node_modules, then imported `readSkillZip` directly from `/scratch/src/packages/core/skill.ts` via tsx (node_modules/tsx is present in the target workspace) and called it with each crafted buffer, timing with process.hrtime.bigint().
3. First measured the raw zlib cost of the empty-stored-block technique in isolation (no application code) at 200k/1M/2M/4M blocks to confirm it genuinely forces proportional CPU work while producing zero output (artifact result.txt).
4. Then measured readSkillZip itself with 1 vs 4 vs 16 vs 64 duplicate/overlapping central-directory entries over a 2 MiB shared region (artifact result2.txt), and finally with 1 vs 256 (the real SKILL_LIMITS.files*4 cap) duplicate entries over a 1 MiB shared region (artifact result3.txt).
5. In all runs, readSkillZip accepted the archive (no refusal for overlap, no refusal for the duplicate/near-zero declared sizes) and returned successfully with one 'file' entry per central-directory record.

**Observed result:** readSkillZip never refuses overlapping compressed ranges: with a single shared 1,000,000-byte compressed region, 1 referencing central-directory entry took ~3.06 ms and 256 referencing entries (the code's own cap, SKILL_LIMITS.files*4) took ~394.86 ms — a ~129x increase in CPU time for only ~13.6 KB of added request body (central-directory records), while the request body already legitimately needed to carry the 1 MiB shared region once. A separate run over a 2 MiB shared region showed the same scaling (1->64 entries: ~3.97 ms -> ~161.20 ms, a ~40.6x increase). A standalone zlib timing (without the skill-archive wrapper) confirmed the underlying mechanism scales close to linearly with the shared blob's byte length (1 MiB: ~2.23 ms, 5 MiB: ~5.82 ms, 10 MiB: ~11.38 ms, 20 MiB: ~23.76 ms), so extrapolating to NACRE_MAX_DOCUMENT_BYTES's REST default (~50 MiB) and the code's 256-entry cap gives a projected single-request cost on the order of several seconds to ~15-20 seconds of fully synchronous CPU inside the API process -- all of it incurred by readSkillZip before skills.write's gate() has checked whether the caller may write (or even see) the targeted layer. Raw transcripts: agents/v27/artifacts/result.txt, agents/v27/artifacts/result2.txt, agents/v27/artifacts/result3.txt.

### Fix

Bound the compressed work the same way the uncompressed work is bounded, and move the parse after authorization. (1) In readSkillZip, sum each entry's `compressed` length into the same (or a parallel) running total and refuse once it exceeds a fixed multiple of SKILL_LIMITS.totalBytes, independent of declared `size`; this closes the near-zero-declared-size loophole regardless of overlap. (2) Reject central-directory entries whose local-data byte range (`localOffset`..`localOffset+compressed`) overlaps a previously-accepted entry's range, since a well-formed archive never needs two entries to share local data. (3) In both server.ts's handleSkills and services.ts's update_skill, resolve the target level and run skills.write's gate()-equivalent visibility/permission check before calling readSkillZip, so a caller who may not write (or see) the level is refused before any parsing cost is spent.

`packages/core/skill.ts`:
```typescript
// After reading `compressed` at line 310:
    compressedTotal += compressed
    if (compressedTotal > SKILL_LIMITS.totalBytes * MAX_COMPRESSION_RATIO) return fail('the archive declares far more compressed data than its contents justify')
    const range = [dataStart, dataStart + compressed]
    if (seenRanges.some(([s, e]) => dataStart < e && s < dataStart + compressed)) return fail(`${name}: entry's data overlaps another entry's`)
    seenRanges.push(range)
```

---

## A member can approve an OAuth connection that acts as any service account in the organization

<a id="api-oauth-consent-agent-visibility-via-unfiltered-service-account-list"></a>

**Severity: MEDIUM** (likelihood: low — The attacker needs a member session, a direct API call, and the random v4 uuid of a target service account. Members cannot list those uuids, so this depends on obtaining one elsewhere.; impact: high — A member obtains a refreshable access token acting as another principal and reaches that service account's grants, possibly including read, write or admin on layers the member cannot access. This crosses the role boundary that keeps agent authority with org_admins.) · confidence {'score': 'high', 'reason': 'The source shows no role gate on the agent path, and the list query is filtered only by org_id. The design docs and OpenAPI both say the agent must be visible to the caller and that service accounts are org_admin-only. A promoted artifact shows the real handler returning 200 with a code to a member. The verifier did not complete its own independent re-run.'}

**Fingerprint:** `api/oauth-consent/agent-visibility-via-unfiltered-service-account-list`

### Description

In the agent flow of POST /v1/oauth/consent, the request body names a service_account_id, and nothing on that path checks the caller's role. The handler is meant to accept only an agent 'this caller can see'. It checks that by looking for the id in options.serviceAccounts.list(auth). PostgresServiceAccounts.list filters only on org_id, so a plain member gets back every service account in the organization and the visibility check always passes. Everywhere else, listing and minting service accounts is org_admin only, and docs/authz.md says the agent flow is an org_admin act. Yet a member can register a client through open RFC 7591 registration, post consent with their own console session naming any service account's uuid, and get back an authorization code. Exchanging the code at /oauth/token gives an access token and refresh token that act as that service account, so the member reaches that account's grants instead of their own.

### Root cause

The agent branch of the consent handler bases its authorization decision on a visibility check that calls PostgresServiceAccounts.list. That method returns every service account in the organization whatever the caller's role. There is no administers(auth) gate on the non-administrative agent path; the only administers() check in the handler sits inside the administrative-MCP branch.

### Intended behavior

Naming a service account in consent should be limited to callers who may list and administer service accounts (org_admin), as docs/authz.md 'Delegated authority' states. A member naming any service account should get the same 404 as for an unknown one. The path open to members is the as-yourself delegation.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:6342` (handler for POST /v1/oauth/consent)
    Reached by any authenticated principal. A member's console session passes the user-type check (6351) and the no-delegation check (6363).
  - **propagation** — `packages/api/src/server.ts:6422` (role gates in the consent handler)
    administersTenants only refuses a platform_admin delegating. administers(auth) at 6451 runs only when the administrative resource is named. The plain agent path has no role gate.
  - **propagation** — `packages/api/src/server.ts:6545` (agent visibility loop)
    The comment states the intended rule: 'one this caller can see ... 404 for anything else'. The loop then accepts the request if options.serviceAccounts.list(auth) contains the named id.
  - **sink** — `packages/api/src/service-keys.ts:228` (PostgresServiceAccounts.list)
    SELECT ... FROM service_accounts WHERE org_id = $1, with no role or caller filter. Every service account in the organization counts as visible to a member, so the request proceeds to consents.record and authorizations.approve with subject actsAs service_account.

### Evidence

  - `packages/api/src/service-keys.ts:228` — list() is scoped only by org_id, so a member and an org_admin get the same rows.
  - `packages/api/src/server.ts:6545` — The comment gives the intended restriction (the agent must be visible to the caller, otherwise 404). The check behind it is vacuous for members.
  - `docs/authz.md:521` — 'Delegated authority': the consent flow could only be completed by an org_admin because its only option was a service account, and both listing and minting one are org_admin. This shows the agent flow is meant to be an org_admin act.
  - `docs/openapi.yaml:977` — ConsentRequest.service_account_id: 'Must be visible to the caller'. Members cannot see service accounts through GET /v1/service-accounts, which is gated on administers.
  - `packages/admin/src/views/consent.ts:301` — The console offers agents only from api.serviceAccounts.list(), which hits the org_admin-gated route. The server-side gap is reachable only by a direct API call.
  - `packages/api/src/main.ts:462` — The shipped API is wired with PostgresServiceAccounts, so production uses the same unfiltered list.

### Conditions

[{'kind': 'authentication_level', 'description': 'The attacker holds a valid console session as a person. A delegation token or a service-account key is refused earlier in the handler.'}, {'kind': 'authorization_role', 'description': 'The attacker is a plain member (not org_admin, not platform_admin).'}, {'kind': 'data_state', 'description': 'The attacker knows the uuid of a target service account in the same organization. Members cannot list service accounts, so the uuid has to come from somewhere else: a leaked config, logs, or a grants listing visible to a scope-level admin.'}, {'kind': 'data_state', 'description': "The escalation matters only if the target service account's grants exceed the member's own."}]

### Reproduction

**Attacker/caller perspective:** An authenticated member who calls the REST API directly, not through the console.

**Payload(s):**
- `POST /v1/oauth/consent with the member's bearer session and body {"client_id":"<client registered via /oauth/register>","redirect_uri":"http://127.0.0.1:33419/callback","code_challenge":"<S256 challenge>","service_account_id":"<uuid of an org service account the member did not create>"}`

**Steps:**
1. Provision a dummy organization with a member user, an org_admin, and a service account created by the org_admin.
2. Register an OAuth client with a loopback redirect URI.
3. As the member, POST /v1/oauth/consent naming the service account's id.
4. Observe a 200 whose redirect_to carries an authorization code. The intended answer is 404.
5. Optionally, exchange the code at /oauth/token with the PKCE verifier; the minted token's subject acts as the service account.

**Observed result:** The promoted hunter artifact (agents/h01-delegation/artifacts/result.txt) records a test against a real PostgreSQL through the shipped createApi handler: 'UNIT2 member-as-agent-consent status=200 hasCode=true body={"redirect_to":"http://127.0.0.1:33419/callback?code=nacre_ac_..."}'. A member received an authorization code for a connection acting as a service account they do not administer. This verifier re-checked every line of the path in source and found no preventing layer. The verifier's own re-run was not completed, so no v01 artifact is cited.

### Fix

In the agent branch (service_account_id present), require administers(auth) before the visibility loop and answer 404 otherwise, matching the gate on GET/POST /v1/service-accounts. Alternatively, give the visibility check a lookup scoped to the caller's role instead of reusing PostgresServiceAccounts.list. Add an authz case asserting that a member naming an existing service account gets 404 and that no consent row is stored.

`packages/api/src/server.ts`:
```typescript
// Agent flow: only an organization administrator may let an application act as an agent.
if (!delegating && !administers(auth)) {
  const problem = notFound(instance, requestId)
  send(res, problem.status, problem.toJSON(), requestId)
  return
}
```

---

## An OAuth connection acting as a service account keeps renewing after the service account is revoked

<a id="api-oauth-refresh-service-account-revocation-not-rechecked"></a>

**Severity: MEDIUM** (likelihood: medium — Requires an existing OAuth connection acting as a service account (a documented, ordinary agent-connection shape) and an administrator revoking the service account rather than (or in addition to) each connection individually. This is a plausible, even favoured, administrative action -- it is the only way to end every connection acting as a given account at once -- but the documented workaround (revoke the connection directly) does still work, and an administrator who always revokes connections one by one never hits this.; impact: medium — A revoked service account's full grant set stays reachable indefinitely through any OAuth connection acting as it, since the refresh/rotation loop never stops: unlike an already-minted bare access token (bounded by its TTL, by design), this is an unbounded renewal. The blast radius is exactly whatever that service account was granted -- not a privilege escalation beyond it -- so impact scales with, but does not exceed, the account's own permissions.) · confidence {'score': 'high', 'reason': "The root cause is unambiguous in source -- rotate()'s revocation re-check is textually gated on c.acts_as = 'user' with no corresponding check anywhere for service_account, and every downstream path (JWT verification, effectivePrincipals, loadGrants) independently lacks one too. The behaviour was independently reproduced against a real PostgreSQL with migrations 0001-0044 applied, using a freshly written test separate from the original hunter's, confirming the exact mechanism end to end: create SA, consent as SA, issue refresh token, revoke SA (confirmed), rotate still succeeds with the SA's identity. The only policy question -- whether this gap was ever a deliberate choice -- is resolved by migration 0024's own header, which states the refresh mechanism exists specifically to keep an OAuth-minted access token's exposure 'bounded ... rather than indefinite'; the service-account path violates exactly that stated property, so this reads as an asymmetric omission rather than an accepted design trade-off."}

**Fingerprint:** `api/oauth-refresh/service-account-revocation-not-rechecked`

### Description

PostgresOAuthRefreshTokens.rotate (packages/api/src/oauth-store.ts) re-checks revocation of the acting principal only for a delegation (acts_as='user'): its SELECT computes `suspended` from a LEFT JOIN on `users` gated by `c.acts_as = 'user'` (oauth-store.ts:827-829), and separately refuses when `c.revoked_at IS NOT NULL` on the connection itself. Neither clause ever reads `service_accounts.revoked_at`. For a connection whose subject is a service account (acts_as='service_account'), rotate() falls straight through to returning a MintRequest (oauth-store.ts:879-882), and the token endpoint (server.ts:4007-4080) mints a fresh service-account access token and reissues the refresh token. The minted JWT has `principal_type:'service_account'` and no `del` claim (oauth-mint.ts: `del` is only added when `delegated`, i.e. actsAs==='user'); authenticate() treats the absence of `del` as 'not a delegation' and returns `base` immediately with no table lookup at all (auth.ts:591-595). effectivePrincipals (packages/core/authz/principals.ts) and loadGrants (packages/core/authz/store.ts) resolve purely from the principal ref and never consult service_accounts.revoked_at either. So once an administrator revokes a service account via DELETE /v1/service-accounts/{id} (-> PostgresServiceAccounts.revoke, server.ts:6790-6799), the account's own nacre_sk_ key stops working immediately (service-keys.ts:91-96 filters revoked_at IS NULL on every lookup), but any OAuth connection that was approved to act as that service account keeps minting valid, fully-privileged access tokens for that account indefinitely, because every refresh re-extends the family with no revocation check at all.

### Root cause

PostgresOAuthRefreshTokens.rotate's revocation re-check is written only for the delegated case (c.acts_as = 'user'); it has no equivalent LEFT JOIN against service_accounts for acts_as = 'service_account', so renewing a service-account connection never consults the one column (service_accounts.revoked_at) that is supposed to end that account's authority. Downstream, authenticate() verifies a service-account JWT by signature alone (no `del` claim means an immediate `return base`), and the resolver (effectivePrincipals/loadGrants) never re-checks a service account's revocation state either, so nothing after rotate() can catch what it missed.

### Intended behavior

Revoking a service account is meant to end its authority outright, the same way the direct nacre_sk_ key path enforces revoked_at IS NULL on every single request. Migration 0024's own header states the design goal for an OAuth-minted access token explicitly: it is a JWT verified locally with nothing consulting a table, so 'the access token then survives at most its own TTL, which is bounded and stated rather than indefinite' -- the refresh/rotation mechanism exists precisely to bound that otherwise-unrevocable JWT to a short TTL by killing the refresh token on revocation, exactly as it already does for a delegation's acts_as='user' case (suspended on the user's disabled_at/role). The refresh endpoint already opens a transaction and joins oauth_consents on every call, so checking service_accounts.revoked_at there costs nothing extra and was clearly intended to mirror the user case; instead, a service-account connection's refresh keeps succeeding forever, turning the documented 'bounded by TTL' promise into unbounded, indefinite renewal for exactly the one case (service_account) where the underlying account has in fact been revoked.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:4007` (POST /oauth/token, grant_type=refresh_token)
    An unauthenticated holder of a refresh token for a connection acting as a service account presents it; the handler calls oauth.refreshTokens.rotate(presented) with no other check.
  - **propagation** — `packages/api/src/oauth-store.ts:827` (PostgresOAuthRefreshTokens.rotate, `suspended` computation)
    `suspended` is computed as (c.acts_as = 'user' AND (... u.disabled_at ... u.role ...)). For acts_as = 'service_account' this is always false and no column of service_accounts is read anywhere in the query, so a revoked service account never makes this branch refuse.
  - **sink** — `packages/api/src/oauth-store.ts:880` (PostgresOAuthRefreshTokens.rotate, return value for a service-account connection)
    Having fallen through used_at, expired/revoked (on the connection itself, not the service account) and suspended, rotate() returns { ...base, subject: { actsAs: 'service_account', serviceAccountId: row.service_account_id } }; server.ts then calls oauth.mint(rotated) and issues a fresh access token plus a fresh refresh token, unconditionally.

### Evidence

  - `packages/api/src/oauth-store.ts:827` — The suspended clause is gated on c.acts_as = 'user'; a service-account connection is structurally excluded from any revocation re-check at refresh time, and no service_accounts row is ever joined into this query.
  - `packages/api/src/service-keys.ts:91` — PostgresServiceKeys.resolve runs SELECT ... FROM service_accounts WHERE key_prefix = $1 AND revoked_at IS NULL on every single request for the direct key -- establishing the asymmetry: the same account's own key dies the instant it is revoked, while its OAuth connection does not.
  - `packages/api/src/auth.ts:595` — When the verified JWT has no del claim (true for every service-account-acting OAuth token, since oauth-mint.ts only sets del when actsAs==='user'), authenticate() returns base immediately -- no database lookup of any kind runs for the service-account subject on this path.
  - `packages/core/authz/principals.ts:44` — effectivePrincipals walks group membership from the principal ref alone; it has no notion of, and never checks, whether the underlying service account is revoked.
  - `packages/core/migrations/0024_oauth_consents.sql:7` — The migration's own header states the intended property this bug violates: an OAuth-minted access token 'is valid until it expires and nothing consults a table', and the refresh/revocation mechanism exists so that the access token 'then survives at most its own TTL, which is bounded and stated rather than indefinite.' For the service-account case this bound does not hold: renewal is never refused, so the exposure after revocation is indefinite rather than bounded.
  - `agents/v32/artifacts/result.txt:1` — Independently reproduced against a real PostgreSQL (44 migrations applied) with a freshly written test (packages/api/src/__tests__/v32x.test.ts, run under the sandbox, not committed to the target): PostgresServiceAccounts.create -> PostgresOAuthConsents.record(actsAs='service_account') -> PostgresOAuthRefreshTokens.issue -> rotate() succeeds -> PostgresServiceAccounts.revoke() returns true (revoked_at set, confirmed by a direct SELECT) -> PostgresOAuthRefreshTokens.rotate() on the still-live refresh token again returned a full MintRequest with subject.actsAs='service_account' and a fresh family, rather than undefined or 'suspended'. This independently reproduces h01-delegation's own result2.txt artifact with a separately written test.

### Conditions

[{'kind': 'data_state', 'description': "An OAuth connection exists with acts_as = 'service_account' (an application was approved through the agent consent flow to act as a service account) and holds a live, unexpired, unused refresh token."}, {'kind': 'authorization_role', 'description': 'An org_admin revokes the service account itself (DELETE /v1/service-accounts/{id}) -- the natural and, where several connections act as the same account, the only way to end all of them at once -- rather than, or in addition to, separately revoking each OAuth connection.'}]

### Reproduction

**Attacker/caller perspective:** The holder of a service-account-acting OAuth connection's refresh token (e.g. a connected application, or anyone who captured that refresh token), after an administrator has revoked the underlying service account believing that ends its authority.

**Payload(s):**
- `POST /oauth/token  grant_type=refresh_token&refresh_token=<the connection's live refresh token>`

**Steps:**
1. As an org_admin, create a service account and approve an OAuth consent acting as it (acts_as='service_account'); obtain a refresh token for that connection (via the authorization_code exchange, or directly via PostgresOAuthRefreshTokens.issue in a local reproduction).
2. Revoke the service account: DELETE /v1/service-accounts/{id} (PostgresServiceAccounts.revoke), and confirm revoked_at is set.
3. Present the connection's live refresh token to POST /oauth/token with grant_type=refresh_token (or call PostgresOAuthRefreshTokens.rotate(token) directly).

**Observed result:** revoked_at was set on the service account (revoke() returned true, confirmed by a direct SELECT), yet rotate() returned a full MintRequest -- {orgId, consentId, family, subject:{actsAs:'service_account', serviceAccountId}} -- rather than undefined or 'suspended'; server.ts would mint a fresh service-account access token and reissue a refresh token from this, exactly as before the revocation. Reproduced independently against a real PostgreSQL (agents/v32/artifacts/result.txt), consistent with h01-delegation's own result2.txt.

### Fix

In PostgresOAuthRefreshTokens.rotate, extend the single SELECT with a LEFT JOIN against service_accounts (by c.service_account_id and org_id) and fold (c.acts_as = 'service_account' AND sa.revoked_at IS NOT NULL) into the refusal -- most naturally into the existing `revoked` check (treat it as equivalent to the connection's own revoked_at, since a revoked service account's authority should end exactly like a revoked connection's) rather than into `suspended` (revoking an account, unlike disabling a person, is not something the product currently reverses). As defence in depth, since an already-minted access token is still accepted purely by signature for its remaining TTL, the resolver/authenticate path could additionally treat a service_account principal whose row is revoked as unauthorized -- mirroring stillActing's existing active() re-check, which today only runs for upload-ticket redemption and never for an ordinary bearer-token request.

`packages/api/src/oauth-store.ts`:
```typescript
-- In rotate()'s SELECT, add: LEFT JOIN service_accounts sa ON sa.id = c.service_account_id AND sa.org_id = c.org_id
-- and change: c.revoked_at IS NOT NULL AS revoked
-- to:        (c.revoked_at IS NOT NULL OR (c.acts_as = 'service_account' AND sa.revoked_at IS NOT NULL)) AS revoked
```

---

## Open OAuth client registration validates an unbounded redirect_uris list with an O(n^2) membership check, allowing cheap single-request CPU exhaustion

<a id="packages-api-src-server-ts-oauth-register-unbounded-redirect-uris"></a>

**Severity: MEDIUM** (likelihood: high — The path requires no credential and no special tooling - only a single HTTP POST with a large but trivially-constructed JSON array - and the only admission control (a generic 100/hour per-source counter) limits how often the expensive call can be triggered, not whether it can be triggered at all.; impact: medium — Each admitted request can cost up to ~3.9s of synchronous, single-threaded CPU time on the shared Node.js event loop (measured), before authentication and before any tenant is known, so it is shared across every organization and caller the API process serves at that moment. It is availability-only (no data exposure, no auth bypass, no cross-tenant read), self-recovers once the call returns, and is bounded in frequency by the default per-source budget (up to roughly 100 such requests, and several minutes of aggregate blocking, per source per hour); persisted client rows (each up to ~1MB) also accumulate for up to 7 days unless the worker's sweep removes them, adding a modest, separately-bounded storage cost.) · confidence {'score': 'high', 'reason': "The missing per-field bound, the sibling door's 20x512 cap, the O(n) registered.includes(uri) scan, the 1,000,000-byte body cap, the 7-day sweep and touch()'s effect on it are all directly read from source at the cited lines. The quadratic cost was independently reproduced inside the approved sandbox by invoking the exact exported function the handler calls, with no modification to the target, over both a scaling series (1,000/4,000/16,000 URIs) and the realistic single-request worst case (25,800 URIs, 995,127 bytes) - resolving the hunter's stated 'event-loop time per request was not measured' blocker directly, which is the only reason the hunter proposed needs_validation rather than confirmed."}

**Fingerprint:** `packages/api/src/server.ts:oauth-register:unbounded-redirect-uris`

### Description

POST /oauth/register (server.ts:3850) is reached before authenticate() (server.ts:4183) is ever called and is gated only by the generic per-source client_registration budget (100/hour by default). The handler reads redirect_uris into an array with no count or length bound (server.ts:3864-3869) and validates it with `uris.every(u => redirectAllowed(u, uris))` (server.ts:3880); redirectAllowed delegates to exactRedirect, whose check is `registered.includes(uri)` (authserver.ts:201) - an O(n) linear scan performed once per URI, making the whole validation O(n^2) in the length of the attacker-supplied list. The only other bound is the generic 1,000,000-byte body cap (server.ts:1202), so a single request can carry roughly 25,000-26,000 short https URIs. I reproduced the cost directly: importing the exact exported `redirectAllowed` function the handler calls and timing `uris.every(...)` over synthetic https URIs inside the sandbox showed clearly superlinear growth (1,000 URIs: 18.6ms; 4,000: 205ms; 16,000: 2,172ms), and a single payload built to sit just under the 1,000,000-byte body limit (25,800 URIs, 995,127 bytes) took 3,897ms of synchronous, single-threaded computation to validate - before any authentication and before the row is even written. The sibling door for the same table, validateMetadataDocument (client-metadata.ts:106), caps the equivalent list at 20 entries of at most 512 characters and is the comparable baseline that shows this is an omission rather than this codebase's general pattern. Persisted rows are swept by the worker only after UNAPPROVED_CLIENT_DAYS = 7 days unseen with no consent and no authorization (adapters.ts:885,902-919), and the authorize endpoint's touch() (oauth-store.ts:350-357) resets last_seen_at on every call, so a client that is merely walked through /oauth/authorize stays out of that sweep indefinitely.

### Root cause

The registration handler omits the per-field bound (entry count and per-string length) that validateMetadataDocument already applies to the same table's other entry door, and redirectAllowed/exactRedirect reuse a plain-array membership scan (`registered.includes(uri)`) that is O(n) per call; calling it once per URI inside `uris.every(...)` makes the self-asserted redirect_uris array's validation cost O(n^2) in its length, with no upper bound on that length besides the generic 1,000,000-byte body cap.

### Intended behavior

Redirect-URI validation should cost time roughly proportional to the number of URIs supplied (e.g. building a Set once and doing O(1) lookups, or validating each URI independently of the others), and POST /oauth/register should bound redirect_uris by count and length the same way the CIMD door (validateMetadataDocument) already does for the identical column, so an unauthenticated caller cannot register an order of magnitude more data, and spend an order of magnitude more CPU validating it, than the parallel door permits for the same table.

### Trace

  - **entrypoint** — `packages/api/src/server.ts:3850` (POST /oauth/register)
    Reached before authenticate() (server.ts:4183) is ever called; the only admission control is the generic per-source client_registration budget applied at server.ts:3859 (100/hour by default, config.ts NACRE_RATE_CLIENT_REGISTRATION_PER_HOUR).
  - **propagation** — `packages/api/src/server.ts:3864` (registration body parsing)
    redirect_uris is read into an array of strings with only the generic 1,000,000-byte body cap (server.ts:1202) applied to the whole request; no count or per-string length bound, unlike the metadata-document door (client-metadata.ts:106, 20 entries x 512 chars).
  - **propagation** — `packages/core/authserver.ts:201` (exactRedirect)
    registered.includes(uri) is an O(n) linear scan of the whole attacker-supplied list, called once per entry from redirectAllowed (authserver.ts:156-158).
  - **sink** — `packages/api/src/server.ts:3880` (uris.every(u => redirectAllowed(u, uris)))
    Synchronous, single-threaded O(n^2) computation on the Node.js event loop before authentication and before the client row exists. Reproduced directly: this exact call shape, invoked over synthetic https URIs in the sandbox, took 3,897ms for 25,800 URIs (995,127 bytes, just under the 1,000,000-byte body cap) - see agents/v22/artifacts/result2.txt.

### Evidence

  - `packages/api/src/client-metadata.ts:106` — validateMetadataDocument refuses more than 20 redirect_uris entries or any entry over 512 characters - the comparable baseline the registration door lacks for the identical oauth_clients.redirect_uris column.
  - `packages/api/src/server.ts:1202` — MAX_BODY_BYTES = 1_000_000 is the only size control on the registration request; readBody(req) at server.ts:3864 uses this default with no smaller override, confirmed by grep - no other call in the register branch passes a maxBodyBytes option.
  - `packages/worker/src/adapters.ts:885` — UNAPPROVED_CLIENT_DAYS = 7; pruneUnapprovedClients (adapters.ts:902-919) only deletes a registered row after 7 days with neither a consent nor an authorization against it.
  - `packages/api/src/oauth-store.ts:350` — touch() updates last_seen_at on every call from the authorize endpoint (server.ts) more than an hour apart, which resets the 7-day sweep window indefinitely for any client that is walked through /oauth/authorize at least once a week.
  - `agents/v22/artifacts/result.txt:1` — Independent local reproduction: timing uris.every(u => redirectAllowed(u, uris)) (the exact exported function the handler calls) over N synthetic https URIs shows clearly superlinear growth: N=1000 -> 18.6ms, N=4000 -> 205.5ms, N=16000 -> 2172.2ms, run inside the sandbox with no network, importing packages/core/authserver.ts directly.
  - `agents/v22/artifacts/result2.txt:1` — Independent local reproduction at the realistic worst case for a single request: 25,800 distinct https URIs serialize to 995,127 bytes (just under the 1,000,000-byte MAX_BODY_BYTES cap); validating that list with the handler's exact check took 3,897ms of synchronous computation in the sandbox.

### Conditions

[{'kind': 'authentication_level', 'description': 'None required. POST /oauth/register is dispatched before authenticate() is called (server.ts:4183 is reached only for routes outside the /v1/auth/* and oauth register/authorize/token blocks), by RFC 7591 design.'}, {'kind': 'system_configuration', 'description': 'Admission beyond the request itself is gated only by the generic client_registration per-source budget, 100 requests/hour by default (config.ts NACRE_RATE_CLIENT_REGISTRATION_PER_HOUR); this bounds how often one source may trigger the expensive validation, not the cost of any single admitted request, which can independently reach ~3.9s of blocking as measured.'}, {'kind': 'network_routing', 'description': "No reverse-proxy body-size override exists in the shipped docker/nginx.conf.template or deploy/helm/nacre/templates/ingress.yaml (grepped for client_max_body_size / proxy-body-size with no match), so a ~995KB JSON body passes through the default Compose and Helm front doors unimpeded to reach the API's own 1,000,000-byte cap."}]

### Reproduction

**Attacker/caller perspective:** An anonymous caller with no account, no prior interaction with the installation, and no special tooling composes one HTTP POST to /oauth/register whose redirect_uris array holds tens of thousands of short https:// strings, kept just under the 1,000,000-byte body cap. Nothing about building that array requires more effort than a short script; the server does the expensive part.

**Payload(s):**
- `POST /oauth/register with Content-Type: application/json and body {"client_name":"x","redirect_uris":["https://c-0.example.com/callback","https://c-1.example.com/callback", ... 25,800 total distinct https entries ...]} totaling 995,127 bytes, under the 1,000,000-byte MAX_BODY_BYTES cap`

**Steps:**
1. In the sandbox, run /sa-tools/prepare-copy.sh to obtain a writable copy of the repository at /scratch/src with node_modules linked.
2. Write a script that imports { redirectAllowed } from /scratch/src/packages/core/authserver.ts - the exact function the registration handler calls at server.ts:3880 - with no modification.
3. Build an array of N distinct https URIs (e.g. `https://c-<i>.example.com/callback`) and time `uris.every(u => redirectAllowed(u, uris))`, matching the handler's own call shape exactly.
4. Run the script under node_modules/.bin/tsx for N = 1000, 4000, 16000 to show superlinear growth (recorded in agents/v22/artifacts/result.txt), then for N = 25800 (995,127-byte serialized body, just under the request's 1,000,000-byte cap) to measure the realistic worst case for one request (recorded in agents/v22/artifacts/result2.txt).
5. Both runs executed entirely inside the sandbox (--secs 180, no network, no Postgres/Redis needed since only the pure validation function was exercised) against the unmodified target source.

**Observed result:** Validation time grows far faster than the input: N=1000 -> 18.6ms, N=4000 (4x) -> 205.5ms (~11x), N=16000 (16x) -> 2172.2ms (~117x from the N=1000 baseline), consistent with the O(n^2) cost that `registered.includes(uri)` inside `every()` implies. At the realistic worst case for a single request - 25,800 URIs serialized to 995,127 bytes, just under the handler's own 1,000,000-byte body cap - the identical check took 3,897ms of synchronous computation. This single call is what POST /oauth/register executes on the shared Node.js event loop, unauthenticated, before any client row is written, for every request the per-source budget admits (100/hour by default).

### Fix

Bound redirect_uris on POST /oauth/register the same way validateMetadataDocument already bounds it for the identical column on the CIMD door - refuse more than a small fixed count of entries (e.g. 20) or any entry over a fixed length (e.g. 512 characters) before running any per-URI check - and make the per-URI check itself O(1) regardless of list size, e.g. by building a Set of the registered URIs once per validation call instead of calling Array.prototype.includes once per entry inside exactRedirect.

`packages/api/src/server.ts`:
```typescript
const uris = Array.isArray(registration.redirect_uris)
  ? registration.redirect_uris.filter((u): u is string => typeof u === 'string')
  : []
if (uris.length === 0 || uris.length > 20 || uris.some((u) => u.length > 512)) {
  send(res, 400, { error: 'invalid_redirect_uri', error_description: "'redirect_uris' must have 1-20 entries of at most 512 characters." }, requestId)
  return
}
```

`packages/core/authserver.ts`:
```typescript
function exactRedirect(uri: string, registered: readonly string[] | ReadonlySet<string>): boolean {
  const isMember = registered instanceof Set ? registered.has(uri) : registered.includes(uri)
  if (!isMember) return false
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  return parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]' || parsed.hostname === 'localhost'
}
// callers that validate a whole list build `new Set(uris)` once and pass it in,
// instead of calling redirectAllowed(u, uris) once per entry of the same array.
```

---

## Per-client sign-in limit becomes a single global bucket behind the shipped nginx front door

<a id="packages-api-src-source-ts-clientsource-trust-proxy-default-behind-shipped-front-door"></a>

**Severity: MEDIUM** (likelihood: high — This is the shipped default in every Compose profile and in the Helm chart; the attack needs only 61 unauthenticated HTTP requests inside a 15-minute window, and was reproduced locally against the real server and a real Redis-backed limiter on the first attempt.; impact: medium — Denial of new sign-ins, second-factor completion, WebAuthn sign-in and password-reset confirmation for every legitimate client sharing the front door; already-issued sessions and already-authenticated requests are unaffected, and the window self-heals (a refused request gives back its increment, per limits.ts).) · confidence {'score': 'high', 'reason': "Independently reproduced end-to-end against the real createApi() server and a real Redis-backed RateLimiter using only the shipped default configuration (trustProxy: 0, login_source limit 60/900s); every file:line in the trace and evidence was read directly from the target source and matches exactly; the project's own documentation (docs/config.md:530) independently confirms the mechanism."}

**Fingerprint:** `packages/api/src/source.ts:clientSource:trust-proxy-default-behind-shipped-front-door`

### Description

NACRE_TRUST_PROXY defaults to 0 in every shipped topology (Compose's .env.example, every Compose profile, and the Helm chart's values.yaml), while every shipped topology also runs nginx (docker/nginx.conf.template, service `web`, present in every Compose profile with no `profiles:` restriction) in front of the API and proxies all of `/v1/`, `/oauth/` and `/.well-known/` to it. At trustProxy=0, clientSource() unconditionally ignores X-Forwarded-For and returns req.socket.remoteAddress, which for every proxied request is nginx's own address. The login_source rate limit (60 per 15 minutes by default) is keyed on that value, so every real client reaching the API through the shipped front door shares one Redis bucket: one unauthenticated caller sending 61 failed POST /v1/auth/login requests exhausts the bucket and every other legitimate client is then refused 429 on sign-in. The same limitedBySource() check gates /v1/auth/second-factor, /v1/auth/second-factor/webauthn and /v1/auth/password-reset/confirm, so a second-factor step, a WebAuthn sign-in and a recovery-link redemption are denied by the same mechanism. The identical defect shape also reaches the client_registration bucket: admitClientRegistration (server.ts:2003) keys on the same clientSource() value, so POST /oauth/register and CIMD metadata fetches collapse into one bucket behind the same front door, and its `?? 'unknown'` fallback for an unidentifiable source shares one key rather than skipping the limit, contradicting source.ts's own stated contract (line 51) that an unidentifiable source must mean 'no limit, never one shared bucket.' Both are the same source-derived root cause (clientSource() returning a non-identifying value under the shipped default) and are correctly merged under this fingerprint. Compose additionally publishes the API's own port (8080) directly beside the front door's port (8082), so simply raising NACRE_TRUST_PROXY without also closing that port would let a direct caller forge X-Forwarded-For and evade the limit entirely — the fix is not a one-line config change.

### Root cause

The default value of NACRE_TRUST_PROXY (0) does not match the topology every shipped deployment actually runs (nginx or an ingress in front of the API), and nothing at startup validates or warns about that mismatch; Compose also exposes the API port directly, so the naive single-line fix (raise trustProxy) is itself unsafe without also closing that port.

### Intended behavior

A shipped deployment should identify each real client correctly for the per-client sign-in, second-factor, WebAuthn and password-reset limits, and should expose only the front door to direct, unauthenticated traffic.

### Trace

  - **entrypoint** — `docker/nginx.conf.template:129` (location /v1/)
    Every browser/API request to /v1/ in the shipped front door is proxied here; the API sees only nginx's own socket address as the request's peer, with X-Forwarded-For appended by nginx itself ($proxy_add_x_forwarded_for).
  - **propagation** — `packages/core/config.ts:1256` (trustProxy)
    NACRE_TRUST_PROXY defaults to 0, the value both .env.example and the Helm chart's values.yaml ship, with no startup check that the deployment actually has zero proxies in front of it.
  - **propagation** — `packages/api/src/source.ts:77` (clientSource)
    At trustProxy=0 the function returns before ever reading the X-Forwarded-For header; it always falls through to req.socket.remoteAddress, which behind the shipped nginx is nginx's own address for every request.
  - **sink** — `packages/api/src/server.ts:2739` (login_source check inside /v1/auth/login)
    options.limits.check(`src:${source}`, 'login_source') is keyed on that shared socket address; every client behind the front door spends from the same 60-per-15-minute Redis bucket, so one unauthenticated client's failed attempts deny sign-in, second-factor, WebAuthn and password-reset to every other client sharing the proxy.

### Evidence

  - `docker-compose.yml:138` — ports: ["${NACRE_API_HOST_PORT:-8080}:8080"] - the API's own port is published directly on the host, beside the nginx front door on 8082 (line 59's NACRE_CANONICAL_URL default), confirmed present with no `profiles:` restriction (i.e. in every Compose profile including `minimal`).
  - `.env.example:189` — NACRE_TRUST_PROXY=0 is the shipped default value, next to NACRE_RATE_LOGIN_SOURCE_PER_15MIN=60, the exact limit reproduced below.
  - `deploy/helm/nacre/values.yaml:505` — trustProxy: 0 - the Helm chart ships the identical unsafe default for Kubernetes deployments, which route through an Ingress by default.
  - `docs/config.md:530` — The project's own documentation states the exact mechanism verbatim: "Ignoring it unconditionally means that behind an ingress every request carries the proxy's address, so one bad client rate-limits every user" - confirming this is a known, named failure mode that the shipped default nonetheless leaves exposed.
  - `packages/api/src/server.ts:2003` — admitClientRegistration keys the client_registration bucket (/oauth/register and CIMD metadata fetches) on the identical clientSource() value with a `?? 'unknown'` fallback for an unidentifiable source, sharing one key rather than skipping the limit - the same root-cause mechanism reaching a second surface, as source.ts:51 documents it must never do.

### Conditions

[{'kind': 'system_configuration', 'description': "NACRE_TRUST_PROXY left at its shipped default of 0 (Compose and Helm) while the shipped topology (nginx in every Compose profile; an Ingress when Helm's web/ingress is enabled) places a proxy in front of the API."}, {'kind': 'authentication_level', 'description': 'No credential is required: /v1/auth/login, /v1/auth/second-factor, /v1/auth/second-factor/webauthn and /v1/auth/password-reset/confirm are all reachable by any unauthenticated caller of the front door.'}]

### Reproduction

**Attacker/caller perspective:** An unauthenticated client of the deployment's public front door.

**Payload(s):**
- `60 failed POST /v1/auth/login requests (distinct target emails, distinct X-Forwarded-For values) over one connection, followed by a 61st request from a never-before-used email and X-Forwarded-For value, all within the 15-minute window`

**Steps:**
1. Reproduced independently inside the sandbox (--redis) with a real Redis-backed RateLimiter (packages/api/src/limits.ts, no mocks) and the real createApi() HTTP server (packages/api/src/server.ts), configured with the shipped default trustProxy: 0 and the shipped default login_source limit of 60 per 900 seconds.
2. Sent 60 POST /v1/auth/login requests over a single loopback connection, each carrying a distinct X-Forwarded-For header and a distinct, never-before-seen target email (simulating 60 different real end users, each presenting through nginx as the test proved X-Forwarded-For must be ignored at trustProxy=0); all 60 received 401 as expected.
3. Sent one more POST /v1/auth/login request carrying yet another new X-Forwarded-For value and a completely unrelated email that had made zero prior attempts of its own.
4. Full test source and console output are the promoted artifact.

**Observed result:** The 61st request - representing an entirely unrelated client that had never attempted a sign-in before - was refused with 429 "Too many requests", solely because 60 prior, unrelated simulated clients shared its Redis bucket (`src:<loopback-address>`) under the shipped trustProxy=0 default. See agents/v23/artifacts/result.txt (vitest run, 1 passed).

### Fix

Ship NACRE_TRUST_PROXY set to the actual number of proxy hops for each shipped topology (1 for the bundled nginx in Compose, the correct count for the Helm Ingress) rather than leaving the unsafe default of 0 in front of a proxy. Because raising it alone would let a direct caller who bypasses the proxy forge X-Forwarded-For and evade the limit, also stop publishing the API and MCP ports on all host interfaces in Compose (bind to 127.0.0.1, or remove the published ports and route only through the front door) and keep the Helm chart's ClusterIP-only default. Separately, make admitClientRegistration's 'unknown' fallback skip the client_registration limit instead of sharing one key, matching the contract source.ts already documents.

---

## nacre CLI ingest follows symlinks out of the ingested directory, uploading arbitrary local files into the index

<a id="packages-cli-src-commands-ts-collect-follows-symlinks-out-of-tree"></a>

**Severity: MEDIUM** (likelihood: low — Requires an attacker to plant a symlink inside a directory the operator later trusts enough to run `nacre ingest` over, and some expectation about which local path is worth exfiltrating; this is a narrower precondition than typical remote attacks and matches the hunter's own characterisation; impact: high — Reproducibly allows reading an arbitrary local file reachable by the OS user running the CLI (credentials, SSH keys, other local documents) and depositing its content into the index, where every principal holding read access to the target layer can then see it — crossing from local filesystem control into the shared, permissioned index) · confidence {'score': 'high', 'reason': "Confirmed independently in the sandbox against the unmodified target source (not by trusting the hunter's artifact): the exported collect() function demonstrably returns a symlink pointing outside the ingested directory as an ingestable entry, and reading that entry's path the same way ingest() does yields the external target's content. Source reading of commands.ts:295-323 (collect) and :356-360 (ingest) independently corroborates the mechanism, and the same absence of an isSymbolicLink() check is visible in the --watch handler at line 455."}

**Fingerprint:** `packages/cli/src/commands.ts:collect:follows-symlinks-out-of-tree`

### Description

collect() in the nacre CLI walks a directory with readdirSync({withFileTypes:true}) and decides whether an entry is a file to ingest purely from entry.isDirectory() (false for a symlink, which Dirent reports without following) and the symlink's own file name having a recognised text extension (.md/.txt/etc.). It never checks entry.isSymbolicLink(). ingest() then calls readFileSync(file.path, 'utf8'), which does follow the symlink, and uploads the resolved target's content via client.documents.add(). A symlink planted inside a directory that an operator later runs `nacre ingest <dir> --layer X` over therefore causes an arbitrary local file reachable by the OS user running the CLI (e.g. SSH keys, cloud credentials, other users' documents) to be read and indexed under an attacker-chosen name, becoming visible to every principal who holds read access to that layer. The --watch path (packages/cli/src/commands.ts:453-455) has the identical flaw.

### Root cause

collect() (packages/cli/src/commands.ts:295-323) branches only on entry.isDirectory() and extensionOf(entry.name); it never calls entry.isSymbolicLink() or lstatSync on the entry, and ingest() (packages/cli/src/commands.ts:356-360) reads the collected path with readFileSync, which transparently follows a symlink to any target the process can read, regardless of whether that target is inside the directory the operator named.

### Intended behavior

Skip symlink entries in collect() (check entry.isSymbolicLink() before isDirectory()/extension), or resolve each entry's real path and refuse one that falls outside the ingested root, in both collect() and the --watch flush() handler.

### Trace

  - **entrypoint** — `packages/cli/src/commands.ts:304` (collect)
    readdirSync(dir, {withFileTypes:true}) enumerates directory entries, including a symlink an attacker planted in the corpus
  - **propagation** — `packages/cli/src/commands.ts:317` (collect)
    A symlink entry whose own name has a recognised text extension is pushed into `found` as a path to ingest; isDirectory() is false for a symlink (Dirent is lstat-based, not followed) so it falls straight into this branch regardless of what the symlink points at
  - **sink** — `packages/cli/src/commands.ts:360` (ingest)
    readFileSync(file.path, 'utf8') follows the symlink and its content is sent as `content` to client.documents.add(), uploading the external target into the index under the attacker-chosen external id

### Evidence

  - `packages/cli/src/commands.ts:455` — The --watch flush() handler calls readFileSync(path, 'utf8') on paths reported by fs.watch with the same lack of a symlink check, so the flaw also applies to long-running `nacre ingest --watch`

### Conditions

[{'kind': 'data_state', 'description': 'The directory later passed to `nacre ingest` contains an attacker-planted symlink entry whose own file name carries a TEXT-listed extension (.md/.txt/.json/etc.) and whose target is any file the OS user running the CLI can read'}, {'kind': 'user_interaction', 'description': "A legitimate operator must run `nacre ingest <that directory> --layer <slug>` (or `--watch` it), i.e. trust the directory's listing enough to ingest it without having reviewed every entry for planted symlinks"}]

### Reproduction

**Attacker/caller perspective:** A contributor who can plant files (e.g. via a shared git repo, synced folder, or extracted archive) into a directory that a trusted operator will later run `nacre ingest` over

**Payload(s):**
- `A symlink named with a recognised text extension (e.g. notes.md) created inside the corpus directory, pointing at a local file outside that directory (e.g. an absolute path to a credentials file readable by the ingesting user)`

**Steps:**
1. Independently reproduced in the sandbox (not inferred from the hunter's artifact): built a corpus directory containing a legitimate readme.md plus a symlink notes.md pointing at a file outside the corpus (/scratch/<outside>/secret.txt containing a dummy secret string), called the real exported collect() from packages/cli/src/commands.ts against the corpus root, and read the resulting entry's `path` the same way ingest() does.

**Observed result:** collect() returned an entry {externalId: 'notes.md', path: <symlink path>} alongside readme.md; readFileSync on that entry's path (the exact call ingest() makes before calling client.documents.add) returned the dummy secret content of the file outside the corpus, 'TOP-SECRET-CONTENT-12345', confirming the symlink is followed and its external target's content is what would be uploaded. A control case in the same run confirmed collect() does not recurse into a symlinked directory at all (Dirent.isDirectory() is lstat-based and never true for a symlink), so the only mis-handling is a symlink masquerading as a leaf file, matching the claimed root cause exactly. Full output: agents/v24/artifacts/result.txt.

### Fix

In collect(), check entry.isSymbolicLink() and skip (or explicitly refuse) such entries before the isDirectory()/extension branches, rather than letting them fall through to the file branch solely because isDirectory() is false. Apply the same check in the --watch flush() handler (lstat the path before readFileSync), since it reads arbitrary paths reported by fs.watch with no symlink check either.

---

## classifyIngestFailure tests the 'unreadable' /parse/ alternative before 'answered 5\d\d', so every parser 5xx -- including the sidecar's own documented-retryable 503 busy reply -- is written to documents as a permanent failure on the first attempt

<a id="packages-core-ingest-failure-ts-classifyingestfailure-parser-busy-unreadable"></a>

**Severity: MEDIUM** (likelihood: medium — No privilege beyond ordinary ingest access is needed, and the triggering condition (the shared parser answering a non-2xx status, most directly its own documented 503 busy reply once PARSE_SLOTS=8 is exceeded, or any extraction that outlives the worker's 120 s abort) is a plausible, anticipated operating condition under scaled-out worker replicas or ordinary bulk/concurrent ingest rather than an exotic or adversarial one -- but it does require enough concurrency or an unusually slow extraction to actually produce a parser error in a given deployment, which is not guaranteed at low load with a single worker replica.; impact: medium — Documents that the system's own retry subsystem is explicitly designed to recover automatically are instead silently and permanently marked 'failed' on the first attempt, degrading search completeness for any affected tenant with no error surfaced beyond the stored row, and the operator-facing diagnostic (layer_status's recovers_by_itself) actively misreports the failure as non-recoverable. The parser is one shared sidecar serving every organization and the claim queue is a single cross-organization FIFO, so the effect is not confined to the tenant that caused the contention. Recovery is possible (POST /v1/documents/{id}/retry or a re-send) but requires a human or external process to notice and act; there is no data exposure or privilege change.) · confidence {'score': 'high', 'reason': "Every line in the trace was independently read and verified against the exact source at the commit under review, including two call sites (recordFailure and admin-services.ts's layer_status) that both depend on the same classifier with no intervening status-aware control anywhere in the pipeline. The decisive result was independently reproduced end to end -- both the classifier verdict and the resulting Postgres row state on a real PostgreSQL 17 with all 44 migrations applied -- using a test file written independently for this verification rather than reusing the hunter's artifact, and both runs passed exactly as predicted against a true-unavailable control that behaved correctly."}

**Fingerprint:** `packages/core/ingest-failure.ts:classifyIngestFailure:parser-busy-unreadable`

### Description

services/parser/app.py bounds concurrency with an 8-slot BoundedSemaphore (PARSE_SLOTS) and, when no slot frees within SLOT_WAIT_SECONDS, replies 503 {error: 'the parser is busy; try again'} -- a reply its own comment (app.py:75-80) says the worker should read as 'unavailable' and retry. HttpParser.parse (packages/worker/src/adapters.ts:605-630) builds the thrown error for EVERY non-ok parser response as `${reason} (parser answered ${status})`, so the literal word 'parser' is present in the text of every parser failure regardless of status code. main.ts wraps the whole parse/chunk/embed/store pipeline in one catch (main.ts:928-954) with no status-aware branch, and passes the error straight to recordFailure, which classifies String(error) with classifyIngestFailure. That classifier's ternary (ingest-failure.ts:85-96) tests /parse|unsupported|not a pdf|%pdf|decode|extract/ (line 90) before /econnrefused|...|answered 5\d\d|unavailable|network/ (line 92); 'parser' contains the substring 'parse', so the first alternative always wins. isRetryable (line 64-66) rejects 'unreadable', so recordFailure's single UPDATE (retry.ts:111-126) writes status='failed' and retry_after=NULL unconditionally on attempt 1 of NACRE_INDEX_MAX_ATTEMPTS -- the document is never requeued, and nothing else in the product retries a 'failed' row automatically. The same classifier is the sole input to the MCP admin tool's layer-health diagnostic (packages/mcp/src/admin-services.ts:517-528), so an operator asking whether a failed document 'recovers by itself' is told no for exactly the failure the parser's own code says should recover by itself. I independently reproduced both halves of this in the sandbox rather than relying on the hunter's artifact: classifyIngestFailure(), called directly on the exact wire text HttpParser.parse builds for the busy-503 ('the parser is busy; try again (parser answered 503)'), returns reason='unreadable'/retryable=false, against a control string for a true embedder outage ('the embedding endpoint answered 503: overloaded') which returns reason='unavailable'/retryable=true; and, against a real PostgreSQL 17 with all 44 migrations applied (no stubs), recordFailure() on attempt 1 of 5 writes documents.status='failed' with retry_after=NULL for the busy-503 text and documents.status='pending' with a non-null retry_after for the control text. The parser is a single sidecar shared by every organization and the worker's claim queue is one cross-organization FIFO served by strictly serial workers (claim.ts:72-104), so contention or an error on the shared parser -- whether from ordinary concurrent load exceeding 8 slots, from several worker replicas, or from an extraction that outlives the worker's 120 s abort while still holding its slot (the sidecar releases the slot only in a finally after its own call returns, app.py:520-523) -- converts what the system is explicitly designed to treat as a transient dependency blip into a silent, permanent per-document failure requiring manual operator action (POST /v1/documents/{id}/retry or a re-send) to recover, for any tenant whose document happened to be in flight.

### Root cause

classifyIngestFailure's regex cascade (packages/core/ingest-failure.ts:85-96) evaluates the 'unreadable' alternative, which matches the bare substring 'parse', strictly before the 'unavailable' alternative, which matches 'answered 5\d\d'. Because HttpParser.parse (packages/worker/src/adapters.ts:626-629) unconditionally appends the literal text '(parser answered ${status})' to the message of every non-2xx parser response -- independent of the actual HTTP status or of whether the sidecar itself intended the failure to be transient -- the word 'parser' (which contains 'parse') always satisfies the earlier alternative first. recordFailure (packages/worker/src/retry.ts:99-100, 111-126) has no other input: it classifies solely on String(error), so every parser-origin failure is classified 'unreadable' and isRetryable rejects it, regardless of whether the underlying HTTP status (e.g. the documented-retryable 503 busy reply) was meant to be retried.

### Intended behavior

Per classifyIngestFailure's own documentation and the parser's own code comment (app.py:75-80: '...is then answered 503, which the worker reads as unavailable and retries later rather than failing the document'), a transient failure of a dependency the deployment runs -- including a busy parser -- should classify as 'unavailable', which isRetryable accepts, so recordFailure's UPDATE sets status='pending' with a bounded, jittered retry_after rather than permanently failing the document on its first attempt.

### Trace

  - **entrypoint** — `services/parser/app.py:517` (Handler.do_POST)
    When no parse slot frees within SLOT_WAIT_SECONDS, the handler replies 503 {"error": "the parser is busy; try again"} (the reply itself is the following line, 518). Verified against source: this is the exact, only place that body is produced.
  - **propagation** — `packages/worker/src/adapters.ts:626` (HttpParser.parse)
    For any non-ok response, regardless of status, throws Error(`${reason} (parser answered ${status})`) when the sidecar supplied a JSON {error} body (as the busy reply does), so the thrown text always contains the literal word 'parser'. Confirmed against the real wire format with packages/worker/src/__tests__/parser-reason.test.ts, which drives this code against a real HTTP server.
  - **propagation** — `packages/worker/src/main.ts:944` (the ingest loop's single catch block)
    The only catch wrapping parse/chunk/embed/store branches on `error instanceof ClaimLost` and otherwise passes the error straight to recordFailure(pool, claim, error, config.indexMaxAttempts) with no status-code-aware handling anywhere upstream -- confirmed by reading the whole try/catch at main.ts:854-954.
  - **propagation** — `packages/worker/src/retry.ts:100` (recordFailure)
    const { reason } = classifyIngestFailure(String(error).slice(0, 500)) -- the sole classification input is the stringified error, confirmed exact at this line.
  - **propagation** — `packages/core/ingest-failure.ts:90` (classifyIngestFailure)
    /parse|unsupported|not a pdf|%pdf|decode|extract/.test(text) is evaluated before the 'answered 5\d\d' alternative at line 92 is ever reached, and matches because 'parser' contains 'parse'. Confirmed exact at this line against the live source.
  - **sink** — `packages/worker/src/retry.ts:113` (recordFailure's UPDATE statement)
    SET status = CASE WHEN $4 AND attempts < $5 THEN 'pending' ELSE 'failed' END ... retry_after = CASE WHEN $4 AND attempts < $5 THEN now()+make_interval(...) ELSE NULL END, where $4 = isRetryable('unreadable') = false. Independently reproduced against a real PostgreSQL 17 (44 migrations applied): the row ends up status='failed', retry_after=NULL on attempt 1 of 5 for the exact busy-503 text, versus status='pending' with a non-null retry_after for a true 'unavailable' control text. See agents/v26/artifacts/result.txt (vitest + migration log, 2/2 passed) and agents/v26/artifacts/result2.txt (verified source trace and summary).

### Evidence

  - `services/parser/app.py:79` — Comment states the 503 busy reply '...is then answered `503`, which the worker reads as `unavailable` and retries later rather than failing the document' -- the documented intent that the classifier's actual behaviour contradicts.
  - `packages/core/ingest-failure.ts:64` — isRetryable admits only 'unavailable' and 'internal'; 'unreadable' is rejected, so the misclassification at line 90 is decisive for whether the worker ever requeues the document.
  - `packages/core/ingest-failure.ts:92` — The 'answered 5\d\d' alternative that was evidently meant to catch exactly this kind of status-coded transient failure is unreachable for any parser-origin message, because the earlier 'parse' alternative at line 90 always matches first.
  - `packages/worker/src/adapters.ts:577` — The worker's own 120 s abort on the parser request. Documents that the sidecar is still extracting past this deadline are aborted on the worker's side while the sidecar's slot (app.py:520-523) is released only when its own call returns, not when the worker gives up -- a second, independent way for 8 slots to stay exhausted.
  - `packages/worker/src/claim.ts:102` — claimNext orders by d.created_at with no per-organization partitioning -- the parser is contended for across the whole installation's queue, not per tenant, so the shared-service argument for cross-tenant impact holds.
  - `packages/mcp/src/admin-services.ts:528` — recovers_by_itself: isRetryable(failure.reason) in the layer_status admin tool reuses the same classifier, so the operator-facing diagnostic for 'will this recover automatically' is also wrong for a busy-503 failure, in the exact tool CLAUDE.md documents as answering that question.

### Conditions

[{'kind': 'authorization_role', 'description': "Requires no elevated privilege: any principal holding ordinary ingest ('write') permission on a layer triggers the vulnerable code path when the shared parser answers any non-2xx status while that document is in flight."}, {'kind': 'environmental_dependency', 'description': "The parser must actually return a non-2xx HTTP response during processing. The documented route is PARSE_SLOTS=8 concurrent /parse requests exhausted across the installation's worker replicas (each worker is strictly serial, so this generally needs either multiple replicas or one slow extraction holding a slot past the worker's 120 s abort, per app.py:520-523 and adapters.ts:577); any other parser-returned 4xx/5xx reaches the same bug, since the '(parser answered NNN)' suffix is appended unconditionally."}, {'kind': 'timing_dependency', 'description': 'The permanent verdict is written on attempt 1 inside a single UPDATE with no intervening window in which a correct retry could occur -- the misclassification is deterministic and immediate, not a race.'}, {'kind': 'data_state', 'description': 'Applies uniformly regardless of document source type (inline, URL, S3, binary) once the content is routed through HttpParser.parse; no format-specific branch avoids it.'}]

### Reproduction

**Attacker/caller perspective:** No adversarial action is required beyond ordinary use of the ingest surface (REST JSON/multipart, MCP ingest_document/request_upload, or the CLI) by any principal holding write access to a layer. Simply ingesting documents while the installation's shared parser sidecar is at or past its concurrency bound (PARSE_SLOTS=8, reachable under normal scaled-out load, a bulk ingest, or one slow/large extraction that outlives the worker's 120 s abort) is sufficient to make the sidecar answer its own documented '503 busy' reply for some in-flight document, at which point that document -- and any other tenant's document being processed by the shared, serial worker pipeline at that moment -- is written to Postgres as permanently failed on the very first attempt instead of being retried.

**Payload(s):**
- `the parser is busy; try again (parser answered 503)`
- `the embedding endpoint answered 503: overloaded`

**Steps:**
1. Call classifyIngestFailure() directly (packages/core/ingest-failure.ts) on 'Error: the parser is busy; try again (parser answered 503)', on 'Error: the parser answered 503', and on the control 'Error: the embedding endpoint answered 503: overloaded'; compare .reason and isRetryable(.reason).
2. Against a real PostgreSQL 17 with all 44 migrations from packages/core/migrations applied via scripts/migrate.ts (no mocks, no stubbed classifier, no fixture written to match the code), insert an organization/workspace/provider/layer/document row in status='indexing' with attempts=1, then call recordFailure(pool, {orgId, documentId, attempts:1}, new Error('the parser is busy; try again (parser answered 503)'), 5) and re-select the row.
3. Repeat the same recordFailure call with new Error('the embedding endpoint answered 503: overloaded') as a control on a second document row.
4. Run via the audit sandbox: SA_TARGET=.../sa-targets/nacre tools/sandbox-run.sh v26 --secs 600 --postgres -e NACRE_PG_URL=postgres://postgres:dummy@pg:5432/postgres -- sh -c 'cd /scratch/src && node node_modules/tsx/dist/cli.mjs scripts/migrate.ts && node node_modules/vitest/vitest.mjs run --project unit packages/worker/src/__tests__/v26-busy-verify.test.ts' (test file written independently in this verification, not reused from the hunter).

**Observed result:** classifyIngestFailure returned reason='unreadable' (isRetryable=false) for both the busy-503-with-body and busy-503-no-body strings, and reason='unavailable' (isRetryable=true) for the embedder-503 control -- matching the claim exactly. Against the real PostgreSQL instance (44/44 migrations applied cleanly), recordFailure on attempt 1 of 5 wrote documents.status='failed' and documents.retry_after=NULL for the busy-503 document (never requeued), while the identical call for the control document wrote documents.status='pending' with a non-null, future documents.retry_after (correctly requeued with backoff). Both vitest assertions passed (2/2). Full output, including the 44-migration apply log and the vitest summary, is preserved at agents/v26/artifacts/result.txt; the verified source trace and summary are at agents/v26/artifacts/result2.txt.

### Fix

Stop relying purely on free-text wording for a signal that is already available as a structured HTTP status. Primary fix: have HttpParser.parse (packages/worker/src/adapters.ts) classify 503 responses from the parser as retryable directly from response.status, independent of the message text, before or instead of handing the string to classifyIngestFailure -- e.g. by throwing a distinguishable error (a subclass, or a message that unambiguously signals 'unavailable') for 503/5xx sidecar responses rather than relying on the generic '(parser answered NNN)' suffix to be read correctly downstream by a wording-based classifier. As a narrower, source-local fix with no interface change, reorder classifyIngestFailure's ternary so the 'answered 5\d\d|unavailable|...' alternative is tested before the 'parse|unsupported|...' alternative, so a transient-availability signal in the text takes priority over the generic 'parse' substring match; this fixes the busy-503 (and any other parser 5xx) case while leaving genuine 4xx sidecar refusals (e.g. 422 'not a PDF') classified 'unreadable' as before, since those never contain 'answered 5\d\d'. Either fix should be accompanied by a regression test pinning exactly the collision demonstrated here (the literal wire text HttpParser.parse builds for a parser 503), since the existing classifier suite (packages/core/__tests__/ingest-failure.test.ts) has no case for a transient parser failure at all.

`packages/core/ingest-failure.ts`:
```typescript
  const reason: IngestFailureReason =
    /must have less than \d+ tokens|too long|maximum (?:input )?length|context length/.test(text)
      ? 'too_long'
      : /quota|max_documents|limit reached|too many documents/.test(text)
        ? 'quota'
        // Availability signals (including the parser's own documented
        // 'answered 5\d\d' busy/transient replies) are tested before the
        // generic 'parse' wording match, because 'parser' always contains
        // 'parse' and would otherwise shadow every transient parser failure,
        // including the one the parser's own code explicitly intends to be
        // retried (services/parser/app.py's busy-503 comment).
        : /econnrefused|enotfound|etimedout|timeout|fetch failed|socket|answered 5\d\d|unavailable|network/.test(
              text,
            )
          ? 'unavailable'
          : /parse|unsupported|not a pdf|%pdf|decode|extract/.test(text)
            ? 'unreadable'
            : 'internal'

```

---

