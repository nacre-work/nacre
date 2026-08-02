---
name: audit-event
description: Use when adding or changing an audit event, the audit log schema, SIEM export, or anything writing to audit_events. Also use when adding a code path that grants or denies access, since denials are events. Triggers on "audit", "audit log", "audit_events", "SIEM", "journal", "access log", "who read what".
---

# Adding an audit event

Contract: `docs/audit.md`. The audit log is a product feature, not a debug log —
"show me which documents your agent read last quarter" has to get a precise
answer, which means completeness matters more than volume.

## Always recorded

Every search with the `doc_id` list it returned; every document access; every
grant issued and revoked; every login and token issue; every organization
configuration change; every reindex start; **every denial**.

Denials are the most useful lines in the file and the easiest to miss, because
the code path producing one is usually an early return. If you add a branch that
refuses access — including one that surfaces as `404` on the wire — it writes an
event with `result: "deny"`.

## Never recorded

Document contents. Chunk text. Full query text unless
`NACRE_AUDIT_QUERY_TEXT=true`; the default stores `query_hash` instead, which is
enough to investigate an incident and not enough to leak through the journal.

An audit log that leaks what it is auditing is worse than none, because it is
retained for 400 days by default and exported to a SIEM.

## Shape

```jsonc
{
  "org_id": "uuid",
  "actor": { "type": "service_account", "id": "uuid", "label": "svc-support-bot" },
  "surface": "mcp",              // api | mcp | admin | system
  "client":  "claude-code/2.1",  // from the client's _meta
  "action":  "search",
  "target":  { "layers": ["contracts"], "returned_docs": ["uuid"], "top_k": 10 },
  "result":  "allow",            // allow | deny | error
  "detail":  { "query_hash": "sha256:…", "latency_ms": 128, "acl_version": 42 },
  "request_id": "01JQ8…"
}
```

`request_id` is mandatory and matches the field in the HTTP error body and the
OpenTelemetry trace. That correspondence is the whole investigative story; an
event without it is close to useless.

## Ordering

**Write the event before the response goes out.** A lost event is worse than a
slow response. Do not move the write into a fire-and-forget background task to
save latency — if that is genuinely needed, it needs a durable queue and a
discussion, not a `void promise`.

## Visibility

`org_admin` sees only its own organization. `platform_admin` sees administrative
operations but **not** records of substantive document access in another
organization — the same separation as rule 2 in `docs/authz.md`. A query that
filters the audit log needs the same care as one that filters documents.

## Storage

The table is append-only: `UPDATE` and `DELETE` are revoked from the application
role at the database level. If a change seems to need mutating an event, it
needs a new event instead.

## A new action reaches `/v1/audit`

`GET /v1/audit` shows `platform_admin` administrative actions only, never the
record of who read what — rule 2 applied to the journal. The set of actions
counted as document access is a deny-list in
`PostgresAuditReader.DOCUMENT_ACCESS`.

**If the action you are adding records a substantive access to a document's
contents, add it to that list.** Left out, it is visible to a platform
administrator, which is the disclosure that rule exists to prevent.

The list is a deny-list on purpose: an allow-list would make a new
*administrative* action invisible to the operator who administers the
installation until someone remembered it, which is a silent gap in an
operational tool. This way the gap is a disclosure to an already highly
privileged role, and it is loud enough to be found. Both directions are bugs;
this is the one that gets noticed.
