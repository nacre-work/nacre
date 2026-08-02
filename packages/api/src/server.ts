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
  TooBusy,
  type Metadata,
  type MultipartPart,
  type ProtectedResourceMetadata,
} from '@nacre.work/core'

import { authenticate, rejectTenantOverride, type AuthContext, type VerifyOptions } from './auth.js'
import { badRequest, internal, notFound, Problem } from './errors.js'
import { isConflict, isReplay, type IdempotencyStore } from './idempotency.js'
import { limitHeaders, type LimitDecision, type LimitPolicy, type RateLimiter, type Resource } from './limits.js'
import type { Login, Tokens } from './login.js'
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
  readonly layer: string
  readonly title: string | null
  readonly status: string
  readonly chunk_count: number
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
  /** Validated before it gets here. `{}` when the caller sent none. */
  readonly metadata: Metadata
}

export interface IngestOutcome {
  readonly documentId: string
  readonly jobId: string
  /** True when the idempotency key and content hash both matched. */
  readonly unchanged: boolean
}

export interface Ingest {
  /**
   * Queue a document, or refuse.
   *
   * `undefined` means the caller may not write to that layer — and it must mean
   * the same for a layer that does not exist. Ingest is the cheapest oracle in
   * the system otherwise: a caller with no read access could enumerate layer
   * names by watching which ones accept a document.
   */
  queue(auth: AuthContext, request: IngestRequest): Promise<IngestOutcome | undefined>
  /** Tombstone. `false` for absent and for not-permitted alike. */
  remove(auth: AuthContext, documentId: string): Promise<boolean>
}

export interface Job {
  readonly jobId: string
  readonly documentId: string
  readonly status: 'queued' | 'parsing' | 'embedding' | 'indexed' | 'failed'
  readonly progress: number
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
   * This is the operation `nacre_acl_propagation_lag_seconds` measures and the
   * one docs/authz.md builds its SLA around, and there was no way to perform it
   * through the API at all. Three documents described revocation; the only
   * implementation was a DELETE against the table by hand.
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

export interface AuditEvent {
  readonly orgId: string
  readonly actor: string
  readonly action: string
  readonly result: 'allow' | 'deny' | 'error'
  readonly detail: Record<string, unknown>
  readonly requestId: string
  /**
   * Which surface the call came in on.
   *
   * Was hardcoded `'api'` in the adapter, and the MCP server shares that sink —
   * so every agent's read was logged as though a human had made it over REST.
   * The column existed, the schema declared the enum, and nothing could tell
   * the two apart. Defaults to `api` so an omission is the common case rather
   * than a lie.
   */
  readonly surface?: 'api' | 'mcp' | 'admin' | 'system'
  /**
   * What the call was about, as `docs/audit.md` specifies it.
   *
   * Was hardcoded `'{}'::jsonb`, so the `gin (target)` index built for it
   * indexed nothing and the document's opening promise — "show me which
   * documents your agent read last quarter" — could not be answered at all.
   * Search fills in the layers and the ids it returned; the rest name what they
   * touched.
   */
  readonly target?: Record<string, unknown>
}

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

export interface AuditSink {
  /** Awaited before the response goes out. A lost event is worse than a slow response. */
  write(event: AuditEvent): Promise<void>
}

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
}

