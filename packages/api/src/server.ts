import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
// Imported rather than taken from the global scope: `lib` is ES2023 with no
// DOM, so the global URL is not typed here.
import { URL } from 'node:url'

import {
  logger,
  MetadataError,
  MultipartError,
  multipartBoundary,
  parseMultipart,
  queryAudit,
  parseFilters,
  parseMetadata,
  PROTECTED_RESOURCE_PATH,
  JWKS_PATH,
  AUTHORIZATION_SERVER_PATH,
  AUTHORIZE_PATH,
  CODE_TTL_MS,
  allowedRequestHeaders,
  corsHeaders,
  isPreflight,
  preflightHeaders,
  REGISTER_PATH,
  TOKEN_PATH,
  authorizationServerMetadata,
  consentRedirect,
  generateClientId,
  generateCode,
  redirectAllowed,
  verifierMatches,
  ADMIN_PREFIX,
  adminRoutes,
  withAuditSinks,
  TooBusy,
  type AuditEvent,
  type AuditWriter,
  type Metadata,
  type MultipartPart,
  type ProtectedResourceMetadata,
  type Permission,
  type IngestFailureReason,
} from '@nacre.work/core'

import {
  administers,
  administersTenants,
  authenticate,
  rejectTenantOverride,
  type AuthContext,
  type VerifyOptions,
} from './auth.js'
import { badRequest, internal, notAdministeredHere, notFound, Problem } from './errors.js'
import { isConflict, isReplay, type IdempotencyStore } from './idempotency.js'
import { limitHeaders, type LimitDecision, type LimitPolicy, type RateLimiter, type Resource } from './limits.js'
import type { Login, LoginOutcome, Tokens } from './login.js'
import type { SecondFactors } from './second-factor.js'
import type {
  ConsentSubject,
  LayerNarrowing,
  MintRequest,
  OAuthAuthorizations,
  OAuthClients,
  OAuthConsents,
  OAuthRefreshTokens,
} from './oauth-store.js'
import { looksLikeEmail, type GroupMember, type Groups, type GroupView, type Users, type UserView } from './principals.js'
import { clientSource } from './source.js'
import {
  auditFormat,
  auditJson,
  readAuditQuery,
  toCsv,
  toNdjson,
} from './audit-export.js'
import { readPage, type Page, type PageResult } from './pagination.js'
export type { Page, PageResult }

/**
 * What the API needs from the rest of the system, as ports.
 *
 * Injected rather than imported so the surface can be tested without a
 * database or a vector store. The parts that must be tested here — the token is
 * the only source of the organization, and invisible is indistinguishable from
 * absent — are properties of this layer, and a test that has to stand up
 * Postgres to check them is a test nobody runs.
 */
export interface Documents {
  /**
   * The document, or undefined.
   *
   * **Undefined must mean the same thing for every reason it can be
   * undefined** — absent, another organization's, or one this caller has no
   * grant reaching. If this ever grows a second answer, the 403/404
   * distinction leaks through whatever the caller does with it.
   *
   * It takes the whole `AuthContext` and not an `orgId`, and that is the
   * point: with an organization alone the implementation is structurally
   * incapable of consulting the resolver, and the first version of this
   * signature was exactly that. Search filtered correctly while
   * `GET /v1/documents/{id}` returned the title of any document in the
   * organization to anyone holding any token for it — including a caller whose
   * grant had been revoked, and a service account with `write` and no `read`.
   */
  read(auth: AuthContext, documentId: string): Promise<DocumentView | undefined>
  /**
   * Replace a document's metadata, leaving its vectors alone.
   *
   * `false` for every reason the write cannot happen — absent, another
   * organization's, denied, or a caller with no `write` reaching it. Same rule
   * as `read`: one answer for all of them, or the 403/404 distinction leaks
   * through whatever the caller does with it.
   *
   * Absent from an implementation means the path answers `404`, like any other
   * capability a surface does not have.
   */
  updateMetadata?(auth: AuthContext, documentId: string, metadata: Metadata): Promise<boolean>
}

/**
 * A document, as a caller sees it.
 *
 * It was `{ id, title }`, which is not enough to do anything with: no layer, no
 * status, no size. A client that got a `202` from ingest and then wanted to
 * know whether the document had indexed had to go to `/v1/jobs/{id}` and knew
 * to only because the two ids happen to be the same value.
 *
 * Nothing here is permission data — the caller has already been resolved
 * against this document, so every field describes something they may see. The
 * text is not included: chunks are what search returns, and a whole-document
 * body on this endpoint would be a second, unpaginated way to read everything.
 */
export interface DocumentView {
  readonly document_id: string
  /**
   * The identifier the caller ingested it under.
   *
   * Write-only until now, which was a hole rather than a decision: ingest is
   * idempotent on `(layer, external_id)`, so a client names its documents and
   * then cannot ask about one by the name it chose. A reference query set names
   * external ids as well, so nothing outside the worker could score recall.
   */
  readonly external_id: string | null
  readonly layer: string
  readonly title: string | null
  readonly status: string
  readonly chunk_count: number
  /**
   * Why indexing failed, for a document whose `status` is `failed`.
   *
   * The worker has written this to `documents.error` since it had a message
   * worth writing, and no surface read it back — so `status: "failed"` with
   * `chunk_count: 0` was the whole of what a caller could learn, and the
   * reason lived where only somebody with the host could reach it.
   *
   * `null` for every other status, including a document that failed once and
   * succeeded on a retry: the column keeps the last error, and reporting it
   * beside `indexed` would describe a working document as a broken one.
   *
   * It follows the document's own permission, so rule 6 keeps it away from a
   * caller holding `write` alone — the same as `source_url`.
   */
  readonly error: string | null
  readonly updated_at: string
  /** What the caller tagged it with, and what `filters` reads back. */
  readonly metadata: Metadata
  /**
   * A presigned link to the original bytes, where a deployment stores them in
   * object storage. Absent otherwise, and absent for a document whose source is
   * inline or a URL.
   *
   * It is a bearer capability with a life of `NACRE_PRESIGN_TTL`: whoever holds
   * it can fetch that object without a Nacre credential, and a revocation
   * inside the window does not reach it. That is what presigning is; the
   * lifetime is how long a deployment is willing for it to be true.
   */
  readonly source_url?: string
}

/**
 * One result, as the contract describes it.
 *
 * Not the vector store's hit. That carried the raw payload — `acl_tags`,
 * `acl_version`, `org_id`, `layer_id` — straight to the client, and carried no
 * text at all, so the product's central operation answered with identifiers and
 * a score and nothing a caller could read. `docs/openapi.yaml` had said
 * otherwise since before there was a server.
 *
 * The tags are the part worth naming: an acl tag is a hash over the grant set
 * reaching a document, so publishing it lets a client group documents by which
 * permissions they share. Not a cross-tenant leak, and still the shape of the
 * organization's access structure handed to anyone who can search.
 */
export interface SearchHit {
  readonly chunk_id: string
  readonly doc_id: string
  readonly layer: string
  readonly title: string | null
  readonly score: number
  readonly text: string
}

/**
 * What a caller may ask of a search beyond the query itself.
 *
 * `rerank` can only ever turn reranking **off**. A deployment without a
 * reranker configured does not grow one because a client asked for it, so this
 * is a preference and not a switch — which is the right way round: the client
 * knows whether it wants latency or quality, the operator knows whether the
 * model server exists.
 */
export interface SearchOptions {
  readonly rerank?: boolean
  /**
   * Layer slugs to restrict the search to. Narrowing only — a layer the caller
   * cannot read contributes nothing whether or not they name it, and naming one
   * that does not exist is the same answer as naming one they cannot see.
   */
  readonly layers?: readonly string[]
  /**
   * Document metadata to restrict to, key to value. Narrowing only.
   *
   * Equality, and a list means "any of these". Never a negation, a range or a
   * disjunction across keys — each of those is a way to widen if it is ever
   * composed wrongly, and none is needed to answer "only documents from this
   * source". Validated before it gets here.
   */
  readonly filters?: Metadata
  /**
   * `false` omits the chunk text from every hit.
   *
   * For a client that wants ids and scores — a reranking front end, a citation
   * index — and does not want to pay for the bodies. Applied after reranking,
   * because a reranker scores the query against the text.
   */
  readonly includeContent?: boolean
}

export interface SearchService {
  search(
    auth: AuthContext,
    query: string,
    topK: number,
    options?: SearchOptions,
  ): Promise<readonly SearchHit[]>
}

export interface IngestRequest {
  readonly layer: string
  readonly externalId: string
  readonly title?: string
  readonly content?: string
  readonly url?: string
  /**
   * Raw document bytes, the third mutually exclusive source. Only the
   * multipart file part produces them, only after the handler verified the
   * declared type and the magic agree, and only on a deployment with object
   * storage — the bytes' only home is the bucket. `contentType` travels with
   * them; the two are set together or not at all.
   */
  readonly bytes?: Uint8Array
  readonly contentType?: string
  /** Validated before it gets here. `{}` when the caller sent none. */
  readonly metadata: Metadata
}

export interface IngestOutcome {
  readonly documentId: string
  readonly jobId: string
  /** True when the idempotency key and content hash both matched. */
  readonly unchanged: boolean
}

/**
 * A module's ingest gate refused the document.
 *
 * Distinct from `undefined`, which is the write check declining and must stay a
 * `404`: by the time a gate runs the caller has been shown to hold `write`, so a
 * quota or a suspension is a real answer they are entitled to, with the 4xx the
 * gate chose. Discriminated by `refused` so the handler can tell it from an
 * accepted document without a second field on the happy path.
 */
export interface IngestRefused {
  readonly refused: true
  readonly status: number
  readonly reason: string
}

export interface Ingest {
  /**
   * Queue a document, refuse it, or decline it as unwritable.
   *
   * `undefined` means the caller may not write to that layer — and it must mean
   * the same for a layer that does not exist. Ingest is the cheapest oracle in
   * the system otherwise: a caller with no read access could enumerate layer
   * names by watching which ones accept a document. An `IngestRefused` is a
   * module gate declining a document the caller *may* write, which is a
   * different answer and carries its own 4xx.
   */
  queue(auth: AuthContext, request: IngestRequest): Promise<IngestOutcome | IngestRefused | undefined>
  /** Tombstone. `false` for absent and for not-permitted alike. */
  remove(auth: AuthContext, documentId: string): Promise<boolean>
}

export interface Job {
  readonly jobId: string
  readonly documentId: string
  readonly status: 'queued' | 'parsing' | 'embedding' | 'indexed' | 'failed'
  readonly progress: number
  /**
   * How many chunks the document indexed as.
   *
   * Here because `indexed` alone does not mean a document is searchable: one
   * that parses to nothing reaches it too, with zero chunks, deliberately — an
   * emptied file has to sweep its old points. A caller checking its own ingest
   * wants the number, and the alternative was `GET /v1/documents/{id}`, which
   * needs `read` and therefore refuses the writer this whole endpoint is for.
   */
  readonly chunkCount: number
  /** Stable, for a program. See `classifyIngestFailure`. */
  readonly reason?: IngestFailureReason
  /** For a person. Carries no host, no URL and none of the document. */
  readonly error?: string
}

export interface Jobs {
  /**
   * `undefined` for absent, for another organization's, and for one the caller
   * has no grant reaching — a job names a document and carries its error
   * string, so it is exactly as much of an oracle as the document is.
   */
  read(auth: AuthContext, jobId: string): Promise<Job | undefined>
}

export interface Layer {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly workspaceId: string
  /** The cursor's sort key. Not serialized; it exists so paging is stable. */
  readonly createdAt: string
  readonly description: string
  /**
   * Live documents in the layer that indexing **failed** on.
   *
   * Beside `documentCount` rather than instead of it, because the two answer
   * different questions and only one of them is actionable. A count of rows is
   * the right definition for the first — counting only `indexed` would make a
   * freshly ingested layer read zero while the worker catches up, so the number
   * would swing on a state that resolves itself.
   *
   * `failed` does not resolve itself. It is the one status that waits for a
   * person, which makes it the one that has to be *reported* rather than merely
   * recorded — and until this existed a layer where every document had failed
   * looked exactly like a healthy one, answering every search with nothing.
   *
   * Not per caller, on the same argument `documentCount` makes: a count that
   * varied by who asked would describe somebody else's grants.
   */
  readonly failedCount: number
  /**
   * Live documents in the layer.
   *
   * Not "documents this caller may read": layer-scoped grants are all this
   * build has, so anyone who can see the layer reaches everything in it. When
   * document-level grants exist this stops being true, and the number has to be
   * computed per caller or removed — a count is a small disclosure and still a
   * disclosure.
   */
  readonly documentCount: number
}

/**
 * Three outcomes, not two.
 *
 * `denied` covers "may not administer this workspace" and "no such workspace"
 * together, which is the usual rule. `conflict` is deliberately separate: the
 * caller has already proved admin on the target workspace by the time it can
 * happen, so the answer is about the resource rather than about what they can
 * see.
 *
 * Folding it into `denied` was the first shape and it makes the endpoint
 * unusable — an administrator who picks a name already in use gets a 404 and
 * cannot tell it from having no permission, so the next move is to guess. It
 * discloses exactly one bit, that the slug is taken somewhere in their own
 * organization, and slugs are organization-unique by design (migration 0006).
 */
/** A workspace, as a caller sees it. */
export interface Workspace {
  readonly id: string
  readonly slug: string
  readonly name: string
  /**
   * Live layers in it — not "layers this caller may read".
   *
   * The same choice the layer listing makes for its document count: a count
   * that varied by who asked would leak the shape of somebody else's grants,
   * and a caller comparing two of them could infer what they cannot see.
   */
  readonly layerCount: number
  readonly createdAt: string
  /**
   * What **this** caller holds on this workspace, resolved for this request.
   *
   * Deliberately per-caller, which `layerCount` deliberately is not, and the
   * difference is what each one would leak. A count that varied by who asked
   * describes somebody else's grants; this describes only the asker's own, on
   * an object they are already being shown.
   *
   * It exists because the admin UI had no way to ask "may I create a layer
   * here?" other than reading a role — and the role is the wrong answer twice
   * over: an `org_admin` is not the only principal who may (a grant of `admin`
   * on the workspace is enough), and a caller who can *see* a workspace with
   * `read` may not. So "New layer" was offered to people whose next click was
   * a `404` that invariant 4 makes indistinguishable from a broken screen.
   *
   * A set rather than a level, on rule 6: permissions are unordered here, so
   * `['write']` is a real answer and a ladder would have lost it.
   */
  readonly permissions: readonly Permission[]
}

/**
 * An embedding provider, as a caller sees it.
 *
 * **No endpoint and no credentials reference.** Both are in the table and
 * neither is on this type: the endpoint names an internal host, the credentials
 * reference names a slot in a secret store, and nothing a caller does with this
 * list needs either. It exists so a layer can be pointed at a model, which
 * takes an id — auditing the deployment's configuration is a different job with
 * a different reader.
 */
export interface EmbeddingProvider {
  readonly id: string
  readonly name: string
  readonly model: string
  readonly dimensions: number
  /** The installation default: the row belonging to no organization. */
  readonly isDefault: boolean
}

export type EmbeddingProviderOutcome =
  | { readonly kind: 'created'; readonly provider: EmbeddingProvider }
  | { readonly kind: 'denied' }
  | { readonly kind: 'conflict' }

export interface EmbeddingProviders {
  /**
   * This organization's providers and the installation default.
   *
   * Deliberately **not** `org_admin`. The caller who needs this is whoever may
   * start a reindex, and that is `admin` on the *layer* — an organization role
   * would hand them an empty picker and a 404 on the button, which is the
   * defect the consent screen shipped with and this repository has now fixed
   * twice.
   *
   * Widening it that far discloses nothing: a provider is installation
   * configuration rather than tenant data, its model and dimensions are already
   * implied by every layer's `vector_name`, and the endpoint is not on the
   * type. The database narrows the rest — `org_isolation` shows a caller their
   * own organization's rows and the global default, and never another
   * tenant's.
   */
  list(auth: AuthContext): Promise<readonly EmbeddingProvider[]>
  /**
   * Add one, at `org_admin`.
   *
   * Creating a provider is installation configuration: it decides what a layer
   * can be migrated onto, it can cost money, and — once an adapter can reach a
   * hosted API — it decides where document text goes. That is an
   * organization-wide act, unlike choosing among the ones that exist.
   */
  create(
    auth: AuthContext,
    input: { name: string; endpoint: string; model: string; dimensions: number },
  ): Promise<EmbeddingProviderOutcome>
}

export type WorkspaceOutcome =
  | { readonly kind: 'created'; readonly workspace: Workspace }
  | { readonly kind: 'denied' }
  | { readonly kind: 'conflict' }

export interface Workspaces {
  /** Only the workspaces this caller can reach. The plan decides, not the caller. */
  list(auth: AuthContext, page?: Page): Promise<PageResult<Workspace>>
  create(auth: AuthContext, input: { slug: string; name: string }): Promise<WorkspaceOutcome>
}

export type LayerOutcome =
  | { readonly kind: 'created'; readonly layer: Layer }
  | { readonly kind: 'denied' }
  | { readonly kind: 'conflict' }
  /**
   * The named provider is not one this organization may use, or the
   * organization runs more than one and the caller named none.
   *
   * 400 rather than 404: the caller has already proved admin on the workspace,
   * so this is a statement about their request. Same reasoning as the reindex
   * path's `unknown_provider`, and a provider is installation configuration
   * rather than a tenant object with visibility rules of its own.
   */
  | { readonly kind: 'provider'; readonly detail: string }

export interface Layers {
  /**
   * Only the layers this caller may read. The plan decides, not the caller.
   *
   * Takes the page rather than returning everything for the handler to slice:
   * slicing after the fact is the same mistake as a post-filter, one layer up —
   * the database reads rows nobody will see, and the cost grows with the
   * collection rather than with the page.
   */
  list(auth: AuthContext, page?: Page): Promise<PageResult<Layer>>
  create(
    auth: AuthContext,
    input: { workspaceId: string; slug: string; name: string; providerId?: string },
  ): Promise<LayerOutcome>
  /**
   * Rename a layer, or change its description.
   *
   * Deliberately not the slug: clients address a layer by slug — `layers` on
   * search, `layer` on ingest — so renaming one silently breaks every caller
   * that stored it, and there is no redirect to soften it.
   *
   * Deliberately not the provider or the chunk configuration either. Both
   * decide how the layer's vectors were built, so changing one without
   * rebuilding them leaves the column disagreeing with the index — which is
   * what `POST /v1/layers/{id}/reindex` is, and it is not something to get by
   * accident from a PATCH.
   *
   * `false` for absent, for another organization's, and for one this caller may
   * not administer. One answer for all three.
   */
  update?(
    auth: AuthContext,
    layerId: string,
    input: { name?: string; description?: string },
  ): Promise<boolean>
  /**
   * Delete a layer, and everything in it.
   *
   * A tombstone, like a document's, and for the same reason: the cascade
   * underneath — points, chunk rows, bucket objects — is bounded by how much
   * the layer holds, and that does not belong on a request. What happens
   * synchronously is what correctness needs: the points stop matching, every
   * document row is tombstoned so the collector has a queue, and the layer
   * stops resolving. The collector reclaims the rest on its own clock, and
   * nothing depends on when.
   *
   * `admin` on the layer's workspace — the same check renaming makes, for the
   * same reason it makes it, and deleting is the more dangerous of the two so
   * it does not get a lower bar. Never `write`: an ingest-only service account
   * holds that, and it must not be able to remove what it fills.
   *
   * Grants naming the layer go with it. A grant on a scope that no longer
   * exists resolves to nothing already, so leaving them changes no answer —
   * but it leaves rows in `GET /v1/grants` that name something a reader cannot
   * look up, which is the kind of debris that gets mistaken for a leak.
   *
   * `false` for absent, for another organization's, and for one this caller may
   * not administer. One answer for all three.
   */
  remove?(auth: AuthContext, layerId: string): Promise<boolean>
}

