import { NacreError, NacreTransportError, type Problem } from './errors.js'
import type {
  AuditPage,
  AuditQuery,
  AuditRecord,
  CreatedServiceAccount,
  CreatedUser,
  Document,
  EmbeddingProvider,
  Grant,
  GrantInput,
  Group,
  GroupMember,
  IngestOutcome,
  IngestRequest,
  Job,
  Layer,
  LayerInput,
  Permission,
  RecallCheck,
  ReferenceQuery,
  ReferenceQueryInput,
  ReindexStatus,
  BegunSecondFactor,
  SecondFactor,
  SignIn,
  Tokens,
  Workspace,
  SearchHit,
  SearchOptions,
  Connection,
  Self,
  ServiceAccount,
  User,
  UserRole,
  SecondFactorKind,
  WebAuthnAssertion,
  WebAuthnAssertionOptions,
  WebAuthnRegistrationOptions,
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
        // `doc_id`, which is what the contract calls it and what the server
        // sends. This read `document_id` — a field that exists in the contract,
        // on `Job`, and not on a search hit — so `?? ''` turned every hit's
        // document id into an empty string and nothing failed. A search result
        // could not be turned into `documents.get(id)`, which is the whole
        // find-it-then-fetch-it flow, through the SDK and therefore through the
        // admin UI as well.
        documentId: String(hit.doc_id ?? ''),
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
        externalId: (body.external_id as string | null) ?? null,
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
          permissions: readPermissions(ws.permissions),
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
        permissions: readPermissions(body.permissions),
      }
    },
  }

  /**
   * The embedding models a layer can be pointed at.
   *
   * Listing is open to anybody in the organization, because the caller who
   * needs it is whoever may start a reindex — `admin` on the layer, not an
   * organization role. Creating one is `org_admin`.
   */
  readonly embeddingProviders = {
    list: async (): Promise<readonly EmbeddingProvider[]> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/embedding-providers',
        retryable: true,
      })) as { items?: unknown[] }
      return (body.items ?? []).map((p) => providerFrom(p as Record<string, unknown>))
    },

    /** `undefined` for a caller who is not an `org_admin` — the usual 404. */
    create: async (input: {
      name: string
      endpoint: string
      model: string
      dimensions: number
    }): Promise<EmbeddingProvider | undefined> => {
      const body = await this.#maybe<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/embedding-providers',
        body: {
          name: input.name,
          endpoint: input.endpoint,
          model: input.model,
          dimensions: input.dimensions,
        },
      })
      return body === undefined ? undefined : providerFrom(body)
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
          failedCount: Number(layer.failed_count ?? 0),
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
        failedCount: Number(body.failed_count ?? 0),
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
   * Approve an OAuth request: as an agent, or as yourself.
   *
   * The one call in the flow that creates authority, and the reason it lives on
   * an authenticated client. Naming a `serviceAccountId` gives the client that
   * **agent's** reach, which is its own principal with its own grants — the
   * token that comes back never acts as the person who approved it. Naming none
   * is a **delegation**: the client acts as the person, reaching exactly what
   * they reach and nothing more, re-resolved on every request.
   *
   * `layers` narrows a delegation to chosen layers, by id. It can only ever
   * remove, and it is meaningless beside an agent — an agent's reach is its
   * grants, which are an administrator's to set.
   *
   * Returns where the browser should go — the redirect is the page's to perform,
   * not the API's, because this is an XHR from a screen the person is looking
   * at.
   */
  readonly consent = async (input: {
    clientId: string
    redirectUri: string
    codeChallenge: string
    /** Absent means the client acts as the signed-in person. */
    serviceAccountId?: string
    /**
     * Layers a delegation is restricted to. Empty means no restriction.
     *
     * A bare id inherits the connection's ceiling — which is what every entry
     * meant before a layer could carry one — and an object sets a ceiling for
     * that layer alone. The per-layer set is intersected with `permissions`
     * and never replaces it; one naming a permission the connection excludes
     * is refused with a `400` rather than stored as a control that does
     * nothing.
     */
    layers?: readonly (string | { id: string; permissions?: readonly Permission[] })[]
    /**
     * Permissions a delegation may exercise. Omit for no ceiling.
     *
     * A set rather than a level: `['write']` alone is an ingest client that
     * cannot read back what it wrote, which is rule 6 and is deliberately
     * expressible. Empty is refused — that would be a delegation that can do
     * nothing, which is not what omitting a restriction means.
     */
    permissions?: readonly ('read' | 'write' | 'admin')[]
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
        ...(input.serviceAccountId === undefined ? {} : { service_account_id: input.serviceAccountId }),
        ...(input.layers === undefined || input.layers.length === 0
          ? {}
          : {
              layers: input.layers.map((l) =>
                typeof l === 'string'
                  ? l
                  : { id: l.id, ...(l.permissions === undefined ? {} : { permissions: [...l.permissions] }) },
              ),
            }),
        ...(input.permissions === undefined ? {} : { permissions: [...input.permissions] }),
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
            // A delegation names no agent. `null` rather than the string
            // "null", which is what `String(...)` produced and what would have
            // rendered on the connections screen.
            actsAs: c.acts_as === 'user' ? ('user' as const) : ('service_account' as const),
            serviceAccountId: c.service_account_id == null ? null : String(c.service_account_id),
            serviceAccountName: c.service_account_name == null ? null : String(c.service_account_name),
            approvedBy: String(c.approved_by),
            // Null rather than the string "null", which is the defect the two
            // lines above already record — a `String(...)` over an absent field
            // renders on the screen.
            approvedByEmail: c.approved_by_email == null ? null : String(c.approved_by_email),
            approverDisabled: c.approver_disabled === true,
            layers: Array.isArray(c.layers) ? c.layers.map(String) : [],
            permissions: Array.isArray(c.permissions)
              ? (c.permissions.map(String) as ('read' | 'write' | 'admin')[])
              : [],
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
    }): Promise<SignIn | undefined> => {
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
      if (body === undefined) return undefined
      /*
       * Two shapes on one 200, and the union is the point.
       *
       * Where the account has a second factor the server answers with a
       * challenge instead of tokens — nothing was refused, the caller is being
       * asked for the rest. A client that read `access_token` and found nothing
       * would report a broken sign-in for a working one, so the type makes the
       * second case impossible to ignore.
       */
      if (body.second_factor_required === true) {
        return {
          secondFactorRequired: true,
          challenge: String(body.challenge ?? ''),
          expiresIn: Number(body.expires_in ?? 0),
        }
      }
      return tokensFrom(body)
    },

    /**
     * Finish a sign-in with a code from an authenticator, or a recovery code.
     *
     * Both go here. From outside they answer the same question, and a separate
     * method would say which one a person is using.
     */
    secondFactor: async (
      input: { challenge: string } & ({ code: string } | { assertion: WebAuthnAssertion }),
    ): Promise<Tokens | undefined> => {
      const body = await this.#unauthorized<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/auth/second-factor',
        noAuthRefresh: true,
        body: {
          challenge: input.challenge,
          ...('code' in input ? { code: input.code } : { assertion: assertionJson(input.assertion) }),
        },
      })
      return body === undefined ? undefined : tokensFrom(body)
    },

    /**
     * The options a browser needs before it can produce an assertion.
     *
     * Takes the sign-in challenge and nothing else, which is what keeps it from
     * being a way to ask which authenticators an address holds: reaching it
     * costs a correct password.
     */
    secondFactorWebAuthn: async (challenge: string): Promise<WebAuthnAssertionOptions | undefined> => {
      const body = await this.#unauthorized<Record<string, unknown>>({
        method: 'POST',
        path: '/v1/auth/second-factor/webauthn',
        noAuthRefresh: true,
        body: { challenge },
      })
      return body === undefined ? undefined : assertionOptionsFrom(body)
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

    /**
     * What this installation offers before anybody has signed in.
     *
     * One boolean, so a sign-in screen can leave the recovery link off where no
     * sender is configured rather than showing one that answers 404.
     */
    methods: async (): Promise<{
      passwordReset: boolean
      secondFactorKinds: readonly SecondFactorKind[]
    }> => {
      const body = (await this.#request({
        method: 'GET',
        path: '/v1/auth/methods',
        noAuthRefresh: true,
      })) as { password_reset?: boolean; second_factor_kinds?: readonly SecondFactorKind[] }
      return {
        passwordReset: body.password_reset === true,
        secondFactorKinds: body.second_factor_kinds ?? [],
      }
    },

    /**
     * Ask for a recovery link.
     *
     * Resolves whatever happened — an address with no account and one with an
     * account are the same answer, deliberately, and a client that reported
     * otherwise would be inventing the information the server refuses to give.
     */
    requestPasswordReset: async (email: string): Promise<void> => {
      await this.#request({
        method: 'POST',
        path: '/v1/auth/password-reset',
        noAuthRefresh: true,
        body: { email },
      })
    },

    /**
     * Spend a link and set the password. `false` for a refusal.
     *
     * A refusal is a link that never existed, one already spent, one that
     * expired, or an account disabled since it was sent — one answer for all
     * four. A password below the minimum raises instead, because that one is
     * about what the caller sent.
     */
    confirmPasswordReset: async (token: string, password: string): Promise<boolean> => {
      const done = await this.#unauthorized({
        method: 'POST',
        path: '/v1/auth/password-reset/confirm',
        noAuthRefresh: true,
        body: { token, password },
      })
      return done !== undefined
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

  /**
   * The caller's **own** second factor, and never anybody else's.
   *
   * There is no administrative counterpart to this on purpose. An administrator
   * resets a password; a second factor is a thing the person holds, and one an
   * administrator could enrol or remove would be a thing the account's
   * administrator holds instead.
   *
   * Every method here answers `404` on an installation with no
   * `NACRE_2FA_KEY`, for a service account, and for a delegation.
   */
  /**
   * Change the password of the account this token belongs to.
   *
   * The current one is required and is the only proof this takes — a session is
   * not enough, because changing the password is the first thing somebody with
   * a stolen session does. It is not `POST /v1/users/{id}/password`, which is
   * an administrator issuing a generated password to somebody else.
   *
   * **It ends every other session and returns the pair that replaces this
   * one.** A client holding a refresh token must adopt what comes back or its
   * next renewal fails: the old refresh token was revoked by the same
   * statement. `undefined` is a wrong current password — one refusal, and it is
   * a `403` rather than a `401` so that a client renewing on `401` does not
   * spend a refresh token retrying something retyping fixes.
   *
   * Answers `404` for a service account, which has no password, and for a
   * delegation, which was not approved to change how somebody signs in.
   */
  readonly changePassword = async (input: {
    currentPassword: string
    newPassword: string
  }): Promise<Tokens | undefined> => {
    try {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/me/password',
        body: { current_password: input.currentPassword, new_password: input.newPassword },
      })) as Record<string, unknown>
      return tokensFrom(body)
    } catch (error) {
      // Only the refusal. A password below the minimum is a `400` and raises,
      // because that one is about what the caller sent and a person retyping
      // needs to be told which rule they missed.
      if (error instanceof NacreError && error.status === 403) return undefined
      throw error
    }
  }

  readonly secondFactor = {
    /** What is enrolled, and how many recovery codes are left. */
    list: async (): Promise<{
      items: readonly SecondFactor[]
      recoveryCodesLeft: number
      kinds: readonly SecondFactorKind[]
    }> => {
      const body = (await this.#request({ method: 'GET', path: '/v1/me/second-factor' })) as {
        items?: readonly Record<string, unknown>[]
        recovery_codes_left?: number
        kinds?: readonly SecondFactorKind[]
      }
      return {
        items: (body.items ?? []).map(secondFactorFrom),
        recoveryCodesLeft: body.recovery_codes_left ?? 0,
        // What this installation can enrol. Empty rather than assumed, so a
        // screen reading it draws nothing rather than a control that 404s.
        kinds: body.kinds ?? [],
      }
    },

    /**
     * Begin enrolling one. The secret comes back **once**.
     *
     * Nothing counts it until `confirm`: a secret that has never produced a
     * correct code is one that did not reach an authenticator.
     */
    begin: async (input: { label?: string } = {}): Promise<BegunSecondFactor> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/me/second-factor',
        body: input.label === undefined ? {} : { label: input.label },
      })) as Record<string, unknown>
      return {
        id: String(body.id ?? ''),
        secret: String(body.secret ?? ''),
        otpauthUrl: String(body.otpauth_url ?? ''),
        label: String(body.label ?? ''),
      }
    },

    /** Confirm it, and take the recovery codes — they are printed once. */
    confirm: async (id: string, code: string): Promise<readonly string[]> => {
      const body = (await this.#request({
        method: 'POST',
        path: `/v1/me/second-factor/${encodeURIComponent(id)}/confirm`,
        body: { code },
      })) as { recovery_codes?: readonly string[] }
      return body.recovery_codes ?? []
    },

    /**
     * Remove one, proving a current code.
     *
     * The code is not ceremony: taking the factor off is the first thing
     * somebody with a stolen session does.
     */
    remove: async (id: string, proof: string | WebAuthnAssertion): Promise<void> => {
      await this.#request({
        method: 'DELETE',
        path: `/v1/me/second-factor/${encodeURIComponent(id)}`,
        body: typeof proof === 'string' ? { code: proof } : { assertion: assertionJson(proof) },
      })
    },

    /**
     * Start enrolling a security key. Two calls, because a ceremony is two.
     *
     * The challenge has to exist on the server before the browser is asked for
     * anything, or the signature would be over a number the client chose.
     */
    beginWebAuthn: async (): Promise<WebAuthnRegistrationOptions> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/me/second-factor/webauthn',
      })) as Record<string, unknown>
      const rp = (body.rp ?? {}) as Record<string, unknown>
      const user = (body.user ?? {}) as Record<string, unknown>
      return {
        challenge: String(body.challenge ?? ''),
        rp: { id: String(rp.id ?? ''), name: String(rp.name ?? '') },
        user: {
          id: String(user.id ?? ''),
          name: String(user.name ?? ''),
          displayName: String(user.display_name ?? ''),
        },
        algorithms: (body.algorithms ?? []) as readonly number[],
        excludeCredentials: (body.exclude_credentials ?? []) as readonly string[],
        timeoutMs: Number(body.timeout_ms ?? 0),
      }
    },

    /**
     * Register what the authenticator signed, and take the recovery codes.
     *
     * No confirm step: producing the attestation *is* the proof, which is the
     * difference from TOTP, where a secret is handed over and only a code says
     * it landed.
     */
    finishWebAuthn: async (input: {
      challenge: string
      attestationObject: string
      clientDataJSON: string
      label?: string
    }): Promise<readonly string[]> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/me/second-factor/webauthn/finish',
        body: {
          challenge: input.challenge,
          attestation_object: input.attestationObject,
          client_data_json: input.clientDataJSON,
          ...(input.label === undefined ? {} : { label: input.label }),
        },
      })) as { recovery_codes?: readonly string[] }
      return body.recovery_codes ?? []
    },

    /**
     * A challenge for proving possession to this surface, which `remove` needs.
     *
     * On an installation with no `NACRE_2FA_KEY` this is the only proof there
     * is, so without it a security key could be enrolled and never removed.
     */
    beginWebAuthnProof: async (): Promise<WebAuthnAssertionOptions> => {
      const body = (await this.#request({
        method: 'POST',
        path: '/v1/me/second-factor/webauthn/assert',
      })) as Record<string, unknown>
      return assertionOptionsFrom(body)
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