export interface AuditReader {
  read(auth: AuthContext, query: AuditQuery, page: Page): Promise<PageResult<AuditRecord>>
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
   * The RFC 9728 document served at `/.well-known/oauth-protected-resource`.
   *
   * Passed in rather than built here so the API and the MCP transport serve
   * byte-identical bytes: two builders would drift, and a client that read one
   * and authenticated against the other would be audience-bound to a string
   * neither agreed on.
   */
  readonly resourceMetadata?: ProtectedResourceMetadata
  /** Absent means the workspace paths answer 404, like any capability a surface lacks. */
  readonly workspaces?: Workspaces
  /** Layer reindex. Absent means the reindex paths answer 404. */
  readonly reindex?: Reindex
  /** Reads the access log back. Absent means `/v1/audit` answers 404. */
  readonly auditReader?: AuditReader
  /** `Idempotency-Key` on unsafe methods. Absent means the header is ignored. */
  readonly idempotency?: IdempotencyStore
  /** Email and password sign-in. Absent means `/v1/auth/*` is 404. */
  readonly login?: Login
  readonly documents: Documents
  readonly search: SearchService
  readonly ingest: Ingest
  readonly audit: AuditSink
  readonly jobs?: Jobs
  readonly layers?: Layers
  readonly grants?: Grants
  readonly serviceAccounts?: ServiceAccountPort
  /** `NACRE_MAX_DOCUMENT_BYTES`. Over it is `413`, not `400`. */
  readonly maxBodyBytes?: number
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
  }
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
  }
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

    let tokens: Tokens | undefined
    try {
      tokens = await options.login.login({
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

    if (tokens === undefined) {
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

    // The successful one does have an organization to belong to, and it is the
    // event that answers "who has been in here". Awaited: a lost audit event is
    // worse than a slow response.
    await options.audit.write({
      orgId: tokens.orgId,
      actor: `user:${tokens.userId}`,
      action: 'login',
      result: 'allow',
      detail: {},
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
  return createServer((req, res) => {
    void handle(req, res, options).catch(() => {
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
      detail: { path: instance },
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
        detail: { resource, limit: decision.limit },
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
        // Decoded here, and refused here, rather than queued and failed later.
        //
        // The parser this feeds extracts no binary formats — it is stdlib-only
        // on purpose, since it runs hostile input through whatever it depends
        // on. Until this check existed the sidecar decoded with
        // `errors="replace"`, so a PDF became a string of replacement
        // characters that was chunked, embedded, stored as the document body
        // and reported as indexed.
        //
        // At the edge the caller learns immediately and nothing is queued. Deep
        // in the worker they would have learned from a `failed` row minutes
        // later, if they looked.
        const decoder = new TextDecoder('utf-8', { fatal: true })
        try {
          content = decoder.decode(uploaded.bytes)
        } catch {
          const problem = badRequest(
            instance,
            requestId,
            'The uploaded file is not UTF-8 text. This installation extracts no binary formats — ' +
              'a PDF, a Word file or an image needs an extractor the parser deliberately does not carry.',
          )
          send(res, problem.status, problem.toJSON(), requestId)
          return
        }
      }
      const url_ = body_.url

      if (typeof layer !== 'string' || typeof externalId !== 'string') {
        const problem = badRequest(instance, requestId, "'layer' and 'external_id' are required.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }
      if ((typeof content === 'string') === (typeof url_ === 'string')) {
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
          ...(job.error === undefined ? {} : { error: job.error }),
        },
        requestId,
      )
      return
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
          detail: { slug, outcome: outcome.kind },
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
        detail: { workspace_id: workspaceId, slug, outcome: outcome.kind },
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
        detail: {
          principal: `${parsed.principalType}:${parsed.principalId}`,
          scope: `${parsed.scopeType}:${parsed.scopeId}`,
          permission: parsed.permission,
        },
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
        detail: { grant_id: id },
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
      if (auth.role !== 'org_admin' && auth.role !== 'platform_admin') {
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
        { ...query, administrativeOnly: auth.role === 'platform_admin' },
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

    if (instance === '/v1/service-accounts' && options.serviceAccounts !== undefined) {
      // org_admin, not "admin on some scope". A service account is a principal
      // in the organization rather than an object inside a workspace, and there
      // is no scope to check it against — someone holding admin on one layer
      // must not be able to mint credentials.
      if (auth.role !== 'org_admin') {
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
            detail: { name: name.trim(), reason: 'name taken' },
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
          // The prefix, never the key. This row is readable by anyone with the
          // audit log, and the key is not recoverable from anywhere else by
          // design — putting it here would undo that.
          detail: { service_account_id: account.id, key_prefix: account.keyPrefix },
          requestId,
        })

        // The only time the key exists outside the caller's process.
        send(res, 201, { ...accountJson(account), key }, requestId)
        return
      }
    }

    const accountMatch = /^\/v1\/service-accounts\/([^/]+)$/.exec(instance)
    if (req.method === 'DELETE' && accountMatch && options.serviceAccounts !== undefined) {
      if (auth.role !== 'org_admin') {
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
        detail: { service_account_id: id },
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
