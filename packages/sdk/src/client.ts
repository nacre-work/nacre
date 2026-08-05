import { NacreError, NacreTransportError, type Problem } from './errors.js'
import type {
  AuditPage,
  AuditQuery,
  AuditRecord,
  CreatedServiceAccount,
  CreatedUser,
  Document,
  Grant,
  GrantInput,
  Group,
  GroupMember,
  IngestOutcome,
  IngestRequest,
  Job,
  Layer,
  LayerInput,
  RecallCheck,
  ReferenceQuery,
  ReferenceQueryInput,
  ReindexStatus,
  Tokens,
  Workspace,
  SearchHit,
  SearchOptions,
  Connection,
  Self,
  ServiceAccount,
  User,
  UserRole,
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
  /**
   * A refresh token, which turns on automatic renewal. With one set, a `401`
   * from an ordinary request makes the client exchange it for a new pair once
   * and replay the request, so a caller does not see the `401`s a forced key
   * rotation or an expiry between calls would otherwise cause. Without one, a
   * `401` surfaces exactly as before — which is the right behaviour for a
   * service-account key, since `nacre_sk_` is not a JWT and has nothing to
   * refresh.
   *
   * The renewal is shared: a burst of concurrent requests that all `401`
   * triggers exactly **one** exchange, because replaying a spent refresh token
   * revokes the whole family, and a client that let ten requests each present
   * the same one would sign its user out on the second.
   */
  readonly refreshToken?: string
  /**
   * Called whenever the client rotates its tokens, with the new pair. Persist
   * the refresh token here — the old one is spent the moment the new one is
   * issued, so an application that reconstructs the client from storage without
   * this loses the session on the next start. Not called for the explicit
   * `auth.login`/`auth.refresh` methods, which hand the tokens back directly.
   */
  readonly onTokens?: (tokens: Tokens) => void
}

interface RequestOptions {
  readonly method: string
  readonly path: string
  readonly body?: unknown
  readonly signal?: AbortSignal
  /** Safe or idempotent, so a transient failure may be retried. */
  readonly retryable?: boolean
  /**
   * The sign-in endpoints and the internal renewal set this, so a `401` from
   * them is an answer rather than a trigger for another renewal — a refresh
   * that itself `401`s means the session is over, not that it should recurse.
   */
  readonly noAuthRefresh?: boolean
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
  #token: string
  readonly #timeoutMs: number
  readonly #retries: number
  readonly #fetch: typeof globalThis.fetch
  #refreshToken: string | undefined
  readonly #onTokens: ((tokens: Tokens) => void) | undefined
  /** The one in-flight renewal, shared by every request that 401s during it. */
  #renewing: Promise<boolean> | undefined

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
    this.#refreshToken = options.refreshToken
    this.#onTokens = options.onTokens
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

  async #attempt(options: RequestOptions): Promise<unknown> {
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

  async #request(options: RequestOptions): Promise<unknown> {
    try {
      return await this.#attempt(options)
    } catch (error) {
      // A 401 on an ordinary request, with a refresh token in hand: renew once
      // and replay. `noAuthRefresh` keeps the sign-in endpoints and the renewal
      // itself out of this, so a spent refresh token ends the session instead
      // of recursing. The replay is not wrapped — a second 401 is the caller's
      // answer, not a reason to renew again.
      if (
        this.#refreshToken !== undefined &&
        options.noAuthRefresh !== true &&
        error instanceof NacreError &&
        error.status === 401 &&
        (await this.#renewOnce())
      ) {
        return await this.#attempt(options)
      }
      throw error
    }
  }

