# Audit events

The audit log is a product feature, not a debug log. "Show me which documents
your agent read last quarter" has to get a precise answer.

## What is recorded

**Always:** every search, with the `doc_id` list it returned; every access to a
document; every grant issued and revoked; every login and token issue; every
change to an organization's configuration; every reindex start; every denial.

**Never:** document contents, chunk text, and — with
`NACRE_AUDIT_QUERY_TEXT=false`, the default — full query text. A query hash is
stored instead. That is enough to investigate an incident and not enough to leak
through the journal itself.

## Schema

```jsonc
{
  "id": 8123412,
  "occurred_at": "2026-08-01T10:22:31.114Z",
  "org_id": "uuid",
  "actor": { "type": "service_account", "id": "uuid", "label": "svc-support-bot" },
  "surface": "mcp",                       // api | mcp | admin | system
  "client":  "claude-code/2.1",           // from the client's _meta
  "action":  "search",
  "target":  { "layers": ["contracts"], "returned_docs": ["uuid","uuid"], "top_k": 10 },
  "result":  "allow",                     // allow | deny | error
  "detail":  { "query_hash": "sha256:…", "latency_ms": 128, "acl_version": 42 },
  "request_id": "01JQ8…"
}
```

## Requirements

- **Written before the response goes out.** A lost event is worse than a slow
  response.
- **Append-only.** `UPDATE` and `DELETE` are revoked from the application role
  at the database level, not merely avoided in code.
- Retention is configurable, 400 days by default. Export as JSONL and CSV
  through `GET /v1/audit`.
- Optional SIEM export: syslog or webhook.
- `org_admin` sees only its own organization. `platform_admin` sees
  administrative operations but **not** records of substantive document access
  in another organization — the same separation as rule 2 in
  [authz.md](./authz.md).

## Denials are events too

`result: "deny"` is the most useful line in the file and the easiest to forget
to write, because the code path that produces it is an early return. Every
denial gets an event, including the ones that come out as `404` on the wire.

## What is written today

Every event carries `surface` (`api` or `mcp`, from the transport that made the
call) and a `target` naming what it was about. Search records the document ids
and layers it returned, so the question this document opens with — *which
documents did your agent read last quarter* — has an answer.

Both were literals in the insert statement until recently: `'api'` and an empty
object, which meant every MCP call was logged as REST and the `gin (target)`
index built for this indexed nothing.

**Retention is not enforced.** `NACRE_AUDIT_RETENTION_DAYS` is validated at
startup and read by nothing, and it cannot be implemented by the application
role: migration `0002` revokes `DELETE` on `audit_events` from `nacre_app`
deliberately, so a pruning job has to run as the owner. That is a decision
still to be made rather than a line still to be written.

`GET /v1/audit` is not implemented — events are written and there is no way to
read them back over the API yet.
