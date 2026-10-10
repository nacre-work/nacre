/**
 * The wire types, in the SDK's naming.
 *
 * The API speaks snake_case and this speaks camelCase; the mapping happens in
 * one place, in `client.ts`, so a rename on the wire is one edit rather than a
 * search. Nothing here carries an organization — see the note on ClientOptions.
 */

export type Permission = 'read' | 'write' | 'admin'
/**
 * A value a delegation's ceiling may hold: a permission, or `skill` — the
 * consent screen's per-layer "edit this layer's skill" box. `skill` is not a
 * permission anybody holds; it lets a connection write a layer's skill where
 * its person holds `admin`, and nothing else. See docs/skills.md.
 */
export type CeilingValue = Permission | 'skill'
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
  /** The document as UTF-8 text. One of `content`, `url` or `bytes`. */
  readonly content?: string
  readonly url?: string
  /**
   * The document as a file — a PDF, a Word, OpenDocument, RTF or EPUB file —
   * sent as a multipart upload. Needs `contentType`, which the server holds
   * against the bytes' own signature: both must agree, and a deployment
   * without object storage refuses every binary upload, naming `NACRE_S3_*`.
   */
  readonly bytes?: Uint8Array
  /** The declared media type of `bytes`, e.g. `application/pdf`. */
  readonly contentType?: string
  /** The file part's name. Defaults to `externalId`; it reaches no path and no object key. */
  readonly filename?: string
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

/** What a ticket fixes about the document it will carry. */
export interface UploadTicketRequest {
  readonly layer: string
  /** Fixed at minting. Absent, the redeem's `filename` decides, then a generated id. */
  readonly externalId?: string
  readonly title?: string
  readonly metadata?: IngestRequest['metadata']
}

/**
 * Where to send the bytes. Shaped after the descriptor the MCP file-transfer
 * proposal (SEP-2631) has a server mint for an upload: `url`, `method`,
 * `headers`, `expiresAt`, `maxSize` — plus the ticket itself and the request
 * as a `curl` line, which is what a model hands to a person or a shell.
 */
