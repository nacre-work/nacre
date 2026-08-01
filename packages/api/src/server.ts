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
  readonly documents: Documents
  readonly search: SearchService
  readonly audit: AuditSink
}

const MAX_BODY_BYTES = 1_000_000

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

    const documentMatch = /^\/v1\/documents\/([^/]+)$/.exec(instance)
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
