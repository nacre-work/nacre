/**
 * The names the access log records, for a client that has to offer them.
 *
 * `GET /v1/audit?action=` is an exact match, so a person filtering the log needs
 * the names as they are recorded — the console offers these in its Action box,
 * and nothing else in the product would tell them.
 *
 * **A copy, and deliberately one.** The source is `packages/core/audit-actions.ts`,
 * which the writers and the reader use; this package has no dependencies and a
 * browser bundle cannot import the core, so the list is repeated here and
 * `lint:audit-actions` holds the two line for line. Changing one without the
 * other fails there.
 *
 * Not every recorded action is here, and a caller should still accept free
 * text: a request that fails with a 500 is recorded under its path, and a
 * commercial module records names of its own.
 */
export interface AuditActionInfo {
  readonly name: string
  /** Withheld from a `platform_admin`'s log — a substantive access to a document. */
  readonly documentAccess: boolean
  readonly summary: string
}

export const AUDIT_ACTIONS: readonly AuditActionInfo[] = [
  { name: 'add_group_member', documentAccess: false, summary: 'A principal was added to a group' },
  { name: 'administer_principals', documentAccess: false, summary: 'Someone who is not an org_admin asked for users or groups' },
  { name: 'admin.delete', documentAccess: false, summary: 'A module route under /v1/admin, DELETE' },
  { name: 'admin.get', documentAccess: false, summary: 'A module route under /v1/admin, GET' },
  { name: 'admin.patch', documentAccess: false, summary: 'A module route under /v1/admin, PATCH' },
  { name: 'admin.post', documentAccess: false, summary: 'A module route under /v1/admin, POST' },
  { name: 'admin.put', documentAccess: false, summary: 'A module route under /v1/admin, PUT' },
  { name: 'audit.read', documentAccess: false, summary: 'The access log was read' },
  { name: 'create_group', documentAccess: false, summary: 'A group was created' },
  { name: 'create_layer', documentAccess: false, summary: 'A layer was created' },
  { name: 'create_service_account', documentAccess: false, summary: 'A service account was created' },
  { name: 'create_user', documentAccess: false, summary: 'A user was created' },
  { name: 'create_workspace', documentAccess: false, summary: 'A workspace was created' },
  { name: 'delete_document', documentAccess: false, summary: 'A document was deleted' },
  { name: 'delete_group', documentAccess: false, summary: 'A group was deleted' },
  { name: 'delete_layer', documentAccess: false, summary: 'A layer and its documents were deleted' },
  { name: 'disable_user', documentAccess: false, summary: 'A user was disabled' },
  { name: 'embedding_provider.create', documentAccess: false, summary: 'An embedding provider was added' },
  { name: 'embedding_provider.delete', documentAccess: false, summary: 'An embedding provider was removed' },
  { name: 'get_document', documentAccess: true, summary: 'A document was fetched' },
  { name: 'ingest', documentAccess: false, summary: 'A document was ingested' },
  { name: 'issue_grant', documentAccess: false, summary: 'A grant was issued' },
  { name: 'layer.reindex', documentAccess: false, summary: 'A layer was moved onto another embedding model' },
  { name: 'login', documentAccess: false, summary: 'A person signed in' },
  { name: 'oauth.consent', documentAccess: false, summary: 'An application was approved' },
  { name: 'oauth.revoke', documentAccess: false, summary: 'A connected application was forgotten' },
  { name: 'password.change', documentAccess: false, summary: 'A person changed their own password' },
  { name: 'rate_limited', documentAccess: false, summary: 'A request was refused by the rate limiter' },
  { name: 'reference_queries.replace', documentAccess: false, summary: "A layer's reference queries were replaced" },
  { name: 'remove_group_member', documentAccess: false, summary: 'A principal was removed from a group' },
  { name: 'reset_password', documentAccess: false, summary: "An administrator reset someone's password" },
  { name: 'retry_document', documentAccess: false, summary: 'A failed document was queued again' },
  { name: 'revoke_grant', documentAccess: false, summary: 'A grant was revoked' },
  { name: 'revoke_service_account', documentAccess: false, summary: 'A service account was revoked' },
  { name: 'search', documentAccess: true, summary: 'A search was run' },
  { name: 'second_factor.enrol', documentAccess: false, summary: 'A second factor was enrolled' },
  { name: 'second_factor.remove', documentAccess: false, summary: 'A second factor was removed' },
  { name: 'tenant_override_attempt', documentAccess: false, summary: 'A request tried to name another organization' },
  { name: 'update_layer', documentAccess: false, summary: 'A layer was renamed' },
  { name: 'update_metadata', documentAccess: false, summary: "A document's tags were changed" },
  { name: 'update_user', documentAccess: false, summary: 'A user was changed — role, or enabled again' },
]
