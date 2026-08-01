import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
// Imported rather than taken from the global scope: `lib` is ES2023 with no
// DOM, so the global URL is not typed here.
import { URL } from 'node:url'

import { authenticate, rejectTenantOverride, type AuthContext, type VerifyOptions } from './auth.js'
import { badRequest, internal, notFound, Problem } from './errors.js'

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
   * **Undefined must mean the same thing for "does not exist" and "exists in
   * another organization".** If this ever grows a third answer, the 403/404
   * distinction leaks through whatever the caller does with it.
   */
  read(orgId: string, documentId: string): Promise<{ id: string; title: string } | undefined>
}

export interface SearchService {
  search(auth: AuthContext, query: string, topK: number): Promise<readonly unknown[]>
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
  /** `undefined` for absent and for another organization's job alike. */
  read(orgId: string, jobId: string): Promise<Job | undefined>
}

export interface Layer {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly workspaceId: string
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
  /** Only the layers this caller may read. The plan decides, not the caller. */
  list(auth: AuthContext): Promise<readonly Layer[]>
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
  list(auth: AuthContext): Promise<readonly GrantRecord[]>
  /** `undefined` when the caller may not administer the scope, or it does not exist. */
  issue(auth: AuthContext, input: GrantInput): Promise<GrantRecord | undefined>
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
  readonly documents: Documents
  readonly search: SearchService
  readonly ingest: Ingest
  readonly audit: AuditSink
  readonly jobs?: Jobs
  readonly layers?: Layers
  readonly grants?: Grants
}

const MAX_BODY_BYTES = 1_000_000

const PRINCIPAL_TYPES = ['user', 'group', 'service_account'] as const
const PERMISSIONS = ['read', 'write', 'admin'] as const

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

function send(res: ServerResponse, status: number, body: unknown, requestId: string): void {
  const json = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    'x-request-id': requestId,
  })
  res.end(json)
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

      res.writeHead(204, { 'x-request-id': requestId })
      res.end()
      return
    }

    if (req.method === 'GET' && documentMatch) {
      const id = decodeURIComponent(documentMatch[1] as string)
      const document = await options.documents.read(auth.orgId, id)

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
      const job = await options.jobs.read(auth.orgId, id)

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
      const layers = await options.layers.list(auth)
      // No audit event: this returns what the caller may already read, and one
      // event per listing buries the ones that matter.
      send(
        res,
        200,
        {
          items: layers.map((l) => ({
            id: l.id,
            slug: l.slug,
            name: l.name,
            workspace_id: l.workspaceId,
          })),
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
        { id: created.id, slug: created.slug, name: created.name, workspace_id: created.workspaceId },
        requestId,
      )
      return
    }

    if (req.method === 'GET' && instance === '/v1/grants' && options.grants !== undefined) {
      const grants = await options.grants.list(auth)
      send(res, 200, { items: grants.map(grantJson) }, requestId)
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

    const problem = notFound(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
  } catch {
    await options.audit
      .write({
        orgId: auth.orgId,
        actor: `${auth.principal.type}:${auth.principal.id}`,
        action: instance,
        result: 'error',
        detail: {},
        requestId,
      })
      .catch(() => {})
    const problem = internal(instance, requestId)
    send(res, problem.status, problem.toJSON(), requestId)
  }
}
