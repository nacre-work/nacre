---
name: db-migration
description: Use when changing the PostgreSQL schema, adding a migration under packages/core/migrations, or touching row-level security, the grants table, tombstones, or the audit table. Triggers on "migration", "schema", "DDL", "RLS", "row level security", "ALTER TABLE", "new column", "index" in a database context.
---

# Changing the schema

Migrations live in `packages/core/migrations`, numbered and **forward-only**.
Never edit a migration that has been applied anywhere; add another.

The schema is the source of truth for tenants, permissions, metadata, and audit.
Vectors are in Qdrant and originals in S3 — if a change would put content that
needs a transaction into either of those, it belongs here instead.

## Every table carrying tenant data

1. **`org_id NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`**, even
   when it is reachable through a parent. The duplication is the point: it lets
   RLS work on the table directly.
2. **Enable RLS and add the `org_isolation` policy** in the same migration as
   the table:
   ```sql
   ALTER TABLE thing ENABLE ROW LEVEL SECURITY;
   CREATE POLICY org_isolation ON thing
     USING (org_id = current_setting('app.current_org')::uuid);
   ```
   RLS is the second line of defense, not the mechanism. The application still
   filters, and invariant 1 is still verified again at serialization. A table
   added without RLS is one forgotten `WHERE` away from a cross-tenant leak.
3. **Indexes that the permission filter needs.** A filter that falls back to a
   scan does not fail a test; it just gets slow enough to matter at a customer's
   volume, which is the worst way to find out.

## Deletion is a tombstone

`deleted_at` is set immediately; physical removal is a background job. Anything
reading documents filters `deleted_at IS NULL`, and the vector payload gets
`deleted: true` in the same queue transaction.

Depending on GC timing is how invariant 5 gets broken. There is a real window
between the delete and the sweep, and the query must be correct inside it.

## The audit table is append-only

`UPDATE` and `DELETE` are **revoked from the application role at the database
level**, not merely avoided in application code. A migration that adds a column
to `audit_events` must not quietly restore write privileges.

## The background worker role

Worker jobs run under a separate role with `BYPASSRLS` and are required to name
`org_id` explicitly in every query. That role is the one place the second line
of defense is off, so changes touching it get the most review.

## Checklist

- [ ] Forward-only; no edit to an applied migration
- [ ] `org_id` present on any table with tenant data
- [ ] RLS enabled and the policy created in the same migration
- [ ] Indexes for whatever the permission filter will use
- [ ] Tombstone semantics preserved for anything document-shaped
- [ ] `docs/architecture.md` updated if the shape changed
- [ ] Comments in English, like the rest of the repository
