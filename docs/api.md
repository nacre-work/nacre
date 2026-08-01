# REST API

Base path `/v1`. The organization comes from the token — never from a request
body, a path, or a header.

## Endpoints

```
POST   /v1/documents                 ingest (multipart | json)
GET    /v1/documents/{id}
PATCH  /v1/documents/{id}            metadata
DELETE /v1/documents/{id}            tombstone
POST   /v1/search
GET    /v1/layers        POST /v1/layers        PATCH /v1/layers/{id}
POST   /v1/layers/{id}/reindex
GET    /v1/workspaces    POST /v1/workspaces
GET    /v1/grants        POST /v1/grants        DELETE /v1/grants/{id}
GET    /v1/jobs/{id}
GET    /v1/audit
GET    /v1/health        /v1/ready               /metrics
```

## Errors — RFC 9457 (`application/problem+json`)

```jsonc
{
  "type":   "https://nacre.work/errors/layer-not-found",
  "title":  "Layer not found",
  "status": 404,
  "detail": "Layer contracts does not exist or is not accessible",
  "instance": "/v1/search",
  "request_id": "01JQ8…"
}
```

- `detail` never reveals the existence of an inaccessible object. **No
  permission and no such object produce the same response**, down to the
  wording. That is invariant I6; a different message is the leak.
- No stack traces, no internal service names.
- `request_id` is always present and matches the field in the audit log.

| Code | When |
|---|---|
| 400 | schema violation |
| 401 | missing or expired token |
| 403 | authenticated, and the operation is explicitly forbidden on a **visible** object |
| 404 | the object is absent **or invisible** |
| 409 | version conflict |
| 413 | document over the size limit |
| 422 | document could not be parsed |
| 429 | rate limited |
| 503 | indexing unavailable |

The 403/404 split is the whole point: 403 says "this exists and you may not
touch it", so it may only be used where the caller can already see the object.

## Idempotency

- `POST /v1/documents` is idempotent on `(layer, external_id)` plus
  `content_hash`. A repeat with identical content returns `200` and the existing
  `document_id` without creating a version.
- Every other unsafe method accepts an `Idempotency-Key` header; the result is
  cached for 24 hours.

## Pagination

Cursor-based, never offset. `?limit=50&cursor=…`, response
`{ items, next_cursor }`, `limit` capped at 200.

Offset is forbidden: it breaks under concurrent inserts and it invites
enumeration.

## Asynchrony

Ingest returns `202` with a `job_id`. Status at `GET /v1/jobs/{id}`:
`queued | parsing | embedding | indexed | failed`, with progress and an error
message. An HMAC-signed completion webhook is optional.

## Limits

Counted per organization, not per token — per-token limits are bypassed by
issuing more keys.

| Resource | Default |
|---|---|
| search | 60 requests/min |
| ingest | 600 documents/hour |
| document size | 50 MB |
| vectors per organization | from `organizations.quotas` |

A `429` carries `Retry-After` and the `RateLimit-*` headers (RFC 9331).

## Versioning

Major version in the path. Breaking changes only with `/v1` → `/v2` and at least
12 months of parallel operation, mirroring the MCP deprecation policy.

## Current state

Nothing in `packages/api` is implemented. The OpenAPI document at
[`openapi.yaml`](./openapi.yaml) is the contract and is validated in CI; it is
ahead of the code on purpose.
