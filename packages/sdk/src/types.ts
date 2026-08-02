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
}

export interface Workspace {
  readonly id: string
  readonly slug: string
  readonly name: string
  /** Live layers in it, not layers you may read — a per-caller count would leak grants. */
  readonly layerCount: number
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