export interface GrantInput {
  readonly principalType: 'user' | 'group' | 'service_account'
  readonly principalId: string
  readonly scopeType: 'workspace' | 'layer'
  readonly scopeId: string
  readonly permission: 'read' | 'write' | 'admin'
}

export interface GrantRecord extends GrantInput {
  readonly id: string
  readonly effect: 'allow' | 'deny'
  readonly source: string
}

export interface Grants {
  /** Grants in the caller's organization. Admin only; the caller is checked above. */
  list(auth: AuthContext, page?: Page): Promise<PageResult<GrantRecord>>
  /** `undefined` when the caller may not administer the scope, or it does not exist. */
  issue(auth: AuthContext, input: GrantInput): Promise<GrantRecord | undefined>
  /**
   * Withdraw a grant. `false` when it is absent, in another organization, or on
   * a scope this caller may not administer — one answer for all three.
   *
   * Three documents described revocation and there was no way to perform it
   * through the API at all; the only implementation was a DELETE against the
   * table by hand.
   *
   * This used to say it is the operation `nacre_acl_propagation_lag_seconds`
   * measures, and the one docs/authz.md builds an SLA around. Both went with
   * the ACL tag cache in migration 0016 — `packages/core/metrics.ts` records
   * that the gauge's absence is deliberate — and the guarantee is structural
   * now rather than timed: the permitted set is computed per request, so the
   * next one after this call already reflects it. Nothing to fall behind, and
   * nothing to measure the lag of.
   */
  revoke(auth: AuthContext, grantId: string): Promise<boolean>
}

export interface ServiceAccountView {
  readonly id: string
  readonly name: string
  readonly keyPrefix: string
  readonly createdAt: string
  readonly lastUsedAt: string | null
  readonly revokedAt: string | null
  /** The person who created it, where one did. See the port's own note. */
  readonly createdBy?: string | null
}

export interface ServiceAccountPort {
  list(auth: AuthContext, page?: Page): Promise<PageResult<ServiceAccountView>>
  /** `undefined` when the name is already taken in this organization. */
  create(
    auth: AuthContext,
    name: string,
  ): Promise<{ account: ServiceAccountView; key: string } | undefined>
  revoke(auth: AuthContext, id: string): Promise<boolean>
}

/**
 * One recorded access, as handed to a sink.
 *
 * Re-exported from `@nacre.work/core` rather than declared here. A sink can be
 * registered by a module that knows neither package, so the shape has to live
 * where both can see it — and two structurally-identical definitions are two
 * things that must agree with nothing making them.
 */
export type { AuditEvent }

/**
 * The counters and histograms the request path fills in.
 *
 * Deliberately a narrow port rather than the whole `Metrics` object: the server
 * should not be able to reach the gauges that a background collector owns, and
 * a test should not need a registry to check that a denial was counted.
 */
export interface RequestMetrics {
  searchDuration: { observe(seconds: number, labels?: Record<string, string>): void }
  searchResults: { inc(labels?: Record<string, string>, by?: number): void }
  aclDenials: { inc(labels?: Record<string, string>, by?: number): void }
  ingestDuration: { observe(seconds: number, labels?: Record<string, string>): void }
  authFailures: { inc(labels?: Record<string, string>, by?: number): void }
}

/**
 * Where a handler's events go. `AuditWriter` from the core, re-exported.
 *
 * It was `AuditSink` here, which then collided with `AuditSink` in
 * `@nacre.work/core` — the thing a module registers to forward events *on* to.
 * Two different concepts under one name in one product is a drift with a long
 * fuse: the day someone reads `audit: AuditSink` as "a module sink", the
 * journal becomes optional. One name, one meaning.
 */
export type { AuditWriter }

/**
 * One event as it is read back, which is not the shape it was written in.
 *
 * `AuditEvent` is what a handler hands to the sink; this is what the table
 * holds — an id, a timestamp, and the actor split into the three columns
 * `docs/audit.md` specifies rather than the single label the writer supplies.
 */
export interface AuditRecord {
  readonly id: string
  readonly occurredAt: string
  readonly actorType: string
  readonly actorId: string | null
  readonly actorLabel: string
  readonly action: string
  readonly surface: string
  readonly client: string | null
  readonly target: Record<string, unknown>
  readonly result: string
  readonly detail: Record<string, unknown>
  readonly requestId: string | null
}

/**
 * What a caller may narrow the log to.
 *
 * Every one of these is applied. That is worth stating because the last three
 * search parameters in this contract were declared and ignored, and an audit
 * filter that silently does nothing is worse than a search filter that does:
 * the person running it is answering a compliance question and will believe the
 * answer.
 */
export interface AuditQuery {
  /** Inclusive lower bound on `occurred_at`, as an ISO timestamp. */
  readonly from?: string
  /** Exclusive upper bound on `occurred_at`. */
  readonly to?: string
  readonly actorId?: string
  readonly action?: string
  readonly result?: 'allow' | 'deny' | 'error'
  /**
   * Restrict to administrative actions — everything that is not a substantive
   * access to a document's contents.
   *
   * Not a caller-supplied filter. It is set by the handler for a
   * `platform_admin`, because `docs/audit.md` gives that role administrative
   * visibility and explicitly withholds records of document access. Keeping it
   * in this type rather than in the SQL means the rule is stated once, at the
   * boundary, where it can be read next to the role check that sets it.
   */
  readonly administrativeOnly?: boolean
}

/**
 * Moving a layer onto a different embedding model.
 *
 * Two operations and no more: start one, and ask how it is going. There is no
 * cancel, and that is a decision rather than an omission — a half-written
 * shadow vector is harmless (nothing reads it until the switch) and a cancel
 * that has to decide whether to unwind it is a second, more dangerous path.
 * Starting a reindex back onto the current model is how you undo one.
 */
export interface Reindex {
  /**
   * `undefined` for a layer the caller may not administer **and** for one that
   * does not exist — the usual rule. `conflict` when a reindex is already
   * running: that is not a permission answer, and the caller has already proved
   * they can administer the layer by the time it can happen.
   */
  start(
    auth: AuthContext,
    layerId: string,
    providerId: string,
  ): Promise<ReindexOutcome | undefined>
  status(auth: AuthContext, layerId: string): Promise<ReindexStatus | undefined>
}

export type ReindexOutcome =
  | { readonly kind: 'started'; readonly status: ReindexStatus }
  | { readonly kind: 'conflict'; readonly status: ReindexStatus }
  | { readonly kind: 'unknown_provider' }
  /** The provider names the vector the layer already uses. */
  | { readonly kind: 'already_current'; readonly vectorName: string }

export interface ReindexStatus {
  readonly layerId: string
  readonly status: 'running' | 'complete' | 'failed'
  /**
   * `copying` while the organization's collection is being rebuilt with room
   * for the new model — org-wide, no embeddings computed. `embedding` while
   * this layer's chunks are being embedded into that room.
   */
  readonly phase: 'copying' | 'embedding'
  readonly shadowVector: string
  readonly currentVector: string
  readonly providerId: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly progress: number
  readonly error: string | null
  /**
   * The recall check, once it has run. `null` until then, and forever for a
   * layer with no reference query set — that layer has no gate.
   */
  readonly check: RecallCheck | null
}

/**
 * What the reindex was scored at before its layer was allowed to switch.
 *
 * `scores` is per reference query and keyed by id rather than by text: the
 * caller wrote the text and can join it from
 * `GET /v1/layers/{id}/reference-queries`, and a status endpoint that echoes
 * stored query strings is a shape this repository keeps out of responses and
 * logs on principle.
 */
export interface RecallCheck {
  readonly recall: number
  readonly floor: number
  readonly passed: boolean
  readonly queries: number
  readonly scores: readonly { readonly queryId: string; readonly recall: number }[]
  /** External ids in the set that name no live document. Any means it failed. */
  readonly unresolved?: readonly string[]
}

/** One line of the reference set: a query and the documents it must still find. */
export interface ReferenceQuery {
  readonly id: string
  readonly query: string
  readonly expected: readonly string[]
}

/**
 * The query set a reindex of this layer is checked against.
 *
 * Replaced whole rather than edited entry by entry. A reference set is one
 * statement about what search must keep doing, and a partial edit is how half
 * of one ends up describing a layer nobody has looked at since. There are also
 * no ids to invent on the way in, which keeps the write idempotent.
 *
 * `admin` on the layer, not `read`: the entries name documents, and rule 7
 * makes `admin` the permission that implies being allowed to see them.
 */
export interface ReferenceQueries {
  /** `undefined` for a layer the caller may not administer and for one that is not there. */
  list(auth: AuthContext, layerId: string): Promise<readonly ReferenceQuery[] | undefined>
  replace(
    auth: AuthContext,
    layerId: string,
    queries: readonly { query: string; expected: readonly string[] }[],
  ): Promise<readonly ReferenceQuery[] | undefined>
}

export interface AuditReader {
  read(auth: AuthContext, query: AuditQuery, page: Page): Promise<PageResult<AuditRecord>>
}

/**
 * The authorization server, when a deployment runs one.
 *
 * Optional, and its absence is a supported shape rather than a degraded one: a
 * deployment with its own identity provider names that in
 * `NACRE_OAUTH_AUTHORIZATION_SERVER` and this stays off, which is exactly what
 * this product was before the flow existed.
 */
export interface OAuthServer {
  /** The issuer, which is this API's canonical URL. */
  readonly issuer: string
  /** Where a browser is sent to choose an agent. The admin UI's consent screen. */
  readonly consentUrl: string
  readonly clients: OAuthClients
  readonly authorizations: OAuthAuthorizations
  readonly consents: OAuthConsents
  readonly refreshTokens: OAuthRefreshTokens
  /** How long an OAuth refresh token lives. The connection's real lifetime. */
  readonly refreshTtlSeconds: number
  /**
   * How long an access token lives, reported to whoever ends a connection.
   *
   * A revocation deletes the refresh token; the access token already out is
   * verified against a key and keeps working until it expires. Saying so is the
   * honest form of "ended".
   */
  readonly accessTtlSeconds: number
  /**
   * Mint an access token for what the connection acts as.
   *
   * Two shapes, and the union is what keeps them apart. A **service account**
   * connection mints the agent's own token: the person authenticates, the agent
   * is authorized, and revoking one does not touch the other. A **delegation**
   * mints a token for the person, carrying the connection's id as `del` — so
   * every request re-resolves their access and the connection can be ended.
   * docs/authz.md, "Delegated authority".
   */
  mint(approved: MintRequest): Promise<{ accessToken: string; expiresIn: number }>
}

export interface ApiOptions {
  readonly verify: VerifyOptions
  /** Rendered at /metrics. Absent means the endpoint answers 404. */
  readonly metrics?: { render(): Promise<string> }
  /**
   * Where the request path writes what it measured.
   *
   * Four of these were registered and never written: `/metrics` served
   * `nacre_search_results_total 0` and `nacre_acl_denials_total 0` forever, and
   * the two histograms rendered nothing at all. A series pinned at zero reads
   * as health, so the p95 target `docs/config.md` sets was not merely unmet —
   * it was unmeasurable, and looked fine.
   */
  readonly observe?: RequestMetrics
  /**
   * Answered at `/v1/ready`. Absent means the endpoint answers 404.
   *
   * One boolean per dependency, and never an error string: this endpoint is
   * unauthenticated, so what it says about the inside of the deployment is what
   * anyone who can reach the port learns.
   */
  readonly ready?: () => Promise<Record<string, boolean>>
  /**
   * Per-organization rate limiting. Absent means unlimited, which is the right
   * default for a surface being tested and the wrong one for a deployment —
   * `main.ts` always provides it.
   */
  readonly limits?: RateLimiter
  readonly limitPolicies?: Readonly<Record<Resource, LimitPolicy>>
  /**
   * How many proxies sit in front of this process, for the per-client login
   * limit. Absent or 0 means `X-Forwarded-For` is ignored and the socket
   * address is the client — see `source.ts` for why neither default is safe.
   */
  readonly trustProxy?: number
  /**
   * A bearer token required on `/metrics`. Absent leaves the endpoint open,
   * which is the default and is right for an internal port — see the handler.
   */
  readonly metricsToken?: string
  /**
   * Browser origins this API answers, from `NACRE_API_ALLOWED_ORIGINS`.
   *
   * Absent means none, which is the default and what every existing deployment
   * has: the admin console is served from this same origin, so it has never
   * needed one.
   *
   * A browser MCP client does: it registers and exchanges its authorization
   * code here, both by `fetch` from a page on another origin, and without this
   * the whole OAuth walk stops after the `401` that starts it. Same list, same
   * rules and the same module as the MCP transport's — see
   * `packages/core/cors.ts`.
   */
  readonly allowedOrigins?: readonly string[]
  /**
   * The RFC 9728 document served at `/.well-known/oauth-protected-resource`.
   *
   * Passed in rather than built here so the API and the MCP transport serve
   * byte-identical bytes: two builders would drift, and a client that read one
   * and authenticated against the other would be audience-bound to a string
   * neither agreed on.
   */
  readonly resourceMetadata?: ProtectedResourceMetadata
  /**
   * The public keys served at `/.well-known/jwks.json`.
   *
   * Absent — which is the default and the case for a deployment signing with
   * `NACRE_JWT_SECRET` — makes the endpoint answer `404`. That is deliberate
   * rather than an omission: a shared secret has no half that is safe to
   * publish.
   */
  readonly jwks?: readonly Record<string, unknown>[]
  /** Absent means the workspace paths answer 404, like any capability a surface lacks. */
  readonly oauth?: OAuthServer
  readonly workspaces?: Workspaces
  readonly embeddingProviders?: EmbeddingProviders
  /**
   * The second factor, when the deployment has a key to seal one with.
   *
   * Optional and absent by default: every installation that has not configured
   * `NACRE_2FA_KEY_REF` answers 404 on this surface and signs in exactly as it
   * did before.
   */
  readonly secondFactors?: SecondFactors
  /** Layer reindex. Absent means the reindex paths answer 404. */
  readonly reindex?: Reindex
  /** The reindex recall gate's query set. Absent means those paths answer 404. */
  readonly referenceQueries?: ReferenceQueries
  /** Reads the access log back. Absent means `/v1/audit` answers 404. */
  readonly auditReader?: AuditReader
  /** `Idempotency-Key` on unsafe methods. Absent means the header is ignored. */
  readonly idempotency?: IdempotencyStore
  /** Email and password sign-in. Absent means `/v1/auth/*` is 404. */
  readonly login?: Login
  readonly documents: Documents
  readonly search: SearchService
  readonly ingest: Ingest
  readonly audit: AuditWriter
  readonly jobs?: Jobs
  readonly layers?: Layers
  readonly grants?: Grants
  readonly serviceAccounts?: ServiceAccountPort
  /** Absent means `/v1/users` answers 404, like any capability a surface lacks. */
  readonly users?: Users
  /** Absent means `/v1/groups` and its membership paths answer 404. */
  readonly groups?: Groups
  /** `NACRE_MAX_DOCUMENT_BYTES`. Over it is `413`, not `400`. */
  readonly maxBodyBytes?: number
  /**
   * Whether this deployment has object storage — `main.ts` sets it from the
   * same fact that builds the S3 client. Binary upload is refused at the edge
   * without it, naming `NACRE_S3_*`: the bytes' only home is the bucket, and
   * the caller should learn that on the request rather than from a `failed`
   * row. Absent means false, which keeps every existing test and every
   * text-only deployment exactly as it was.
   */
  readonly objectStorage?: boolean
  /**
   * `NACRE_AUDIT_QUERY_TEXT`. Absent is the default and means the journal keeps
   * the hash of a query and not the query.
   */
  readonly auditQueryText?: boolean
}

/**
 * The default body cap, in bytes.
 *
 * `NACRE_MAX_DOCUMENT_BYTES` overrides it — the variable was validated at
 * startup and read by nothing, so `docs/api.md` promised 50 MB while the server
 * refused anything over 1 MB, and refused it with a `400` whose message did not
 * mention size. An operator raising the documented limit saw no change.
 */
const MAX_BODY_BYTES = 1_000_000

/** Distinguishable from a malformed body, because the answers differ: 413, not 400. */
class BodyTooLarge extends Error {}

/**
 * `top_k`, clamped to what the contract declares.
 *
 * It was passed through as whatever JSON produced: `1e309` becomes `Infinity`
 * and reached Qdrant's `limit` verbatim, and with reranking on the same number
 * decided how many rows to hydrate from Postgres. Negative and fractional
 * values went through too.
 *
 * Clamped rather than refused. The bound is a resource limit and not a
 * permission one, so a client that asks for more than the maximum is answered
 * with the maximum — the same thing every paginated endpoint here does.
 */
const MAX_TOP_K = 50
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string')

/**
 * A delegation's narrowing, as `POST /v1/oauth/consent` accepts it.
 *
 * Two spellings of the same field, because a bare layer id is what an entry
 * meant before a layer could carry a ceiling of its own — and it still means
 * exactly that, "inherit the connection's ceiling". So the older form is the
 * shorter spelling rather than a compatibility branch to be removed later.
 *
 * `INVALID` rather than `undefined` for a malformed value, because `undefined`
 * is a real answer here: it is "no narrowing", and conflating the two would
 * turn a typo into an application that reaches everything its person does.
 */
const INVALID = Symbol('invalid')

const readNarrowing = (value: unknown): readonly LayerNarrowing[] | undefined | typeof INVALID => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return INVALID

  const out: LayerNarrowing[] = []
  for (const entry of value as readonly unknown[]) {
    if (typeof entry === 'string') {
      out.push({ id: entry })
      continue
    }
    if (typeof entry !== 'object' || entry === null) return INVALID
    const { id, permissions } = entry as { id?: unknown; permissions?: unknown }
    if (typeof id !== 'string') return INVALID
    if (permissions === undefined) {
      out.push({ id })
      continue
    }
    // Empty is refused rather than read as "no ceiling here". A layer the
    // delegation may do nothing in is a layer that should not be in the
    // narrowing at all, and the column's CHECK refuses one too — this is the
    // same rule arriving as a 400 instead of as a constraint violation.
    if (
      !isStringArray(permissions) ||
      permissions.length === 0 ||
      permissions.some((p) => !(PERMISSIONS as readonly string[]).includes(p))
    ) {
      return INVALID
    }
    out.push({ id, permissions: permissions as readonly Permission[] })
  }
  return out
}

const boundedTopK = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 10
  return Math.min(MAX_TOP_K, Math.max(1, Math.floor(value)))
}

const PRINCIPAL_TYPES = ['user', 'group', 'service_account'] as const
const PERMISSIONS = ['read', 'write', 'admin'] as const

function accountJson(a: ServiceAccountView): Record<string, unknown> {
  return {
    id: a.id,
    name: a.name,
    // Never the key. It exists in the create response and nowhere else.
    key_prefix: a.keyPrefix,
    created_at: a.createdAt,
    last_used_at: a.lastUsedAt,
    revoked_at: a.revokedAt,
    // Null on everything created before the column, and on anything `init`
    // made. "My agents" filters on it; a guessed owner would be worse than
    // none.
    created_by: a.createdBy ?? null,
  }
}

