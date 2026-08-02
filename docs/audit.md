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

**Retention is enforced**, and the decision that was open is made. The worker
prunes hourly in bounded batches, and `NACRE_AUDIT_RETENTION_DAYS` is what it
prunes against.

`DELETE` on `audit_events` stays revoked from `nacre_app` and from
`nacre_worker` — migration `0002` did that deliberately and `0012` does not
undo it. Pruning goes through a `SECURITY DEFINER` function instead, and the
reason that is compatible with append-only rather than a hole in it is worth
stating, because it is the whole argument:

**Append-only protects against history being rewritten** — a specific
inconvenient event erased, a `deny` flipped to an `allow`. Expiring everything
older than a published horizon is the opposite operation. It is indiscriminate
by construction, it is declared in the configuration, and an auditor can compute
exactly which window survives.

So the function is built so that indiscriminate expiry is the *only* thing it
can do. It takes a number of days and never a predicate, so no caller can name a
row, an actor, an organization or a result. It refuses a retention under 30
days, which the startup check refuses too, so it cannot become "delete this
morning". It deletes at most `max_rows` per call and returns the count.

Those properties hold whoever calls it, which matters: `nacre_app` inherits
`nacre_worker` and can therefore reach the function. The `EXECUTE` grant states
intent and keeps third parties out; it is not what makes this safe. The shape of
the function is.

`GET /v1/audit` is not implemented — events are written and there is no way to
read them back over the API yet.