/**
 * The permissions field, filtered to the three this model has.
 *
 * A server that grew a fourth would otherwise widen `Permission` at runtime
 * while the type said three, and every client comparison against the unknown
 * value would be silently false rather than a type error. An older server that
 * omits the field entirely answers the empty set, which is the safe reading:
 * "nothing is known to be permitted here" hides a control rather than offering
 * one that cannot work.
 */
function readPermissions(value: unknown): readonly Permission[] {
  const all: readonly Permission[] = ['read', 'write', 'admin']
  if (!Array.isArray(value)) return []
  return all.filter((p) => value.includes(p))
}

function providerFrom(p: Record<string, unknown>): EmbeddingProvider {
  return {
    id: String(p.id),
    name: String(p.name ?? ''),
    model: String(p.model ?? ''),
    dimensions: Number(p.dimensions ?? 0),
    isDefault: p.is_default === true,
  }
}

function secondFactorFrom(f: Record<string, unknown>): SecondFactor {
  return {
    id: String(f.id),
    // Read rather than written. It said `'totp'` from when there was one kind,
    // which is the shape a mapper agreeing with itself always has: the field
    // was on the wire and this ignored it, so every security key would have
    // listed as an authenticator app.
    kind: f.kind === 'webauthn' ? 'webauthn' : 'totp',
    label: String(f.label ?? ''),
    createdAt: String(f.created_at ?? ''),
    lastUsedAt: f.last_used_at === null || f.last_used_at === undefined ? null : String(f.last_used_at),
  }
}

/** One writer for the wire shape, so two call sites cannot spell it two ways. */
function assertionJson(a: WebAuthnAssertion): Record<string, string> {
  return {
    credential_id: a.credentialId,
    authenticator_data: a.authenticatorData,
    client_data_json: a.clientDataJSON,
    signature: a.signature,
    challenge: a.challenge,
  }
}

/** And one reader, for the two paths that hand these out. */
function assertionOptionsFrom(body: Record<string, unknown>): WebAuthnAssertionOptions {
  return {
    challenge: String(body.challenge ?? ''),
    rpId: String(body.rp_id ?? ''),
    allowCredentials: (body.allow_credentials ?? []) as readonly string[],
    timeoutMs: Number(body.timeout_ms ?? 0),
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
