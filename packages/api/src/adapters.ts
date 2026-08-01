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
  vectorName,
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
  LayerOutcome,
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
   * Undefined for absent, for another organization's, and for one this caller
   * has no grant reaching — one answer for all three.
   *
   * The query is scoped three ways on purpose: `withOrg` sets the row-level
   * security context, `org_id` is named in the WHERE clause anyway, and the
   * plan decides whether the layer it landed in is reachable. Any one alone
   * would do for tenancy; only the third does anything about permissions
   * inside a tenant, and it is the one that was missing.
   */
  async read(auth: AuthContext, documentId: string): Promise<{ id: string; title: string } | undefined> {
    const orgId = auth.orgId
    // A malformed id must not reach Postgres as a cast error — an error
    // distinguishable from "not found" is an oracle for the id format.
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return undefined

    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        // The plan first. Reading the row and then checking is the same
        // information leak with extra steps if the check is ever forgotten,
        // and the layer a document sits in is what the grant is on.
        const plan = resolve(await contextFor(client, auth), 'read')
        if (plan.kind === 'none') return undefined

        const { rows } = await client.query<{ id: string; title: string | null; layer_id: string }>(
          `SELECT id, title, layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [orgId, documentId],
        )
        const row = rows[0]
        if (row === undefined) return undefined

        // `all` is org_admin, which reaches everything by rule 3. Otherwise the
        // document has to sit in a layer the plan reached, or be named
        // explicitly by a document-scoped grant — and not be denied by one.
        if (plan.kind === 'scoped') {
          if (plan.deniedDocs.includes(documentId)) return undefined
          const reachable =
            plan.layers.includes(row.layer_id) || plan.extraDocs.includes(documentId)
          if (!reachable) return undefined
        }

        return { id: row.id, title: row.title ?? '' }
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
export interface IngestDeps {
  readonly pool: Pool
  /**
   * What takes a document out of results. Narrower than `VectorStore` on
   * purpose: the delete path has no business searching, and a port that could
   * would let a later change reach the index without a plan.
   */
  readonly tombstone: DocumentTombstone
  /** Resolved per organization; the collection name is derived from it. */
  readonly orgSlug: (orgId: string) => Promise<string | undefined>
  readonly role?: string
}

export interface DocumentTombstone {
  tombstone(orgSlug: string, documentId: string): Promise<void>
}

export class NacreIngest implements Ingest {
  constructor(private readonly deps: IngestDeps) {}

  private get pool() {
    return this.deps.pool
  }

  private get scope() {
    return this.deps.role === undefined ? {} : { role: this.deps.role }
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

    const slug = await this.deps.orgSlug(auth.orgId)
    // The token names an organization that is not there. Refusing rather than
    // deleting only in Postgres: a tombstone we cannot mirror into the index is
    // a document that stays searchable while the API reports it gone.
    if (slug === undefined) return false

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
        if (plan.kind === 'scoped') {
          // deniedDocs first. `resolve` populates it precisely so a deny beats
          // an allow at any depth (rule 5), and checking only `layers` let a
          // document inside an allowed layer be deleted despite an explicit
          // deny on it. The read path already honoured this — buildFilter emits
          // must_not from the same list — so this was the write path drifting
          // away from the read path rather than a rule nobody had implemented.
          if (plan.deniedDocs.includes(documentId)) return false
          if (!plan.layers.includes(layerId) && !plan.extraDocs.includes(documentId)) return false
        }

        // The index first, then the row — the reverse of ingest, and the order
        // is the whole point.
        //
        // `deleted = false` is what the pre-filter tests, and that flag lives on
        // the points. Writing only the Postgres tombstone leaves the document in
        // every answer until the collector reaches it, which is precisely the
        // window invariant I5 forbids; the collector runs on a schedule measured
        // in minutes, so this is not a narrow race.
        //
        // Postgres-first also fails in the unrecoverable direction: the row says
        // deleted, so nothing queues the document for retagging or re-ingest,
        // and the only job that would ever touch its points again is the sweep —
        // which purges rather than repairs. Index-first fails the other way: the
        // points are marked, the row is not, the caller sees an error and
        // retries, and in the meantime the document is already invisible.
        await this.deps.tombstone.tombstone(slug, documentId)

        // A tombstone, not a delete, on this side too. Physical removal of the
        // points is the collector's job, and `deleted_at` is what puts the
        // document in its queue.
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

  async read(auth: AuthContext, jobId: string): Promise<Job | undefined> {
    const orgId = auth.orgId
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return undefined

    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        // A job id is a document id, so this is the document read with a
        // different projection — and needs the same check. The status and the
        // error string are both facts about a document the caller may not be
        // allowed to know exists.
        const plan = resolve(await contextFor(client, auth), 'read')
        if (plan.kind === 'none') return undefined

        const { rows } = await client.query<{
          id: string
          status: string
          error: string | null
          chunk_count: number
          layer_id: string
        }>(
          `SELECT id, status, error, chunk_count, layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [orgId, jobId],
        )

        const row = rows[0]
        if (row === undefined) return undefined

        if (plan.kind === 'scoped') {
          if (plan.deniedDocs.includes(jobId)) return undefined
          if (!plan.layers.includes(row.layer_id) && !plan.extraDocs.includes(jobId)) return undefined
        }

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
  ): Promise<LayerOutcome> {
    if (!/^[0-9a-f-]{36}$/i.test(input.workspaceId)) return { kind: 'denied' }

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
          return { kind: 'denied' }
        }

        // Checked after the permission, so a caller who may not administer the
        // workspace gets the same answer whether or not it exists.
        const { rows: workspaces } = await client.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, input.workspaceId],
        )
        if (workspaces[0] === undefined) return { kind: 'denied' }

        const { rows: providers } = await client.query<{
          id: string
          model: string
          dimensions: number
        }>(
          `SELECT id, model, dimensions FROM embedding_providers
            WHERE org_id = $1 OR org_id IS NULL ORDER BY org_id NULLS LAST LIMIT 1`,
          [auth.orgId],
        )
        const provider = providers[0]
        if (provider === undefined) {
          throw new Error('no embedding provider is configured; a layer cannot be created without one')
        }

        // Derived, never a literal. The worker writes points to the vector this
        // column names and search looks for the one the configuration derives;
        // a layer created with a placeholder here indexes into a vector the
        // collection does not have, which fails every upsert with `Bad
        // Request` and would return nothing even if it did not.
        const vector = vectorName(provider.model, provider.dimensions)

        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          workspace_id: string
        }>(
          `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT DO NOTHING
           RETURNING id, slug, name, workspace_id`,
          [auth.orgId, input.workspaceId, input.slug, input.name, provider.id, vector],
        )

        const row = rows[0]
        // ON CONFLICT DO NOTHING returns nothing, and by here the caller has
        // already proved admin on the workspace — so the only way to get here
        // is a slug already in use.
        if (row === undefined) return { kind: 'conflict' }

        return {
          kind: 'created',
          layer: { id: row.id, slug: row.slug, name: row.name, workspaceId: row.workspace_id },
        }
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

  /**
   * Withdraw a grant.
   *
   * A real DELETE, not an effect flip. Setting `effect = 'deny'` would look
   * equivalent and is not: a deny is a commercial capability this build refuses
   * to issue, and it beats an allow at any depth — so a "revocation" written
   * that way would also suppress a grant the principal holds through a group or
   * a parent scope. Removing the row leaves whatever else they were given.
   *
   * Admin on the grant's own scope, resolved from the row rather than from
   * anything the caller sent. Reading the scope first and checking it after is
   * the only order that works: the caller names an id, and the permission
   * question is about what that id points at.
   */
  async revoke(auth: AuthContext, grantId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(grantId)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ scope_type: string; scope_id: string }>(
          `SELECT scope_type, scope_id FROM grants WHERE org_id = $1 AND id = $2`,
          [auth.orgId, grantId],
        )

        const row = rows[0]
        // Absent, another organization's, and one whose scope this caller
        // cannot administer all answer the same. Rule 4 does not stop applying
        // because the object is a grant rather than a document.
        if (row === undefined) return false

        const context = await contextFor(client, auth)
        const scope = {
          type: row.scope_type as 'workspace' | 'layer' | 'document',
          id: row.scope_id,
        }
        if (!referenceAllows(context, scope, 'admin')) return false

        const result = await client.query(`DELETE FROM grants WHERE org_id = $1 AND id = $2`, [
          auth.orgId,
          grantId,
        ])

        // The trigger on `grants` bumps groups_version, which is what makes the
        // worker recompute the payload tags and what the propagation gauge then
        // measures. Nothing here has to do that by hand, and nothing here
        // should: a second place that bumps it is a second place to forget.
        return (result.rowCount ?? 0) > 0
      },
      this.scope,
    )
  }
}
