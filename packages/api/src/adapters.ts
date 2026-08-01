import {
  aclTags,
  buildFilter,
  effectivePrincipals,
  loadGrants,
  loadScopeTree,
  PostgresGroupGraph,
  referenceAllows,
  resolve,
  VectorStore,
  withOrg,
  type Hit,
} from '@nacre.work/core'
import { createHash } from 'node:crypto'

import type { Pool } from 'pg'

import type {
  AuditEvent,
  AuditSink,
  Documents,
  GrantInput,
  GrantRecord,
  Grants,
  Ingest,
  IngestOutcome,
  IngestRequest,
  Job,
  Jobs,
  Layer,
  Layers,
  SearchService,
} from './server.js'
import type { AuthContext } from './auth.js'

/**
 * The adapters that put the permission model on the request path.
 *
 * `NacreSearchService` is the one to read. Every step between a token and a
 * result is here, in order, and none of them can be skipped by a caller —
 * there is no method that takes a filter, and no method that takes an
 * organization.
 */

export interface Embedder {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

export class PostgresDocuments implements Documents {
  constructor(private readonly pool: Pool, private readonly role?: string) {}

  /**
   * Undefined for absent and for another organization's document alike.
   *
   * The query is scoped twice on purpose: `withOrg` sets the row-level security
   * context, and `org_id` is named in the WHERE clause anyway. Either alone
   * would do; both means a mistake in one is not a leak.
   */
  async read(orgId: string, documentId: string): Promise<{ id: string; title: string } | undefined> {
    // A malformed id must not reach Postgres as a cast error — an error
    // distinguishable from "not found" is an oracle for the id format.
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return undefined

    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string; title: string | null }>(
          `SELECT id, title FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [orgId, documentId],
        )
        const row = rows[0]
        return row === undefined ? undefined : { id: row.id, title: row.title ?? '' }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

export interface SearchDeps {
  readonly pool: Pool
  readonly vectors: VectorStore
  readonly embedder: Embedder
  /** Resolved per organization; the collection name is derived from it. */
  readonly orgSlug: (orgId: string) => Promise<string | undefined>
  readonly vectorName: string
  readonly role?: string
}

export class NacreSearchService implements SearchService {
  constructor(private readonly deps: SearchDeps) {}

  async search(auth: AuthContext, query: string, topK: number): Promise<readonly Hit[]> {
    const slug = await this.deps.orgSlug(auth.orgId)
    if (slug === undefined) {
      // The token names an organization that is not there. Rule I3: a
      // permission that cannot be evaluated denies.
      return []
    }

    const plan = await withOrg(
      this.deps.pool,
      auth.orgId,
      async (client) => {
        const graph = await PostgresGroupGraph.load(client, auth.orgId)
        const principals = effectivePrincipals(auth.principal, graph)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(
          client,
          auth.orgId,
          grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
        )
        return resolve({ orgId: auth.orgId, role: auth.role, principals, grants, tree }, 'read')
      },
      this.deps.role === undefined ? {} : { role: this.deps.role },
    )

    // No access at all. Returning early rather than querying is not an
    // optimization — buildFilter refuses this plan, and it refuses it because
    // there is no filter that means "nothing" without meaning "everything" by
    // one mistake.
    if (plan.kind === 'none') return []

    const [vector] = await this.deps.embedder.embed([query])
    if (vector === undefined) throw new Error('the embedder returned no vector for the query')

    const hits = await this.deps.vectors.search({
      orgId: auth.orgId,
      orgSlug: slug,
      plan,
      branches: [{ kind: 'dense', using: this.deps.vectorName, vector }],
      // Passed through. Asking for more and trimming is a post-filter that also
      // costs more.
      topK,
    })

    // Invariant I1, checked again on the way out. Raises rather than filtering:
    // silently dropping the row would hide the bug that produced it.
    return VectorStore.assertTenant(auth.orgId, hits)
  }

  /** Exposed so the filter can be inspected in tests without a vector store. */
  static filterFor(orgId: string, plan: Parameters<typeof buildFilter>[1]) {
    return buildFilter(orgId, plan)
  }
}

/**
 * The audit sink.
 *
 * Writes with the application role, which has INSERT and SELECT on
 * `audit_events` and neither UPDATE nor DELETE — revoked at the database level
 * by migration 0002, so a bug here cannot rewrite history and neither can
 * anyone holding these credentials.
 */
export class PostgresAudit implements AuditSink {
  constructor(private readonly pool: Pool, private readonly role?: string) {}

  async write(event: AuditEvent): Promise<void> {
    const [actorType, actorId] = event.actor.split(':')
    await withOrg(
      this.pool,
      event.orgId,
      async (client) => {
        await client.query(
          `INSERT INTO audit_events
             (org_id, actor_type, actor_id, actor_label, action, surface, target, result, detail, request_id)
           VALUES ($1,$2,$3,$4,$5,'api','{}'::jsonb,$6,$7,$8)`,
          [
            event.orgId,
            actorType ?? 'unknown',
            /^[0-9a-f-]{36}$/i.test(actorId ?? '') ? actorId : null,
            event.actor,
            event.action,
            event.result,
            JSON.stringify(event.detail),
            event.requestId,
          ],
        )
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

/**
 * An OpenAI-compatible embedding client.
 *
 * "Bring your own model" means this has to work against anything speaking that
 * shape, so the only thing assumed is `POST /embeddings` returning
 * `{ data: [{ embedding: number[] }] }`.
 */
export class HttpEmbedder implements Embedder {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []

    const response = await fetch(new URL('/embeddings', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    })

    if (!response.ok) {
      throw new Error(`the embedding endpoint answered ${response.status}`)
    }

    const body = (await response.json()) as { data?: { embedding?: unknown }[] }
    const vectors = (body.data ?? []).map((d) => d.embedding)

    if (vectors.length !== texts.length) {
      // Same reason as in the ingest pipeline: a short or reordered batch
      // attaches the wrong vector to the wrong text, and nothing downstream can
      // tell.
      throw new Error(`the embedding endpoint returned ${vectors.length} vectors for ${texts.length} inputs`)
    }

    return vectors.map((v, i) => {
      if (!Array.isArray(v) || v.length !== this.dimensions || !v.every((n) => typeof n === 'number')) {
        throw new Error(
          `vector ${i} is not ${this.dimensions} numbers; the endpoint and ` +
            'NACRE_DEFAULT_EMBEDDING_DIM disagree, and the index would be built wrong',
        )
      }
      return v as number[]
    })
  }
}

export { aclTags }


/**
 * Queueing a document, with the write permission checked first.
 *
 * `write` is resolved, not `read`. Rule 6 is the whole reason this is a
 * separate resolve: an ingest-only service account has `write` and no `read`,
 * and a check that asked for `read` would refuse exactly the caller this
 * endpoint exists for. Asking for `admin` would refuse them too.
 */
export class NacreIngest implements Ingest {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  /** The layers this caller may write to, by slug. */
  private async writableLayer(
    client: import('pg').PoolClient,
    auth: AuthContext,
    layerSlug: string,
  ): Promise<string | undefined> {
    const graph = await PostgresGroupGraph.load(client, auth.orgId)
    const principals = effectivePrincipals(auth.principal, graph)
    const grants = await loadGrants(client, auth.orgId, principals)
    const tree = await loadScopeTree(
      client,
      auth.orgId,
      grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
    )
    const plan = resolve({ orgId: auth.orgId, role: auth.role, principals, grants, tree }, 'write')
    if (plan.kind === 'none') return undefined

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM layers WHERE org_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [auth.orgId, layerSlug],
    )
    const id = rows[0]?.id
    if (id === undefined) return undefined

    // A layer that exists but is not writable and a layer that does not exist
    // return the same thing, so the caller cannot tell them apart.
    if (plan.kind === 'all') return id
    return plan.layers.includes(id) ? id : undefined
  }

  async queue(auth: AuthContext, request: IngestRequest): Promise<IngestOutcome | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const layerId = await this.writableLayer(client, auth, request.layer)
        if (layerId === undefined) return undefined

        const source = request.content !== undefined ? request.content : (request.url as string)
        const sourceType = request.content !== undefined ? 'inline' : 'url'
        const hash = createHash('sha256').update(source, 'utf8').digest('hex')

        const { rows } = await client.query<{ id: string; content_hash: string; status: string }>(
          `INSERT INTO documents
             (org_id, layer_id, external_id, source_type, source_ref, title, content_hash, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
           ON CONFLICT (layer_id, external_id) DO UPDATE SET
             -- Only touch the row when the content actually changed. A repeat
             -- with the same bytes must not re-queue work: every client that
             -- times out retries, and re-embedding is what that costs.
             source_ref   = CASE WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                                 THEN EXCLUDED.source_ref ELSE documents.source_ref END,
             title        = COALESCE(EXCLUDED.title, documents.title),
             content_hash = EXCLUDED.content_hash,
             status       = CASE WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                                 THEN 'pending' ELSE documents.status END,
             deleted_at   = NULL,
             updated_at   = now()
           RETURNING id, content_hash, status`,
          [
            auth.orgId,
            layerId,
            request.externalId,
            sourceType,
            source,
            request.title ?? null,
            `sha256:${hash}`,
          ],
        )

        const row = rows[0]
        if (row === undefined) throw new Error('the document upsert returned no row')

        return {
          documentId: row.id,
          jobId: row.id,
          unchanged: row.status === 'indexed',
        }
      },
      this.scope,
    )
  }

  async remove(auth: AuthContext, documentId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const graph = await PostgresGroupGraph.load(client, auth.orgId)
        const principals = effectivePrincipals(auth.principal, graph)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(client, auth.orgId, [documentId])
        const plan = resolve({ orgId: auth.orgId, role: auth.role, principals, grants, tree }, 'write')
        if (plan.kind === 'none') return false

        const { rows } = await client.query<{ layer_id: string }>(
          `SELECT layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, documentId],
        )
        const layerId = rows[0]?.layer_id
        if (layerId === undefined) return false
        if (plan.kind === 'scoped' && !plan.layers.includes(layerId) && !plan.extraDocs.includes(documentId)) {
          return false
        }

