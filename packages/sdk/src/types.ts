/**
 * The wire types, in the SDK's naming.
 *
 * The API speaks snake_case and this speaks camelCase; the mapping happens in
 * one place, in `client.ts`, so a rename on the wire is one edit rather than a
 * search. Nothing here carries an organization — see the note on ClientOptions.
 */

export type Permission = 'read' | 'write' | 'admin'
export type PrincipalType = 'user' | 'group' | 'service_account'
export type ScopeType = 'workspace' | 'layer' | 'document'
export type Effect = 'allow' | 'deny'
export type JobStatus = 'pending' | 'parsing' | 'indexing' | 'indexed' | 'failed'

export interface SearchHit {
  readonly documentId: string
  readonly chunkId: string
  readonly score: number
  readonly text: string
  readonly layer: string
  readonly title: string | null
}

export interface SearchOptions {
  /**
   * How many results to return. Passed through uncorrected — the filter runs
   * inside the index traversal, so this many *permitted* results come back.
   * There is no over-fetch to compensate for, and asking for one would be the
   * post-filter invariant I2 is written against.
   */
  readonly topK?: number
  /**
   * Layer slugs to restrict the search to.
   *
   * Narrowing only. A layer you cannot read contributes nothing whether or not
   * you name it, and naming one that does not exist is the same answer as
   * naming one you cannot see — which is invariant I4 applied to a parameter.
   */
  readonly layers?: readonly string[]
  /**
   * Document metadata to restrict to, key to value.
   *
   * Equality; a list means any of those values. Narrowing only, like `layers` —
   * a filter can never reach a document you could not already read.
   */
  readonly filters?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
  /** `false` omits the chunk text, leaving ids and scores. */
  readonly includeContent?: boolean
  /** `false` answers in fusion order. A deployment with no reranker is already there. */
  readonly rerank?: boolean
  readonly signal?: AbortSignal
}

export interface IngestRequest {
  readonly layer: string
  /**
   * The caller's own identifier for the document. Ingest is idempotent on
   * `(layer, externalId)` plus the content hash, so re-sending unchanged bytes
   * costs nothing and does not create a version.
   */
  readonly externalId: string
  readonly title?: string
  readonly content?: string
  readonly url?: string
  /**
   * Tags the document is filterable by, key to value.
   *
   * Keys are lower case letters, digits and underscores. Values are strings,
   * numbers, booleans, or lists of those — nested objects are refused rather
   * than flattened. Sending it through ingest re-indexes the document, because
   * ingest re-parses and re-embeds; `documents.setMetadata` changes the tags
   * alone and touches no vector.
   */
  readonly metadata?: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
}

export interface IngestOutcome {
  readonly documentId: string
  readonly jobId: string
  /** `true` when the content was already indexed and nothing was queued. */
  readonly unchanged: boolean
}

export interface Document {
  readonly documentId: string
  /** The id you ingested it under, or `null` if you ingested it without one. */
  readonly externalId: string | null
  readonly layer: string
  readonly title: string | null
  readonly status: JobStatus
  readonly chunkCount: number
  readonly updatedAt: string
}

export interface Job {
  readonly jobId: string
  readonly documentId: string
  readonly status: JobStatus
  readonly error: string | null
}

export interface Layer {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly description: string
  readonly documentCount: number
  /**
   * Live documents in the layer that indexing failed on.
   *
   * Beside the count rather than folded into it: rows are the right definition
   * of "documents in this layer" — counting only indexed ones would swing while
   * the worker catches up — and `failed` is the one status that waits for a
   * person rather than resolving itself. A layer with documents and every one
   * of them failed answers every search with nothing, and looked identical to a
   * healthy one until this existed.
   */
  readonly failedCount: number
}