  /**
   * Exchange the refresh token for a new pair, at most once concurrently.
   *
   * Every request that 401s during a renewal awaits the same promise rather
   * than starting its own — a spent refresh token revokes the whole family, so
   * a burst presenting it in parallel would sign the user out. Returns whether
   * the client now holds a fresh access token.
   */
  #renewOnce(): Promise<boolean> {
    this.#renewing ??= this.#renew().finally(() => {
      this.#renewing = undefined
    })
    return this.#renewing
  }

  async #renew(): Promise<boolean> {
    const refreshToken = this.#refreshToken
    if (refreshToken === undefined) return false

    let tokens: Tokens | undefined
    try {
      tokens = await this.auth.refresh(refreshToken)
    } catch {
      // A transport error says nothing about the token's validity, so keep it
      // and let a later request try again rather than ending the session on a
      // blip.
      return false
    }

    // `undefined` is the server refusing the refresh token: the session is over
    // and re-presenting it only 401s again, so drop it and let the 401 surface.
    if (tokens === undefined) {
      this.#refreshToken = undefined
      return false
    }

    this.#token = tokens.accessToken
    this.#refreshToken = tokens.refreshToken
    this.#onTokens?.(tokens)
    return true
  }

  /**
   * `undefined` for a 401 — the sign-in paths, where a refusal is an answer.
   *
   * Separate from `#maybe` because the two mean different things and must not
   * be merged: a 404 elsewhere is "absent or invisible", and a 401 here is
   * "these credentials are not valid", which the server deliberately does not
   * elaborate on. Both are answers rather than faults, and neither is the
   * other.
   */
  async #unauthorized<T>(options: RequestOptions): Promise<T | undefined> {
    try {
      return (await this.#request(options)) as T
    } catch (error) {
      if (error instanceof NacreError && error.status === 401) return undefined
      throw error
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
    /**
     * Replace a document's metadata without re-indexing it.
     *
     * `false` for a document that is absent, another organization's, or one
     * this credential may not write to — one answer for all three, which is
     * what keeps "no such document" and "not yours" indistinguishable.
     *
     * A replacement, not a merge: send every tag the document should have.
     */
    setMetadata: async (
      documentId: string,
      metadata: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>,
    ): Promise<boolean> => {
      try {
        await this.#request({
          method: 'PATCH',
          path: `/v1/documents/${encodeURIComponent(documentId)}`,
          body: { metadata },
          // Replacing a value with the same value is the same value. A retry
          // after a timeout cannot produce a second anything.
          retryable: true,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

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

  /**
   * Who this token belongs to.
   *
   * The one call a client can make before it knows anything: it composes its
   * answer from the presented token and names no other principal. A UI needs it
   * to know which controls to offer — without it the admin UI drew every button
   * for everybody, and a member pressing one got the `404` invariant 4 requires,
   * which reads as a broken application rather than as a permission they lack.
   */
  readonly me = async (): Promise<Self> => {
    const body = (await this.#request({ method: 'GET', path: '/v1/me', retryable: true })) as Record<string, unknown>
    return {
      organization: String(body.organization),
      principalType: body.principal_type === 'service_account' ? 'service_account' : 'user',
      principalId: String(body.principal_id),
      role: String(body.role) as Self['role'],
    }
  }

  /**
   * Workspaces. A layer needs one, and until this endpoint existed the only
   * way to have its id was the line `init` printed.
   */
  readonly workspaces = {
    /** Only the workspaces this token can reach. The catalog is permission data. */
    list: async (): Promise<readonly Workspace[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/workspaces',
        retryable: true,
      })) as { items?: unknown[] }

      return (body.items ?? []).map((w) => {
        const ws = w as Record<string, unknown>
        return {
          id: String(ws.id),
          slug: String(ws.slug),
          name: String(ws.name ?? ''),
          layerCount: Number(ws.layer_count ?? 0),
        }
      })
    },

    /** `org_admin` only — there is no scope above a workspace to hold a grant on. */
    create: async (input: { slug: string; name: string }): Promise<Workspace | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/workspaces',
        body: { slug: input.slug, name: input.name },
      })
      if (body === undefined) return undefined

      return {
        id: String(body.id),
        slug: String(body.slug),
        name: String(body.name ?? ''),
        layerCount: Number(body.layer_count ?? 0),
      }
    },
  }

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

    /**
     * Rename a layer, or change its description.
     *
     * Name and description only. What model built the vectors is not editable
     * here and is not an oversight: changing it is a reindex, because the
     * vectors have to be rebuilt, and a `PATCH` that quietly started one would
     * be an expensive background job triggered by an edit form.
     *
     * `false` for a layer this token may not administer and for one that is not
     * there — the usual rule, and the same answer.
     */
    update: async (
      layerId: string,
      changes: { name?: string; description?: string },
    ): Promise<boolean> => {
      try {
        await this.#request({
          method: 'PATCH',
          path: `/v1/layers/${encodeURIComponent(layerId)}`,
          body: {
            ...(changes.name === undefined ? {} : { name: changes.name }),
            ...(changes.description === undefined ? {} : { description: changes.description }),
          },
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    /**
     * Delete a layer and everything in it.
     *
     * Returns as soon as the layer stops resolving and its documents stop
     * matching — the points and any stored bytes are reclaimed by the
     * collector afterwards, and nothing depends on when. `false` for absent,
     * for another organization's, and for one this token may not administer.
     */
    remove: async (layerId: string): Promise<boolean> => {
      try {
        await this.#request({
          method: 'DELETE',
          path: `/v1/layers/${encodeURIComponent(layerId)}`,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    /**
     * Move the layer onto a different embedding model.
     *
     * Returns immediately with the state to poll; the work happens in the
     * worker and search keeps answering from the old vectors throughout. There
     * is no cancel — starting a reindex back onto the previous provider is how
     * one is undone.
     *
     * Throws `NacreError` with status 409 when one is already running on this
     * layer, and 400 for a provider that does not exist or that names the model
     * the layer already uses.
     */
    reindex: async (layerId: string, providerId: string): Promise<ReindexStatus | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'POST',
        path: `/v1/layers/${encodeURIComponent(layerId)}/reindex`,
        body: { provider_id: providerId },
      })
      return body === undefined ? undefined : reindexFrom(body)
    },

    /** How far a reindex has got. `undefined` when none has ever run. */
    reindexStatus: async (layerId: string): Promise<ReindexStatus | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'GET',
        path: `/v1/layers/${encodeURIComponent(layerId)}/reindex`,
        retryable: true,
      })
      return body === undefined ? undefined : reindexFrom(body)
    },

    /**
     * The query set a reindex of this layer is checked against.
     *
     * A migration onto a new model succeeds mechanically whether or not the new
     * model works, so this is what stands between "every document got a vector"
     * and "search still answers". Empty — the default — means the layer has no
     * gate, because the check needs documents somebody chose.
     *
     * `admin` on the layer, not `read`: the entries name the documents you
     * consider the canonical answers to a query.
     */
    referenceQueries: async (layerId: string): Promise<readonly ReferenceQuery[] | undefined> => {
      const body = await this.#maybe<{ items?: unknown[] }>({
        method: 'GET',
        path: `/v1/layers/${encodeURIComponent(layerId)}/reference-queries`,
        retryable: true,
      })
      return body === undefined ? undefined : (body.items ?? []).map(referenceQueryFrom)
    },

    /**
     * Replace that set whole. `[]` removes the gate.
     *
     * Replaced rather than edited entry by entry, which is the server's shape
     * too: a reference set is one statement about what search must keep doing,
     * and a partial edit is how half of one ends up describing a layer nobody
     * has looked at since.
     *
     * At most 50 queries, each naming at most 10 documents — that second bound
     * is how many the check retrieves, so a longer list could never score 1.0.
     * The external ids need not exist yet; a set is often written before the
     * documents it names are ingested.
     */
    setReferenceQueries: async (
      layerId: string,
      queries: readonly ReferenceQueryInput[],
    ): Promise<readonly ReferenceQuery[] | undefined> => {
      const body = await this.#maybe<{ items?: unknown[] }>({
        method: 'PUT',
        path: `/v1/layers/${encodeURIComponent(layerId)}/reference-queries`,
        body: { queries: queries.map((q) => ({ query: q.query, expected: [...q.expected] })) },
      })
      return body === undefined ? undefined : (body.items ?? []).map(referenceQueryFrom)
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
     * The change is reflected on the next request. The permitted set is computed
     * per request from the grants, so a revoked grant is gone from results
     * immediately — there is nothing asynchronous to propagate and nothing to
     * wait on.
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

  /**
   * Approve an OAuth request, naming the agent the client will act as.
   *
   * The one call in the flow that creates authority, and the reason it lives on
   * an authenticated client: a signed-in person is choosing which **service
   * account** a client gets to be. The token that comes back to the client acts
   * as that account and never as them.
   *
   * Returns where the browser should go — the redirect is the page's to perform,
   * not the API's, because this is an XHR from a screen the person is looking
   * at.
   */
  readonly consent = async (input: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    serviceAccountId: string
    state?: string
    resource?: string
  }): Promise<string> => {
    const body = (await this.#request({
      method: 'POST',
      path: '/v1/oauth/consent',
      body: {
        client_id: input.clientId,
        redirect_uri: input.redirectUri,
        code_challenge: input.codeChallenge,
        service_account_id: input.serviceAccountId,
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.resource === undefined ? {} : { resource: input.resource }),
      },
    })) as { redirect_to?: unknown }
    return String(body.redirect_to)
  }

  /**
   * Applications connected to this organization, and ending one.
   *
   * "Forget this application" is what a person actually wants when they are
   * done with a client, and it is a different act from revoking the agent: an
   * agent may have several connections and a key of its own in use elsewhere.
   */
  readonly connections = {
    list: async (): Promise<{ items: readonly Connection[]; accessTokenTtlSeconds: number }> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/oauth/consents',
        retryable: true,
      })) as { items?: unknown[]; access_token_ttl_seconds?: unknown }
      return {
        items: (body.items ?? []).map((raw) => {
          const c = raw as Record<string, unknown>
          return {
            id: String(c.id),
            clientId: String(c.client_id),
            clientName: String(c.client_name),
            serviceAccountId: String(c.service_account_id),
            serviceAccountName: String(c.service_account_name),
            approvedBy: String(c.approved_by),
            createdAt: String(c.created_at),
            lastRefreshedAt: c.last_refreshed_at === null ? null : String(c.last_refreshed_at),
            revokedAt: c.revoked_at === null ? null : String(c.revoked_at),
          }
        }),
        accessTokenTtlSeconds: Number(body.access_token_ttl_seconds ?? 0),
      }
    },

    /**
     * End it. The refresh token goes immediately; an access token already
     * issued is verified against a key and keeps working until it expires, so
     * the answer carries how long that can still be.
     */
    end: async (id: string): Promise<{ accessTokenTtlSeconds: number } | undefined> => {
      try {
        const body = (await this.#request({
          method: 'DELETE',
          path: `/v1/oauth/consents/${encodeURIComponent(id)}`,
        })) as { access_token_ttl_seconds?: unknown }
        return { accessTokenTtlSeconds: Number(body.access_token_ttl_seconds ?? 0) }
      } catch (error) {
        if (error instanceof NacreError && error.status === 404) return undefined
        throw error
      }
    },
  }

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

  // ─── users and groups ────────────────────────────────────────────────────

  /**
   * The people in the organization.
   *
   * Every one of these needs `org_admin`, and a caller without it gets the same
   * `404` an unknown path gets — so `list` throwing `isNotFound` means "not an
   * administrator" as readily as it means anything else, which is invariant 4
   * working as intended rather than a shortcoming of this client.
   */
  readonly users = {
    list: async (): Promise<readonly User[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/users',
        retryable: true,
      })) as { items?: unknown[] }
      return (body.items ?? []).map((u) => userFrom(u as Record<string, unknown>))
    },

    /** The response carries the password. It is not recoverable afterwards. */
    create: async (email: string, role: 'member' | 'org_admin' = 'member'): Promise<CreatedUser> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/users',
        body: { email, role },
      })) as Record<string, unknown>

      return { ...userFrom(body), password: String(body.password) }
    },

    /** Change the role, the disabled state, or both. False when there is no such user. */
    update: async (
      id: string,
      change: { role?: 'member' | 'org_admin'; disabled?: boolean },
    ): Promise<boolean> => {
      try {
        await this.#request({
          method: 'PATCH',
          path: `/v1/users/${encodeURIComponent(id)}`,
          body: change,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    /**
     * Disable. The row is kept — see the endpoint's own note on why.
     *
     * `409` is not swallowed: refusing to strand an organization with no
     * administrator is a different answer from "no such user", and a caller
     * that cannot tell them apart would report the wrong one.
     */
    disable: async (id: string): Promise<boolean> => {
      try {
        await this.#request({ method: 'DELETE', path: `/v1/users/${encodeURIComponent(id)}` })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    /** A new password, shown once. `undefined` when there is no such user. */
    resetPassword: async (id: string): Promise<string | undefined> => {
      try {
        const body = (await this.#request({
          method: 'POST',
          path: `/v1/users/${encodeURIComponent(id)}/password`,
        })) as Record<string, unknown>
        return String(body.password)
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return undefined
        throw error
      }
    },
  }

  readonly groups = {
    list: async (): Promise<readonly Group[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/groups',
        retryable: true,
      })) as { items?: unknown[] }
      return (body.items ?? []).map((g) => groupFrom(g as Record<string, unknown>))
    },

    create: async (name: string): Promise<Group> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/groups',
        body: { name },
      })) as Record<string, unknown>
      return groupFrom(body)
    },

    remove: async (id: string): Promise<boolean> => {
      try {
        await this.#request({ method: 'DELETE', path: `/v1/groups/${encodeURIComponent(id)}` })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    /** Direct members. `undefined` when there is no such group — distinct from an empty one. */
    members: async (id: string): Promise<readonly GroupMember[] | undefined> => {
      try {
        const body = (await this.#request({
          method: 'GET',
          path: `/v1/groups/${encodeURIComponent(id)}/members`,
          retryable: true,
        })) as { items?: unknown[] }
        return (body.items ?? []).map((m) => memberFrom(m as Record<string, unknown>))
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return undefined
        throw error
      }
    },

    /** True once the member is in the group, whether this call is what put them there. */
    addMember: async (
      id: string,
      member: { type: 'user' | 'group'; id: string },
    ): Promise<boolean> => {
      try {
        await this.#request({
          method: 'POST',
          path: `/v1/groups/${encodeURIComponent(id)}/members`,
          body: { type: member.type, id: member.id },
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },

    removeMember: async (
      id: string,
      member: { type: 'user' | 'group'; id: string },
    ): Promise<boolean> => {
      try {
        await this.#request({
          method: 'DELETE',
          path:
            `/v1/groups/${encodeURIComponent(id)}/members/` +
            `${member.type}/${encodeURIComponent(member.id)}`,
        })
        return true
      } catch (error) {
        if (error instanceof NacreError && error.isNotFound) return false
        throw error
      }
    },
  }

  // ─── sign-in ─────────────────────────────────────────────────────────────

  /**
   * Email and password, and the refresh that keeps a session alive.
   *
   * **These are the one part of this client that does not use the constructor's
   * token**, because they are what a caller has instead of one. The client is
   * still constructed with a token — pass anything for a login-only client, or
   * construct a second one from the access token these return.
   *
   * That is deliberate rather than convenient. A client that swapped its own
   * credential when a login succeeded would make "which identity is this
   * object" depend on call history, and an application holding one for a
   * background job and one for a request would eventually get the wrong one.
   *
   * `undefined` for a refusal, and there is exactly one refusal: unknown
   * address, wrong password, wrong organization, disabled account, and an
   * account with no password set are one `401` with one message, in the same
   * time. Distinguishing them here would invent information the server refused
   * to give.
   */
  readonly auth = {
    login: async (input: {
      email: string
      password: string
      /**
       * A lookup key, never a claim. What goes into the issued token is the
       * organization on the row that authenticated — naming one you have no
       * account in is a refusal, not a token for either. Omit on a
       * single-organization installation.
       */
      organization?: string
    }): Promise<Tokens | undefined> => {
      const body = await this.#unauthorized<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/auth/login',
        noAuthRefresh: true,
        body: {
          email: input.email,
          password: input.password,
          ...(input.organization === undefined ? {} : { organization: input.organization }),
        },
      })
      return body === undefined ? undefined : tokensFrom(body)
    },

    /**
     * Exchange a refresh token for a new pair. The old one stops working.
     *
     * **Replaying a spent refresh token revokes the whole family**, so a client
     * that retries this after a success signs its user out. Store the new
     * refresh token before doing anything else with the access token: by the
     * time the legitimate holder has exchanged one, a second presentation of it
     * is either a bug or a theft and there is no way to tell which.
     */
    refresh: async (refreshToken: string): Promise<Tokens | undefined> => {
      const body = await this.#unauthorized<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/auth/refresh',
        noAuthRefresh: true,
        body: { refresh_token: refreshToken },
      })
      return body === undefined ? undefined : tokensFrom(body)
    },

    /** End the session. Idempotent: an already-revoked token is not an error. */
    logout: async (refreshToken: string): Promise<void> => {
      await this.#request({
        method: 'POST',
        path: '/v1/auth/logout',
        noAuthRefresh: true,
        body: { refresh_token: refreshToken },
      })
    },
  }

  // ─── the access log ──────────────────────────────────────────────────────

  /**
   * Read the journal back. Newest first, cursor-paged.
   *
   * **Two roles see two different logs, and it is not a parameter.**
   * `org_admin` sees its organization's log in full, including which documents
   * were read. `platform_admin` sees administrative actions and never that —
   * rule 2 applied to the journal, set by the server, so there is nothing to
   * pass here that would widen it. A `member` gets nothing.
   *
   * Reading it is itself recorded, as `audit.read`.
   *
   * JSONL and CSV exports exist on this endpoint through content negotiation
   * and are deliberately not wrapped: they are a stream to write to a file, not
   * a value to hold in memory, and a method returning one as a string would
   * invite exactly the use they exist to avoid.
   */
  readonly audit = {
    read: async (query: AuditQuery = {}): Promise<AuditPage> => {
      const search = new URLSearchParams()
      if (query.from !== undefined) search.set('from', query.from)
      if (query.to !== undefined) search.set('to', query.to)
      if (query.actorId !== undefined) search.set('actor_id', query.actorId)
      if (query.action !== undefined) search.set('action', query.action)
      if (query.result !== undefined) search.set('result', query.result)
      if (query.limit !== undefined) search.set('limit', String(query.limit))
      if (query.cursor !== undefined) search.set('cursor', query.cursor)

      const suffix = search.size === 0 ? '' : `?${search.toString()}`
      const body = (await this.#request({
        method: 'GET',
        path: `/v1/audit${suffix}`,
        retryable: true,
      })) as { items?: unknown[]; next_cursor?: unknown }

      const nextCursor = typeof body.next_cursor === 'string' ? body.next_cursor : undefined
      return {
        items: (body.items ?? []).map(auditRecordFrom),
        ...(nextCursor === undefined ? {} : { nextCursor }),
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

function tokensFrom(t: Record<string, unknown>): Tokens {
  return {
    accessToken: String(t.access_token),
    tokenType: String(t.token_type ?? 'Bearer'),
    expiresIn: Number(t.expires_in ?? 0),
    refreshToken: String(t.refresh_token),
  }
}

function reindexFrom(r: Record<string, unknown>): ReindexStatus {
  const check = r.check as Record<string, unknown> | null | undefined
  return {
    layerId: String(r.layer_id),
    status: r.status as ReindexStatus['status'],
    phase: r.phase === 'copying' ? 'copying' : 'embedding',
    currentVector: String(r.current_vector ?? ''),
    shadowVector: String(r.shadow_vector ?? ''),
    providerId: String(r.provider_id ?? ''),
    startedAt: String(r.started_at ?? ''),
    finishedAt: typeof r.finished_at === 'string' ? r.finished_at : null,
    total: Number(r.total ?? 0),
    done: Number(r.done ?? 0),
    failed: Number(r.failed ?? 0),
    progress: Number(r.progress ?? 0),
    error: typeof r.error === 'string' ? r.error : null,
    // `null` and not `undefined`. Absent would read as "this deployment does
    // not check recall"; null says "this migration has not been scored", which
    // for a layer with no reference set is the permanent and correct answer.
    check: check === null || check === undefined ? null : recallCheckFrom(check),
  }
}

function recallCheckFrom(c: Record<string, unknown>): RecallCheck {
  const unresolved = Array.isArray(c.unresolved)
    ? c.unresolved.filter((u): u is string => typeof u === 'string')
    : []
  return {
    recall: Number(c.recall ?? 0),
    floor: Number(c.floor ?? 0),
    passed: c.passed === true,
    queries: Number(c.queries ?? 0),
    scores: (Array.isArray(c.scores) ? c.scores : []).map((s) => {
      const score = s as Record<string, unknown>
      return { queryId: String(score.query_id), recall: Number(score.recall ?? 0) }
    }),
    ...(unresolved.length === 0 ? {} : { unresolved }),
  }
}

function referenceQueryFrom(q: unknown): ReferenceQuery {
  const entry = q as Record<string, unknown>
  return {
    id: String(entry.id),
    query: String(entry.query ?? ''),
    expected: (Array.isArray(entry.expected) ? entry.expected : []).map(String),
  }
}

function auditRecordFrom(r: unknown): AuditRecord {
  const record = r as Record<string, unknown>
  const actor = (record.actor ?? {}) as Record<string, unknown>
  return {
    id: String(record.id),
    occurredAt: String(record.occurred_at ?? ''),
    actor: {
      type: String(actor.type ?? ''),
      id: typeof actor.id === 'string' ? actor.id : null,
      label: typeof actor.label === 'string' ? actor.label : null,
    },
    surface: typeof record.surface === 'string' ? record.surface : null,
    client: typeof record.client === 'string' ? record.client : null,
    action: String(record.action ?? ''),
    target: (record.target ?? {}) as Record<string, unknown>,
    result: record.result as AuditRecord['result'],
    detail: (record.detail ?? {}) as Record<string, unknown>,
    requestId: typeof record.request_id === 'string' ? record.request_id : null,
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

function userFrom(u: Record<string, unknown>): User {
  return {
    id: String(u.id),
    email: String(u.email ?? ''),
    role: (u.role as UserRole | undefined) ?? 'member',
    createdAt: String(u.created_at ?? ''),
    disabledAt: (u.disabled_at as string | null) ?? null,
    hasPassword: u.has_password === true,
  }
}

function groupFrom(g: Record<string, unknown>): Group {
  return {
    id: String(g.id),
    name: String(g.name ?? ''),
    createdAt: String(g.created_at ?? ''),
    memberCount: Number(g.member_count ?? 0),
  }
}

function memberFrom(m: Record<string, unknown>): GroupMember {
  return {
    type: m.type === 'group' ? 'group' : 'user',
    id: String(m.id),
    label: String(m.label ?? ''),
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