function userJson(u: UserView): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    created_at: u.createdAt,
    disabled_at: u.disabledAt,
    // Whether one is set, never anything derived from it. False is an SSO-only
    // account, which is a fact an administrator needs and which says nothing
    // about the credential.
    has_password: u.hasPassword,
  }
}

function groupJson(g: GroupView): Record<string, unknown> {
  return { id: g.id, name: g.name, created_at: g.createdAt, member_count: g.memberCount }
}

function memberJson(m: GroupMember): Record<string, unknown> {
  return { type: m.type, id: m.id, label: m.label }
}

function grantJson(g: GrantRecord): Record<string, unknown> {
  return {
    id: g.id,
    principal_type: g.principalType,
    principal_id: g.principalId,
    scope_type: g.scopeType,
    scope_id: g.scopeId,
    permission: g.permission,
    effect: g.effect,
    source: g.source,
  }
}

/**
 * A grant body, or the reason it is not one.
 *
 * Two of the rejections here are the open/commercial boundary rather than
 * validation. `docs/licensing.md` puts document-level ACLs and deny rules in
 * the commercial half; the core is workspace- and layer-scoped allow-only RBAC.
 * The resolver can already represent both — an enterprise resolver registered
 * through `registerAuthzResolver` produces them — but the core must not issue
 * what it does not implement the propagation for.
 *
 * `400` and not `404`: the caller is an administrator asking for a capability
 * this build does not have, which is not a question about whether an object
 * exists, so invariant I4 has no bearing and saying so plainly is right.
 */
/** Shape only. Existence is the adapter's, and answers `404` rather than `400`. */
const UUID_SHAPE = /^[0-9a-f-]{36}$/i

function parseGrant(body: Record<string, unknown>): GrantInput | string {
  const principalType = body.principal_type
  const principalId = body.principal_id
  const scopeType = body.scope_type
  const scopeId = body.scope_id
  const permission = body.permission
  const effect = body.effect

  if (typeof principalId !== 'string' || typeof scopeId !== 'string') {
    return "'principal_id' and 'scope_id' are required."
  }
  // Shape, here, and existence in the adapter — because the two answers are
  // different and only one of them is allowed to be specific.
  //
  // A value that is not a uuid is a fact about the caller's own request: it
  // discloses nothing, so it gets a `400` naming the field they got wrong.
  // A well-formed uuid that names nothing is `404`, indistinguishable from one
  // they may not administer, which is invariant 4.
  //
  // Collapsing the two is what sent somebody looking at the wrong half of a
  // form: they typed a service account's *name* into `principal_id`, and the
  // only answer was "no such scope" — about the field that was correct.
  if (!UUID_SHAPE.test(principalId)) {
    return "'principal_id' must be a uuid. It is the principal's id, not its name — " +
      'a service account, a user or a group listed in this organization.'
  }
  if (!UUID_SHAPE.test(scopeId)) {
    return "'scope_id' must be a uuid — the id of the workspace or layer being granted on."
  }
  if (typeof principalType !== 'string' || !PRINCIPAL_TYPES.includes(principalType as never)) {
    return `'principal_type' must be one of ${PRINCIPAL_TYPES.join(', ')}.`
  }
  if (typeof permission !== 'string' || !PERMISSIONS.includes(permission as never)) {
    return `'permission' must be one of ${PERMISSIONS.join(', ')}.`
  }
  if (scopeType === 'document') {
    return 'Document-level grants are not available in this build. Grant on the layer or the workspace instead.'
  }
  if (scopeType !== 'workspace' && scopeType !== 'layer') {
    return "'scope_type' must be 'workspace' or 'layer'."
  }
  if (effect !== undefined && effect !== 'allow') {
    return 'Deny rules are not available in this build. Grants are allow-only; remove the grant to revoke it.'
  }

  return {
    principalType: principalType as GrantInput['principalType'],
    principalId,
    scopeType,
    scopeId,
    permission: permission as GrantInput['permission'],
  }
}

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new BodyTooLarge('body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * The body as text, for the one endpoint whose media type is not JSON.
 *
 * RFC 6749 specifies `application/x-www-form-urlencoded` at the token endpoint,
 * so it has to see the bytes rather than a parsed object.
 */
async function readRawBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return (await readRaw(req, limit)).toString('utf8')
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const raw = await readRaw(req, limit)
  if (raw.length === 0) return undefined
  return JSON.parse(raw.toString('utf8'))
}

/**
 * A multipart body, reduced to the same shape a JSON one has.
 *
 * Two things depend on this being a plain object of fields rather than a
 * special case threaded through the handler.
 *
 * The first is T2. `rejectTenantOverride` scans the body for an organization
 * named at any depth, before routing and before validation, and it runs on
 * whatever `body` is. A multipart request whose fields never became `body`
 * would be a second door into the ingest endpoint with that check on the other
 * side of it — which is exactly the shape of hole the rate limiter and the
 * metrics each had when MCP was a second surface.
 *
 * The second is that everything downstream stays one code path: the same
 * required-field checks, the same metadata parsing, the same audit event.
 *
 * The file is kept out of it. Its bytes are not a field, and putting a
 * document body into an object that gets scanned, logged and error-messaged is
 * how content ends up somewhere it should not be.
 */
function multipartBody(parts: readonly MultipartPart[]): {
  fields: Record<string, unknown>
  file?: MultipartPart
} {
  const fields: Record<string, unknown> = {}
  let file: MultipartPart | undefined

  for (const part of parts) {
    // The file is the part with a filename, or the one called `file` — which
    // is what openapi.yaml names it and what every form sends.
    if (part.filename !== undefined || part.name === 'file') {
      if (file !== undefined) {
        throw new MultipartError('more than one file part; a document is one file')
      }
      file = part
      continue
    }
    if (part.name in fields) {
      // Refused rather than last-wins. A repeated field is a caller who
      // believes something different from what would be stored.
      throw new MultipartError(`the field ${part.name} appears more than once`)
    }
    fields[part.name] = Buffer.from(part.bytes).toString('utf8')
  }

  return { fields, ...(file === undefined ? {} : { file }) }
}

/** The wire shape of a reindex, snake case like every other response here. */
function reindexJson(status: ReindexStatus): Record<string, unknown> {
  return {
    layer_id: status.layerId,
    status: status.status,
    phase: status.phase,
    // Both names, because "which model is search using right now" and "which
    // one is being built" are different questions and an operator watching a
    // migration needs to see them move independently.
    current_vector: status.currentVector,
    shadow_vector: status.shadowVector,
    provider_id: status.providerId,
    started_at: status.startedAt,
    finished_at: status.finishedAt,
    total: status.total,
    done: status.done,
    failed: status.failed,
    progress: status.progress,
    error: status.error,
    // `null` and not omitted. Absent would read as "this deployment does not do
    // recall checks"; null says "this migration has not been scored", which for
    // a layer with no reference set is the permanent and correct answer.
    check:
      status.check === null
        ? null
        : {
            recall: status.check.recall,
            floor: status.check.floor,
            passed: status.check.passed,
            queries: status.check.queries,
            scores: status.check.scores.map((s) => ({ query_id: s.queryId, recall: s.recall })),
            ...(status.check.unresolved === undefined
              ? {}
              : { unresolved: [...status.check.unresolved] }),
          },
  }
}

/** One reference query on the wire, snake case like every other response here. */
function referenceQueryJson(q: ReferenceQuery): Record<string, unknown> {
  return { id: q.id, query: q.query, expected: [...q.expected] }
}

/** At most this many queries in a set, and this many expected documents in one. */
const MAX_REFERENCE_QUERIES = 50
const MAX_EXPECTED_PER_QUERY = 10

/**
 * The reference set from a request body.
 *
 * Every bound here is a refusal rather than a truncation, for the reason the
 * multipart parser gives: a truncation is a silent disagreement between what
 * was sent and what got stored, and this one would be measured later as a
 * recall number the operator cannot reconcile with what they wrote.
 *
 * `MAX_EXPECTED_PER_QUERY` is not a size limit, it is `RECALL_K`. A query
 * naming more expected documents than the check retrieves could never score
 * 1.0, so its floor would be unreachable and would read as a regression in the
 * model rather than as a mistake in the set.
 *
 * An empty list is accepted and means "no gate on this layer", which is how a
 * set is removed. Refusing it would leave no way back from having written one.
 */
function parseReferenceQueries(
  body: unknown,
): { queries: { query: string; expected: string[] }[] } | { error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'The body must be an object with a "queries" array.' }
  }
  const raw = (body as Record<string, unknown>)['queries']
  if (!Array.isArray(raw)) return { error: "'queries' must be an array." }
  if (raw.length > MAX_REFERENCE_QUERIES) {
    return { error: `A reference set may hold at most ${MAX_REFERENCE_QUERIES} queries.` }
  }

  const queries: { query: string; expected: string[] }[] = []
  for (const [i, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { error: `queries[${i}] must be an object.` }
    }
    const { query, expected } = entry as Record<string, unknown>
    if (typeof query !== 'string' || query.trim() === '' || query.length > 1024) {
      return { error: `queries[${i}].query must be a string of 1 to 1024 characters.` }
    }
    if (!Array.isArray(expected) || expected.length === 0) {
      return { error: `queries[${i}].expected must be a non-empty array of external ids.` }
    }
    if (expected.length > MAX_EXPECTED_PER_QUERY) {
      return {
        error:
          `queries[${i}].expected may name at most ${MAX_EXPECTED_PER_QUERY} documents, ` +
          'which is how many the check retrieves. A longer list could never score 1.0.',
      }
    }
    if (!expected.every((e) => typeof e === 'string' && e !== '')) {
      return { error: `queries[${i}].expected must hold non-empty external ids.` }
    }
    // Deduplicated rather than refused: a repeated id is a typo with an obvious
    // reading, and leaving it in would divide the score by a denominator the
    // caller did not mean.
    queries.push({ query, expected: [...new Set(expected as string[])] })
  }
  return { queries }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extra: Record<string, string> = {},
): void {
  // 204 means no content, and it meant it while this function wrote the four
  // bytes `null` into the body. Some clients tolerate that and some treat a
  // body on a 204 as a framing error.
  if (status === 204) {
    res.writeHead(204, { 'x-request-id': requestId, ...extra })
    res.end()
    return
  }

  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    'x-request-id': requestId,
    ...extra,
  })
  res.end(json)
}

/**
 * Merge headers into whatever the handler writes, and capture the body.
 *
 * `writeHead` is patched rather than wrapped at each call site because the
 * headers apply to every response on the request, including the ones produced
 * deep inside a handler's error path. `end` is patched to hand the serialized
 * body to the idempotency store — after the response is on the wire, since a
 * cache write must never be what delays an answer.
 */
function decorate(
  res: ServerResponse,
  extra: Record<string, string>,
  store: ((status: number, body: unknown) => Promise<void>) | undefined,
): void {
  if (Object.keys(extra).length === 0 && store === undefined) return

  const writeHead = res.writeHead.bind(res)
  let status = 200

  res.writeHead = ((code: number, ...rest: unknown[]) => {
    status = code
    const headers = rest.find((r) => typeof r === 'object' && r !== null) as
      | Record<string, string>
      | undefined
    return writeHead(code, { ...extra, ...(headers ?? {}) })
  }) as typeof res.writeHead

  if (store === undefined) return

  const end = res.end.bind(res)
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string' && chunk.length > 0) {
      try {
        // Only a JSON body is worth replaying. A 204 has none, and anything
        // else on this API would be a bug rather than a response to cache.
        void store(status, JSON.parse(chunk))
      } catch {
        // Not JSON — nothing to replay, and refusing to answer over it would
        // be absurd.
      }
    } else if (status === 204) {
      void store(status, null)
    }
    return end(chunk as never, ...(rest as []))
  }) as typeof res.end
}

/**
 * Which limit a request counts against, or none.
 *
 * Search and ingest are the two the contract names, and they are the two that
 * cost real money — an embedding call each. Reads of metadata are cheap and are
 * not counted; adding them later means adding a policy, not restructuring this.
 */
function resourceFor(method: string, instance: string): Resource | undefined {
  if (method === 'POST' && instance === '/v1/search') return 'search'
  if (method === 'POST' && instance === '/v1/documents') return 'ingest'
  return undefined
}

/**
 * Paths whose responses must never enter the idempotency cache.
 *
 * `/v1/service-accounts` is here because its response carries the key itself,
 * once, and the key is stored hashed precisely so that it cannot be recovered
 * from the database or from a backup. Caching that response puts the plaintext
 * key in Redis for 24 hours and undoes the whole reason for hashing it — a
 * convenience feature quietly weakening a credential store. The endpoint is
 * already safe to retry without a cache: the unique name constraint answers a
 * duplicate with `409` rather than minting a second key.
 *
 * `/v1/documents` is here for a different reason and not a security one: it is
 * already idempotent on `(layer, external_id)` and the content hash, which
 * survives this cache expiring and is therefore the stronger guarantee.
 * Wrapping it would add a weaker one on top and a second thing to reason about.
 *
 * `/v1/search` is here because it is the one response made entirely of other
 * people's documents. Caching it put chunk text in Redis for 24 hours — the
 * defect already found once with service account keys, on the endpoint that
 * returns the most sensitive thing in the product. A search is also safe to
 * repeat by definition, so idempotency bought it nothing in the first place.
 *
 * The test for adding a path: **would the response be a problem in a cache
 * dump?** If a response is only ever shown once on purpose, or is assembled
 * from what one caller in particular may read, it does not go in a store with a
 * 24-hour TTL and no access control of its own.
 */
const NEVER_CACHED: readonly string[] = ['/v1/service-accounts', '/v1/documents', '/v1/search']

/** Prefix rather than exact match, so `/v1/service-accounts/{id}` is covered too. */
const neverCached = (instance: string): boolean =>
  NEVER_CACHED.some((path) => instance === path || instance.startsWith(`${path}/`))

/**
 * `/v1/auth/*`: the endpoints that exist to produce a credential.
 *
 * Separate from `handle` because everything there assumes an `AuthContext`, and
 * these three run before there is one. The refusals are deliberately
 * indistinguishable: unknown address, wrong password, wrong organization,
 * disabled account and an account with no password set are one `401` with one
 * message, and `Login` spends the same time on each.
 *
 * Rate limited on the address rather than the organization, because there is no
 * organization yet and because the thing being defended against is guessing one
 * account's password. That is the one limit keyed on something a caller
 * chooses, so it is normalized and hashed into the key rather than used raw —
 * an unbounded string from an unauthenticated request should not become a Redis
 * key, and an operator reading `KEYS nacre:rl:*` should not be reading a list
 * of who has an account here.
 */
