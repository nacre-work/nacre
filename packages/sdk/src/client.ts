import { NacreError, NacreTransportError, type Problem } from './errors.js'
import type {
  CreatedServiceAccount,
  Document,
  Grant,
  GrantInput,
  IngestOutcome,
  IngestRequest,
  Job,
  Layer,
  LayerInput,
  SearchHit,
  SearchOptions,
  ServiceAccount,
} from './types.js'

/**
 * The TypeScript client.
 *
 * Two decisions shape the whole surface, and both are about the permission
 * model rather than about ergonomics.
 *
 * **No method takes an organization.** Not as an option, not as an override for
 * administrators, not anywhere. Invariant I1 says the organization comes from
 * the token, and the server refuses a request that names one with a 403 — which
 * from inside an application reads as a bug in this library. Making it
 * unrepresentable is cheaper than explaining it.
 *
 * **`get`-shaped methods answer `undefined` for 404 rather than throwing.** The
 * API returns the same 404, with the same wording, for "absent" and for "not
 * yours" (invariant I4). A client that surfaced those as an exception would
 * invite a `catch` that treats one as retryable and the other as fatal, and
 * there is no information here to tell them apart. `undefined` says exactly
 * what the server said.
 *
 * Zero dependencies. `fetch` is in every runtime this targets, and a client for
 * a security product is the wrong place to inherit a dependency tree.
 */

export interface ClientOptions {
  /** Where the API lives, e.g. `https://api.nacre.work`. No trailing `/v1`. */
  readonly baseUrl: string
  /**
   * A JWT from `init`, or a `nacre_sk_` service account key. The client does
   * not care which — both go in the same header, and the server distinguishes
   * them. The organization is inside it, which is why no method takes one.
   */
  readonly token: string
  /** Per-request timeout in milliseconds. Default 30 seconds. */
  readonly timeoutMs?: number
  /**
   * Attempts for a transient failure (429, 503, 5xx). Default 2, meaning one
   * retry. Only ever applied to safe methods and to ingest, which is idempotent
   * on `(layer, external_id)` and its content hash — retrying a delete or a
   * grant would be a second, different write.
   */
  readonly retries?: number
  /** Swap in for tests, or for a runtime with its own instrumented fetch. */
  readonly fetch?: typeof globalThis.fetch
}

interface RequestOptions {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  /** Safe or idempotent, so a transient failure may be retried. */
  readonly retryable?: boolean
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 2

const isProblem = (value: unknown): value is Problem =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { status?: unknown }).status === 'number' &&
  typeof (value as { title?: unknown }).title === 'string'

export class NacreClient {
  readonly #base: string
  readonly #token: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #fetch: typeof globalThis.fetch

