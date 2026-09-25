/**
 * Every action the journal records, by the name it is recorded under.
 *
 * ## Why there is a list at all
 *
 * `GET /v1/audit?action=` is an exact match, and the only way to learn the
 * names was to read `server.ts`. The console's Action box said `grant.issue`
 * as its example — a name nothing has ever written; the handler records
 * `issue_grant` — and the screenshot fixture carried `grant.issue`,
 * `document.read` and `document.ingest`, three more names nothing writes. A
 * filter on any of them is an empty log, which on that screen reads as "nothing
 * happened" rather than as "you spelled it wrong".
 *
 * The same drift had a worse consequence one file over.
 * `PostgresAuditReader.DOCUMENT_ACCESS` — the deny-list that keeps a
 * `platform_admin` from being shown who read what — named `document.get`,
 * `document.read` and `chunk.read`, while the REST route and the MCP tool both
 * record a document fetch as `get_document`. So every document fetch was on a
 * platform administrator's log, which is rule 2 in `docs/authz.md` failing
 * through the record that exists to prove it held. A property in three places —
 * the writers, the reader's list and the screen — with nothing that knew there
 * were three.
 *
 * So this is the one list, and `lint:audit-actions` holds it in both
 * directions: every literal `action:` a writer in `packages/api`,
 * `packages/mcp`, `packages/worker` or here records is on it, every entry on it
 * is recorded somewhere, and the SDK's copy — which is what the console and the
 * CLI can reach, since neither may import this package — is the same list.
 *
 * ## What is not on it, and why
 *
 * A request that fails with a 500 is recorded under its **path** as the action
 * (`server.ts`, the error boundary), because the handler that failed is the one
 * fact worth keeping and there is no name to give it. Those are unbounded and
 * are deliberately not enumerated; the console's field still takes free text.
 *
 * Actions a commercial module records are that module's. The core does not
 * know them and must not: the boundary job fails if it did.
 *
 * ## `documentAccess`
 *
 * True for an action that records a substantive access to a document's
 * contents. Those are withheld from `platform_admin` — see
 * `DOCUMENT_ACCESS_ACTIONS` below, which the reader uses rather than a list of
 * its own. Still a deny-list in effect, for the reason `docs/audit.md` gives:
 * a new action added here with `documentAccess: false` is visible to a platform
 * administrator, which is loud; an allow-list would make a new administrative
 * action silently invisible to the operator.
 *
 * One entry per line and nothing computed, because the check reads this file
 * and the SDK's copy as text rather than importing either.
 */
export interface AuditActionInfo {
  readonly name: string
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

/**
 * The actions a `platform_admin` is never shown.
 *
 * Derived rather than written, so the reader cannot name an action nobody
 * records while missing the one somebody does — which is the defect this file
 * was written against.
 */
export const DOCUMENT_ACCESS_ACTIONS: readonly string[] = AUDIT_ACTIONS.filter((a) => a.documentAccess).map(
  (a) => a.name,
)