async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
  instance: string,
  requestId: string,
  options: ApiOptions,
): Promise<void> {
  if (options.login === undefined || req.method !== 'POST') {
    const problem = notFound(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
    return
  }

  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    const problem = badRequest(instance, requestId, 'The request body could not be read.')
    send(res, problem.status, problem.toJSON(), requestId)
    return
  }

  const refuse = (): void => {
    const problem = new Problem({
      type: 'https://nacre.work/errors/unauthorized',
      title: 'Unauthorized',
      status: 401,
      // One message for every reason. A wrong password and an address with no
      // account must not be tellable apart, or this endpoint enumerates users.
      detail: 'Those credentials are not valid.',
      instance,
      requestId,
    })
    send(res, problem.status, problem.toJSON(), requestId)
  }

  if (instance === '/v1/auth/login') {
    const { email, password, organization } = (body ?? {}) as {
      email?: unknown
      password?: unknown
      organization?: unknown
    }
    if (typeof email !== 'string' || typeof password !== 'string') {
      const problem = badRequest(instance, requestId, "'email' and 'password' are required.")
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }

    if (options.limits !== undefined && options.limitPolicies?.login !== undefined) {
      // Two limits, on two different things, because either alone leaves a
      // hole. The address limit stops one account being ground down; on its own
      // it does nothing about the attack that is actually run, which is one
      // password against a directory — that never repeats an address and never
      // meets the limit. The source limit bounds that; on its own it would
      // over-trust topology, because an office behind one NAT is one source.
      //
      // Checked in that order and reported as one 429 with the address limit's
      // headers, which is the tighter of the two: the alternative is a response
      // whose RateLimit-Remaining depends on which limit fired, and that is a
      // signal about other people's traffic.
      const subject = createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 32)
      const source = clientSource(req, { trustProxy: options.trustProxy ?? 0 })

      const decisions = [await options.limits.check(subject, 'login')]
      // `undefined` means the transport gave no address to key on. Skipped
      // rather than folded into a shared bucket — one bucket for every client
      // that cannot be identified is a denial of service with extra steps.
      if (source !== undefined && options.limitPolicies.login_source !== undefined) {
        decisions.push(await options.limits.check(`src:${source}`, 'login_source'))
      }

      const refused = decisions.find((d) => !d.allowed)
      if (refused !== undefined) {
        const problem = new Problem({
          type: 'https://nacre.work/errors/rate-limited',
          title: 'Too many requests',
          status: 429,
          detail: `Too many sign-in attempts. Try again in ${refused.reset} seconds.`,
          instance,
          requestId,
        })
        send(
          res,
          problem.status,
          problem.toJSON(),
          requestId,
          limitHeaders(decisions[0] as LimitDecision, options.limitPolicies.login, 'login'),
        )
        return
      }
    }

    let outcome: LoginOutcome | undefined
    try {
      outcome = await options.login.login({
        email,
        password,
        ...(typeof organization === 'string' ? { organization } : {}),
      })
    } catch (error) {
      // The process is already verifying as many passwords as it will. scrypt
      // runs on libuv's thread pool, which is shared with DNS and file I/O, so
      // an unbounded login endpoint stops the *rest* of the API on a name
      // lookup — see the gate in core/passwords.ts.
      //
      // 503 and not 401: nothing was decided about these credentials, and
      // answering "not valid" to a request that was never checked is a lie the
      // client will act on. 503 with Retry-After is the honest one.
      //
      // Not an oracle either. It depends on how loaded the process is and not
      // at all on whether the account exists.
      if (error instanceof TooBusy) {
        const problem = new Problem({
          type: 'https://nacre.work/errors/unavailable',
          title: 'Service unavailable',
          status: 503,
          detail: 'Too many sign-in attempts are being processed. Try again shortly.',
          instance,
          requestId,
        })
        send(res, problem.status, problem.toJSON(), requestId, { 'retry-after': '2' })
        return
      }
      throw error
    }

    if (outcome === undefined) {
      // Logged rather than audited, and the difference is not laziness. The
      // audit log is per-organization; an address that matches no user belongs
      // to no tenant, and giving that row an owner would put one
      // organization's failed attempts into another's access log. A security
      // team watching for password spraying wants this across the whole
      // installation anyway, which is what a log line is.
      //
      // The address, never the password, and never how far the attempt got —
      // "no such user" and "wrong password" must not be tellable apart from a
      // log any more than from a response.
      logger.warn('sign-in refused', { email: email.trim().toLowerCase(), request_id: requestId })
      refuse()
      return
    }

    /*
     * A correct password and a second factor to produce.
     *
     * Not an audit event yet, and not a `login` one whatever happens next: this
     * is half of an authentication, and writing "login allow" here would put a
     * successful sign-in in the journal for somebody who never produced their
     * code. The event is written where the session is issued.
     *
     * 200 rather than 401, because nothing was refused — the client is being
     * asked for the rest of what it needs, which is what `second_factor_required`
     * says.
     */
    if (outcome.kind === 'second-factor') {
      send(
        res,
        200,
        {
          second_factor_required: true,
          challenge: outcome.challenge,
          expires_in: outcome.expiresIn,
        },
        requestId,
      )
      return
    }

    const tokens = outcome.tokens

    // The successful one does have an organization to belong to, and it is the
    // event that answers "who has been in here". Awaited: a lost audit event is
    // worse than a slow response.
    await options.audit.write({
      orgId: tokens.orgId,
      actor: `user:${tokens.userId}`,
      action: 'login',
      result: 'allow',
      target: { user_id: tokens.userId },
      detail: {},
      requestId,
    })

    send(res, 200, tokenJson(tokens), requestId)
    return
  }

  /*
   * The second half of a sign-in.
   *
   * Rate limited on the same buckets as `/v1/auth/login`, because otherwise the
   * limit is a limit on passwords and not on sessions: an attacker holding a
   * password spends one login and then guesses six digits here without ever
   * meeting a bucket again. The per-factor lock in Postgres is the bound that
   * survives a Redis restart; this one is the bound that costs an attacker
   * their source.
   */
  if (instance === '/v1/auth/second-factor') {
    const { challenge, code } = (body ?? {}) as { challenge?: unknown; code?: unknown }
    if (typeof challenge !== 'string' || typeof code !== 'string') {
      const problem = badRequest(instance, requestId, "'challenge' and 'code' are required.")
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }

    if (options.limits !== undefined && options.limitPolicies?.login !== undefined) {
      const source = clientSource(req, { trustProxy: options.trustProxy ?? 0 })
      if (source !== undefined && options.limitPolicies.login_source !== undefined) {
        const decision = await options.limits.check(`src:${source}`, 'login_source')
        if (!decision.allowed) {
          const problem = new Problem({
            type: 'https://nacre.work/errors/rate-limited',
            title: 'Too many requests',
            status: 429,
            detail: `Too many sign-in attempts. Try again in ${decision.reset} seconds.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }
    }

    const tokens = await options.login.completeSecondFactor(challenge, code)
    if (tokens === undefined) {
      // One refusal for an expired challenge, a forged one, a wrong code and a
      // disabled account alike. Which of the four it was is nothing a client
      // needs and something an attacker would use.
      logger.warn('second factor refused', { request_id: requestId })
      refuse()
      return
    }

    await options.audit.write({
      orgId: tokens.orgId,
      actor: `user:${tokens.userId}`,
      action: 'login',
      result: 'allow',
      target: { user_id: tokens.userId },
      // The journal says which door, because "signed in with a second factor"
      // and "signed in with a password" are different facts to an investigator.
      detail: { second_factor: true },
      requestId,
    })

    send(res, 200, tokenJson(tokens), requestId)
    return
  }

  const token = (body as { refresh_token?: unknown } | undefined)?.refresh_token
  if (typeof token !== 'string' || token === '') {
    const problem = badRequest(instance, requestId, "'refresh_token' is required.")
    send(res, problem.status, problem.toJSON(), requestId)
    return
  }

  if (instance === '/v1/auth/refresh') {
    const tokens = await options.login.refresh(token)
    if (tokens === undefined) {
      refuse()
      return
    }
    send(res, 200, tokenJson(tokens), requestId)
    return
  }

  if (instance === '/v1/auth/logout') {
    // 204 whether or not the token was live. Saying "that token did not exist"
    // tells whoever is holding a stolen one whether it is still worth using.
    await options.login.logout(token)
    send(res, 204, null, requestId)
    return
  }

  const problem = notFound(instance, requestId)
  send(res, problem.status, problem.toJSON(), requestId)
}

function tokenJson(tokens: Tokens): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: 'Bearer',
    expires_in: tokens.expiresIn,
    refresh_token: tokens.refreshToken,
  }
}

export function createApi(options: ApiOptions): Server {
  // Applied once, here, so every event this surface records reaches a module's
  // sinks whatever adapter is behind the port. It used to live inside the
  // Postgres adapter, which made forwarding a property of how an event was
  // stored rather than of it having been stored.
  const withSinks: ApiOptions = {
    ...options,
    audit: withAuditSinks(options.audit, (sink, event, error) => {
      logger.warn('audit sink failed; the event is still in the table', {
        sink,
        action: event.action,
        error: String(error).slice(0, 200),
      })
    }),
  }

  return createServer((req, res) => {
    void handle(req, res, withSinks).catch(() => {
      // handle() converts everything it can into a Problem. Reaching here means
      // the failure was in the error path itself; say nothing about it.
      if (!res.headersSent) send(res, 500, internal(req.url ?? '/', 'unknown').toJSON(), 'unknown')
    })
  })
}

async function handle(req: IncomingMessage, res: ServerResponse, options: ApiOptions): Promise<void> {
  const requestId = randomUUID()
  const url = new URL(req.url ?? '/', 'http://localhost')
  const instance = url.pathname

  // ── admitting a browser ─────────────────────────────────────────────────
  //
  // Set before anything routes, so every reply carries them — including the
  // `401` a client reads `WWW-Authenticate` off to find the discovery document.
  // `writeHead` merges what it is given over what is set here, and nothing
  // below writes an `access-control-*` header.
  //
  // Empty is the default: no header is emitted and a preflight is a `404` like
  // any other unrouted method, which is exactly what this API did before.
  const allowedOrigins = options.allowedOrigins ?? []
  const cors = corsHeaders(req.headers.origin, allowedOrigins)
  for (const [name, value] of Object.entries(cors)) res.setHeader(name, value)

  if (isPreflight(req.method)) {
    const origin = req.headers.origin
    if (origin === undefined || !allowedOrigins.includes(origin)) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    res.writeHead(
      204,
      preflightHeaders({
        origin,
        methods: 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        // What this API reads *on top of* what every MCP client sends. That
        // shared set is not optional here: this API serves the two `/.well-known`
        // documents a browser MCP client reads, and the SDK puts
        // `mcp-protocol-version` on those requests too.
        //
        // `idempotency-key` is the one the MCP transport has never heard of, and
        // a browser that may not send it cannot make the retry-safe call the
        // contract asks for.
        headers: allowedRequestHeaders(['idempotency-key', 'if-none-match']),
      }),
    )
    res.end()
    return
  }

  if (req.method === 'GET' && instance === '/metrics') {
    // Unauthenticated by default, like every Prometheus endpoint, and therefore
    // carrying nothing that is not already a count. No document ids, no query
    // text, no organization ids — organizations appear by slug, which is in the
    // URL of every request that tenant makes anyway.
    //
    // A token is available and off unless configured. Requiring one would break
    // every existing scrape config for a product people self-host, and the
    // default is right for the deployment this is designed around: the port is
    // on an internal network. It stops being right the moment somebody puts the
    // API behind a public ingress without carving this path out, which is a
    // thing that happens — so `NACRE_METRICS_TOKEN` exists for the operator who
    // knows they are in that situation. See docs/config.md.
    if (options.metrics === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }

    if (options.metricsToken !== undefined) {
      const header = req.headers.authorization
      const presented = header?.startsWith('Bearer ') === true ? header.slice(7) : undefined
      // Constant time, and length-checked first because timingSafeEqual throws
      // on a mismatch. A scrape token is a credential like any other.
      const expected = Buffer.from(options.metricsToken, 'utf8')
      const given = Buffer.from(presented ?? '', 'utf8')
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        // 404 rather than 401, for the same reason invariant 4 gives: a
        // deployment that hides its metrics endpoint should not confirm it has
        // one. There is nothing to authenticate *into* here, so a challenge
        // would only say "keep guessing".
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
    }
    const body = await options.metrics.render()
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
    return
  }

  if (req.method === 'GET' && instance === PROTECTED_RESOURCE_PATH) {
    // RFC 9728 discovery, and unauthenticated by definition: it is what a
    // client reads *because* it has no credential yet. Every 401 from the MCP
    // transport names this path in `WWW-Authenticate`, and nothing served it —
    // so a client doing exactly what the header told it to got a 404.
    //
    // Absent means the deployment did not configure a canonical URL, which
    // cannot happen: it is required at startup.
    if (options.resourceMetadata === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    send(res, 200, options.resourceMetadata as unknown as Record<string, unknown>, requestId)
    return
  }

  /**
   * RFC 8414 — where a client finds the two endpoints.
   *
   * Served only when this deployment runs the authorization server. Absent, the
   * discovery below still answers and simply names no `authorization_servers`,
   * which is the resource-server-only shape this product had before and still
   * supports: a deployment with its own identity provider names that instead.
   */
  if (req.method === 'GET' && instance === AUTHORIZATION_SERVER_PATH) {
    if (options.oauth === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    send(
      res,
      200,
      authorizationServerMetadata(options.oauth.issuer) as unknown as Record<string, unknown>,
      requestId,
    )
    return
  }

  if (req.method === 'GET' && instance === JWKS_PATH) {
    // The public half of the signing key, so anything outside this process can
    // verify a token without a secret — a gateway, a sidecar, a second service
    // in the same deployment.
    //
    // Unauthenticated, like every other `/.well-known` document, and that is
    // not a concession: a public key is public. What would be a leak is the
    // other mode, which is exactly why this answers `404` for a deployment
    // signing with `NACRE_JWT_SECRET`. A shared secret has no publishable half,
    // and an endpoint that "helpfully" served one would be serving the key that
    // mints tokens.
    if (options.jwks === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    send(res, 200, { keys: options.jwks }, requestId)
    return
  }

  if (req.method === 'GET' && instance === '/v1/health') {
    // Liveness touches no dependency. A health check that calls Postgres turns
    // one slow database into a cascading restart loop.
    send(res, 200, { status: 'ok' }, requestId)
    return
  }

  if (req.method === 'GET' && instance === '/v1/ready') {
    // Readiness, which is the opposite of liveness and touches everything this
    // process cannot serve a request without.
    //
    // `docs/config.md` has told operators to point a Kubernetes readinessProbe
    // here since before there was a server, and the path answered `401` — it
    // fell through to the authenticator, so the probe never succeeded and the
    // rollout never completed. Unauthenticated for the same reason `/metrics`
    // is: a probe has no credential to present, and the body says only which
    // dependency is unhappy, never why.
    //
    // `503` rather than `200` with a body to parse. An orchestrator reads the
    // status code, and a readiness endpoint that answers 200 while saying it is
    // not ready is a readiness endpoint that does nothing.
    if (options.ready === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    const checks = await options.ready()
    const ok = Object.values(checks).every(Boolean)
    send(res, ok ? 200 : 503, { status: ok ? 'ready' : 'not ready', checks }, requestId)
    return
  }

  // Sign-in, before authentication, because it is what produces the credential
  // everything below this line requires.
  //
  // `rejectTenantOverride` does not apply here and must not: it refuses a body
  // naming an organization, and naming one is exactly what a login on a
  // multi-organization installation is allowed to do. The invariant is kept a
  // different way — see login.ts. The organization in the issued token comes
  // from the row that authenticated, never from the request.
  if (instance.startsWith('/v1/auth/')) {
    await handleAuth(req, res, instance, requestId, options)
    return
  }

  // A path this server does not route is `404`, and it says so **before**
  // asking for a credential.
  //
  // Everything unauthenticated is already handled above — `/metrics`, the two
  // `/.well-known` documents, health, readiness, sign-in. So anything left that
  // is not under `/v1/` is not part of this API at all, and answering `401`
  // for it claims a path exists and is merely gated.
  //
  // That is not a hypothetical reading. A client pointed at this port looking
  // for an MCP endpoint probed `/.well-known/oauth-authorization-server`,
  // `/.well-known/openid-configuration` and `/register`, got `401 "A bearer
  // token is required"` from each, and concluded the deployment had OAuth
  // discovery behind a middleware that needed lifting. There is no such
  // middleware and there are no such routes: this is a resource server and
  // declines the authorization-server role — see docs/mcp.md. An afternoon
  // went into un-gating endpoints that do not exist.
  //
  // Unknown paths *under* `/v1/` still answer `401`, and that is the line
  // rather than an omission: they are inside the authenticated surface, where
  // presenting a credential is the price of being told anything. Nothing is
  // concealed by it — every route this API serves is in docs/openapi.yaml.
  // ─────────────────────── the authorization server ───────────────────────
  //
  // Three endpoints, and one decision running through all of them: the token
  // this flow issues acts as whatever the *person* chose at consent — as them,
  // or as an agent. Both are offered because they are different acts. A
  // delegation reaches exactly what its person reaches and is recomputed every
  // request; an agent is a principal with its own grants, and collapsing "what
  // may this agent read" into "what may you read" would throw away the
  // distinction this whole product is built on.
  //
  // Unauthenticated by necessity — a client arrives here with no credential,
  // which is what it came to get. Authority is created at exactly one point:
  // `POST /v1/oauth/consent`, which is inside the authenticated surface and is
  // where a signed-in person makes that choice.
  if (options.oauth !== undefined && (instance === REGISTER_PATH || instance === AUTHORIZE_PATH || instance === TOKEN_PATH)) {
    const oauth = options.oauth

    // RFC 7591. Open, which is what an MCP client expects and what the RFC is
    // for; the exposure is bounded by the fact that a client row permits
    // nothing at all. It becomes authority only when somebody signs in and
    // approves it, and the consent screen shows the redirect URI beside the
    // self-asserted name, because the URI is what actually decides where a code
    // goes.
    if (instance === REGISTER_PATH) {
      if (req.method !== 'POST') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // Read here rather than by the shared parse below: this endpoint sits
      // ahead of the authenticated surface, which is where that happens.
      let posted: unknown
      try {
        posted = await readBody(req)
      } catch {
        send(res, 400, { error: 'invalid_request', error_description: 'The request body could not be read.' }, requestId)
        return
      }
      const registration = (posted ?? {}) as { client_name?: unknown; redirect_uris?: unknown }
      const uris = Array.isArray(registration.redirect_uris)
        ? registration.redirect_uris.filter((u): u is string => typeof u === 'string')
        : []
      if (uris.length === 0) {
        send(res, 400, { error: 'invalid_redirect_uri', error_description: "'redirect_uris' is required." }, requestId)
        return
      }
      // Checked at registration as well as at authorize. A URI that could never
      // receive a code is better refused now, when there is somebody to tell,
      // than at the redirect, when the failure is a blank browser tab.
      if (!uris.every((u) => redirectAllowed(u, uris))) {
        send(
          res,
          400,
          {
            error: 'invalid_redirect_uri',
            error_description:
              'Every redirect URI must be https, or http on loopback (127.0.0.1, [::1], localhost).',
          },
          requestId,
        )
        return
      }
      const name = typeof registration.client_name === 'string' ? registration.client_name.slice(0, 200) : 'unnamed client'
      const clientId = generateClientId()
      await oauth.clients.register(name, uris, clientId)
      // 201 and the RFC's field names. No secret: this is a public client and
      // PKCE is what binds the exchange, so issuing one would be theatre.
      send(res, 201, { client_id: clientId, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none' }, requestId)
      return
    }

    // The authorize endpoint hands the browser to the consent screen and does
    // nothing else. Nothing is written here: an unapproved authorization
    // request is a set of query parameters the browser is already carrying, and
    // storing it would add a table any unauthenticated caller could fill.
    if (instance === AUTHORIZE_PATH) {
      if (req.method !== 'GET') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      const q = url.searchParams
      const clientId = q.get('client_id') ?? ''
      const redirectUri = q.get('redirect_uri') ?? ''
      const client = clientId === '' ? undefined : await oauth.clients.find(clientId)

      // These two are the only errors that must **not** redirect. RFC 6749 is
      // explicit and the reason is worth stating: an unvalidated redirect URI
      // is exactly what an attacker supplies, so bouncing an error to it would
      // make this endpoint an open redirector.
      if (client === undefined) {
        send(res, 400, { error: 'invalid_client', error_description: 'Unknown client_id.' }, requestId)
        return
      }
      if (!redirectAllowed(redirectUri, client.redirectUris)) {
        send(
          res,
          400,
          { error: 'invalid_redirect_uri', error_description: 'redirect_uri does not match a registered value.' },
          requestId,
        )
        return
      }

      const challenge = q.get('code_challenge') ?? ''
      const method = q.get('code_challenge_method') ?? ''
      const back = (error: string, description: string): void => {
        const to = new URL(redirectUri)
        to.searchParams.set('error', error)
        to.searchParams.set('error_description', description)
        const state = q.get('state')
        if (state !== null) to.searchParams.set('state', state)
        res.writeHead(302, { location: to.toString() })
        res.end()
      }
      if (q.get('response_type') !== 'code') {
        back('unsupported_response_type', 'Only the authorization code flow is supported.')
        return
      }
      // S256 only. `plain` is in RFC 7636 and defeats it — the verifier travels
      // in the clear, so anybody holding the code holds the challenge too.
      if (method !== 'S256' || challenge === '') {
        back('invalid_request', 'PKCE with code_challenge_method=S256 is required.')
        return
      }

      // Straight to the consent screen. `consentRedirect` carries the rule that
      // the fragment is a route and the request is appended to it — see the
      // note there for what assigning it outright did.
      res.writeHead(302, { location: consentRedirect(oauth.consentUrl, q) })
      res.end()
      return
    }

    // The exchange. A code, a verifier, and the redirect URI it was issued for.
    if (instance === TOKEN_PATH) {
      if (req.method !== 'POST') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // `application/x-www-form-urlencoded` is what RFC 6749 specifies and what
      // every client sends; JSON is accepted too because some send that and
      // refusing it would be a conformance point nobody benefits from.
      let form: Record<string, unknown>
      try {
        const raw = await readRawBody(req)
        form =
          (req.headers['content-type'] ?? '').includes('json')
            ? ((JSON.parse(raw) ?? {}) as Record<string, unknown>)
            : Object.fromEntries(new URLSearchParams(raw))
      } catch {
        send(res, 400, { error: 'invalid_request', error_description: 'The request body could not be read.' }, requestId)
        return
      }
      const fail = (error: string, description: string): void => {
        send(res, 400, { error, error_description: description }, requestId)
      }
      // The refresh grant, which is what makes a connection endable. An access
      // token is a JWT verified against a key, so nothing can take one back
      // before it expires; the refresh token is stored, and revoking the
      // connection deletes it. The access token then outlives a revocation by
      // at most its own TTL, which is bounded and stated rather than forever.
      if (form.grant_type === 'refresh_token') {
        const presented = typeof form.refresh_token === 'string' ? form.refresh_token : ''
        if (presented === '') {
          fail('invalid_request', "'refresh_token' is required.")
          return
        }
        const rotated = await oauth.refreshTokens.rotate(presented)
        if (rotated === 'suspended') {
          // The one refusal that is not final, and therefore the one that must
          // not be `invalid_grant`.
          //
          // Disabling a person suspends their delegations and deliberately does
          // **not** spend the refresh token, so that re-enabling them is a
          // restoration rather than a reconnection. That promise was
          // unreachable: `invalid_grant` is RFC 6749's "this grant is dead", so
          // every conforming client discarded the token the server had gone out
          // of its way to keep, and the connection could only ever come back
          // through the consent screen. Found by driving the whole flow —
          // connect, disable, re-enable — against a running server.
          //
          // `503` with `Retry-After` is what an HTTP client already understands
          // as "not now, ask again", so a client that has never heard of
          // `temporarily_unavailable` still does the right thing: RFC 6749 does
          // not define that code for this endpoint, and §8.5 is what permits
          // one, but the status is what carries the behaviour.
          //
          // It does say more than the other refusals do — a holder learns the
          // account is suspended rather than that the token is bad. That is
          // accepted rather than overlooked: the holder is an application the
          // person connected, the same fact is on their sign-in screen, and the
          // alternative is a control that reads as reversible and is not.
          send(
            res,
            503,
            {
              error: 'temporarily_unavailable',
              error_description:
                'The person this connection acts as is currently disabled. This is not permanent and the ' +
                'refresh token has not been spent — try again later.',
            },
            requestId,
            { 'retry-after': '60', 'cache-control': 'no-store', pragma: 'no-cache' },
          )
          return
        }
        if (rotated === undefined) {
          // One answer for expired, revoked, unknown and replayed. A client can
          // act on exactly one thing — start the flow again — and telling them
          // apart would say whether a token ever existed.
          fail('invalid_grant', 'The refresh token is unknown, expired, already used, or the connection was ended.')
          return
        }
        const next = generateCode()
        await oauth.refreshTokens.issue(
          rotated.orgId,
          rotated.consentId,
          next,
          rotated.family,
          new Date(Date.now() + oauth.refreshTtlSeconds * 1000),
        )
        const issued = await oauth.mint(rotated)
        send(
          res,
          200,
          {
            access_token: issued.accessToken,
            token_type: 'Bearer',
            expires_in: issued.expiresIn,
            refresh_token: next,
          },
          requestId,
          { 'cache-control': 'no-store', pragma: 'no-cache' },
        )
        return
      }

      if (form.grant_type !== 'authorization_code') {
        fail('unsupported_grant_type', 'Only authorization_code and refresh_token are supported.')
        return
      }
      const code = typeof form.code === 'string' ? form.code : ''
      const verifier = typeof form.code_verifier === 'string' ? form.code_verifier : ''
      if (code === '' || verifier === '') {
        fail('invalid_request', "'code' and 'code_verifier' are required.")
        return
      }

      // Consumed here whether or not the checks below pass, and deliberately:
      // a code presented with a wrong verifier is a code that has been in the
      // wrong hands, and the safe response is to spend it.
      const approved = await oauth.authorizations.redeem(code)
      if (approved === undefined) {
        fail('invalid_grant', 'The code is unknown, expired, or already used.')
        return
      }
      if (!verifierMatches(verifier, approved.codeChallenge)) {
        fail('invalid_grant', 'The code_verifier does not match the challenge.')
        return
      }
      if (typeof form.client_id === 'string' && form.client_id !== approved.clientId) {
        fail('invalid_grant', 'The code was issued to another client.')
        return
      }
      if (typeof form.redirect_uri === 'string' && form.redirect_uri !== approved.redirectUri) {
        fail('invalid_grant', 'The redirect_uri does not match the one the code was issued for.')
        return
      }

      const token = await oauth.mint(approved)

      // A refresh token, hung on the standing connection. Without one the
      // client's access simply stops at the TTL and it has to send somebody
      // back through consent — and, more to the point, there would be nothing
      // to revoke when they end the connection.
      //
      // Absent for a code from before consents existed: those rows carry no
      // connection, and issuing a refresh token against nothing would create
      // access with no record and no way to end it.
      let refresh: string | undefined
      if (approved.consentId !== undefined) {
        refresh = generateCode()
        await oauth.refreshTokens.issue(
          approved.orgId,
          approved.consentId,
          refresh,
          undefined,
          new Date(Date.now() + oauth.refreshTtlSeconds * 1000),
        )
      }

      // `no-store`, which RFC 6749 requires of this response and which matters
      // more here than usual: the body is a bearer token and a caching proxy
      // that keeps it hands it to whoever asks next.
      send(
        res,
        200,
        {
          access_token: token.accessToken,
          token_type: 'Bearer',
          expires_in: token.expiresIn,
          ...(refresh === undefined ? {} : { refresh_token: refresh }),
        },
        requestId,
        { 'cache-control': 'no-store', pragma: 'no-cache' },
      )
      return
    }
  }

  if (!instance.startsWith('/v1/')) {
    const problem = notFound(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
    return
  }

  const auth = await authenticate(req.headers.authorization, options.verify, instance, requestId)
  if (auth instanceof Problem) {
    // Counted by what was presented, never by why it failed.
    //
    // `authenticate` answers one 401 with one message for every reason, on
    // purpose — "revoked key" and "wrong audience" and "expired" must not be
    // tellable apart by a caller. A label carrying the reason would put that
    // distinction back on an endpoint that is unauthenticated by default, so
    // this counts the *kind of credential* instead, which is what an operator
    // actually needs and what no caller learns anything from.
    //
    // Rotating the signing key is the case it exists for: every outstanding
    // access token 401s at once and there is no dual-key window, so an operator
    // needs to watch that spike drain. Nothing here logs requests, so before
    // this there was no way to see it at all.
    const presented = req.headers.authorization
    const kind =
      presented === undefined || !presented.startsWith('Bearer ')
        ? 'missing'
        : presented.slice(7).startsWith('nacre_sk_')
          ? 'service_key'
          : 'jwt'
    options.observe?.authFailures.inc({ kind })
    send(res, auth.status, auth.toJSON(), requestId)
    return
  }

  let body: unknown
  // Held aside from `body` on purpose — see multipartBody.
  let uploaded: MultipartPart | undefined
  let wasMultipart = false
  try {
    const limit = options.maxBodyBytes ?? MAX_BODY_BYTES
    const boundary = multipartBoundary(req.headers['content-type'])
    if (boundary === undefined) {
      body = await readBody(req, limit)
    } else {
      const reduced = multipartBody(parseMultipart(await readRaw(req, limit), boundary))
      body = reduced.fields
      uploaded = reduced.file
      wasMultipart = true
    }
  } catch (error) {
    // 413 for size and 400 for anything else. They were one answer, and the
    // message said neither — a caller over the limit was told their body could
    // not be read, which is true and useless.
    const problem =
      error instanceof BodyTooLarge
        ? new Problem({
            type: 'https://nacre.work/errors/payload-too-large',
            title: 'Payload too large',
            status: 413,
            detail: `The request body is over the ${options.maxBodyBytes ?? MAX_BODY_BYTES} byte limit set by NACRE_MAX_DOCUMENT_BYTES.`,
            instance,
            requestId,
          })
        : error instanceof MultipartError
          ? // Named, because every one of them is a caller mistake with a fix,
            // and "the request body could not be read" sends them looking at
            // their bytes rather than at their boundary.
            badRequest(instance, requestId, `${error.message}.`)
          : badRequest(instance, requestId, 'The request body could not be read.')
    send(res, problem.status, problem.toJSON(), requestId)
    return
  }

  // T2. Before routing, before validation: a request that names an organization
  // is not a malformed request, it is an attempt to act as another tenant.
  const override = rejectTenantOverride(body, url.searchParams, req.headers, instance, requestId)
  if (override !== undefined) {
    await options.audit.write({
      orgId: auth.orgId,
      actor: `${auth.principal.type}:${auth.principal.id}`,
      action: 'tenant_override_attempt',
      result: 'deny',
      target: { path: instance },
      detail: {},
      requestId,
    })
    send(res, override.status, override.toJSON(), requestId)
    return
  }

  // Rate limiting, after the token is verified and before any work is done.
  //
  // After verification because the limit is per organization and the
  // organization comes from the token — there is nothing to count against
  // until it has been read. Before the handler because the point is to refuse
  // before spending an embedding call.
  //
  // The headers go on the successful response too. A client that only learns
  // its budget by being refused has to be refused to learn it.
  let rateHeaders: Record<string, string> = {}
  const resource = resourceFor(req.method ?? 'GET', instance)
  if (resource !== undefined && options.limits !== undefined && options.limitPolicies !== undefined) {
    const decision = await options.limits.check(auth.orgId, resource)
    rateHeaders = limitHeaders(decision, options.limitPolicies[resource], resource)

    if (!decision.allowed) {
      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'rate_limited',
        result: 'deny',
        target: { resource },
        detail: { limit: decision.limit },
        requestId,
      })
      const problem = new Problem({
        type: 'https://nacre.work/errors/rate-limited',
        title: 'Too many requests',
        status: 429,
        detail: `The ${resource} limit for this organization is ${decision.limit} per ${
          options.limitPolicies[resource].windowSeconds
        } seconds. Try again in ${decision.reset} seconds.`,
        instance,
        requestId,
      })
      send(res, problem.status, problem.toJSON(), requestId, rateHeaders)
      return
    }
  }

  // Idempotency-Key, for the unsafe methods that are not already idempotent.
  const idempotencyKey = req.headers['idempotency-key']
  let storeIdempotent: ((status: number, value: unknown) => Promise<void>) | undefined

  if (
    typeof idempotencyKey === 'string' &&
    idempotencyKey.length > 0 &&
    options.idempotency !== undefined &&
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method ?? '') &&
    !neverCached(instance)
  ) {
    const outcome = await options.idempotency.begin(
      idempotencyKey,
      // The principal, not just the organization. Two principals in one tenant
      // see different things, so a response cached for one must never be
      // replayed to another — a replay is sent before any handler runs, so
      // there is no permission check left to catch it.
      { orgId: auth.orgId, type: auth.principal.type, id: auth.principal.id },
      req.method ?? '',
      instance,
      body,
    )

    if (isReplay(outcome)) {
      // `send` drops the body on a 204, so a replayed delete replays as a
      // delete rather than as a 204 with `null` in it.
      send(res, outcome.cached.status, outcome.cached.body, requestId, {
        ...rateHeaders,
        'idempotency-replayed': 'true',
      })
      return
    }

    if (isConflict(outcome)) {
      // The same key with a different body, or the first attempt still running.
      // Replaying a response that does not match what was asked for — or does
      // not exist yet — is worse than saying so.
      const problem = new Problem({
        type: 'https://nacre.work/errors/conflict',
        title: 'Conflict',
        status: 409,
        detail:
          'This Idempotency-Key is in use for a different request, or the first ' +
          'attempt has not finished. Use a new key, or retry the identical request.',
        instance,
        requestId,
      })
      send(res, problem.status, problem.toJSON(), requestId, rateHeaders)
      return
    }

    storeIdempotent = outcome.store
  }

  // The response is decorated rather than every `send` call being rewritten.
  //
  // Thirty handlers each remembering to attach rate headers and to cache their
  // body is thirty chances to forget, and the one that forgets is invisible
  // until a client asks why its budget headers vanished on one endpoint. This
  // patches `writeHead` and `end` once, so the handlers stay unaware.
  decorate(res, rateHeaders, storeIdempotent)

  try {
    if (req.method === 'POST' && instance === '/v1/search') {
      const request = (body ?? {}) as {
        query?: unknown
        top_k?: unknown
        rerank?: unknown
        layers?: unknown
        filters?: unknown
        include_content?: unknown
      }
      const query = request.query
      if (typeof query !== 'string' || query.length === 0) {
        const problem = badRequest(instance, requestId, "'query' is required.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (request.layers !== undefined && !isStringArray(request.layers)) {
        const problem = badRequest(instance, requestId, "'layers' must be an array of layer slugs.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Narrowing, and only ever narrowing.
      //
      // `filters` was in the contract from before there was a server and read
      // by nothing, then refused with 400 rather than ignored — because a
      // caller who filters a search and gets everything back believes they
      // scoped it. It is applied now, and the shape it is applied in is the
      // point: it never becomes a filter the caller assembled. `buildFilter`
      // turns each entry into a `must` on a namespaced payload key alongside
      // the permission constraint, so the only thing a filter can do is remove
      // results the caller was already permitted to see.
      let filters
      try {
        filters = parseFilters(request.filters)
      } catch (error) {
        const problem = badRequest(
          instance,
          requestId,
          error instanceof MetadataError ? error.message : "'filters' is not usable.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const started = process.hrtime.bigint()
      const results = await options.search.search(auth, query, boundedTopK(request.top_k), {
        ...(Object.keys(filters).length === 0 ? {} : { filters }),
        // Only ever a way to turn it off; a deployment with no reranker
        // configured does not acquire one because a client asked.
        ...(request.rerank === false ? { rerank: false } : {}),
        ...(isStringArray(request.layers) && request.layers.length > 0
          ? { layers: request.layers }
          : {}),
        ...(request.include_content === false ? { includeContent: false } : {}),
      })
      // Measured around the whole thing — resolve, embed, traverse, hydrate,
      // rerank — because that is what a caller waits for and what the p95
      // target in docs/config.md is about. It was never observed at all, so the
      // histogram rendered no series and the target was unmeasurable.
      const elapsedNs = Number(process.hrtime.bigint() - started)
      options.observe?.searchDuration.observe(elapsedNs / 1e9)
      options.observe?.searchResults.inc({}, results.length)
      if (results.length === 0) {
        // Zero permitted results is what a denial looks like on this endpoint:
        // there is no 403 to count, by design. Without it the denial counter sat
        // at zero forever, which reads as "nobody is being refused".
        options.observe?.aclDenials.inc({ reason: 'search_empty' })
      }
      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'search',
        result: 'allow',
        // `docs/audit.md` opens by promising that "show me which documents your
        // agent read last quarter has to get a precise answer". That needs the
        // ids, and this wrote a count.
        target: {
          returned_docs: [...new Set(results.map((r) => r.doc_id))],
          layers: [...new Set(results.map((r) => r.layer))],
          top_k: boundedTopK(request.top_k),
        },
        // The hash always, the text only where a deployment asked for it. The
        // same call on the MCP side, so one search leaves one shape of record
        // whichever door it came through.
        // `latency_ms` is in the documented shape of a search event and was
        // not written either. The number is already measured for the histogram
        // one line above; it just never reached the journal, where it is what
        // makes "this search was slow" answerable per caller rather than only
        // as a percentile.
        detail: {
          returned: results.length,
          latency_ms: Math.round(elapsedNs / 1e6),
          ...queryAudit(query, options.auditQueryText === true),
        },
        requestId,
      })
      send(res, 200, { items: results }, requestId)
      return
    }

    if (req.method === 'POST' && instance === '/v1/documents') {
      const body_ = (body ?? {}) as Record<string, unknown>
      const layer = body_.layer

      // A file part is content. The external id defaults to its filename,
      // because a form that uploads `q3-plan.md` has already said what the
      // document is called and asking for the same string twice is how a
      // client ends up with two names for one document.
      //
      // The filename is used for that and for nothing else. It never reaches a
      // path, and never an object key — `documentKey` hashes the external id,
      // so a caller cannot choose the shape of anything in the bucket.
      const externalId =
        typeof body_.external_id === 'string'
          ? body_.external_id
          : (uploaded?.filename ?? undefined)

      let content = body_.content
      let binary: { bytes: Uint8Array; contentType: string } | undefined
      if (uploaded !== undefined) {
        if (typeof content === 'string' || typeof body_.url === 'string') {
          const problem = badRequest(
            instance,
            requestId,
            "A multipart upload carries the document; 'content' and 'url' are for the JSON body.",
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        // PDF first, and both signals must agree: the part must declare
        // `application/pdf` AND the bytes must begin with `%PDF-`. Either
        // alone is a refusal that names the other — a declared type the bytes
        // contradict is exactly the disagreement the multipart parser's
        // strictness doctrine exists to refuse, and sniffing alone would turn
        // the declared type into decoration. Other formats extend this table;
        // nothing falls through to a guess.
        const declared = (uploaded.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // %PDF-
        const magic =
          uploaded.bytes.length >= MAGIC.length && MAGIC.every((b, i) => uploaded.bytes[i] === b)

        if (declared === 'application/pdf' && !magic) {
          const problem = badRequest(
            instance,
            requestId,
            "The file part declares 'application/pdf' but the bytes do not begin with the %PDF- magic. " +
              'Both must agree; a declared type the bytes contradict is refused rather than trusted.',
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        if (declared !== 'application/pdf' && magic) {
          const problem = badRequest(
            instance,
            requestId,
            "The bytes begin with the %PDF- magic but the file part does not declare 'application/pdf'. " +
              'Both must agree; declare the type rather than relying on sniffing.',
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (declared === 'application/pdf' && magic) {
          // Binary requires object storage, at the edge. The bytes' only home
          // is the bucket — `documents.source_ref` is text and stays text — so
          // a deployment without one learns on the request, naming the
          // variables, not from a `failed` row minutes later.
          if (options.objectStorage !== true) {
            const problem = badRequest(
              instance,
              requestId,
              'A PDF upload needs object storage, and this deployment has none configured. ' +
                'Set NACRE_S3_* (endpoint, bucket, access key, secret key) to enable binary ingest.',
            )
            send(res, problem.status, problem.toJSON(), requestId)
            return
          }
          binary = { bytes: uploaded.bytes, contentType: 'application/pdf' }
        } else {
          // Decoded here, and refused here, rather than queued and failed
          // later.
          //
          // The parser extracts exactly the formats in the table above — it
          // took its first dependency for PDF and nothing else. Until this
          // check existed the sidecar decoded with `errors="replace"`, so a
          // binary file became a string of replacement characters that was
          // chunked, embedded, stored as the document body and reported as
          // indexed.
          //
          // At the edge the caller learns immediately and nothing is queued.
          // Deep in the worker they would have learned from a `failed` row
          // minutes later, if they looked.
          const decoder = new TextDecoder('utf-8', { fatal: true })
          try {
            content = decoder.decode(uploaded.bytes)
          } catch {
            const problem = badRequest(
              instance,
              requestId,
              'The uploaded file is not UTF-8 text. This installation extracts PDF and nothing else — ' +
                'a Word file or an image needs an extractor the parser deliberately does not carry, ' +
                'and a PDF must declare application/pdf on the file part.',
            )
            send(res, problem.status, problem.toJSON(), requestId)
            return
          }
        }
      }
      const url_ = body_.url

      if (typeof layer !== 'string' || typeof externalId !== 'string') {
        const problem = badRequest(instance, requestId, "'layer' and 'external_id' are required.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // A PDF file part is the third source and already excludes the other
      // two: `content` and `url` beside a file were refused above, before the
      // bytes were even looked at.
      if (binary === undefined && (typeof content === 'string') === (typeof url_ === 'string')) {
        // Accepting both would mean choosing silently, and the choice would
        // differ from whatever the caller assumed.
        const problem = badRequest(instance, requestId, "Exactly one of 'content' or 'url' is required.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Declared in openapi.yaml with no caveat and read by nothing until now,
      // which made it the quietest of the parameters that were: a caller tagged
      // a document, got 202, and the tag existed nowhere. Refused rather than
      // trimmed when it is malformed — a dropped key is a document the caller
      // believes is tagged and a filter that will never match it.
      // Every multipart field is a string, so `metadata` arrives as JSON text
      // where the JSON body carries an object. Parsed here rather than taught
      // to parseMetadata, which is shared with `PATCH` and with MCP and should
      // keep meaning one thing.
      //
      // Found by running it: the first version of this branch answered 400 for
      // a perfectly good `metadata` field, because the string never became an
      // object.
      let rawMetadata: unknown = body_.metadata
      if (wasMultipart && typeof rawMetadata === 'string') {
        try {
          rawMetadata = JSON.parse(rawMetadata)
        } catch {
          const problem = badRequest(
            instance,
            requestId,
            "The 'metadata' field is not JSON. In a multipart upload it carries a JSON object as text.",
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }

      let metadata
      try {
        metadata = parseMetadata(rawMetadata)
      } catch (error) {
        const problem = badRequest(
          instance,
          requestId,
          error instanceof MetadataError ? error.message : "'metadata' is not usable.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const queuedAt = process.hrtime.bigint()
      const outcome = await options.ingest.queue(auth, {
        layer,
        externalId,
        ...(typeof body_.title === 'string' ? { title: body_.title } : {}),
        ...(typeof content === 'string' ? { content } : {}),
        ...(typeof url_ === 'string' ? { url: url_ } : {}),
        ...(binary === undefined ? {} : { bytes: binary.bytes, contentType: binary.contentType }),
        metadata,
      })
      // The accept stage only — parse, chunk and embed happen in the worker,
      // which has no registry of its own. Labelled so the rest can join it
      // later without changing the metric's meaning.
      options.observe?.ingestDuration.observe(Number(process.hrtime.bigint() - queuedAt) / 1e9, {
        stage: 'accept',
      })

      if (outcome === undefined) {
        options.observe?.aclDenials.inc({ reason: 'ingest_layer' })
        // Not 403. A caller without write access must not learn which layers
        // exist by seeing which ones refuse differently from which ones are
        // absent.
        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'ingest',
          result: 'deny',
          target: { layer },
          detail: { layer },
          requestId,
        })
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if ('refused' in outcome) {
        // A module's ingest gate declined a document the caller may write — a
        // quota, a suspension. Not a 404: the layer is not being hidden, the
        // caller was allowed to write against it. Recorded as a denial so an
        // operator can see quota-refused ingests; the gate's reason is the
        // detail, and the gate chose the status.
        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'ingest',
          result: 'deny',
          target: { layer },
          detail: { layer, reason: outcome.reason },
          requestId,
        })
        const problem = new Problem({
          type: 'https://nacre.work/errors/ingest-refused',
          title: outcome.status === 429 ? 'Too many requests' : 'Forbidden',
          status: outcome.status,
          detail: outcome.reason,
          instance,
          requestId,
        })
        send(res, outcome.status, problem.toJSON(), requestId)
        return
      }

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'ingest',
        result: 'allow',
        target: { layer, document_id: outcome.documentId },
        detail: { document_id: outcome.documentId, unchanged: outcome.unchanged },
        requestId,
      })

      // 200 for an idempotent repeat, 202 for work actually queued. The
      // difference is what lets a client tell "already indexed" from "wait for
      // the job" without polling to find out.
      send(
        res,
        outcome.unchanged ? 200 : 202,
        { document_id: outcome.documentId, job_id: outcome.jobId, status: outcome.unchanged ? 'indexed' : 'queued' },
        requestId,
      )
      return
    }

    const documentMatch = /^\/v1\/documents\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && documentMatch) {
      const id = decodeURIComponent(documentMatch[1] as string)
      const removed = await options.ingest.remove(auth, id)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'delete_document',
        result: removed ? 'allow' : 'deny',
        target: { document_id: id },
        detail: { document_id: id },
        requestId,
      })

      if (!removed) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    if (req.method === 'PATCH' && documentMatch) {
      const id = decodeURIComponent(documentMatch[1] as string)

      if (options.documents.updateMetadata === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const body_ = (body ?? {}) as Record<string, unknown>
      if (body_.metadata === undefined) {
        const problem = badRequest(
          instance,
          requestId,
          "'metadata' is required. It is the only field this endpoint changes: " +
            'content goes through POST /v1/documents, which re-indexes.',
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      let patch
      try {
        patch = parseMetadata(body_.metadata)
      } catch (error) {
        const problem = badRequest(
          instance,
          requestId,
          error instanceof MetadataError ? error.message : "'metadata' is not usable.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const updated = await options.documents.updateMetadata(auth, id, patch)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'update_metadata',
        result: updated ? 'allow' : 'deny',
        target: { document_id: id },
        // The keys, never the values. A tag can carry anything a caller puts in
        // it, and the journal is read by more people than the document is.
        detail: { document_id: id, keys: Object.keys(patch).sort() },
        requestId,
      })

      if (!updated) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // 204, not the updated document. Rule 6: `write` does not imply `read`,
      // so a caller who may retag a document and not read it must not learn its
      // title or its layer from a successful PATCH. `GET` is where the document
      // is, for whoever may see it.
      send(res, 204, null, requestId)
      return
    }

    if (req.method === 'GET' && documentMatch) {
      const id = decodeURIComponent(documentMatch[1] as string)
      const document = await options.documents.read(auth, id)

      if (document === undefined) {
        // T8. The same response for "no such document" and "another
        // organization's document". Same status, same body, one code path — two
        // call sites with two messages is how the oracle comes back.
        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'get_document',
          result: 'deny',
          target: { document_id: id },
          detail: { document_id: id },
          requestId,
        })
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'get_document',
        result: 'allow',
        target: { document_id: id },
        detail: { document_id: id },
        requestId,
      })
      send(res, 200, document, requestId)
      return
    }

    const jobMatch = /^\/v1\/jobs\/([^/]+)$/.exec(instance)
    if (req.method === 'GET' && jobMatch && options.jobs !== undefined) {
      const id = decodeURIComponent(jobMatch[1] as string)
      const job = await options.jobs.read(auth, id)

      if (job === undefined) {
        // A job names a document, so it is as much of an oracle as the document
        // is. Absent and another organization's answer identically.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(
        res,
        200,
        {
          job_id: job.jobId,
          document_id: job.documentId,
          status: job.status,
          progress: job.progress,
          chunk_count: job.chunkCount,
          ...(job.reason === undefined ? {} : { reason: job.reason }),
          ...(job.error === undefined ? {} : { error: job.error }),
        },
        requestId,
      )
      return
    }

    /**
     * Who the caller is — and nothing about anyone else.
     *
     * There was no way to ask. The admin UI signed in, got a pair of tokens,
     * and had no idea whether the person holding them was an `org_admin` or a
     * `member` — so it drew every screen and every button for everybody. A
     * member then pressed "New user" and got a `404`, because invariant 4 makes
     * a refusal indistinguishable from a missing object. That is right for the
     * API and unusable as a product: to the person it reads as a broken
     * application rather than as a permission they do not hold.
     *
     * Telling a caller their own role is not a leak and is not in tension with
     * invariant 4. Rule 4 is about *objects* being invisible; this discloses
     * nothing except what the presented token already asserts, which the caller
     * necessarily has. Nothing here can name another principal.
     *
     * A service account gets an answer too, which the "sign in as an agent to
     * see what it sees" flow needs: the UI accepts a `nacre_sk_` key and could
     * not previously say which account it belonged to.
     */
    if (instance === '/v1/me') {
      // 404 for another method, the same as every other path here: invariant 4
      // reserves the distinction for objects, and a 405 on a path that answers
      // one verb tells a caller nothing they can act on.
      if (req.method !== 'GET') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // Composed from the token and nothing else — no query, so this cannot
      // grow a way to name somebody else. `organization` is included because a
      // UI showing "you are an administrator" has to say of what, and it is the
      // same value invariant 1 already took from the token.
      send(
        res,
        200,
        {
          organization: auth.orgId,
          principal_type: auth.principal.type,
          principal_id: auth.principal.id,
          role: auth.role,
        },
        requestId,
      )
      return
    }

    /*
     * The caller's own second factor.
     *
     * Under `/v1/me` and never `/v1/users/{id}`, which is the security property
     * rather than a URL preference: an administrator resets somebody's password
     * and must not be able to enrol, read or remove their second factor —
     * doing so would make the factor a thing the account's administrator holds,
     * and the whole point is that it is a thing the *person* holds.
     *
     * A service account and a delegation are refused. A key is not a person and
     * has nobody to carry an authenticator; a delegation is a third party
     * acting for somebody, and letting it change how that somebody signs in
     * would be an escalation out of what was approved.
     */
    if (instance === '/v1/me/second-factor' || instance.startsWith('/v1/me/second-factor/')) {
      if (options.secondFactors === undefined || !options.secondFactors.available) {
        // No key configured, so the feature is absent rather than broken. 404
        // and not 501: from outside, a route this installation does not serve
        // and one it has not been given a key for are the same thing.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if (auth.principal.type !== 'user' || auth.delegation !== undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const factors = options.secondFactors
      const userId = auth.principal.id
      const rest = instance.slice('/v1/me/second-factor'.length)

      if (rest === '' && req.method === 'GET') {
        const [items, left] = await Promise.all([
          factors.list(auth.orgId, userId),
          factors.recoveryCodesLeft(auth.orgId, userId),
        ])
        send(
          res,
          200,
          {
            items: items.map((f) => ({
              id: f.id,
              kind: f.kind,
              label: f.label,
              created_at: f.createdAt.toISOString(),
              last_used_at: f.lastUsedAt?.toISOString() ?? null,
            })),
            recovery_codes_left: left,
          },
          requestId,
        )
        return
      }

      if (rest === '' && req.method === 'POST') {
        const label = (body as { label?: unknown } | undefined)?.label
        const named = typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 60) : 'Authenticator'
        const begun = await factors.begin(auth.orgId, userId, named)
        if (begun === undefined) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        // The secret in the response and nowhere else: this is the one moment
        // it exists outside the sealed column, exactly as a generated password
        // is.
        send(
          res,
          201,
          { id: begun.id, secret: begun.secret, otpauth_url: begun.otpauthUrl, label: named },
          requestId,
        )
        return
      }

      if (rest.endsWith('/confirm') && req.method === 'POST') {
        const id = rest.slice(1, -'/confirm'.length)
        const code = (body as { code?: unknown } | undefined)?.code
        if (!UUID_SHAPE.test(id) || typeof code !== 'string') {
          const problem = badRequest(instance, requestId, "'code' is required.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        const codes = await factors.confirm(auth.orgId, userId, id, code)
        if (codes === undefined) {
          // One refusal for a wrong code and for an enrolment that is not
          // there. Telling them apart would say whether a given id exists.
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        await options.audit.write({
          orgId: auth.orgId,
          actor: `user:${userId}`,
          action: 'second_factor.enrol',
          result: 'allow',
          target: { user_id: userId },
          detail: {},
          requestId,
        })
        // Printed once. A second call returns an empty list rather than new
        // codes, because reissuing them here would invalidate the set somebody
        // has already written down.
        send(res, 200, { recovery_codes: codes }, requestId)
        return
      }

      if (rest !== '' && !rest.includes('/') && req.method === 'DELETE') {
        const id = rest.slice(1)
        const code = (body as { code?: unknown } | undefined)?.code
        if (!UUID_SHAPE.test(id) || typeof code !== 'string') {
          const problem = badRequest(instance, requestId, "'code' is required to remove a second factor.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        /*
         * A current code to take one off, and that is the whole reason this
         * endpoint takes a body at all. Removing the second factor is the first
         * thing somebody with a stolen session does, and a session is exactly
         * what the factor exists to be more than.
         */
        if (!(await factors.verify(auth.orgId, userId, code))) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        const removed = await factors.remove(auth.orgId, userId, id)
        if (!removed) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        await options.audit.write({
          orgId: auth.orgId,
          actor: `user:${userId}`,
          action: 'second_factor.remove',
          result: 'allow',
          target: { user_id: userId },
          detail: {},
          requestId,
        })
        send(res, 204, null, requestId)
        return
      }

      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }

    if (instance === '/v1/embedding-providers' && options.embeddingProviders !== undefined) {
      if (req.method === 'GET') {
        // Not paged. A deployment has a handful of these — one per model it
        // runs — and a cursor over three rows is machinery with nothing to do.
        // No audit event either, on the layer listing's rule: this is
        // configuration the caller can already infer from any layer.
        const items = await options.embeddingProviders.list(auth)
        send(
          res,
          200,
          {
            items: items.map((p) => ({
              id: p.id,
              name: p.name,
              model: p.model,
              dimensions: p.dimensions,
              is_default: p.isDefault,
            })),
          },
          requestId,
        )
        return
      }

      if (req.method === 'POST') {
        const body_ = (body ?? {}) as Record<string, unknown>
        const name = body_.name
        const endpoint = body_.endpoint
        const model = body_.model
        const dimensions = body_.dimensions

        if (
          typeof name !== 'string' || name.trim() === '' ||
          typeof endpoint !== 'string' || endpoint.trim() === '' ||
          typeof model !== 'string' || model.trim() === ''
        ) {
          const problem = badRequest(instance, requestId, "'name', 'endpoint' and 'model' are required.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        // The endpoint is parsed rather than stored as typed. `minio:9000` was
        // accepted by `new URL` once, as the scheme `minio:` with an empty
        // host, and the failure surfaced far from here — so a value that cannot
        // be an http(s) address is refused where the person can still fix it.
        let parsed: URL
        try {
          parsed = new URL(endpoint)
        } catch {
          const problem = badRequest(instance, requestId, "'endpoint' must be an absolute http(s) URL.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
          const problem = badRequest(instance, requestId, "'endpoint' must be an absolute http(s) URL.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        // The load-bearing field. A layer's collection slot is created from it,
        // so a wrong number is a layer that accepts documents and fails every
        // one of them in the worker while the API answers `queued` — which is a
        // defect this repository has already had once, from the other side.
        if (typeof dimensions !== 'number' || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 16_384) {
          const problem = badRequest(
            instance,
            requestId,
            "'dimensions' must be a whole number between 1 and 16384, and must match what the model actually returns.",
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const outcome = await options.embeddingProviders.create(auth, {
          name: name.trim(),
          endpoint: endpoint.trim(),
          model: model.trim(),
          dimensions,
        })

        if (outcome.kind === 'denied') {
          await options.audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'embedding_provider.create',
            result: 'deny',
            target: { name: name.trim() },
            detail: {},
            requestId,
          })
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        if (outcome.kind === 'conflict') {
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: `A provider named '${name.trim()}' already exists in this organization.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'embedding_provider.create',
          result: 'allow',
          target: { provider_id: outcome.provider.id, name: outcome.provider.name },
          detail: { model: outcome.provider.model },
          requestId,
        })
        send(
          res,
          201,
          {
            id: outcome.provider.id,
            name: outcome.provider.name,
            model: outcome.provider.model,
            dimensions: outcome.provider.dimensions,
            is_default: outcome.provider.isDefault,
          },
          requestId,
        )
        return
      }
    }

    if (instance === '/v1/workspaces' && options.workspaces !== undefined) {
      if (req.method === 'GET') {
        const page = readPage(url.searchParams, instance, requestId)
        if (page instanceof Problem) {
          send(res, page.status, page.toJSON(), requestId)
          return
        }

        const { items, nextCursor } = await options.workspaces.list(auth, page)

        // No audit event, for the same reason the layer listing has none: this
        // returns what the caller may already reach, and one event per listing
        // buries the ones that matter.
        send(
          res,
          200,
          {
            items: items.map((w) => ({
              id: w.id,
              slug: w.slug,
              name: w.name,
              layer_count: w.layerCount,
              created_at: w.createdAt,
              permissions: w.permissions,
            })),
            next_cursor: nextCursor,
          },
          requestId,
        )
        return
      }

      if (req.method === 'POST') {
        const body_ = (body ?? {}) as Record<string, unknown>
        const slug = body_.slug
        const name = body_.name

        if (typeof slug !== 'string' || typeof name !== 'string') {
          const problem = badRequest(instance, requestId, "'slug' and 'name' are required.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const outcome = await options.workspaces.create(auth, { slug, name })

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'create_workspace',
          result: outcome.kind === 'created' ? 'allow' : 'deny',
          target: { slug },
          detail: { outcome: outcome.kind },
          requestId,
        })

        if (outcome.kind === 'denied') {
          // 404, not 403. Whether an organization has workspaces a caller
          // cannot administer is not something they are told.
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (outcome.kind === 'conflict') {
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: `A workspace with the slug '${slug}' already exists in this organization.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const created = outcome.workspace
        send(
          res,
          201,
          {
            id: created.id,
            slug: created.slug,
            name: created.name,
            layer_count: created.layerCount,
            created_at: created.createdAt,
            permissions: created.permissions,
          },
          requestId,
        )
        return
      }
    }

    if (req.method === 'GET' && instance === '/v1/layers' && options.layers !== undefined) {
      const page = readPage(url.searchParams, instance, requestId)
      if (page instanceof Problem) {
        send(res, page.status, page.toJSON(), requestId)
        return
      }

      const { items, nextCursor } = await options.layers.list(auth, page)

      // No audit event: this returns what the caller may already read, and one
      // event per listing buries the ones that matter.
      send(
        res,
        200,
        {
          items: items.map((l) => ({
            id: l.id,
            slug: l.slug,
            name: l.name,
            workspace_id: l.workspaceId,
            description: l.description,
            document_count: l.documentCount,
            failed_count: l.failedCount,
          })),
          next_cursor: nextCursor,
        },
        requestId,
      )
      return
    }

    if (req.method === 'POST' && instance === '/v1/layers' && options.layers !== undefined) {
      const body_ = (body ?? {}) as Record<string, unknown>
      const workspaceId = body_.workspace_id
      const slug = body_.slug
      const name = body_.name

      if (typeof workspaceId !== 'string' || typeof slug !== 'string' || typeof name !== 'string') {
        const problem = badRequest(
          instance,
          requestId,
          "'workspace_id', 'slug' and 'name' are required.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const providerId = body_.provider_id
      if (providerId !== undefined && (typeof providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(providerId))) {
        const problem = badRequest(instance, requestId, "'provider_id' must be a uuid.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const outcome = await options.layers.create(auth, {
        workspaceId,
        slug,
        name,
        ...(providerId === undefined ? {} : { providerId }),
      })

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'create_layer',
        result: outcome.kind === 'created' ? 'allow' : 'deny',
        target: { workspace_id: workspaceId, slug },
        detail: { outcome: outcome.kind },
        requestId,
      })

      if (outcome.kind === 'denied') {
        // 404, not 403. A caller who may not administer a workspace must not be
        // able to tell it apart from one that does not exist.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (outcome.kind === 'provider') {
        const problem = badRequest(instance, requestId, outcome.detail)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (outcome.kind === 'conflict') {
        const problem = new Problem({
          type: 'https://nacre.work/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail: `A layer with the slug '${slug}' already exists in this organization.`,
          instance,
          requestId,
        })
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const created = outcome.layer
      send(
        res,
        201,
        {
          id: created.id,
          slug: created.slug,
          name: created.name,
          workspace_id: created.workspaceId,
          description: created.description,
          document_count: created.documentCount,
          failed_count: created.failedCount,
        },
        requestId,
      )
      return
    }

    if (req.method === 'GET' && instance === '/v1/grants' && options.grants !== undefined) {
      const page = readPage(url.searchParams, instance, requestId)
      if (page instanceof Problem) {
        send(res, page.status, page.toJSON(), requestId)
        return
      }

      const { items, nextCursor } = await options.grants.list(auth, page)
      send(res, 200, { items: items.map(grantJson), next_cursor: nextCursor }, requestId)
      return
    }

    if (req.method === 'POST' && instance === '/v1/grants' && options.grants !== undefined) {
      const body_ = (body ?? {}) as Record<string, unknown>
      const parsed = parseGrant(body_)

      if (typeof parsed === 'string') {
        const problem = badRequest(instance, requestId, parsed)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const issued = await options.grants.issue(auth, parsed)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'issue_grant',
        result: issued === undefined ? 'deny' : 'allow',
        target: {
          principal: `${parsed.principalType}:${parsed.principalId}`,
          scope: `${parsed.scopeType}:${parsed.scopeId}`,
          permission: parsed.permission,
        },
        detail: {},
        requestId,
      })

      if (issued === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 201, grantJson(issued), requestId)
      return
    }

    const grantMatch = /^\/v1\/grants\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && grantMatch && options.grants !== undefined) {
      const id = decodeURIComponent(grantMatch[1] as string)
      const revoked = await options.grants.revoke(auth, id)

      // Written before the response either way. A revocation nobody can prove
      // happened is not a revocation an auditor will accept, and a *refused*
      // one is what an attempt to revoke someone else's grant looks like.
      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'revoke_grant',
        result: revoked ? 'allow' : 'deny',
        target: { grant_id: id },
        detail: {},
        requestId,
      })

      if (!revoked) {
        // 404 for absent, for another organization's, and for one whose scope
        // this caller cannot administer. Distinguishing them would let an
        // administrator of one layer enumerate grants across the organization.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    const layerMatch = /^\/v1\/layers\/([0-9a-f-]{36})$/i.exec(instance)
    if (req.method === 'PATCH' && layerMatch !== null) {
      const layerId = layerMatch[1] as string

      if (options.layers?.update === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const body_ = (body ?? {}) as Record<string, unknown>
      const name = body_.name
      const description = body_.description

      if (name !== undefined && typeof name !== 'string') {
        const problem = badRequest(instance, requestId, "'name' must be a string.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if (description !== undefined && typeof description !== 'string') {
        const problem = badRequest(instance, requestId, "'description' must be a string.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if (name === undefined && description === undefined) {
        const problem = badRequest(
          instance,
          requestId,
          "One of 'name' or 'description' is required. The slug is not editable — " +
            'clients address a layer by it — and the embedding model changes through ' +
            'POST /v1/layers/{id}/reindex, which rebuilds the vectors.',
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const updated = await options.layers.update(auth, layerId, {
        ...(typeof name === 'string' ? { name } : {}),
        ...(typeof description === 'string' ? { description } : {}),
      })

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'update_layer',
        result: updated ? 'allow' : 'deny',
        target: { layer_id: layerId },
        detail: { layer_id: layerId, fields: Object.keys(body_).sort() },
        requestId,
      })

      if (!updated) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    if (req.method === 'DELETE' && layerMatch !== null) {
      const layerId = layerMatch[1] as string

      if (options.layers?.remove === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const removed = await options.layers.remove(auth, layerId)

      // Recorded whichever way it went, and before the answer. Deleting a layer
      // takes every document in it out of every answer at once, which is the
      // largest single thing a caller can do here — a refused attempt is worth
      // as much to an investigation as a successful one.
      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'delete_layer',
        result: removed ? 'allow' : 'deny',
        target: { layer_id: layerId },
        detail: { layer_id: layerId },
        requestId,
      })

      if (!removed) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    // `/v1/admin/...` — routes a commercial module mounted.
    //
    // After authentication and after `rejectTenantOverride`, deliberately. A
    // module gets an already-authenticated principal and a body that has
    // already been scanned for a tenant override, so invariants 1 and 2 hold
    // for its routes without it having to know they exist. It cannot opt out of
    // either, because it never sees the request before this point.
    //
    // `platform_admin` and `org_admin` only. There is no module-supplied role
    // check to get wrong: an administrative surface is administrative, and a
    // member reaching one would be a widening decided in the closed half.
    if (instance.startsWith(ADMIN_PREFIX)) {
      // Role before route lookup. Both answer the same 404, so this is not
      // about what a caller can tell apart — it is that a member must not
      // reach module code at all, and "the module happened to have no matching
      // route" is not a reason to be safe.
      if (!administersTenants(auth) && !administers(auth)) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const route = adminRoutes().find(
        (r) => r.method === req.method && r.pattern.test(instance),
      )

      if (route === undefined) {
        // 404 whether nothing is mounted or nothing matched — the two are the
        // same answer, and a deployment without the module must not be
        // distinguishable from one where the path is simply wrong.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const url = new URL(req.url ?? '/', 'http://internal')
      const matched = route.pattern.exec(instance)
      const answer = await route.handle({
        method: req.method ?? 'GET',
        path: instance,
        params: (matched ?? []).slice(1),
        query: url.searchParams,
        body,
        auth,
      })

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: `admin.${req.method?.toLowerCase() ?? 'get'}`,
        surface: 'admin',
        result: answer.status < 400 ? 'allow' : 'deny',
        target: { path: instance },
        detail: { status: answer.status },
        requestId,
      })

      send(res, answer.status, answer.body ?? null, requestId)
      return
    }

    // `/v1/layers/{id}/reference-queries`
    const referencePath = /^\/v1\/layers\/([0-9a-f-]{36})\/reference-queries$/i.exec(instance)
    if (referencePath !== null) {
      const layerId = referencePath[1] as string

      if (options.referenceQueries === undefined || (req.method !== 'GET' && req.method !== 'PUT')) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (req.method === 'GET') {
        const found = await options.referenceQueries.list(auth, layerId)
        if (found === undefined) {
          // No such layer and no permission to administer it, one answer.
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        send(res, 200, { items: found.map(referenceQueryJson) }, requestId)
        return
      }

      const parsed = parseReferenceQueries(body)
      if ('error' in parsed) {
        const problem = badRequest(instance, requestId, parsed.error)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const replaced = await options.referenceQueries.replace(auth, layerId, parsed.queries)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'reference_queries.replace',
        result: replaced === undefined ? 'deny' : 'allow',
        target: { layer_id: layerId },
        // The count and never the queries. They are the operator's own text
        // rather than a caller's search, so this is not the rule about query
        // text — but the journal is read by more people than the endpoint is,
        // and a document's title has already reached it once by this route.
        detail: { layer_id: layerId, queries: parsed.queries.length },
        requestId,
      })

      if (replaced === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 200, { items: replaced.map(referenceQueryJson) }, requestId)
      return
    }

    // `/v1/layers/{id}/reindex`
    const reindexPath = /^\/v1\/layers\/([0-9a-f-]{36})\/reindex$/i.exec(instance)
    if (reindexPath !== null) {
      const layerId = reindexPath[1] as string

      if (options.reindex === undefined || (req.method !== 'POST' && req.method !== 'GET')) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (req.method === 'GET') {
        const status = await options.reindex.status(auth, layerId)
        if (status === undefined) {
          // No reindex, no such layer, and no permission are one answer. The
          // first is not a permission fact and the other two must not be
          // separable, so all three are 404 — see invariant 4.
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        send(res, 200, reindexJson(status), requestId)
        return
      }

      const providerId = (body as { provider_id?: unknown } | undefined)?.provider_id
      if (typeof providerId !== 'string' || !/^[0-9a-f-]{36}$/i.test(providerId)) {
        const problem = badRequest(instance, requestId, "'provider_id' must be a uuid.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const outcome = await options.reindex.start(auth, layerId, providerId)
      if (outcome === undefined) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (outcome.kind === 'unknown_provider') {
        // 400 and not 404: the caller has already proved they administer this
        // layer, so this is a statement about their request rather than about
        // what exists. A provider is installation-level configuration, not a
        // tenant object with visibility rules of its own.
        const problem = badRequest(
          instance,
          requestId,
          'No embedding provider with that id is available to this organization.',
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (outcome.kind === 'already_current') {
        const problem = badRequest(
          instance,
          requestId,
          `This layer already uses ${outcome.vectorName}. Reindexing onto the model it ` +
            'is on would rewrite every vector to the same values.',
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (outcome.kind === 'conflict') {
        const problem = new Problem({
          type: 'https://nacre.work/errors/conflict',
          title: 'Conflict',
          status: 409,
          detail:
            `A reindex onto ${outcome.status.shadowVector} is already running for this layer. ` +
            'Wait for it, or let it fail — two at once would race to switch vector_name.',
          instance,
          requestId,
        })
        // The problem body and not the status object: a 409 is an error
        // response and RFC 9457 says what shape one has. `GET` on this same
        // path is where the state lives, and the detail above names what to
        // wait for.
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      await options.audit?.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'layer.reindex',
        result: 'allow',
        surface: 'api',
        target: { layer_id: layerId, shadow_vector: outcome.status.shadowVector },
        detail: { provider_id: providerId, total: outcome.status.total },
        requestId,
      })

      // 202: the work happens in the worker. docs/api.md says an operation that
      // outlives its request answers 202 with somewhere to poll, which is this
      // same path with GET.
      send(res, 202, reindexJson(outcome.status), requestId)
      return
    }

    if (instance === '/v1/audit') {
      // 404 rather than 403 for a caller who may not read it, and rather than
      // 405 for a method this path does not have. Invariant 4 reserves 403 for
      // an operation forbidden on an object the caller can already see, and
      // whether an organization keeps an audit log is not something a member is
      // told. The contract published this answer before the endpoint existed.
      if (options.auditReader === undefined || req.method !== 'GET') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Two roles, two different logs, and the difference is rule 2 rather than
      // a convenience.
      //
      // `org_admin` administers the tenant and sees its log in full — including
      // which documents were read, which is the question docs/audit.md opens
      // with. `platform_admin` administers the *installation*: it sees grants
      // issued, accounts created, configuration changed, and deliberately not
      // the record of who read what. A platform administrator who can read
      // every tenant's document-access log has the access the permission model
      // spends its whole effort denying, obtained through the journal that
      // exists to prove they did not.
      //
      // On a single-organization community install the two sit in the same
      // organization and this reads as an odd distinction. It is not for this
      // build; it is for the multi-tenancy module, which inherits this endpoint
      // and where a platform administrator spans tenants. Writing the rule now
      // costs three lines. Retrofitting it later means auditing every caller.
      if (!administers(auth) && !administersTenants(auth)) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const page = readPage(url.searchParams, instance, requestId)
      if (page instanceof Problem) {
        send(res, page.status, page.toJSON(), requestId)
        return
      }

      const query = readAuditQuery(url.searchParams, instance, requestId)
      if (query instanceof Problem) {
        send(res, query.status, query.toJSON(), requestId)
        return
      }

      const format = auditFormat(req.headers.accept)
      if (format === undefined) {
        const problem = new Problem({
          type: 'https://nacre.work/errors/not-acceptable',
          title: 'Not acceptable',
          status: 406,
          detail:
            'This endpoint serves application/json, application/x-ndjson and text/csv. ' +
            'Ask for one of those, or send no Accept header for JSON.',
          instance,
          requestId,
        })
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const { items, nextCursor } = await options.auditReader.read(
        auth,
        // `administrativeOnly` is set here and never read from the request. A
        // caller cannot widen their own view by omitting a parameter, which is
        // the shape this would take if it were a query filter.
        { ...query, administrativeOnly: administersTenants(auth) },
        page,
      )

      // Reading the log is itself an access worth recording. It is the one
      // action where leaving it out is self-serving: an administrator who can
      // read who-read-what without that read appearing is a hole in exactly the
      // guarantee this endpoint exists to provide.
      await options.audit?.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'audit.read',
        result: 'allow',
        surface: 'api',
        target: { format, returned: items.length, ...query },
        detail: {},
        requestId,
      })

      if (format === 'json') {
        send(res, 200, { items: items.map(auditJson), next_cursor: nextCursor }, requestId)
        return
      }

      // JSONL and CSV are exports, so they carry no cursor — a client streaming
      // to a file has nowhere to put one. `Link` is where the contract puts it,
      // which keeps the body a clean stream of records rather than a stream
      // with a footer that every consumer has to know to strip.
      const headers: Record<string, string> = {
        'content-type': format === 'ndjson' ? 'application/x-ndjson' : 'text/csv; charset=utf-8',
        'x-request-id': requestId,
      }
      if (nextCursor !== null) {
        const next = new URL(url.href)
        next.searchParams.set('cursor', nextCursor)
        headers.link = `<${next.pathname}${next.search}>; rel="next"`
      }

      res.writeHead(200, headers)
      res.end(format === 'ndjson' ? toNdjson(items) : toCsv(items))
      return
    }

    /**
     * The one point in the OAuth flow where authority is created.
     *
     * Everything before it — registration, the authorize redirect — is a
     * conversation with an unauthenticated caller and grants nothing. This is
     * inside the authenticated surface because it has to be: a signed-in person
     * is choosing which **agent** the client will act as.
     *
     * The token that comes out acts as that service account and never as the
     * person. That is the design and not an implementation detail: an agent
     * holding your authority answers "what may this agent read" with "whatever
     * you may read", which is the question the whole permission model exists to
     * ask separately.
     *
     * The service account must already exist and the caller must be able to see
     * it. Creating one, and granting it anything, goes through the endpoints
     * that already exist and already check — this deliberately adds no second
     * path to either, because a second path is how the guarded one gets walked
     * around.
     */
    /**
     * The connections this caller may see, and ending one.
     *
     * "Forget this application" is the whole point, and it is why 0024 exists:
     * before it there was a record of an authorization *code* — ninety seconds
     * long and consumed — and nothing of the connection that outlived it. So
     * nothing could list what was connected, and nothing could stop it.
     *
     * Ending one deletes its refresh tokens in the same transaction. The access
     * token already issued is a JWT verified against a key, so it keeps working
     * until it expires — at most `NACRE_ACCESS_TOKEN_TTL`. That window is real
     * and is stated in the response rather than papered over: the alternative
     * is a denylist consulted on every request, which would make local
     * verification not local.
     */
    if (instance === '/v1/oauth/consents' && options.oauth !== undefined) {
      if (req.method !== 'GET') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      const items = await options.oauth.consents.list(auth)
      send(
        res,
        200,
        {
          items: items.map((c) => ({
            id: c.id,
            client_id: c.clientId,
            client_name: c.clientName,
            // What it acts as, named rather than inferred from which of the
            // two id fields came back — the screen has to tell a person "this
            // application acts as you" from "this application acts as an
            // agent", and those are different sentences.
            acts_as: c.subject.actsAs,
            service_account_id: c.subject.actsAs === 'service_account' ? c.subject.serviceAccountId : null,
            service_account_name: c.serviceAccountName,
            approved_by: c.approvedBy,
            // The address beside the id, because the id answers "which row"
            // and every reader of this list is asking "who". Not a privacy
            // widening: an `org_admin` can already list every user with their
            // address, and everybody else sees only their own connections.
            approved_by_email: c.approvedByEmail,
            approver_disabled: c.approverDisabled,
            // Empty means the delegation reaches everything its approver does.
            layers: c.layers,
            created_at: c.createdAt,
            last_refreshed_at: c.lastRefreshedAt,
            revoked_at: c.revokedAt,
          })),
          // Not a field a caller has to compute from configuration they cannot
          // see. It is how long an already-issued access token can still work
          // after a connection is ended, and a screen that says "ended" without
          // it would be overstating what just happened.
          access_token_ttl_seconds: options.oauth.accessTtlSeconds,
        },
        requestId,
      )
      return
    }

    if (instance.startsWith('/v1/oauth/consents/') && options.oauth !== undefined) {
      const id = instance.slice('/v1/oauth/consents/'.length)
      if (req.method !== 'DELETE') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      const ended = await options.oauth.consents.revoke(auth, id)
      if (!ended) {
        // One they cannot see, one that does not exist, and one already ended
        // are the same answer.
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      await options.audit?.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'oauth.revoke',
        result: 'allow',
        detail: { consent_id: id },
        requestId,
      })
      send(res, 200, { ended: true, access_token_ttl_seconds: options.oauth.accessTtlSeconds }, requestId)
      return
    }

    if (instance === '/v1/oauth/consent' && options.oauth !== undefined) {
      if (req.method !== 'POST') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // A service account cannot consent on behalf of anybody: the flow exists
      // so a *person* decides what an agent gets, and an agent approving its
      // own successor is that decision made by the thing it is about.
      if (auth.principal.type !== 'user') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const consent = (body ?? {}) as Record<string, unknown>
      const need = (field: string): string | undefined =>
        typeof consent[field] === 'string' && consent[field] !== '' ? (consent[field] as string) : undefined

      const clientId = need('client_id')
      const redirectUri = need('redirect_uri')
      const codeChallenge = need('code_challenge')
      const serviceAccountId = need('service_account_id')
      if (clientId === undefined || redirectUri === undefined || codeChallenge === undefined) {
        const problem = badRequest(
          instance,
          requestId,
          "'client_id', 'redirect_uri' and 'code_challenge' are required.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Naming an agent is what makes this the agent flow; naming nobody is a
      // delegation. Not a mode flag beside the field, because two ways to say
      // one thing is two ways for them to disagree — and this endpoint used to
      // *require* the agent, which is exactly why a member reached a screen
      // they could not complete.
      const delegating = serviceAccountId === undefined

      // Never delegable. It spans tenants in the multi-tenancy module, so a
      // delegation of it would be an escalation out of the organization this
      // screen is scoped to — the same argument that already refuses minting
      // one from an org-scoped endpoint. Refused here *and* again at
      // validation: this is the reachable path, the other is the one that holds
      // if a token is ever minted some other way.
      if (delegating && administersTenants(auth)) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // The narrowing, which can only ever remove. Ids rather than slugs: this
      // is stored and read on the authentication path, and a slug is renameable
      // — a narrowing that follows a rename is one that silently changes what a
      // person approved.
      //
      // Each entry is a layer id, or `{ id, permissions }` where the person set
      // a ceiling for that layer alone. A bare id means "inherit the
      // connection's ceiling", which is what every entry meant before per-layer
      // ceilings existed — so the older shape is still the shorter spelling of
      // the same thing rather than a compatibility branch.
      const narrowing = readNarrowing(consent['layers'])
      if (narrowing === INVALID) {
        const problem = badRequest(
          instance,
          requestId,
          "'layers' must be an array of layer ids, or of { id, permissions } objects " +
            'whose permissions are a non-empty subset of read, write and admin.',
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      // The permission ceiling, which is the dimension a person reaches for
      // first. Validated here rather than left to the database, so a typo is a
      // 400 naming the field instead of a constraint violation as a 500.
      const ceiling = consent['permissions']
      if (ceiling !== undefined && (!isStringArray(ceiling) || ceiling.some((p) => !(PERMISSIONS as readonly string[]).includes(p)))) {
        const problem = badRequest(
          instance,
          requestId,
          "'permissions' must be an array of 'read', 'write' or 'admin'.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if (delegating && isStringArray(ceiling) && ceiling.length === 0) {
        // Empty is not "no ceiling", it is a delegation that can do nothing —
        // a restriction nobody meant to write, and the database refuses one
        // too. Omitting the field is how a caller says there is no ceiling.
        const problem = badRequest(
          instance,
          requestId,
          "'permissions' cannot be empty. Omit it for a delegation with no restriction.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if (!delegating && ceiling !== undefined) {
        // An agent's reach is its grants, which are an administrator's to set.
        const problem = badRequest(
          instance,
          requestId,
          "'permissions' restricts a delegation, and this consent names an agent.",
        )
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (!delegating && narrowing !== undefined && narrowing.length > 0) {
        // An agent's reach is its grants, and those are an administrator's to
        // set. Accepting a narrowing here and storing it against a connection
        // nothing reads it for would be a control that does nothing.
        const problem = badRequest(instance, requestId, "'layers' narrows a delegation, and this consent names an agent.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Re-checked here rather than trusted from the browser. Everything in
      // this body came back through a redirect the caller controls, so the
      // client and its redirect URI are verified against the registration
      // again — the authorize endpoint's check protected the redirect, and this
      // one protects the code.
      const client = await options.oauth.clients.find(clientId)
      if (client === undefined || !redirectAllowed(redirectUri, client.redirectUris)) {
        const problem = badRequest(instance, requestId, 'Unknown client, or a redirect_uri it did not register.')
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // The agent has to be one this caller can see, which is what makes the
      // consent theirs to give. `404` for anything else, because an agent they
      // cannot see and one that does not exist are the same answer here as
      // everywhere.
      if (!delegating) {
        const visible = options.serviceAccounts === undefined
          ? undefined
          : (await options.serviceAccounts.list(auth, { limit: 200, after: undefined })).items.find(
              (a) => a.id === serviceAccountId,
            )
        if (visible === undefined) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }

      // Every named layer has to be one this caller can read.
      //
      // Not a security check — a narrowing can only remove, so a layer they
      // cannot reach would simply contribute nothing. It is here because the
      // alternative is a foreign key violation surfacing as a 500 on a typo,
      // and because a person approving a restriction should be told when the
      // restriction they wrote is not the one they meant. `404` for an unknown
      // id and for an unreadable one alike, on invariant I6.
      if (delegating && narrowing !== undefined && narrowing.length > 0) {
        const readable = options.layers === undefined
          ? []
          : (await options.layers.list(auth, { limit: 500, after: undefined })).items.map((l) => l.id)
        if (narrowing.some((l) => !readable.includes(l.id))) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }

      // A per-layer ceiling that the connection's ceiling excludes could never
      // take effect: `oauth_consents.permissions` gates the resolver before
      // rule 3, so the resolver would win and the entry would be a control that
      // does nothing. Refused here, naming both sets, rather than stored.
      if (delegating && isStringArray(ceiling)) {
        const allowed = ceiling as readonly string[]
        const outside = narrowing?.find((l) =>
          l.permissions?.some((p: Permission) => !allowed.includes(p)),
        )
        if (outside !== undefined) {
          const problem = badRequest(
            instance,
            requestId,
            `A layer may not be given more than the connection: ${
              outside.permissions?.join(', ') ?? ''
            } against a ceiling of ${(ceiling as readonly string[]).join(', ')}.`,
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }

      // The standing connection first, then the code that points at it. That
      // order matters: the code is exchanged for a refresh token hung on the
      // connection, and a code with no connection would mint access nobody can
      // ever take back — which is the gap this closes.
      const subject: ConsentSubject = delegating
        ? { actsAs: 'user', userId: auth.principal.id }
        : { actsAs: 'service_account', serviceAccountId: serviceAccountId as string }
      const consentId = await options.oauth.consents.record(
        auth,
        clientId,
        subject,
        narrowing === undefined ? [] : narrowing,
        isStringArray(ceiling) ? (ceiling as readonly Permission[]) : undefined,
      )
      const code = generateCode()
      const common = {
        orgId: auth.orgId,
        clientId,
        redirectUri,
        codeChallenge,
        ...(need('resource') === undefined ? {} : { resource: need('resource') as string }),
        code,
        consentId,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      }
      // Two calls rather than one with a union in it. The delegated shape
      // *requires* the connection id and the agent shape does not, and writing
      // that as one object hands the compiler a value it cannot place in either
      // arm — which is the same reason 0025 gave the database a CHECK per mode
      // instead of one that permits both halves.
      await options.oauth.authorizations.approve(
        auth,
        subject.actsAs === 'user' ? { ...common, subject } : { ...common, subject },
      )

      // Recorded, because "why does this agent hold a token" is a question an
      // administrator will ask and the grant table cannot answer: the grants
      // were there before, and what changed is that a client was handed the
      // right to act as this principal.
      await options.audit?.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'oauth.consent',
        result: 'allow',
        detail: {
          client_id: clientId,
          client_name: client.clientName,
          acts_as: subject.actsAs,
          ...(delegating
            ? {
                delegation_id: consentId,
                layers: (narrowing ?? []).map((l) => l.id),
                // Recorded because it is the answer to "why can this
                // application not delete anything", asked six months later.
                permissions: isStringArray(ceiling) ? ceiling : 'no ceiling',
              }
            : { service_account_id: serviceAccountId as string }),
        },
        requestId,
      })

      // The redirect is returned rather than performed: this is an API call
      // from a page, and the page is what navigates. `state` is echoed
      // untouched — it is the client's, it is opaque to us, and it is how the
      // client ties the response back to the request it started.
      const to = new URL(redirectUri)
      to.searchParams.set('code', code)
      const state = need('state')
      if (state !== undefined) to.searchParams.set('state', state)
      send(res, 200, { redirect_to: to.toString() }, requestId)
      return
    }

    if (instance === '/v1/service-accounts' && options.serviceAccounts !== undefined) {
      // org_admin, not "admin on some scope". A service account is a principal
      // in the organization rather than an object inside a workspace, and there
      // is no scope to check it against — someone holding admin on one layer
      // must not be able to mint credentials.
      if (!administers(auth)) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (req.method === 'GET') {
        const page = readPage(url.searchParams, instance, requestId)
        if (page instanceof Problem) {
          send(res, page.status, page.toJSON(), requestId)
          return
        }

        const { items, nextCursor } = await options.serviceAccounts.list(auth, page)
        send(res, 200, { items: items.map(accountJson), next_cursor: nextCursor }, requestId)
        return
      }

      if (req.method === 'POST') {
        const name = ((body ?? {}) as Record<string, unknown>).name
        if (typeof name !== 'string' || name.trim().length === 0) {
          const problem = badRequest(instance, requestId, "'name' is required.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const created = await options.serviceAccounts.create(auth, name.trim())

        if (created === undefined) {
          // 409, not 500. The name is unique per organization and a duplicate
          // is something the caller typed — it surfaced as an internal error
          // with the constraint name in the log and nothing on screen.
          await options.audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'create_service_account',
            result: 'deny',
            target: { name: name.trim() },
            detail: { reason: 'name taken' },
            requestId,
          })
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: `A service account named '${name.trim()}' already exists in this organization.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const { account, key } = created

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'create_service_account',
          result: 'allow',
          target: { service_account_id: account.id, name: account.name },
          // The prefix, never the key. This row is readable by anyone with the
          // audit log, and the key is not recoverable from anywhere else by
          // design — putting it here would undo that.
          detail: { key_prefix: account.keyPrefix },
          requestId,
        })

        // The only time the key exists outside the caller's process.
        send(res, 201, { ...accountJson(account), key }, requestId)
        return
      }
    }

    const accountMatch = /^\/v1\/service-accounts\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && accountMatch && options.serviceAccounts !== undefined) {
      if (!administers(auth)) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const id = decodeURIComponent(accountMatch[1] as string)
      const revoked = await options.serviceAccounts.revoke(auth, id)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'revoke_service_account',
        result: revoked ? 'allow' : 'deny',
        target: { service_account_id: id },
        detail: {},
        requestId,
      })

      if (!revoked) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    // ───────────────────────────── principals ─────────────────────────────
    //
    // Users and groups. `org_admin`, on the same argument service accounts
    // make: a principal belongs to the organization rather than to a scope
    // inside it, so there is nothing to check `admin` against — and someone
    // holding admin on one layer must not be able to mint one.
    //
    // The refusal writes a `deny` event. It surfaces as `404`, which is what
    // makes it easy to miss: an early return that answers "no such path" is
    // still a refusal, and `docs/audit.md` counts every one.
    const principalPath = /^\/v1\/(users|groups)(\/.*)?$/.exec(instance)
    if (principalPath !== null) {
      const port = principalPath[1] === 'users' ? options.users : options.groups
      if (port !== undefined && !administers(auth)) {
        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'administer_principals',
          result: 'deny',
          target: { path: instance, method: req.method ?? 'GET' },
          detail: { reason: 'not an org_admin' },
          requestId,
        })
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
    }

    if (instance === '/v1/users' && options.users !== undefined) {
      if (req.method === 'GET') {
        const page = readPage(url.searchParams, instance, requestId)
        if (page instanceof Problem) {
          send(res, page.status, page.toJSON(), requestId)
          return
        }

        const { items, nextCursor } = await options.users.list(auth, page)
        send(res, 200, { items: items.map(userJson), next_cursor: nextCursor }, requestId)
        return
      }

      if (req.method === 'POST') {
        const fields = (body ?? {}) as Record<string, unknown>
        const email = typeof fields.email === 'string' ? fields.email.trim() : ''
        if (!looksLikeEmail(email)) {
          const problem = badRequest(instance, requestId, "'email' is required and must be an address.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const role = fields.role ?? 'member'
        // `platform_admin` is deliberately not creatable here, and this is the
        // one refusal in this block that is about the model rather than about
        // input. That role administers the *installation* and spans tenants in
        // the multi-tenancy module; an org_admin minting one would be
        // escalating out of their own organization through an endpoint scoped
        // to it. It is set by whoever runs `init`, and stays there.
        if (role !== 'member' && role !== 'org_admin') {
          const problem = badRequest(
            instance,
            requestId,
            "'role' must be 'member' or 'org_admin'. 'platform_admin' administers the " +
              'installation rather than this organization and is not issued here.',
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const created = await options.users.create(auth, email, role)

        if (created === undefined) {
          await options.audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'create_user',
            result: 'deny',
            target: { email },
            detail: { reason: 'address taken' },
            requestId,
          })
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: `A user with the address '${email}' already exists in this organization.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'create_user',
          result: 'allow',
          target: { user_id: created.user.id, email },
          // The role, never the password — this row is readable by anyone with
          // the audit log, and the password is not recoverable from anywhere
          // else by design.
          detail: { role },
          requestId,
        })

        // The only time the password exists outside the caller's process.
        send(res, 201, { ...userJson(created.user), password: created.password }, requestId)
        return
      }
    }

    const userMatch = /^\/v1\/users\/([^/]+)$/.exec(instance)
    if (userMatch && options.users !== undefined) {
      const id = decodeURIComponent(userMatch[1] as string)

      if (req.method === 'DELETE') {
        // Disabled, never deleted, which is what `DELETE` means on every
        // removable thing here: a document is tombstoned, a key is revoked, and
        // a user keeps their row because the audit log names its id and
        // `grants.created_by` references it with no cascade. `PATCH` with
        // `disabled: false` is how somebody comes back.
        //
        // Through the same call `PATCH` makes rather than a second statement,
        // so the last-administrator guard covers both spellings. Two removals
        // with one check between them is how the guarded one gets routed
        // around.
        const disabled = await options.users.update(auth, id, { disabled: true })

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'disable_user',
          result: disabled === 'updated' ? 'allow' : 'deny',
          target: { user_id: id },
          detail: disabled === 'updated' ? {} : { reason: disabled },
          requestId,
        })

        if (disabled === 'platform-admin') {
          const problem = notAdministeredHere(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (disabled === 'last-admin') {
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail:
              'This is the only active org_admin in the organization. Promote another user ' +
              'first — an organization with none has no route back through the API.',
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (disabled === 'no-user') {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        send(res, 204, null, requestId)
        return
      }

      if (req.method === 'PATCH') {
        const fields = (body ?? {}) as Record<string, unknown>
        const wantsRole = 'role' in fields
        const wantsDisabled = 'disabled' in fields
        if (!wantsRole && !wantsDisabled) {
          const problem = badRequest(instance, requestId, "Give at least one of 'role' or 'disabled'.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        if (wantsRole && fields.role !== 'member' && fields.role !== 'org_admin') {
          const problem = badRequest(
            instance,
            requestId,
            "'role' must be 'member' or 'org_admin'. 'platform_admin' administers the " +
              'installation rather than this organization and is not issued here.',
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
        if (wantsDisabled && typeof fields.disabled !== 'boolean') {
          const problem = badRequest(instance, requestId, "'disabled' must be a boolean.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        // The last administrator cannot demote or disable themselves through
        // this path. Not paternalism: an organization with no `org_admin` has
        // no route back — every endpoint that could restore one is behind the
        // role that was just given up, and the remedy would be SQL. The check
        // is in the adapter, where it can count in the same transaction.
        const changed = await options.users.update(auth, id, {
          ...(wantsRole ? { role: fields.role as 'member' | 'org_admin' } : {}),
          ...(wantsDisabled ? { disabled: fields.disabled as boolean } : {}),
        })

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'update_user',
          result: changed === 'updated' ? 'allow' : 'deny',
          target: { user_id: id },
          detail: {
            ...(wantsRole ? { role: fields.role } : {}),
            ...(wantsDisabled ? { disabled: fields.disabled } : {}),
            ...(changed === 'updated' ? {} : { reason: changed }),
          },
          requestId,
        })

        if (changed === 'platform-admin') {
          const problem = notAdministeredHere(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (changed === 'last-admin') {
          // 409 rather than 404: the caller is looking straight at this user —
          // it is their own account or one they just listed — so the answer is
          // about the organization's state and not about what they can see.
          // Invariant 4 is about invisibility, and nothing here is invisible.
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail:
              'This is the only active org_admin in the organization. Promote another user ' +
              'first — an organization with none has no route back through the API.',
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        if (changed === 'no-user') {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        send(res, 204, null, requestId)
        return
      }
    }

    const passwordMatch = /^\/v1\/users\/([^/]+)\/password$/.exec(instance)
    if (req.method === 'POST' && passwordMatch && options.users !== undefined) {
      const id = decodeURIComponent(passwordMatch[1] as string)
      const reset = await options.users.resetPassword(auth, id)
      const refused = typeof reset === 'string' ? reset : undefined

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'reset_password',
        result: refused === undefined ? 'allow' : 'deny',
        // That it happened and to whom. Never the value.
        target: { user_id: id },
        detail: refused === undefined ? {} : { reason: refused },
        requestId,
      })

      // The refusal that matters most on this route, and the one the whole
      // guard was written for. Demoting a platform administrator takes the role
      // away; resetting their password hands the caller the plaintext in the
      // response and lets them sign in as the account that administers the
      // installation.
      if (reset === 'platform-admin') {
        const problem = notAdministeredHere(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      if (reset === 'no-user') {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      // Generated rather than chosen, for the reason `init` gives: an argument
      // ends up in a shell history, and a password an administrator picked is
      // one they know. This is the only time it exists outside the process.
      send(res, 200, { password: reset.password }, requestId)
      return
    }

    if (instance === '/v1/groups' && options.groups !== undefined) {
      if (req.method === 'GET') {
        const page = readPage(url.searchParams, instance, requestId)
        if (page instanceof Problem) {
          send(res, page.status, page.toJSON(), requestId)
          return
        }

        const { items, nextCursor } = await options.groups.list(auth, page)
        send(res, 200, { items: items.map(groupJson), next_cursor: nextCursor }, requestId)
        return
      }

      if (req.method === 'POST') {
        const name = ((body ?? {}) as Record<string, unknown>).name
        if (typeof name !== 'string' || name.trim().length === 0) {
          const problem = badRequest(instance, requestId, "'name' is required.")
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const created = await options.groups.create(auth, name.trim())

        if (created === undefined) {
          await options.audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'create_group',
            result: 'deny',
            target: { name: name.trim() },
            detail: { reason: 'name taken' },
            requestId,
          })
          const problem = new Problem({
            type: 'https://nacre.work/errors/conflict',
            title: 'Conflict',
            status: 409,
            detail: `A group named '${name.trim()}' already exists in this organization.`,
            instance,
            requestId,
          })
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'create_group',
          result: 'allow',
          target: { group_id: created.id, name: created.name },
          detail: {},
          requestId,
        })

        send(res, 201, groupJson(created), requestId)
        return
      }
    }

    const groupMatch = /^\/v1\/groups\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && groupMatch && options.groups !== undefined) {
      const id = decodeURIComponent(groupMatch[1] as string)
      const removed = await options.groups.remove(auth, id)

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'delete_group',
        result: removed ? 'allow' : 'deny',
        target: { group_id: id },
        detail: {},
        requestId,
      })

      if (!removed) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    const membersMatch = /^\/v1\/groups\/([^/]+)\/members$/.exec(instance)
    if (membersMatch && options.groups !== undefined) {
      const groupId = decodeURIComponent(membersMatch[1] as string)

      if (req.method === 'GET') {
        const page = readPage(url.searchParams, instance, requestId)
        if (page instanceof Problem) {
          send(res, page.status, page.toJSON(), requestId)
          return
        }

        const result = await options.groups.members(auth, groupId, page)
        if (result === undefined) {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        send(
          res,
          200,
          { items: result.items.map(memberJson), next_cursor: result.nextCursor },
          requestId,
        )
        return
      }

      if (req.method === 'POST') {
        const fields = (body ?? {}) as Record<string, unknown>
        const type = fields.type
        const memberId = fields.id
        if ((type !== 'user' && type !== 'group') || typeof memberId !== 'string') {
          const problem = badRequest(
            instance,
            requestId,
            "'type' must be 'user' or 'group', and 'id' is required.",
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        const outcome = await options.groups.addMember(auth, groupId, { type, id: memberId })

        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'add_group_member',
          result: outcome === 'no-group' || outcome === 'no-member' ? 'deny' : 'allow',
          target: { group_id: groupId, member_type: type, member_id: memberId },
          detail: {
            ...(outcome === 'already' ? { note: 'already a member' } : {}),
            ...(outcome === 'no-group' || outcome === 'no-member' ? { reason: outcome } : {}),
          },
          requestId,
        })

        if (outcome === 'no-group' || outcome === 'no-member') {
          const problem = notFound(instance, requestId)
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }

        // 204 for both `added` and `already`. The request asked for a state and
        // that state holds either way, and distinguishing them would tell a
        // caller whether somebody was already in a group — which is a fact
        // about the group and not about their request.
        send(res, 204, null, requestId)
        return
      }
    }

    // `{type}/{id}` rather than `{id}` alone: the edge is keyed by which member
    // column it uses, so a bare uuid does not identify one. Same shape `grants`
    // uses for the other end of the same relationship.
    const memberMatch = /^\/v1\/groups\/([^/]+)\/members\/(user|group)\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && memberMatch && options.groups !== undefined) {
      const groupId = decodeURIComponent(memberMatch[1] as string)
      const type = memberMatch[2] as 'user' | 'group'
      const memberId = decodeURIComponent(memberMatch[3] as string)

      const removed = await options.groups.removeMember(auth, groupId, { type, id: memberId })

      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'remove_group_member',
        result: removed ? 'allow' : 'deny',
        target: { group_id: groupId, member_type: type, member_id: memberId },
        detail: {},
        requestId,
      })

      if (!removed) {
        const problem = notFound(instance, requestId)
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      send(res, 204, null, requestId)
      return
    }

    const problem = notFound(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
  } catch (error) {
    // The 500 body says "whatever went wrong is in the journal under this
    // request_id", and until this line nothing wrote it there: the error was
    // discarded by a bare `catch`, and the audit row carried an empty detail.
    // A caller reporting a 500 with a request id had nothing to be joined to.
    //
    // The message, not the request. A handler failure can carry a query string
    // or a document body in its cause, and neither belongs in a log — see the
    // list in CLAUDE.md. `String(error)` is the class and the message; the
    // stack goes with it because that is what names the line.
    logger.error('request failed', { request_id: requestId,
        method: req.method,
        instance,
        org_id: auth.orgId,
        error: String(error).slice(0, 500),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined })

    await options.audit
      .write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: instance,
        result: 'error',
        // The class alone. An audit row is read by more people than a log line
        // and is retained far longer, so it says what kind of failure it was
        // and points at the log for the rest.
        detail: { error: error instanceof Error ? error.name : 'unknown' },
        requestId,
      })
      .catch((cause: unknown) => {
        // Losing the audit row of a failed request is itself worth a line.
        logger.error('audit write failed', { request_id: requestId, error: String(cause) })
      })

    const problem = internal(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
  }
}