  constructor(options: ClientOptions) {
    if (!options.baseUrl) throw new TypeError('baseUrl is required')
    if (!options.token) throw new TypeError('token is required')

    // Trailing slashes are stripped so `${base}/v1/...` cannot become `//v1`,
    // which some proxies redirect and some reject.
    this.#base = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#retries = Math.max(1, options.retries ?? DEFAULT_RETRIES)
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async #once(options: RequestOptions): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    let response: Response
    try {
      response = await this.#fetch(`${this.#base}${options.path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          accept: 'application/json',
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      })
    } catch (cause) {
      throw new NacreTransportError(
        options.signal?.aborted === true
          ? 'the request was aborted by the caller'
          : `could not reach ${this.#base}`,
        undefined,
        { cause },
      )
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    if (response.status === 204) return undefined

    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length === 0 ? undefined : JSON.parse(text)
    } catch (cause) {
      throw new NacreTransportError(
        `${options.method} ${options.path} answered ${response.status} with a body that is not JSON`,
        response.status,
        { cause },
      )
    }

    if (response.ok) return parsed

    // A problem document, or something upstream of the API answered — a proxy,
    // a load balancer, a WAF. Saying which matters: the second is not the
    // server refusing, and no request id exists to look up.
    if (isProblem(parsed)) throw new NacreError(parsed)
    throw new NacreTransportError(
      `${options.method} ${options.path} answered ${response.status} without a problem document; ` +
        'something between this client and the API answered instead',
      response.status,
    )
  }

  async #request(options: RequestOptions): Promise<unknown> {
    let attempt = 0
    for (;;) {
      attempt++
      try {
        return await this.#once(options)
      } catch (error) {
        const transient =
          (error instanceof NacreError && error.isTransient) ||
          (error instanceof NacreTransportError && error.status === undefined)

        // Retrying a delete or a grant would be a second, different write. Only
        // the caller's own abort ends this early, and it is not transient.
        if (!options.retryable || !transient || attempt >= this.#retries) throw error
        if (options.signal?.aborted === true) throw error

        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)))
      }
    }
  }

  /** `undefined` for 404 — absent and invisible are one answer. */
  async #maybe<T>(options: RequestOptions): Promise<T | undefined> {
    try {
      return (await this.#request(options)) as T
    } catch (error) {
      if (error instanceof NacreError && error.isNotFound) return undefined
      throw error
    }
  }

  // ─── search ──────────────────────────────────────────────────────────────

  /**
   * Search, bounded by what this token may see.
   *
   * `topK` goes through uncorrected: the filter is applied inside the index
   * traversal, so this many permitted results come back rather than this many
   * candidates minus whatever was stripped afterwards.
   */
  async search(query: string, options: SearchOptions = {}): Promise<readonly SearchHit[]> {
    const body = await this.#request({
      method: 'POST',
      path: '/v1/search',
      body: {
        query,
        top_k: options.topK ?? 10,
        ...(options.layers === undefined ? {} : { layers: options.layers }),
        ...(options.filters === undefined ? {} : { filters: options.filters }),
        ...(options.includeContent === undefined ? {} : { include_content: options.includeContent }),
        ...(options.rerank === undefined ? {} : { rerank: options.rerank }),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      retryable: true,
    })

    const items = (body as { items?: unknown[] }).items ?? []
    return items.map((h) => {
      const hit = h as Record<string, unknown>
      return {
        documentId: String(hit.document_id ?? ''),
        chunkId: String(hit.chunk_id ?? ''),
        score: Number(hit.score ?? 0),
        text: String(hit.text ?? ''),
        layer: String(hit.layer ?? ''),
        title: (hit.title as string | null) ?? null,
      }
    })
  }

  // ─── documents ───────────────────────────────────────────────────────────

  readonly documents = {
    /**
     * Queue a document. `202` and a job id, or `200` and `unchanged: true` when
     * the same bytes are already indexed.
     */
    add: async (request: IngestRequest): Promise<IngestOutcome> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/documents',
        body: {
          layer: request.layer,
          external_id: request.externalId,
          ...(request.title === undefined ? {} : { title: request.title }),
          ...(request.content === undefined ? {} : { content: request.content }),
          ...(request.url === undefined ? {} : { url: request.url }),
          ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
        },
        // Idempotent on (layer, external_id) and the content hash, so a retry
        // after a timeout cannot produce a second document or a second version.
        retryable: true,
      })) as Record<string, unknown>

      return {
        documentId: String(body.document_id),
        jobId: String(body.job_id),
        unchanged: body.status === 'indexed',
      }
    },

    get: async (documentId: string): Promise<Document | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/documents/${encodeURIComponent(documentId)}`,
        retryable: true,
      })
      if (body === undefined) return undefined

      return {
        documentId: String(body.document_id),
        layer: String(body.layer ?? ''),
        title: (body.title as string | null) ?? null,
        status: body.status as Document['status'],
        chunkCount: Number(body.chunk_count ?? 0),
        updatedAt: String(body.updated_at ?? ''),
      }
    },

    /**
     * Delete a document. `true` when it was deleted, `false` when it was
     * already gone or was never visible to this caller.
     *
     * It leaves search immediately — the vectors are flagged before the row is
     * written, and collection of the points is a background job that nothing
     * depends on.
     */
    remove: async (documentId: string): Promise<boolean> => {
      try {
        await this.#request({
          method: 'DELETE',
          path: `/v1/documents/${encodeURIComponent(documentId)}`,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },
  }

  // ─── jobs ────────────────────────────────────────────────────────────────

  readonly jobs = {
    get: async (jobId: string): Promise<Job | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/jobs/${encodeURIComponent(jobId)}`,
        retryable: true,
      })
      if (body === undefined) return undefined

      return {
        jobId: String(body.job_id),
        documentId: String(body.document_id),
        status: body.status as Job['status'],
        error: (body.error as string | null) ?? null,
      }
    },

    /**
     * Poll until the job leaves the queue.
     *
     * Ingest is asynchronous by design — parsing and embedding are slow enough
     * that holding a request open for them is how a client times out and
     * retries into a second copy of the same work. This is the wait, written
     * once, so every caller does not write it slightly differently.
     *
     * Resolves on `indexed` **and** on `failed`: both are terminal, and a
     * helper that threw on failure would bury the reason the job carries.
     */
    wait: async (
      jobId: string,
      options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
    ): Promise<Job | undefined> => {
      const interval = options.intervalMs ?? 1000
      const deadline = Date.now() + (options.timeoutMs ?? 300_000)

      for (;;) {
        const job = await this.jobs.get(jobId)
        if (job === undefined) return undefined
        if (job.status === 'indexed' || job.status === 'failed') return job

        if (Date.now() + interval > deadline) {
          throw new NacreTransportError(`job ${jobId} was still ${job.status} after the timeout`)
        }
        if (options.signal?.aborted === true) {
          throw new NacreTransportError('the wait was aborted by the caller')
        }
        await new Promise((r) => setTimeout(r, interval))
      }
    },
  }

  // ─── layers ──────────────────────────────────────────────────────────────

  readonly layers = {
    /** Only the layers this token may read. The catalog is permission data. */
    list: async (): Promise<readonly Layer[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/layers',
        retryable: true,
      })) as { items?: unknown[] }

      return (body.items ?? []).map((l) => {
        const layer = l as Record<string, unknown>
        return {
          id: String(layer.id),
          slug: String(layer.slug),
          name: String(layer.name ?? ''),
          description: String(layer.description ?? ''),
          documentCount: Number(layer.document_count ?? 0),
        }
      })
    },

    create: async (input: LayerInput): Promise<Layer | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/layers',
        body: {
          workspace_id: input.workspaceId,
          slug: input.slug,
          name: input.name,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.providerId === undefined ? {} : { provider_id: input.providerId }),
        },
      })
      if (body === undefined) return undefined

      return {
        id: String(body.id),
        slug: String(body.slug),
        name: String(body.name ?? ''),
        description: String(body.description ?? ''),
        documentCount: Number(body.document_count ?? 0),
      }
    },
  }

  // ─── grants ──────────────────────────────────────────────────────────────

  readonly grants = {
    list: async (): Promise<readonly Grant[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/grants',
        retryable: true,
      })) as { items?: unknown[] }
      return (body.items ?? []).map((g) => grantFrom(g as Record<string, unknown>))
    },

    /**
     * Issue a grant. Requires admin on the scope being granted, not admin in
     * general — otherwise holding admin on one layer would be a way to grant
     * yourself another.
     */
    issue: async (input: GrantInput): Promise<Grant | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/grants',
        body: {
          principal_type: input.principalType,
          principal_id: input.principalId,
          scope_type: input.scopeType,
          scope_id: input.scopeId,
          permission: input.permission,
        },
      })
      return body === undefined ? undefined : grantFrom(body)
    },

    /**
     * Withdraw a grant. `false` when it is absent or on a scope this caller may
     * not administer.
     *
     * The change is reflected in results within the propagation SLA, not
     * instantly: the payload tags on the vectors are recomputed by the worker.
     * `nacre_acl_propagation_lag_seconds` is what says how far behind that is.
     */
    revoke: async (grantId: string): Promise<boolean> => {
      try {
        await this.#request({
          method: 'DELETE',
          path: `/v1/grants/${encodeURIComponent(grantId)}`,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },
  }

  // ─── service accounts ────────────────────────────────────────────────────

  readonly serviceAccounts = {
    list: async (): Promise<readonly ServiceAccount[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/service-accounts',
        retryable: true,
      })) as { items?: unknown[] }
      return (body.items ?? []).map((a) => accountFrom(a as Record<string, unknown>))
    },

    /** The response carries the key. It is not recoverable afterwards. */
    create: async (name: string): Promise<CreatedServiceAccount> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/service-accounts',
        body: { name },
      })) as Record<string, unknown>

      return { ...accountFrom(body), key: String(body.key) }
    },

    revoke: async (id: string): Promise<boolean> => {
      try {
        await this.#request({
          method: 'DELETE',
          path: `/v1/service-accounts/${encodeURIComponent(id)}`,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },
  }

  // ─── health ──────────────────────────────────────────────────────────────

  /** Liveness. Touches no dependency, and needs no token to be useful. */
  async health(): Promise<boolean> {
    try {
      await this.#request({ method: 'GET', path: '/v1/health', retryable: true })
      return true
    } catch {
      return false
    }
  }
}

function grantFrom(g: Record<string, unknown>): Grant {
  return {
    id: String(g.id),
    principalType: g.principal_type as Grant['principalType'],
    principalId: String(g.principal_id),
    scopeType: g.scope_type as Grant['scopeType'],
    scopeId: String(g.scope_id),
    permission: g.permission as Grant['permission'],
    effect: g.effect as Grant['effect'],
    source: String(g.source ?? ''),
  }
}

function accountFrom(a: Record<string, unknown>): ServiceAccount {
  return {
    id: String(a.id),
    name: String(a.name ?? ''),
    keyPrefix: String(a.key_prefix ?? ''),
    createdAt: String(a.created_at ?? ''),
    lastUsedAt: (a.last_used_at as string | null) ?? null,
    revokedAt: (a.revoked_at as string | null) ?? null,
  }
}
