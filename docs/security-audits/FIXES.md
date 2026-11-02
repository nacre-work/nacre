# Fix tracker

Which commit (or pull request, until one merges) closed each finding a security
audit confirmed. One row per finding, one audit per dated folder under
`docs/security-audits/`.

**Commit hashes are final only once the pull request that carries them has
merged into `main`.** Until then the row names the pull request, because a
hash on an open branch can still move (a rebase, a force-push, a fixup) in a
way a merge commit on `main` never does. Once a row's PR merges, replace its
`see PR #N` with the merge commit's hash — not the hash of any commit on the
now-deleted branch, which this table never cites once a fix has landed on
`main`.

**This report lands with the release that ships the fixes, not before.** The
audit ran against commit `f1806fef282e1e8e3f316a8ebc5e3c3c00ec8a84`; all 19
findings were fixed and merged (squash) as
`60c6e6239323c5b489858ba320de35eaaac62261` on `main` before this report and
this table were added, in the same pull request that bumps the version these
fixes ship in — a public report naming unfixed holes in a running product is
worse than no report.

## 2026-11-01 — `nacre-run-1`

Full report: [`2026-11-01/REPORT.md`](./2026-11-01/REPORT.md). Full technical
detail: [`2026-11-01/FINDINGS-DETAIL.md`](./2026-11-01/FINDINGS-DETAIL.md).
Nine `needs_validation` leads and two rejected candidates that did not become
findings: [`2026-11-01/NEEDS-VALIDATION.md`](./2026-11-01/NEEDS-VALIDATION.md).

| Fingerprint | Severity | Fix commit | PR | Date fixed |
|---|---|---|---|---|
| `packages/core/config.ts:loadJwtKeys:published-example-secret-accepted` | HIGH | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/core/skill.ts:readSkillZip:overlapping-compressed-input-before-authz` | HIGH | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `api/oauth-consent/agent-visibility-via-unfiltered-service-account-list` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `api/oauth-refresh/service-account-revocation-not-rechecked` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/server.ts:oauth-register:unbounded-redirect-uris` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/source.ts:clientSource:trust-proxy-default-behind-shipped-front-door` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` (narrow fix only — see below) | #307 | 2026-11-02 |
| `packages/cli/src/commands.ts:collect:follows-symlinks-out-of-tree` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/core/ingest-failure.ts:classifyIngestFailure:parser-busy-unreadable` | MEDIUM | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `api/users-password-reset/sessions-not-invalidated` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `nacre/api/anonymous-login-recovery-fanout-per-organization` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` (capped, not redesigned — see below) | #307 | 2026-11-02 |
| `nacre/core/vector/collection-name-collision:copy-target-deletes-and-provisioning-adopts-foreign-collection` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `nginx-prefix-backslash-dotsegment-reaches-api-metrics` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/adapters.ts:NacreIngest.writableLayer:layer-delete-race` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/adapters.ts:PostgresWorkspaces.list:delegation-narrowing-not-applied` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/adapters.ts:layer-document-count-includes-denied-documents` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/idempotency.ts:CREDENTIAL_FIELDS:enrolment-challenge` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/principals.ts:PostgresUsers.update:last-admin-count-write-skew` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/server.ts:oauth-consent:metadata-client-cache-freshness` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |
| `packages/api/src/server.ts:oauth-consents-list-and-revoke-accept-delegated-token` | LOW | `60c6e6239323c5b489858ba320de35eaaac62261` | #307 | 2026-11-02 |

All 19 findings closed in [pull request #307](https://github.com/nacre-work/nacre/pull/307),
each as its own commit before the squash — see the PR description for the
per-finding breakdown that existed before it.

### Two findings with a narrower outcome than the audit's own remediation

- **`trust-proxy-default-behind-shipped-front-door`.** The audit's full
  remediation asked for two changes: fix `admitClientRegistration`'s `??
  'unknown'` fallback (a real code defect, fixed in #307), and separately raise
  `NACRE_TRUST_PROXY`'s shipped default and stop publishing the API/MCP ports
  directly — a topology change, not a bug, and one `docker-compose.yml`
  documents at length as deliberate (those ports carry the MCP transport's own
  RFC 9728 discovery). Only the first half is fixed. The second is an open
  architectural question, not a confirmed-and-unfixed vulnerability: closing
  it needs a human call on whether the shipped Compose topology should change,
  and is tracked separately from this finding rather than left silently
  "fixed."
- **`anonymous-login-recovery-fanout-per-organization`.** The audit's own fix
  offered two options: resolve an unscoped email in one bounded lookup instead
  of one transaction per organization, or — "if the per-organization loop is
  kept" — cap how many organizations one unauthenticated request may scan.
  #307 takes the second: `Login.find` and `PasswordRecovery.findUser`'s loop is
  capped at `MAX_UNSCOPED_ORG_SCAN` (500), which bounds the worst case without
  touching the lookup's shape. Both functions sit outside `packages/core/authz`
  (confirmed by the PR's own diff), so the two-maintainer rule for that
  directory did not gate this fix; a redesign to the single-lookup form, if
  ever wanted, is a separate and larger change.

### What else changed in #307

A `lint:tenant-scope` exemption for `assertCollectionUnclaimed`'s deliberately
cross-organization `retired_collections` lookup (part of the collision fix
above), and the CI fixes `docs/upgrading.md`'s own `0.41.2` section lists under
"what changed underneath."
