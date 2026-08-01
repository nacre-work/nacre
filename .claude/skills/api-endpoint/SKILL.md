---
name: api-endpoint
description: Use when adding or changing a REST endpoint, an error response, pagination, idempotency, or rate limiting in packages/api, or when editing docs/openapi.yaml. Triggers on "endpoint", "REST", "OpenAPI", "problem+json", "RFC 9457", "cursor pagination", "Idempotency-Key", "rate limit", "status code", "429", "403 vs 404".
---

# Adding or changing a REST endpoint

Contract: `docs/api.md`, machine-readable in `docs/openapi.yaml`. The OpenAPI
document is linted in CI (`pnpm lint:openapi`) and runs ahead of the code on
purpose — update it in the same PR, not afterwards.

## Status codes

The 403/404 split is the whole point and the easiest thing to get wrong:

- **`403`** only when the caller is authenticated **and** the object is already
  **visible** to them, and the *operation* is forbidden.
- **`404`** when the object is absent **or invisible**. Same status, same body,
  same wording for both. Any difference lets someone enumerate identifiers to
  discover which documents exist — that is invariant 4.

The rest: `400` schema, `401` missing or expired token, `409` version conflict,
`413` over `NACRE_MAX_DOCUMENT_BYTES`, `422` unparseable, `429` rate limited,
`503` indexing unavailable.

## Error bodies — RFC 9457

`application/problem+json`, with `type`, `title`, `status`, `detail`,
`instance`, `request_id`.

- `detail` never reveals that an inaccessible object exists.
- No stack traces, no internal service or host names.
- `request_id` is always present and matches the audit log field. That
  correspondence is what makes an auditor's question answerable, so a
  code path that omits it is a real defect.

## Pagination

Cursor-based. `?limit=50&cursor=…` → `{ items, next_cursor }`, `limit` capped at
200. **Offset is forbidden** — it breaks under concurrent inserts and invites
enumeration. A PR adding `?offset=` should be rejected on both grounds.

## Idempotency

- `POST /v1/documents` is idempotent on `(layer, external_id)` plus
  `content_hash`. A repeat with identical content returns `200` and the existing
  `document_id` without creating a version.
- Every other unsafe method accepts `Idempotency-Key`, cached 24 hours.

## Limits

Counted **per organization**, not per token. Per-token limits are bypassed by
issuing another key. `429` carries `Retry-After` and `RateLimit-*` (RFC 9331).

## Always

- The organization comes from the token. Never a body field, path segment, or
  header — not even as an optional override for admins.
- Ingest is asynchronous: `202` plus `job_id`, status at `GET /v1/jobs/{id}`.
- Anything returning documents goes through the authorization service and gets
  a pre-filter, not a post-filter. See the `authz-change` skill if you are
  touching that path.

## Versioning

Major version in the path. Breaking changes only at `/v1` → `/v2`, with at least
12 months running in parallel. Adding a required request field or removing a
response field is a breaking change; be honest about which one you are making.