export interface Workspace {
  readonly id: string
  readonly slug: string
  readonly name: string
  /** Live layers in it, not layers you may read — a per-caller count would leak grants. */
  readonly layerCount: number
  /**
   * What *this* caller holds on this workspace, resolved for this request.
   *
   * Per-caller on purpose, which `layerCount` deliberately is not. It answers
   * "may I create a layer here?" — a question the caller's role cannot answer,
   * since a grant of `admin` on the workspace is enough and seeing one with
   * `read` is not. Reaching a layer inside it never reports as authority over
   * the workspace.
   */
  readonly permissions: readonly Permission[]
}

/**
 * An embedding model this organization can point a layer at.
 *
 * No endpoint and no credentials reference: both are in the table and neither
 * is on the wire. Choosing a provider takes an id; auditing the deployment's
 * configuration is a different job with a different reader.
 */
export interface EmbeddingProvider {
  readonly id: string
  readonly name: string
  readonly model: string
  /** What the model returns, and what a layer's vector slot is created with. */
  readonly dimensions: number
  /** The installation default — readable by every tenant, writable by none. */
  readonly isDefault: boolean
}

export interface LayerInput {
  readonly workspaceId: string
  readonly slug: string
  readonly name: string
  readonly description?: string
  /**
   * Which embedding model the layer is indexed with.
   *
   * Optional, and only needed by an organization running more than one — with
   * two, the server refuses to guess rather than picking whichever row came
   * back first.
   */
  readonly providerId?: string
}

export interface Grant {
  readonly id: string
  readonly principalType: PrincipalType
  readonly principalId: string
  readonly scopeType: ScopeType
  readonly scopeId: string
  readonly permission: Permission
  readonly effect: Effect
  readonly source: string
}

export interface GrantInput {
  readonly principalType: PrincipalType
  readonly principalId: string
  readonly scopeType: ScopeType
  readonly scopeId: string
  readonly permission: Permission
}

export interface ServiceAccount {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
}

export interface CreatedServiceAccount extends ServiceAccount {
  /**
   * The key, in this response and nowhere else, ever again. It is stored
   * hashed, so it cannot be recovered from the database or from a backup.
   */
  readonly key: string
}

// ─── principals: the users and groups a grant is issued to ─────────────────

export type UserRole = 'platform_admin' | 'org_admin' | 'member'

export interface User {
  readonly id: string
  readonly email: string
  readonly role: UserRole
  readonly createdAt: string
  /** When sign-in stopped working. The row is kept — the audit log names this id. */
  readonly disabledAt: string | null
  /** Whether a local password is set at all. False is an SSO-only account. */
  readonly hasPassword: boolean
}

export interface CreatedUser extends User {
  /**
   * The password, in this response and nowhere else, ever again. It is stored
   * as a scrypt hash, so it cannot be recovered from the database or from a
   * backup — issue a new one with `users.resetPassword` instead.
   */
  readonly password: string
}

export interface Group {
  readonly id: string
  readonly name: string
  readonly createdAt: string
  /** Direct members. A nested group counts as one, not as its members. */
  readonly memberCount: number
}

export interface GroupMember {
  readonly type: 'user' | 'group'
  readonly id: string
  /** The email for a user, the name for a nested group. */
  readonly label: string
}

// ─── the reindex, and the gate in front of it ──────────────────────────────

export type ReindexStatusName = 'running' | 'complete' | 'failed'

export interface ReindexStatus {
  readonly layerId: string
  readonly status: ReindexStatusName
  /**
   * `copying` is the organization's collection being rebuilt with room for the
   * new model — org-wide, no embeddings computed, and `progress` reads 0
   * throughout. `embedding` is the per-layer work `progress` measures.
   */
  readonly phase: 'copying' | 'embedding'
  /** What search is using right now. */
  readonly currentVector: string
  /** What is being built. They differ until the switch. */
  readonly shadowVector: string
  readonly providerId: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly total: number
  readonly done: number
  readonly failed: number
  /** 0 to 1, clamped. An empty layer reads 1, because it is finished. */
  readonly progress: number
  readonly error: string | null
  /**
   * What the recall gate scored, once it has run. `null` until then, and `null`
   * forever for a layer with no reference query set — that layer has no gate.
   */
  readonly check: RecallCheck | null
}

