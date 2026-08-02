import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
// Imported rather than taken from the global scope: `lib` is ES2023 with no
// DOM, so the global URL is not typed here.
import { URL } from 'node:url'

import { authenticate, rejectTenantOverride, type AuthContext, type VerifyOptions } from './auth.js'
import { badRequest, internal, notFound, Problem } from './errors.js'
import { isConflict, isReplay, type IdempotencyStore } from './idempotency.js'
import { limitHeaders, type LimitPolicy, type RateLimiter, type Resource } from './limits.js'
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

export interface SearchService {
  search(auth: AuthContext, query: string, topK: number): Promise<readonly SearchHit[]>
}

export interface IngestRequest {
  readonly layer: string
  readonly externalId: string
  readonly title?: string
  readonly content?: string
  readonly url?: string
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
export type LayerOutcome =
  | { readonly kind: 'created'; readonly layer: Layer }
  | { readonly kind: 'denied' }
  | { readonly kind: 'conflict' }

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
    input: { workspaceId: string; slug: string; name: string },
  ): Promise<LayerOutcome>
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
}

export interface AuditSink {
  /** Awaited before the response goes out. A lost event is worse than a slow response. */
  write(event: AuditEvent): Promise<void>
}

export interface ApiOptions {
  readonly verify: VerifyOptions
  /** Rendered at /metrics. Absent means the endpoint answers 404. */
  readonly metrics?: { render(): Promise<string> }
  /**
   * Per-organization rate limiting. Absent means unlimited, which is the right
   * default for a surface being tested and the wrong one for a deployment —
   * `main.ts` always provides it.
   */
  readonly limits?: RateLimiter
  readonly limitPolicies?: Readonly<Record<Resource, LimitPolicy>>
  /** `Idempotency-Key` on unsafe methods. Absent means the header is ignored. */
  readonly idempotency?: IdempotencyStore
  readonly documents: Documents
  readonly search: SearchService
  readonly ingest: Ingest
  readonly audit: AuditSink
  readonly jobs?: Jobs
  readonly layers?: Layers
  readonly grants?: Grants
  readonly serviceAccounts?: ServiceAccountPort
}

const MAX_BODY_BYTES = 1_000_000

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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
 * The test for adding a path: **would the response be a problem in a cache
 * dump?** If a response is only ever shown once on purpose, it does not go in a
 * store with a 24-hour TTL and no access control of its own.
 */
const NEVER_CACHED: ReadonlySet<string> = new Set(['/v1/service-accounts', '/v1/documents'])

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
    // Unauthenticated, like every Prometheus endpoint, and therefore carrying
    // nothing that is not already a count. No document ids, no query text, no
    // organization ids — organizations appear by slug, which is in the URL of
    // every request that tenant makes anyway.
    if (options.metrics === undefined) {
      const problem = notFound(instance, requestId)
      send(res, problem.status, problem.toJSON(), requestId)
      return
    }
    const body = await options.metrics.render()
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' })
    res.end(body)
    return
  }

  if (req.method === 'GET' && instance === '/v1/health') {
    // Liveness touches no dependency. A health check that calls Postgres turns
    // one slow database into a cascading restart loop.
    send(res, 200, { status: 'ok' }, requestId)
    return
  }

  const auth = await authenticate(req.headers.authorization, options.verify, instance, requestId)
  if (auth instanceof Problem) {
    send(res, auth.status, auth.toJSON(), requestId)
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
    !NEVER_CACHED.has(instance)
  ) {
    const outcome = await options.idempotency.begin(
      idempotencyKey,
      auth.orgId,
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
      const query = (body as { query?: unknown } | undefined)?.query
      const topK = (body as { top_k?: unknown } | undefined)?.top_k
      if (typeof query !== 'string' || query.length === 0) {
        const problem = badRequest(instance, requestId, "'query' is required.")
        send(res, problem.status, problem.toJSON(), requestId)
        return
      }

      const results = await options.search.search(auth, query, typeof topK === 'number' ? topK : 10)
      await options.audit.write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: 'search',
        result: 'allow',
        detail: { returned: results.length },
        requestId,
      })
      send(res, 200, { items: results }, requestId)
      return
    }

    if (req.method === 'POST' && instance === '/v1/documents') {
      const body_ = (body ?? {}) as Record<string, unknown>
      const layer = body_.layer
      const externalId = body_.external_id
      const content = body_.content
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

      const outcome = await options.ingest.queue(auth, {
        layer,
        externalId,
        ...(typeof body_.title === 'string' ? { title: body_.title } : {}),
        ...(typeof content === 'string' ? { content } : {}),
        ...(typeof url_ === 'string' ? { url: url_ } : {}),
      })

      if (outcome === undefined) {
        // Not 403. A caller without write access must not learn which layers
        // exist by seeing which ones refuse differently from which ones are
        // absent.
        await options.audit.write({
          orgId: auth.orgId,
          actor: `${auth.principal.type}:${auth.principal.id}`,
          action: 'ingest',
          result: 'deny',
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

      const outcome = await options.layers.create(auth, { workspaceId, slug, name })

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
    console.error(
      JSON.stringify({
        msg: 'request failed',
        request_id: requestId,
        method: req.method,
        instance,
        org_id: auth.orgId,
        error: String(error).slice(0, 500),
        stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
      }),
    )

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
        console.error(
          JSON.stringify({ msg: 'audit write failed', request_id: requestId, error: String(cause) }),
        )
      })

    const problem = internal(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
  }
}