export interface UploadDescriptor {
  readonly ticket: string
  readonly url: string
  readonly method: 'POST'
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: string
  readonly maxSize: number
  readonly accepts: readonly string[]
  readonly curl: string
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
  /**
   * The workspace it is in. In the contract since the first layer, and dropped
   * here until a screen needed it: renaming or deleting a layer takes `admin`
   * on its *workspace*, which `permissions` below cannot answer, so the Layers
   * screen offered both to people the server then refused.
   */
  readonly workspaceId: string
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
  /**
   * What this token may do on the layer — the verbs it resolves to there,
   * inside its ceiling and narrowing. Unordered, on rule 6: `['write']` is a
   * real answer. Empty against an API older than 0.31.0, which did not say.
   */
  readonly permissions: readonly Permission[]
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
  /**
   * Whether this credential is one several people hold — a published demo
   * login, a kiosk, a read-only account handed round a team.
   *
   * Such an account has no `/v1/me` credential surface: it cannot enrol a
   * second factor, change its own password, or be sent a reset link. An
   * administrator still resets its password, which is how a published one is
   * rotated. It is fixed at creation and cannot be changed afterwards.
   */
  readonly shared: boolean
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

/**
 * What a sign-in returns when the account has a second factor.
 *
 * A union with `Tokens` rather than a nullable field on it: a client that read
 * `accessToken` and found nothing would report a broken sign-in for a working
 * one. Nothing was refused here — the caller is being asked for the rest of
 * what it needs.
 */
export interface SecondFactorRequired {
  readonly secondFactorRequired: true
  /**
   * Present it to `auth.secondFactor`. Bound to an audience that is not the
   * API's, so it is refused everywhere an access token is accepted.
   */
  readonly challenge: string
  /** Seconds. */
  readonly expiresIn: number
}

/**
 * What a sign-in returns when a policy demands a second factor this account
 * does not have.
 *
 * Produced by a commercial module registered on the core's `registerSignInGate`
 * — an installation running no module never answers this. It is in the union
 * regardless, because a client written today is the client that meets it on the
 * day a customer turns a policy on, and one that read `accessToken` and found
 * nothing would report a broken sign-in for a working one.
 *
 * The challenge is **not** a session and not a sign-in challenge either. Point
 * a client at it as its token and it reaches the four enrolment routes and
 * nothing else; every other path answers `401`.
 */
export interface SecondFactorEnrolmentRequired {
  readonly secondFactorEnrolmentRequired: true
  readonly challenge: string
  /** Seconds. Longer than a sign-in challenge: this is a setup, not a code. */
  readonly expiresIn: number
  /** The gate's own words, meant to be shown to the person. */
  readonly reason: string
}

export type SignIn = Tokens | SecondFactorRequired | SecondFactorEnrolmentRequired

/**
 * What comes back from confirming an enrolment.
 *
 * `tokens` is present only where the enrolment was reached with an **enrolment
 * challenge** rather than a session — there, confirming is the end of a sign-in
 * as well, and being made to enrol and then asked to sign in again is the
 * moment a person gives up. An object rather than a bare list of codes so that
 * a caller has to say what it does with the session; returning the codes alone
 * and adding the pair later would be a field every existing call site ignores.
 */
export interface ConfirmedSecondFactor {
  readonly recoveryCodes: readonly string[]
  readonly tokens: Tokens | undefined
}

/** Which kinds an installation can enrol. */
export type SecondFactorKind = 'totp' | 'webauthn'

/** An enrolled authenticator. No secret is ever in one of these — and for a
 * security key there is none to be in one: it leaves a public key here and
 * nothing a database dump could use. */
export interface SecondFactor {
  readonly id: string
  readonly kind: SecondFactorKind
  readonly label: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
}

/**
 * What `navigator.credentials.get` produced, base64url throughout.
 *
 * The field names are this client's, and the encoding is the browser's: an
 * `ArrayBuffer` off a `PublicKeyCredential` becomes base64url before it
 * reaches here, because that is what the server compares against.
 */
export interface WebAuthnAssertion {
  readonly credentialId: string
  readonly authenticatorData: string
  readonly clientDataJSON: string
  readonly signature: string
  /** The challenge this ceremony was issued. */
  readonly challenge: string
}

/** What to hand `navigator.credentials.get`. */
export interface WebAuthnAssertionOptions {
  readonly challenge: string
  readonly rpId: string
  readonly allowCredentials: readonly string[]
  readonly timeoutMs: number
}

/** And what to hand `navigator.credentials.create`. */
export interface WebAuthnRegistrationOptions {
  readonly challenge: string
  readonly rp: { readonly id: string; readonly name: string }
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  /** COSE identifiers: -7 ES256, -257 RS256, -8 EdDSA. */
  readonly algorithms: readonly number[]
  readonly excludeCredentials: readonly string[]
  readonly timeoutMs: number
}

/** An enrolment in progress. The secret is here and nowhere else, once. */
export interface BegunSecondFactor {
  readonly id: string
  readonly secret: string
  readonly otpauthUrl: string
  readonly label: string
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

/** Where a client connects — `GET /v1/endpoints`. */
export interface Endpoints {
  /** The REST API's base, ending in `/v1`. */
  readonly api: string
  /** The MCP endpoint, Streamable HTTP. */
  readonly mcp: string
  /** The administrative MCP endpoint — present only for somebody who administers the organization. */
  readonly mcpAdmin?: string
  /** The OpenAPI document for the release the server was built from. */
  readonly contract: string
  readonly version: string
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
  /**
   * Whether this token administers **this organization**.
   *
   * The server's own predicate, reported rather than derived — and derived is
   * what went wrong. `role === 'org_admin' || role === 'platform_admin'` reads
   * as the obvious answer and is false: a `platform_admin` administers the
   * *installation*, and every endpoint scoped to one organization refuses that
   * role in both directions. A console deriving it offered three screens that
   * all answer `404`.
   *
   * It also carries the delegation ceiling, which `role` cannot: a token
   * restricted below `admin` does not administer anything even when its person
   * does.
   *
   * Falls back to `role === 'org_admin'` against an older API that does not
   * report it — the conservative half of the old derivation, never the half
   * that offered too much.
   */
  readonly administers: boolean
  /**
   * Whether this principal may change its own password and second factor.
   *
   * False for a service account, for a delegation, and for a **shared** account
   * — a credential more than one person holds, such as a published demo login,
   * where there is no "the person" to hold a factor and the first holder to
   * enrol one would lock out every other.
   *
   * It is here so a screen can leave those controls off rather than drawing
   * ones that answer `404`. `true` against an older API that does not report
   * it, which is the safe direction: showing a control the server refuses costs
   * a readable error, and hiding one it would have accepted takes a working
   * feature away.
   */
  readonly holdsOwnCredentials: boolean
  /**
   * Whether this caller may manage embedding providers: `org_admin`, and the
   * tenant-providers switch on. Drives whether the console shows the Models
   * screen. `false` against an older API that does not report it, the safe
   * direction here — a managed platform with the surface off should not have
   * the screen appear just because the field is missing.
   */
  readonly managesEmbedders: boolean
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
/**
 * A change an agent proposed on the administrative MCP, waiting for the person
 * who approved that connection. docs/mcp-admin.md.
 *
 * `summary` and `details` are the server's own words, written from names it
 * resolved — what a person reads before pressing Apply.
 */
export interface Proposal {
  readonly id: string
  readonly tool: string
  /** The module that registered the tool; null for the core's own. */
  readonly module: string | null
  readonly summary: string
  /** `text` marks a file's whole text, to be shown with its line breaks — a skill proposal's files. */
  readonly details: readonly { readonly label: string; readonly value: string; readonly text?: boolean }[]
  readonly createdAt: string
  readonly expiresAt: string
  /** The administrative connection it came through. */
  readonly connection: { readonly id: string; readonly application: string | null }
}

/** What pressing Apply did. */
export type ProposalOutcome =
  | { readonly kind: 'applied'; readonly result: unknown }
  /** The change itself was refused, in the server's words; the proposal is spent. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** Applied, cancelled, expired, or not this person's — one answer. */
  | { readonly kind: 'gone' }

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
  /**
   * Layers a delegation was narrowed to, each with its own ceiling where the
   * person set one. Empty means no narrowing. A layer with no `permissions`
   * inherits the connection's.
   */
  readonly layers: readonly { readonly id: string; readonly permissions?: readonly CeilingValue[] }[]
  /**
   * What a delegation may exercise. Empty means no ceiling — it reaches every
   * verb its person holds.
   */
  readonly permissions: readonly CeilingValue[]
  /**
   * Which resource the connection is for. `admin` is the administrative MCP
   * (docs/mcp-admin.md): its tokens reach `/mcp/admin` and nothing else, and
   * only an organization administrator approves one. An API older than that
   * surface sends nothing, which is `default`.
   */
  readonly surface: 'default' | 'admin'
  readonly createdAt: string
  readonly lastRefreshedAt: string | null
  readonly revokedAt: string | null
}

// ─── skills ────────────────────────────────────────────────────────────────

/**
 * Which skill. docs/skills.md has the three levels: the installation's, which
 * every organization that has not set its own is given; the organization's,
 * which replaces it; and a layer's, which is added to whichever applies.
 */
export type SkillLevel = 'installation' | 'organization' | { readonly layerId: string }

/** A skill folder in Claude's format: relative path → text. `SKILL.md` is required. */
export type SkillFiles = Readonly<Record<string, string>>

export interface SkillEntry {
  /** Where it comes from. `default` is the skill shipped in the image. */
  readonly level: 'default' | 'installation' | 'organization' | 'layer'
  readonly layerId: string | null
  readonly layerSlug: string | null
  readonly name: string
  readonly description: string
  /** Null for the default skill, which has no versions. */
  readonly version: number | null
  /** Anything under `scripts/`. They run on the agent's side, never here. */
  readonly hasScripts: boolean
  readonly paths: readonly string[]
}

/** The skill this caller's agents are given, with its files. */
export interface BaseSkill extends SkillEntry {
  readonly files: SkillFiles
}

export interface SkillVersion {
  readonly version: number
  /** Null on a version that cleared the skill. */
  readonly name: string | null
  readonly description: string | null
  readonly hasScripts: boolean
  readonly fileCount: number
  /** `{type}:{id}`, as the access log writes it. */
  readonly principal: string
  readonly surface: 'rest' | 'mcp' | 'mcp-admin'
  readonly connectionId: string | null
  /** Written through MCP, a connected application, or a service account. */
  readonly byAgent: boolean
  readonly restoredFrom: number | null
  readonly createdAt: string
  /** Present on a single version; absent in a history page. */
  readonly files?: SkillFiles
}

/**
 * How a write ended, where the answer is not an error.
 *
 * A conflict is an answer rather than a fault: somebody else wrote first, and
 * the caller's next step is to read `current`, merge, and write again naming
 * it. A refusal to write (403) and a skill the format refuses (400) throw.
 */
export type SkillWrite =
  | { readonly kind: 'written'; readonly version: SkillVersion; readonly cleared: boolean }
  | { readonly kind: 'conflict'; readonly current: number }