export interface RecallCheck {
  /** The mean of `scores`, 0 to 1. */
  readonly recall: number
  readonly floor: number
  readonly passed: boolean
  readonly queries: number
  readonly scores: readonly { readonly queryId: string; readonly recall: number }[]
  /**
   * External ids naming no live document. Any of these means `passed` is false
   * whatever `recall` says — a stale reference set and a model that lost recall
   * are different problems.
   */
  readonly unresolved?: readonly string[]
}

export interface ReferenceQuery {
  readonly id: string
  readonly query: string
  /** External ids the query must still find. At most ten; see `referenceQueries`. */
  readonly expected: readonly string[]
}

export interface ReferenceQueryInput {
  readonly query: string
  readonly expected: readonly string[]
}

// ─── sign-in ───────────────────────────────────────────────────────────────

export interface Tokens {
  readonly accessToken: string
  readonly tokenType: string
  /** Seconds. The access token's lifetime, not the refresh token's. */
  readonly expiresIn: number
  readonly refreshToken: string
}

// ─── the access log ────────────────────────────────────────────────────────

export interface AuditRecord {
  /** A sequence rather than a uuid, because a log is ordered. */
  readonly id: string
  readonly occurredAt: string
  /** Who. `label` is a display name and may be absent for a deleted principal. */
  readonly actor: {
    readonly type: string
    readonly id: string | null
    readonly label: string | null
  }
  /** `rest` or `mcp`. Which door the request came through. */
  readonly surface: string | null
  readonly client: string | null
  readonly action: string
  readonly target: Record<string, unknown>
  readonly result: 'allow' | 'deny' | 'error'
  readonly detail: Record<string, unknown>
  /** Matches the `request_id` in the problem document the caller saw. */
  readonly requestId: string | null
}

export interface AuditQuery {
  readonly from?: string
  readonly to?: string
  readonly actorId?: string
  readonly action?: string
  readonly result?: 'allow' | 'deny' | 'error'
  readonly limit?: number
  readonly cursor?: string
}

export interface AuditPage {
  readonly items: readonly AuditRecord[]
  /** Absent on the last page. Pass it back as `cursor`. */
  readonly nextCursor?: string
}

/**
 * The caller, as the server sees them.
 *
 * `group` is deliberately not a principal type here: a group is granted to and
 * never authenticated as, so nothing can present a token that is one.
 */
export interface Self {
  readonly organization: string
  readonly principalType: 'user' | 'service_account'
  readonly principalId: string
  readonly role: UserRole
}

/**
 * An application connected to this organization, acting as an agent.
 *
 * `lastRefreshedAt` is "last seen renewing" rather than last used, and the name
 * says so: an access token is verified locally, so its use touches nothing the
 * server could record. A connection in constant use with a long-lived access
 * token looks idle here, and claiming otherwise would be a number that reads as
 * fact and is a guess.
 */
export interface Connection {
  readonly id: string
  readonly clientId: string
  readonly clientName: string
  /**
   * What the application acts as.
   *
   * `service_account` is an agent with its own grants; `user` is a delegation,
   * where the application acts as the person who approved it and reaches
   * exactly what they reach.
   */
  readonly actsAs: 'service_account' | 'user'
  /** Null for a delegation, which names no agent. */
  readonly serviceAccountId: string | null
  readonly serviceAccountName: string | null
  readonly approvedBy: string
  /**
   * The approver's address. `approvedBy` answers which row; a reader is asking
   * who. Null only where the row points at a user the organization no longer
   * has.
   */
  readonly approvedByEmail: string | null
  /** Whether that person is disabled — a delegation of one is refused. */
  readonly approverDisabled: boolean
  /** Layers a delegation was narrowed to. Empty means no narrowing. */
  readonly layers: readonly string[]
  /**
   * Permissions a delegation may exercise. Empty means no ceiling — it reaches
   * every verb its person holds.
   */
  readonly permissions: readonly ('read' | 'write' | 'admin')[]
  readonly createdAt: string
  readonly lastRefreshedAt: string | null
  readonly revokedAt: string | null
}