        // A tombstone, not a delete. Physical removal of the points is a
        // background job, and the document has to leave results before it runs
        // — depending on the sweep's timing is how invariant I5 breaks.
        await client.query(
          `UPDATE documents SET deleted_at = now(), updated_at = now()
            WHERE org_id = $1 AND id = $2`,
          [auth.orgId, documentId],
        )
        return true
      },
      this.scope,
    )
  }
}

/**
 * Ingest job status.
 *
 * The job id is the document id — ingest writes a row and the worker moves its
 * status, so there is no separate job table to drift out of step with it. That
 * also means the visibility rule is the document's: absent and another
 * organization's answer identically.
 */
export class PostgresJobs implements Jobs {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  async read(orgId: string, jobId: string): Promise<Job | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return undefined

    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          status: string
          error: string | null
          chunk_count: number
        }>(
          `SELECT id, status, error, chunk_count FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [orgId, jobId],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        const status = (
          ['queued', 'parsing', 'embedding', 'indexed', 'failed'].includes(row.status)
            ? row.status
            : row.status === 'pending'
              ? 'queued'
              : 'queued'
        ) as Job['status']

        // Coarse on purpose. A percentage that moves smoothly would have to be
        // written by the pipeline on every chunk, which is a write per chunk to
        // make a progress bar prettier.
        const progress = status === 'indexed' ? 1 : status === 'failed' ? 0 : 0.5

        return {
          jobId: row.id,
          documentId: row.id,
          status,
          progress,
          ...(row.error === null ? {} : { error: row.error }),
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

/** The per-request permission context, loaded once and asked several questions. */
async function contextFor(
  client: import('pg').PoolClient,
  auth: AuthContext,
): Promise<{
  orgId: string
  role: AuthContext['role']
  principals: ReadonlySet<import('@nacre.work/core').PrincipalRef>
  grants: readonly import('@nacre.work/core').Grant[]
  tree: import('@nacre.work/core').ScopeTree
}> {
  const graph = await PostgresGroupGraph.load(client, auth.orgId)
  const principals = effectivePrincipals(auth.principal, graph)
  const grants = await loadGrants(client, auth.orgId, principals)
  const tree = await loadScopeTree(
    client,
    auth.orgId,
    grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
  )
  return { orgId: auth.orgId, role: auth.role, principals, grants, tree }
}

export class PostgresLayers implements Layers {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  /**
   * The layers this caller may read.
   *
   * Narrowed by the plan in SQL rather than fetched and filtered afterwards.
   * This is a listing rather than a search, so a post-filter here would not
   * break invariant I2 — but writing it the other way keeps one habit for both
   * and removes the question of which endpoints are allowed to be sloppy.
   */
  async list(auth: AuthContext): Promise<readonly Layer[]> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const plan = resolve(await contextFor(client, auth), 'read')
        if (plan.kind === 'none') return []

        const { rows } =
          plan.kind === 'all'
            ? await client.query<{ id: string; slug: string; name: string; workspace_id: string }>(
                `SELECT id, slug, name, workspace_id FROM layers
                  WHERE org_id = $1 AND deleted_at IS NULL ORDER BY slug`,
                [auth.orgId],
              )
            : await client.query<{ id: string; slug: string; name: string; workspace_id: string }>(
                `SELECT id, slug, name, workspace_id FROM layers
                  WHERE org_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])
                  ORDER BY slug`,
                [auth.orgId, [...plan.layers]],
              )

        return rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          workspaceId: r.workspace_id,
        }))
      },
      this.scope,
    )
  }

  async create(
    auth: AuthContext,
    input: { workspaceId: string; slug: string; name: string },
  ): Promise<Layer | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(input.workspaceId)) return undefined

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const context = await contextFor(client, auth)

        // `referenceAllows` and not `resolve`: the question is "may they
        // administer this one workspace", which is what the reference answers
        // directly. Reading it out of a flattened plan would mean inferring a
        // workspace permission from the layers it happens to contain — and an
        // empty workspace contains none.
        if (!referenceAllows(context, { type: 'workspace', id: input.workspaceId }, 'admin')) {
          return undefined
        }

        // Checked after the permission, so a caller who may not administer the
        // workspace gets the same answer whether or not it exists.
        const { rows: workspaces } = await client.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, input.workspaceId],
        )
        if (workspaces[0] === undefined) return undefined

        const { rows: providers } = await client.query<{ id: string }>(
          `SELECT id FROM embedding_providers
            WHERE org_id = $1 OR org_id IS NULL ORDER BY org_id NULLS LAST LIMIT 1`,
          [auth.orgId],
        )
        const providerId = providers[0]?.id
        if (providerId === undefined) {
          throw new Error('no embedding provider is configured; a layer cannot be created without one')
        }

        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          workspace_id: string
        }>(
          `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4,$5,'default')
           ON CONFLICT DO NOTHING
           RETURNING id, slug, name, workspace_id`,
          [auth.orgId, input.workspaceId, input.slug, input.name, providerId],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        return { id: row.id, slug: row.slug, name: row.name, workspaceId: row.workspace_id }
      },
      this.scope,
    )
  }
}

export class PostgresGrants implements Grants {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  /**
   * Every grant in the organization, for a caller who may administer it.
   *
   * Not narrowed to the caller's own grants. Someone who can issue a grant on a
   * scope can already see who else holds one there, and a partial list is worse
   * than none — an administrator who cannot see an existing grant revokes the
   * wrong thing.
   */
  async list(auth: AuthContext): Promise<readonly GrantRecord[]> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const context = await contextFor(client, auth)
        const plan = resolve(context, 'admin')
        if (plan.kind === 'none') return []

        const { rows } = await client.query<{
          id: string
          principal_type: string
          principal_id: string
          scope_type: string
          scope_id: string
          permission: string
          effect: string
          source: string
        }>(
          `SELECT id, principal_type, principal_id, scope_type, scope_id, permission, effect, source
             FROM grants WHERE org_id = $1 ORDER BY created_at`,
          [auth.orgId],
        )

        return rows
          .filter((r) =>
            referenceAllows(
              context,
              { type: r.scope_type as 'workspace' | 'layer' | 'document', id: r.scope_id },
              'admin',
            ),
          )
          .map((r) => ({
            id: r.id,
            principalType: r.principal_type as GrantRecord['principalType'],
            principalId: r.principal_id,
            scopeType: r.scope_type as GrantRecord['scopeType'],
            scopeId: r.scope_id,
            permission: r.permission as GrantRecord['permission'],
            effect: r.effect as GrantRecord['effect'],
            source: r.source,
          }))
      },
      this.scope,
    )
  }

  async issue(auth: AuthContext, input: GrantInput): Promise<GrantRecord | undefined> {
    if (!/^[0-9a-f-]{36}$/i.test(input.scopeId) || !/^[0-9a-f-]{36}$/i.test(input.principalId)) {
      return undefined
    }

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const context = await contextFor(client, auth)

        // Admin on the scope being granted, not admin in general. Otherwise
        // anyone holding admin on one layer could grant themselves another.
        if (!referenceAllows(context, { type: input.scopeType, id: input.scopeId }, 'admin')) {
          return undefined
        }

        const { rows } = await client.query<{ id: string; effect: string; source: string }>(
          `INSERT INTO grants
             (org_id, principal_type, principal_id, scope_type, scope_id, permission, effect, source)
           VALUES ($1,$2,$3,$4,$5,$6,'allow','api')
           ON CONFLICT (org_id, principal_type, principal_id, scope_type, scope_id, permission)
             DO UPDATE SET effect = 'allow'
           RETURNING id, effect, source`,
          [
            auth.orgId,
            input.principalType,
            input.principalId,
            input.scopeType,
            input.scopeId,
            input.permission,
          ],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        return {
          id: row.id,
          principalType: input.principalType,
          principalId: input.principalId,
          scopeType: input.scopeType,
          scopeId: input.scopeId,
          permission: input.permission,
          effect: row.effect as GrantRecord['effect'],
          source: row.source,
        }
      },
      this.scope,
    )
  }
}
