# Audit events

The audit log is a product feature, not a debug log. "Show me which documents
your agent read last quarter" has to get a precise answer.

## What is recorded

**Always:** every search, with the `doc_id` list it returned; every access to a
document; every grant issued and revoked; every login and token issue; every
change to an organization's configuration; every reindex start; every denial.

**Never:** document contents, chunk text, and — with
`NACRE_AUDIT_QUERY_TEXT=false`, the default — full query text. A query hash is
stored instead: `detail.query_hash`, `sha256:` and hex, the same shape as
`documents.content_hash`. That is enough to investigate an incident — *did this
agent run this query, and how often* is a comparison of hashes — and not enough
to leak what was searched for through the journal itself.

With the flag on, `detail.query` carries the text as well. The hash is written
either way and is always of the whole query, so an installation that turns the
flag on can still compare its new records against its old ones. A stored query
is truncated at 1024 characters; the hash is not.

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

**And `target` was true of the document paths only.** Ingest, delete, the layer
operations and `audit.read` filled it; every administrative event —
`create_user`, `disable_user`, `reset_password`, `create_group`,
`add_group_member`, `create_service_account`, `revoke_service_account`,
`issue_grant` and the rest — put the object in `detail` and left `target` empty.
Twenty-three call sites out of thirty-five. So the log recorded *that* an
administrator reset a password and never *whose*, in the field this document
names and the index covers.

Nothing could have failed: each handler is individually correct, the column has
a default, and an empty object is not an error at any layer. It was found by
reading the log through `nacre audit` against a running installation.

The rule is the one sentence above — **`target` is what the call was about,
`detail` is everything else** — and `lint:audit-target` holds every call site to
it, refusing an absent target and an empty one alike.

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

## Reading it back

`GET /v1/audit` is implemented. Newest first, cursor-paged, and available as
JSON, JSONL or CSV by content negotiation rather than a `format` parameter —
the difference between them is representation, not resource.

Filters: `from`, `to`, `actor_id`, `action`, `result`. All five are applied. A
malformed one is refused with `400` rather than dropped, and a range with `from`
at or after `to` is refused rather than returning nothing: on a compliance query
"no events happened" and "you asked for an impossible range" are opposite
answers, and an audit filter that silently does nothing is worse than a search
filter that does, because the person running it will believe the result.

JSON carries `next_cursor` in the body. JSONL and CSV carry it in a
`Link: rel="next"` header, because an export streaming to a file has nowhere to
put a footer and no consumer should have to know to strip one.

**The two roles see two different logs.** `org_admin` administers the tenant and
sees its log in full, including which documents were read — the question this
document opens with. `platform_admin` administers the *installation* and is
shown administrative actions only, never the record of who read what. That is
rule 2 in [authz.md](./authz.md) applied to the journal: a platform
administrator able to read every tenant's document-access log has exactly the
access the permission model spends its whole effort denying, obtained through
the record that exists to prove they did not have it.

It is not a request parameter. A caller cannot widen their own view by omitting
one, which is the shape the bug would take if it were.

On a single-organization community install the two roles sit in the same
organization and the distinction reads as odd. It is there for the
multi-tenancy module, which inherits this endpoint and where a platform
administrator spans tenants.

The set of actions treated as document access is a **deny-list**, in
`PostgresAuditReader.DOCUMENT_ACCESS`. That is the uncomfortable direction — a
new action defaults to visible to a platform administrator rather than hidden —
and it is chosen because the alternative fails worse. An allow-list of
administrative actions means a new administrative action is invisible to the
operator who administers the installation until someone remembers to add it: a
silent gap in an operational tool. This way a new *access* action is visible
until someone adds it, which is a disclosure to an already highly-privileged
role within one installation. Both are bugs; only one of them is quiet. Adding
an action means updating that list, which the `audit-event` checklist says.

Reading the log is itself recorded, as `audit.read`. It is the one action where
leaving that out would be self-serving.

A member gets `404`, not `403` — invariant 4 reserves `403` for an operation
forbidden on an object the caller can already see, and whether an organization
keeps an audit log is not something a member is told. A method other than `GET`
answers the same way: the append-only guarantee is not something to advertise a
method for and then refuse.
