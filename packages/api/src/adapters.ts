import {
  aclTags,
  buildFilter,
  effectivePrincipals,
  fromStateJson,
  loadGrants,
  loadScopeTree,
  PostgresGroupGraph,
  referenceAllows,
  reindexProgress,
  resolve,
  toStateJson,
  VectorStore,
  vectorName,
  withOrg,
  type Hit,
  type Metadata,
  type Narrowing,
  type QueryablePlan,
  type ReindexState,
} from '@nacre.work/core'
import { createHash } from 'node:crypto'

import type { Pool, PoolClient } from 'pg'

import { encodeCursor, pageOf } from './pagination.js'
import { applyRanking, type Reranker } from './rerank.js'

import type {
  Reindex,
  ReindexOutcome,
  ReindexStatus,
  AuditEvent,
  AuditQuery,
  AuditReader,
  AuditRecord,
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
  DocumentView,
  Layers,
  Page,
  PageResult,
  SearchHit,
  SearchOptions,
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
  constructor(
    private readonly pool: Pool,
    /**
     * What writes metadata into the payload of a document's points.
     *
     * Narrow on purpose, like the delete path's tombstone port: this endpoint
     * has no business searching, and a port that could would let a later change
     * reach the index without a plan.
     */
    private readonly payload: DocumentMetadataWriter,
    private readonly role?: string,
  ) {}

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
  async read(auth: AuthContext, documentId: string): Promise<DocumentView | undefined> {
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

        const { rows } = await client.query<{
          id: string
          title: string | null
          layer_id: string
          layer: string
          status: string
          chunk_count: number
          updated_at: Date
          metadata: Record<string, unknown> | null
        }>(
          `SELECT d.id, d.title, d.layer_id, l.slug AS layer, d.status, d.chunk_count,
                  d.updated_at, d.metadata
             FROM documents d
             JOIN layers l ON l.id = d.layer_id AND l.org_id = d.org_id
            WHERE d.org_id = $1 AND d.id = $2 AND d.deleted_at IS NULL`,
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

        return {
          document_id: row.id,
          layer: row.layer,
          title: row.title,
          status: row.status,
          chunk_count: Number(row.chunk_count),
          updated_at: row.updated_at.toISOString(),
          // Read back, because a caller who tags a document and cannot see the
          // tag has no way to tell a successful write from a dropped one — and
          // this field was dropped by the handler for as long as it existed.
          metadata: (row.metadata ?? {}) as Metadata,
        }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }

  /**
   * Replace a document's metadata without re-embedding it.
   *
   * This is the cheap path `docs/api.md` said was not built. Ingest treats a
   * metadata change as a change: the row and the vector payload would otherwise
   * disagree and the document would carry a tag it does not answer to, so a
   * re-tag cost a full re-parse, re-chunk and re-embed. Here the vectors are
   * untouched and only the payload is rewritten — the same `setPayload` the ACL
   * retag sweep uses, for the same reason.
   *
   * `write`, not `read`, and rule 6 means those are not the same set. The
   * answer carries no body at all: a caller who may write to a document and not
   * read it must not learn its title or its layer from a successful PATCH.
   *
   * Row first, then payload, both inside one transaction. A payload write that
   * throws rolls the row back, so the two cannot end up disagreeing in the
   * direction that matters — the row is what the worker rebuilds the payload
   * from on the next index, so a row that ran ahead would be reverted while a
   * payload that ran ahead would not.
   */
  async updateMetadata(
    auth: AuthContext,
    documentId: string,
    metadata: Metadata,
  ): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return false

        const plan = resolve(await contextFor(client, auth), 'write')
        if (plan.kind === 'none') return false

        const { rows } = await client.query<{ layer_id: string }>(
          `SELECT layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, documentId],
        )
        const layerId = rows[0]?.layer_id
        if (layerId === undefined) return false

        if (plan.kind === 'scoped') {
          // deniedDocs first, as on the delete path: a deny beats an allow at
          // any depth, and checking only `layers` would let a document inside
          // an allowed layer be retagged despite an explicit deny on it.
          if (plan.deniedDocs.includes(documentId)) return false
          if (!plan.layers.includes(layerId) && !plan.extraDocs.includes(documentId)) return false
        }

        await client.query(
          `UPDATE documents SET metadata = $3, updated_at = now()
            WHERE org_id = $1 AND id = $2`,
          [auth.orgId, documentId, JSON.stringify(metadata)],
        )

        // `version` is deliberately not bumped. It counts revisions of the
        // document's content, and a tag change is not one — bumping it would
        // make every retag look like an edit to anything watching for one.
        await this.payload.setMetadata(collection, documentId, metadata)
        return true
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

export interface DocumentMetadataWriter {
  setMetadata(collection: string, documentId: string, metadata: Metadata): Promise<void>
}

export interface SearchDeps {
  readonly pool: Pool
  readonly vectors: VectorStore
  /**
   * The query embedder for a given provider.
   *
   * Per provider and not one for the whole process. `NACRE_EMBEDDING_MODEL`
   * used to decide both the named vector a search looked in and the model the
   * query was embedded with, for every layer in every organization — so a layer
   * created against a second provider was silently unsearchable: its points
   * carry `v_small_v2_768` and the query went to `v_bge_m3_1024`, which matches
   * nothing and raises nothing. `embedding_providers` has had an `org_id`
   * column and a documented "NULL = global default" since the first migration;
   * the search path was the half that never honoured it.
   */
  readonly embedderFor: (provider: EmbeddingProvider) => Embedder
  readonly role?: string
  /** Absent means reranking is off, which is what the `minimal` profile is. */
  readonly reranker?: Reranker
  /** Candidates to rerank. docs/architecture.md says 50. */
  readonly rerankCandidates?: number
  /**
   * Reranking stopped working, with the search still answering in fusion order.
   * An operator who turned reranking on is entitled to know it is not running.
   */
  readonly onRerankFailed?: (error: unknown) => void
}

/** What a layer needs embedded with, and where. */
export interface EmbeddingProvider {
  readonly id: string
  readonly endpoint: string
  readonly model: string
  readonly dimensions: number
}

/** One dense branch's worth of the organization: a model and the layers on it. */
interface ModelGroup {
  readonly vectorName: string
  readonly provider: EmbeddingProvider
  readonly layerIds: readonly string[]
}

export class NacreSearchService implements SearchService {
  constructor(private readonly deps: SearchDeps) {}

  async search(
    auth: AuthContext,
    query: string,
    topK: number,
    options: SearchOptions = {},
  ): Promise<readonly SearchHit[]> {
    const context = await withOrg(
      this.deps.pool,
      auth.orgId,
      async (client) => {
        // The collection, from the column that owns it. Read in the transaction
        // the plan needs anyway rather than through a cache: a reindex moves
        // this pointer, and a cached one means the API keeps searching the
        // collection the worker has stopped writing to. That failure returns
        // results, just increasingly stale ones, which is the kind nobody
        // notices.
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return undefined

        const graph = await PostgresGroupGraph.load(client, auth.orgId)
        const principals = effectivePrincipals(auth.principal, graph)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(
          client,
          auth.orgId,
          grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
        )
        const plan = resolve(
          { orgId: auth.orgId, role: auth.role, principals, grants, tree },
          'read',
        )

        // Every live layer with the model it is on. Small — an installation
        // runs tens of layers per organization, not thousands — and it is what
        // decides how many branches the query has.
        const { rows: layers } = await client.query<{
          id: string
          vector_name: string
          provider_id: string
          endpoint: string
          model: string
          dimensions: number
        }>(
          `SELECT l.id, l.vector_name, p.id AS provider_id, p.endpoint, p.model, p.dimensions
             FROM layers l
             JOIN embedding_providers p ON p.id = l.provider_id
            WHERE l.org_id = $1 AND l.deleted_at IS NULL`,
          [auth.orgId],
        )

        return { collection, plan, layers }
      },
      this.deps.role === undefined ? {} : { role: this.deps.role },
    )

    if (context === undefined) {
      // The token names an organization that is not there. Rule I3: a
      // permission that cannot be evaluated denies.
      return []
    }

    const { collection, plan } = context

    // No access at all. Returning early rather than querying is not an
    // optimization — buildFilter refuses this plan, and it refuses it because
    // there is no filter that means "nothing" without meaning "everything" by
    // one mistake.
    if (plan.kind === 'none') return []

    // The caller's own restriction, resolved before the query.
    //
    // `layers` was declared in openapi.yaml and in the MCP tool schema from the
    // beginning and read by nothing, so a client scoping a search to one layer
    // silently searched all of them. For a product whose selling point is that
    // a search returns only what you may see, a scoping parameter that does
    // nothing is the worst kind of no-op: the caller believes they narrowed it.
    let narrow: Narrowing | undefined
    if (options.filters !== undefined && Object.keys(options.filters).length > 0) {
      // Metadata alone is a valid narrowing — a caller may filter by source
      // without naming a layer. `buildFilter` turns each entry into a `must`
      // beside the permission constraint; there is no path from here to a
      // filter the caller assembled.
      narrow = { metadata: options.filters }
    }

    if (options.layers !== undefined && options.layers.length > 0) {
      const resolved = await this.layerIds(auth.orgId, options.layers)

      // Intersected with what the plan actually reaches, before deciding
      // whether to query at all.
      //
      // The filter would already return nothing for a layer this caller cannot
      // read — `must` on layer_id against a `should` that names other layers
      // matches no point. Doing it here as well closes a narrower hole: without
      // it, an unreadable-but-existing layer runs the query and an absent one
      // does not, so anything that makes the query path *fail* — the vector
      // store being down — separates the two. That is invariant I4 leaking
      // through a dependency outage, and it costs six lines to remove. It also
      // saves a round trip in the ordinary case.
      //
      // Not intersected when the plan carries `extraDocs`: those are documents
      // granted individually and they can sit in any layer, including one the
      // caller reaches no other way. Dropping such a layer here would answer
      // empty where the correct answer is "the documents you were granted".
      const permitted =
        plan.kind === 'scoped' && plan.extraDocs.length === 0
          ? resolved.filter((id) => plan.layers.includes(id))
          : resolved

      // Nothing the caller named is reachable. That covers a slug that does not
      // exist and one that does but sits outside their grants — and it has to,
      // because invariant I4 makes those the same answer. Empty results, no
      // error naming the layer, and no query.
      if (permitted.length === 0) return []

      narrow = { ...narrow, layers: permitted }
    }

    // One branch per model actually in scope.
    //
    // Almost always exactly one: an organization runs a single embedding model
    // and every layer is on it. Two while a reindex is part-way through, and
    // two for as long as an operator keeps layers on different providers.
    // Zero means the organization has no layers, or none the caller can reach,
    // and there is nothing to ask the index.
    const groups = this.groupsInScope(context.layers, plan, narrow)
    if (groups.length === 0) return []

    const branches = await Promise.all(
      groups.map(async (group) => {
        const [vector] = await this.deps.embedderFor(group.provider).embed([query])
        if (vector === undefined) {
          throw new Error(`the embedder for ${group.provider.model} returned no vector for the query`)
        }
        return {
          kind: 'dense' as const,
          using: group.vectorName,
          vector,
          // Confined to the layers on this model. A reindexed layer keeps its
          // old vector until the collection is rebuilt without it, so without
          // this it would match the other model's branch too and fusion would
          // rank it above everything for no reason but having been migrated.
          //
          // Only when there is more than one group: with a single model this
          // clause is every layer in the organization, which is a longer filter
          // that removes nothing.
          ...(groups.length > 1 ? { onlyLayers: group.layerIds } : {}),
        }
      }),
    )

    // Off unless the deployment configured a reranker and the caller left it on.
    const reranking = this.deps.reranker !== undefined && options.rerank !== false

    const hits = await this.deps.vectors.search({
      orgId: auth.orgId,
      collection,
      plan,
      branches,
      // Without a reranker this is passed through uncorrected: asking for more
      // and trimming would be a post-filter that also costs more.
      //
      // With one it is widened, and that is not the same thing. The trim a
      // reranker performs is on relevance over a set the index has already
      // filtered by permission, so it changes *which* permitted results come
      // back and never how many. See rerank.ts — the distinction is the whole
      // argument for this being allowed at all.
      topK: reranking ? Math.max(topK, this.deps.rerankCandidates ?? 50) : topK,
      // A `must` on layer_id inside the traversal, never a trim afterwards.
      // Narrowing a search is still a pre-filter: `top_k` comes back full from
      // the smaller set rather than being cut down from the larger one.
      ...(narrow === undefined ? {} : { narrow }),
    })

    // Invariant I1, checked again on the way out. Raises rather than filtering:
    // silently dropping the row would hide the bug that produced it.
    const checked = VectorStore.assertTenant(auth.orgId, hits)
    if (checked.length === 0) return []

    const candidates = await this.hydrate(auth.orgId, checked)
    const ranked = reranking ? await this.rerank(query, candidates, topK) : candidates

    // Last, because reranking scores the query against the text. Dropping it
    // earlier would rerank against nothing.
    return options.includeContent === false ? ranked.map((hit) => ({ ...hit, text: '' })) : ranked
  }

  /**
   * The organization's layers, grouped by the model they are indexed with.
   *
   * Restricted first to what this search can actually reach — the permission
   * plan, then the caller's own `layers` narrowing — so a query never embeds
   * against a provider whose layers contribute nothing. That is not only a
   * saving: an embedding endpoint that is down would otherwise fail a search
   * over layers that have no connection to it.
   *
   * A plan carrying `extraDocs` keeps every group. Documents granted
   * individually can sit in any layer, including one the caller reaches no
   * other way, so dropping a group here would answer empty where the correct
   * answer is "the documents you were granted".
   */
  private groupsInScope(
    layers: readonly {
      id: string
      vector_name: string
      provider_id: string
      endpoint: string
      model: string
      dimensions: number
    }[],
    plan: QueryablePlan,
    narrow: Narrowing | undefined,
  ): readonly ModelGroup[] {
    const reachable = layers.filter((l) => {
      // Only the layer half narrows the branch set. A metadata restriction says
      // nothing about which models are in scope: it removes points inside the
      // query rather than removing layers from it.
      if (narrow?.layers !== undefined && !narrow.layers.includes(l.id)) return false
      if (plan.kind === 'all') return true
      if (plan.extraDocs.length > 0) return true
      return plan.layers.includes(l.id)
    })

    const byVector = new Map<string, { provider: EmbeddingProvider; layerIds: string[] }>()
    for (const layer of reachable) {
      // `vector_name` and `provider_id` have to agree, because the first says
      // which slot to search and the second says which model to embed the query
      // with. They disagreed once already — a reindex switched the vector and
      // left the provider behind — and the symptom was Qdrant refusing the
      // whole query on a dimension mismatch, which takes every *other* layer in
      // the organization down with it. Named here rather than left to arrive as
      // `Bad Request`, and raised rather than skipped: dropping the layer from
      // the branch set would answer a search with a silently smaller corpus.
      const expected = vectorName(layer.model, layer.dimensions)
      if (expected !== layer.vector_name) {
        throw new Error(
          `layer ${layer.id} names vector ${layer.vector_name} but its provider is ` +
            `${layer.model}/${layer.dimensions}, which is ${expected}. A reindex left the two ` +
            'out of step; the layer cannot be searched until they agree.',
        )
      }

      const group = byVector.get(layer.vector_name) ?? {
        provider: {
          id: layer.provider_id,
          endpoint: layer.endpoint,
          model: layer.model,
          dimensions: layer.dimensions,
        },
        layerIds: [],
      }
      group.layerIds.push(layer.id)
      byVector.set(layer.vector_name, group)
    }

    return [...byVector].map(([vectorName, group]) => ({
      vectorName,
      provider: group.provider,
      layerIds: group.layerIds,
    }))
  }

  /**
   * Layer slugs to ids, within one organization.
   *
   * Scoped through `withOrg` like every other tenant read, so a slug belonging
   * to another organization resolves to nothing rather than to their layer. The
   * result is intersected with what the caller may reach by the filter itself —
   * the ids become a `must` and the permission constraint stays a `should`, so
   * a layer this caller cannot read contributes no results even when it
   * resolves here.
   *
   * Unknown slugs are dropped rather than reported. Answering "no such layer"
   * would separate "does not exist" from "you cannot see it", which is exactly
   * the distinction invariant I4 exists to prevent.
   */
  private async layerIds(orgId: string, slugs: readonly string[]): Promise<readonly string[]> {
    // Bounded, because this is an unauthenticated-shaped input on an
    // authenticated path: an array of ten thousand slugs is one query with ten
    // thousand parameters otherwise.
    const wanted = [...new Set(slugs.map((s) => s.trim().toLowerCase()).filter((s) => s !== ''))].slice(
      0,
      64,
    )
    if (wanted.length === 0) return []

    return withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM layers WHERE org_id = $1 AND slug = ANY($2::text[])',
          [orgId, wanted],
        )
        return rows.map((r) => r.id)
      },
      this.deps.role === undefined ? {} : { role: this.deps.role },
    )
  }

  /**
   * Reorder by cross-encoder score, or answer in fusion order and say so.
   *
   * The text comes from the hydration that had to happen anyway. A reranker
   * scores query against text, and the vector store holds no text — so the
   * order here is search, hydrate the candidates, rerank, cut. Hydrating fifty
   * rows rather than ten is one query with a wider `ANY($2)`, which is the cost
   * of the quality this buys.
   *
   * Failure answers with what fusion produced rather than raising. Reranking
   * decides ordering over candidates that were all permitted before it saw
   * them, so a reranker being down is a quality degradation and not a
   * permissions one — and making the product's central operation depend on an
   * optional model server would be the worse trade. It is reported, never
   * silent.
   */
  private async rerank(
    query: string,
    candidates: readonly SearchHit[],
    topK: number,
  ): Promise<readonly SearchHit[]> {
    const reranker = this.deps.reranker
    if (reranker === undefined) return candidates.slice(0, topK)

    try {
      const scores = await reranker.rank(
        query,
        candidates.map((c) => c.text),
      )
      return applyRanking(candidates, scores, topK)
    } catch (error) {
      this.deps.onRerankFailed?.(error)
      return candidates.slice(0, topK)
    }
  }

  /**
   * Turn hits into results a caller can read.
   *
   * The vector store holds no text — chunks live in Postgres, and the payload
   * carries only what the filter needs. Returning the payload as the result,
   * which is what happened before this existed, gave a caller identifiers and a
   * score and nothing to show a user, and shipped `acl_tags` and `acl_version`
   * along with it.
   *
   * This is a join and not a filter. The permitted set was decided inside the
   * index traversal and is not narrowed here — with one exception, stated
   * rather than left implicit: a chunk whose document has since been tombstoned
   * in Postgres has no row to join to and does not appear. That is invariant I5
   * enforced a second time on a different store, the same way row-level
   * security backs up invariant I1, and it can only ever remove a document that
   * is already meant to be gone.
   *
   * The order the index returned is kept. Postgres has no reason to preserve
   * it, and re-sorting by anything else here would be a reranking step nobody
   * asked for.
   */
  private async hydrate(orgId: string, hits: readonly Hit[]): Promise<readonly SearchHit[]> {
    const chunkIds = hits.map((h) => String(h.payload.chunk_id ?? h.id))

    const rows = await withOrg(
      this.deps.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{
          chunk_id: string
          doc_id: string
          layer: string
          title: string | null
          text: string
        }>(
          // point_id, not chunks.id. The payload's `chunk_id` is the vector
          // store's point identifier — `chunks` keeps both, and they are
          // different values. Joining on the wrong one matches nothing and
          // returns an empty result set, which looks exactly like a permission
          // working correctly.
          `SELECT c.point_id AS chunk_id, c.document_id AS doc_id, l.slug AS layer, d.title, c.text
             FROM chunks c
             JOIN documents d ON d.id = c.document_id AND d.org_id = c.org_id
             JOIN layers    l ON l.id = d.layer_id    AND l.org_id = d.org_id
            WHERE c.org_id = $1
              AND c.point_id = ANY($2::uuid[])
              AND d.deleted_at IS NULL
              AND l.deleted_at IS NULL`,
          [orgId, chunkIds],
        )
        return rows
      },
      this.deps.role === undefined ? {} : { role: this.deps.role },
    )

    const byId = new Map(rows.map((r) => [r.chunk_id, r]))

    return hits
      .map((hit) => {
        const row = byId.get(String(hit.payload.chunk_id ?? hit.id))
        if (row === undefined) return undefined
        return {
          chunk_id: row.chunk_id,
          doc_id: row.doc_id,
          layer: row.layer,
          title: row.title,
          score: hit.score,
          text: row.text,
        }
      })
      .filter((r): r is SearchHit => r !== undefined)
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
          // `surface` and `target` were literals in this statement — 'api' and
          // an empty object — so every MCP call was logged as REST and the
          // `gin (target)` index built for this indexed nothing. The columns
          // and the schema were right from the first migration; only the write
          // was not.
          `INSERT INTO audit_events
             (org_id, actor_type, actor_id, actor_label, action, surface, target, result, detail, request_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
          [
            event.orgId,
            actorType ?? 'unknown',
            /^[0-9a-f-]{36}$/i.test(actorId ?? '') ? actorId : null,
            event.actor,
            event.action,
            event.surface ?? 'api',
            JSON.stringify(event.target ?? {}),
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
    /** One query, one vector, and a caller waiting on it. */
    private readonly timeoutMs = 15_000,
  ) {}

  /**
   * One embedder per provider, built once and reused.
   *
   * Keyed on the provider's id, so an operator who edits an endpoint has to
   * restart — which is true of every other piece of configuration here, and the
   * alternative is a cache that has to be invalidated from a table nothing
   * watches.
   */
  static pool(timeoutMs?: number): (provider: EmbeddingProvider) => Embedder {
    const embedders = new Map<string, HttpEmbedder>()
    return (provider) => {
      const cached = embedders.get(provider.id)
      if (cached !== undefined) return cached
      const embedder = new HttpEmbedder(
        provider.endpoint,
        provider.model,
        provider.dimensions,
        ...(timeoutMs === undefined ? [] : ([timeoutMs] as const)),
      )
      embedders.set(provider.id, embedder)
      return embedder
    }
  }

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []

    // On the search path, so much tighter than the worker's: a caller is
    // waiting. Without any bound a wedged embedder held every search open for
    // undici's 300 s default, which exhausts the connection pool long before
    // anyone sees an error.
    const response = await fetch(new URL('/embeddings', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs),
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
  readonly role?: string
}

export interface DocumentTombstone {
  tombstone(collection: string, documentId: string): Promise<void>
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
             (org_id, layer_id, external_id, source_type, source_ref, title, content_hash, metadata, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
           ON CONFLICT (layer_id, external_id) DO UPDATE SET
             -- Only touch the row when the content actually changed. A repeat
             -- with the same bytes must not re-queue work: every client that
             -- times out retries, and re-embedding is what that costs.
             source_ref   = CASE WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                                 THEN EXCLUDED.source_ref ELSE documents.source_ref END,
             title        = COALESCE(EXCLUDED.title, documents.title),
             content_hash = EXCLUDED.content_hash,
             metadata     = EXCLUDED.metadata,
             -- Metadata counts as a change, because it is written into the
             -- vector payload of every point and a filter reads it from there.
             -- Updating the row alone would leave the two disagreeing: the
             -- document would carry a tag it does not answer to, which is the
             -- silent shape of failure this repository keeps removing.
             --
             -- The cost is real — this re-embeds a document whose bytes did not
             -- change — and the cheaper path is a payload-only write like the
             -- ACL retag sweep does. Not built; docs/api.md says so rather than
             -- letting an operator discover it from a bill.
             status       = CASE WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                                   OR documents.metadata IS DISTINCT FROM EXCLUDED.metadata
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
            JSON.stringify(request.metadata),
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
        // The collection, from the column that owns it, inside the same
        // transaction as the permission check. Refusing rather than deleting
        // only in Postgres: a tombstone we cannot mirror into the index is a
        // document that stays searchable while the API reports it gone.
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return false

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
        await this.deps.tombstone.tombstone(collection, documentId)

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

interface LayerRow {
  id: string
  slug: string
  name: string
  workspace_id: string
  description: string | null
  document_count: string
  created_at: Date
}

export class PostgresLayers implements Layers {
  constructor(
    private readonly pool: Pool,
    /**
     * Only to ask which named vectors the organization's collection has.
     *
     * A layer is created against a provider, and the provider decides which
     * named vector the layer's points go into. Qdrant fixes that set when the
     * collection is created and has no way to extend it, so a layer on a
     * provider the collection has no slot for is a layer whose every document
     * fails in the worker with `Not existing vector name` — after the API has
     * answered 202 and the row says `pending`. Checking here is what turns that
     * into a collection rebuild instead.
     */
    private readonly vectors: { vectorsOf(collection: string): Promise<Record<string, number>> },
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
  async list(auth: AuthContext, page?: Page): Promise<PageResult<Layer>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const plan = resolve(await contextFor(client, auth), 'read')
        if (plan.kind === 'none') return { items: [], nextCursor: null }

        // The count comes from the same statement. It is what a catalog is
        // for — an agent choosing where to search, or a person deciding
        // whether a layer is worth opening — and the MCP catalog has always
        // carried it, so a REST client had to be told to use MCP for that.
        //
        // It counts live documents in the layer, not documents this caller may
        // read: layer-scoped grants are all this build has, so anyone who can
        // see the layer can read everything in it. The moment document-level
        // grants exist — a commercial module — this becomes a number that
        // discloses more than the caller can reach, and it has to be recomputed
        // per caller or dropped.
        const projection = `l.id, l.slug, l.name, l.workspace_id, l.description, l.created_at,
              (SELECT count(*) FROM documents d
                WHERE d.layer_id = l.id AND d.deleted_at IS NULL) AS document_count`

        // Ordered by (created_at, id) rather than by slug, because that is the
        // cursor's sort key and a page has to be stable under inserts. Sorting
        // by a mutable column would move rows between pages when one is renamed.
        const order = 'ORDER BY l.created_at, l.id'
        const after = page?.after
        const seek = after === undefined ? '' : ' AND (l.created_at, l.id) > ($3::timestamptz, $4::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } =
          plan.kind === 'all'
            ? await client.query<LayerRow>(
                `SELECT ${projection} FROM layers l
                  WHERE l.org_id = $1 AND l.deleted_at IS NULL${seek.replace('$3', '$2').replace('$4', '$3')}
                  ${order}${cap}`,
                after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
              )
            : await client.query<LayerRow>(
                `SELECT ${projection} FROM layers l
                  WHERE l.org_id = $1 AND l.deleted_at IS NULL AND l.id = ANY($2::uuid[])${seek}
                  ${order}${cap}`,
                after === undefined
                  ? [auth.orgId, [...plan.layers]]
                  : [auth.orgId, [...plan.layers], after.createdAt, after.id],
              )

        const layers = rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          workspaceId: r.workspace_id,
          description: r.description ?? '',
          documentCount: Number(r.document_count),
          createdAt: r.created_at.toISOString(),
        }))

        return pageOf(layers, page, (l) => ({ createdAt: l.createdAt, id: l.id }))
      },
      this.scope,
    )
  }

  async create(
    auth: AuthContext,
    input: { workspaceId: string; slug: string; name: string; providerId?: string },
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

        // The caller's choice, or the organization's if there is no ambiguity.
        //
        // `ORDER BY org_id NULLS LAST LIMIT 1` was the whole of this, which is
        // fine while an organization has one provider and arbitrary the moment
        // it has two — two rows with the same non-null `org_id` come back in
        // whatever order the database felt like, so the model a layer was
        // created against was a coin toss with no way for the caller to call
        // it. Now they can, and where they do not, an ambiguous choice is
        // refused rather than guessed.
        const { rows: providers } = await client.query<{
          id: string
          model: string
          dimensions: number
          own: boolean
        }>(
          `SELECT id, model, dimensions, (org_id IS NOT NULL) AS own
             FROM embedding_providers
            WHERE (org_id = $1 OR org_id IS NULL)
              AND ($2::uuid IS NULL OR id = $2::uuid)
            ORDER BY org_id NULLS LAST, id`,
          [auth.orgId, input.providerId ?? null],
        )

        if (input.providerId !== undefined && providers[0] === undefined) {
          return {
            kind: 'provider',
            detail: 'No embedding provider with that id is available to this organization.',
          }
        }

        const own = providers.filter((p) => p.own)
        if (input.providerId === undefined && own.length > 1) {
          return {
            kind: 'provider',
            detail:
              `This organization has ${own.length} embedding providers, so which one a layer ` +
              "is indexed with is not implied. Name it with 'provider_id'.",
          }
        }

        const provider = own[0] ?? providers[0]
        if (provider === undefined) {
          throw new Error('no embedding provider is configured; a layer cannot be created without one')
        }

        // Derived, never a literal. The worker writes points to the vector this
        // column names and search looks for the one the configuration derives;
        // a layer created with a placeholder here indexes into a vector the
        // collection does not have, which fails every upsert with `Bad
        // Request` and would return nothing even if it did not.
        const vector = vectorName(provider.model, provider.dimensions)

        // Does the collection have room for this model?
        //
        // Usually yes: `init` creates the collection and the global provider
        // from the same configuration, so every layer lands on the slot that is
        // already there. An operator who adds a second provider is the case
        // this exists for — `embedding_providers` has carried an `org_id` and a
        // documented "NULL = global default" since the first migration, and a
        // layer created against an organization's own provider used to accept
        // documents and fail every one of them, forever, with the API reporting
        // `queued` throughout.
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return { kind: 'denied' }

        const present = await this.vectors.vectorsOf(collection)
        // A copy in flight if the slot is missing. The layer is created either
        // way — it is a real layer with a real provider — and the worker holds
        // its documents at `pending` until the collection that can hold them
        // exists. See `claimNext`.
        //
        // Reusing the reindex's own state rather than inventing a second
        // mechanism: this *is* the copy phase of a reindex, with no documents
        // to re-embed afterwards, so `finishCopy` and `finishReindexIfDone`
        // close it out with nothing added.
        const state =
          vector in present
            ? null
            : toStateJson({
                status: 'running',
                phase: 'copying',
                shadowVector: vector,
                providerId: provider.id,
                startedAt: new Date().toISOString(),
                total: 0,
                done: 0,
                failed: 0,
              })

        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          workspace_id: string
          description: string | null
          created_at: Date
        }>(
          `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name, reindex_state)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT DO NOTHING
           RETURNING id, slug, name, workspace_id, description, created_at`,
          [auth.orgId, input.workspaceId, input.slug, input.name, provider.id, vector, state],
        )

        const row = rows[0]
        // ON CONFLICT DO NOTHING returns nothing, and by here the caller has
        // already proved admin on the workspace — so the only way to get here
        // is a slug already in use.
        if (row === undefined) return { kind: 'conflict' }

        return {
          kind: 'created',
          layer: {
            id: row.id,
            slug: row.slug,
            name: row.name,
            workspaceId: row.workspace_id,
            description: row.description ?? '',
            // Just created, so this is a fact rather than a query.
            documentCount: 0,
            createdAt: row.created_at.toISOString(),
          },
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
  /**
   * Paginated, and the page may be short.
   *
   * Which grants a caller may see is decided by `referenceAllows` against the
   * scope tree, which SQL cannot express — so rows are fetched by cursor and
   * filtered afterwards. That makes `items.length < limit` normal rather than a
   * signal, and `next_cursor` the only thing that says whether more exist.
   *
   * The cursor comes from the last row **fetched**, not the last returned.
   * Deriving it from the last returned row would skip everything the filter
   * removed after it, which is a page of grants silently missing from an
   * administrator's view of who can reach what.
   */
  async list(auth: AuthContext, page?: Page): Promise<PageResult<GrantRecord>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const context = await contextFor(client, auth)
        const plan = resolve(context, 'admin')
        if (plan.kind === 'none') return { items: [], nextCursor: null }

        const after = page?.after
        const seek =
          after === undefined ? '' : ' AND (created_at, id) > ($2::timestamptz, $3::uuid)'
        const cap = page === undefined ? '' : ` LIMIT ${page.limit}`

        const { rows } = await client.query<{
          id: string
          principal_type: string
          principal_id: string
          scope_type: string
          scope_id: string
          permission: string
          effect: string
          source: string
          created_at: Date
        }>(
          `SELECT id, principal_type, principal_id, scope_type, scope_id, permission, effect, source,
                  created_at
             FROM grants WHERE org_id = $1${seek} ORDER BY created_at, id${cap}`,
          after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
        )

        const visible = rows
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

        // From the last row fetched rather than the last returned. The filter
        // above removes rows the caller may not administer, and taking the
        // cursor from a survivor would skip every row the filter dropped after
        // it — a page of grants silently missing from an administrator's view.
        const lastFetched = rows[rows.length - 1]
        const nextCursor =
          page !== undefined && rows.length >= page.limit && lastFetched !== undefined
            ? encodeCursor({ createdAt: lastFetched.created_at.toISOString(), id: lastFetched.id })
            : null

        return { items: visible, nextCursor }
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


/**
 * Reading the access log back.
 *
 * Scoped through `withOrg` like every other tenant read, so the row-level
 * policy on `audit_events` is the second line of defence behind the role check
 * in the handler. `SELECT` is the only grant the application role has on this
 * table and that stays true — nothing here writes.
 *
 * ## Newest first, and what that does to the cursor
 *
 * Every other paged collection here reads oldest-first, because a catalog is a
 * set and the order is arbitrary. A log is not: the useful end is the recent
 * one, and an auditor paging forward from the beginning of a 400-day retention
 * window to find yesterday is not a feature. So this orders
 * `(occurred_at, id) DESC` and the seek predicate is `<` rather than `>`.
 *
 * The cursor still means "everything after the last row you saw", which is the
 * same contract read in the other direction. It is worth being explicit because
 * copying the seek clause from the layers adapter — where it is `>` — would
 * produce a first page that works and a second page that silently returns the
 * beginning of the log.
 */
export class PostgresAuditReader implements AuditReader {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
  ) {}

  /**
   * Actions that record a substantive access to a document's contents.
   *
   * Withheld from `platform_admin`, per rule 2 in docs/authz.md as
   * docs/audit.md applies it to the journal. Named as a deny-list rather than
   * an allow-list of administrative actions, and that is the uncomfortable
   * direction: a new action defaults to *visible* to a platform administrator
   * rather than hidden.
   *
   * Chosen anyway, because the alternative fails worse. An allow-list means a
   * new administrative action is invisible to the operator who administers the
   * installation until someone remembers to add it — a silent gap in an
   * operational tool. This way a new *access* action is visible until someone
   * adds it here, which is a disclosure to an already highly-privileged role
   * within one installation. Both are bugs; only one of them is quiet.
   *
   * The `audit-event` skill's checklist is where this list is kept in step.
   */
  private static readonly DOCUMENT_ACCESS = ['search', 'document.read', 'document.get', 'chunk.read']

  async read(auth: AuthContext, query: AuditQuery, page: Page): Promise<PageResult<AuditRecord>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const where: string[] = ['org_id = $1']
        const params: unknown[] = [auth.orgId]
        const bind = (value: unknown): string => {
          params.push(value)
          return `$${params.length}`
        }

        if (query.from !== undefined) where.push(`occurred_at >= ${bind(query.from)}::timestamptz`)
        if (query.to !== undefined) where.push(`occurred_at < ${bind(query.to)}::timestamptz`)
        if (query.actorId !== undefined) where.push(`actor_id = ${bind(query.actorId)}::uuid`)
        if (query.action !== undefined) where.push(`action = ${bind(query.action)}`)
        if (query.result !== undefined) where.push(`result = ${bind(query.result)}`)
        if (query.administrativeOnly === true) {
          where.push(`action <> ALL(${bind(PostgresAuditReader.DOCUMENT_ACCESS)}::text[])`)
        }

        // Descending, and `<` to match. See the note on the class.
        if (page.after !== undefined) {
          where.push(
            `(occurred_at, id) < (${bind(page.after.createdAt)}::timestamptz, ${bind(page.after.id)}::bigint)`,
          )
        }

        // One more than asked for, so "is there another page" is answered
        // without a second query and without a count — a count over a
        // retention window is the expensive thing this endpoint must not do on
        // every request.
        const { rows } = await client.query<AuditRow>(
          `SELECT id::text, occurred_at, actor_type, actor_id, actor_label, action,
                  surface, client, target, result, detail, request_id
             FROM audit_events
            WHERE ${where.join(' AND ')}
            ORDER BY occurred_at DESC, id DESC
            LIMIT ${page.limit + 1}`,
          params,
        )

        const items = rows.slice(0, page.limit).map(
          (r): AuditRecord => ({
            id: r.id,
            occurredAt: r.occurred_at.toISOString(),
            actorType: r.actor_type,
            actorId: r.actor_id,
            actorLabel: r.actor_label,
            action: r.action,
            surface: r.surface,
            client: r.client,
            target: r.target ?? {},
            result: r.result,
            detail: r.detail ?? {},
            requestId: r.request_id,
          }),
        )

        const last = items[items.length - 1]
        const nextCursor =
          rows.length > page.limit && last !== undefined
            ? encodeCursor({ createdAt: last.occurredAt, id: last.id })
            : null

        return { items, nextCursor }
      },
      this.scopeFor(),
    )
  }

  private scopeFor(): { role?: string } {
    return this.role === undefined ? {} : { role: this.role }
  }
}

interface AuditRow {
  readonly id: string
  readonly occurred_at: Date
  readonly actor_type: string
  readonly actor_id: string | null
  readonly actor_label: string
  readonly action: string
  readonly surface: string
  readonly client: string | null
  readonly target: Record<string, unknown> | null
  readonly result: string
  readonly detail: Record<string, unknown> | null
  readonly request_id: string | null
}

/**
 * Starting a reindex, and reporting on one.
 *
 * The work is the worker's. This writes the intent — `layers.reindex_state` —
 * counts what there is to do, and declares the new named vector on the
 * collection.
 *
 * That last part belongs here and an earlier version of this comment said the
 * opposite: that Qdrant creates a named vector when a point is first written
 * with it, so the worker's first batch would bring it into existence. It does
 * not. `updateVectors` against an undeclared name answers
 * `Not existing vector name error`, and the reindex that assumed otherwise
 * started cleanly, reported `running`, and failed every document forever with
 * the progress gauge sitting at zero — which is step 1 of the sequence in
 * docs/architecture.md being skipped, and the document has it first for a
 * reason.
 *
 * Doing it here rather than in the worker also puts the failure where somebody
 * is looking: an operator who cannot create the vector finds out from the
 * response to their own request, not by watching a counter not move.
 */
export class PostgresReindex implements Reindex {
  constructor(
    private readonly pool: Pool,
    private readonly vectors: { vectorsOf(collection: string): Promise<Record<string, number>> },
    private readonly role?: string,
  ) {}

  private get scope(): { role?: string } {
    return this.role === undefined ? {} : { role: this.role }
  }

  async start(
    auth: AuthContext,
    layerId: string,
    providerId: string,
  ): Promise<ReindexOutcome | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<ReindexOutcome | undefined> => {
        // Administering a layer, not reading it. A reindex rewrites every
        // vector in the layer and changes which model answers every future
        // query — `read` is nowhere near enough, and `write` is about putting
        // documents in rather than about the layer itself.
        const plan = resolve(await contextFor(client, auth), 'admin')
        if (plan.kind === 'none') return undefined

        // Locked for the whole decision. Two starts arriving together would
        // both read "no reindex running" and both write a state, and the loser
        // would leave a shadow vector nothing is filling.
        const { rows: layers } = await client.query<{
          id: string
          vector_name: string
          reindex_state: unknown
        }>(
          `SELECT id, vector_name, reindex_state FROM layers
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL
            FOR UPDATE`,
          [auth.orgId, layerId],
        )
        const layer = layers[0]
        if (layer === undefined) return undefined
        if (plan.kind === 'scoped' && !plan.layers.includes(layer.id)) return undefined

        const running = fromStateJson(layer.reindex_state)
        if (running?.status === 'running') {
          // The live remaining count, not zero. A caller who collides with a
          // running reindex is asking "how far has it got" as much as "why was
          // I refused", and the answer they get should be the same one `GET`
          // gives — not a placeholder that reads as finished.
          const remaining = await this.remaining(client, auth.orgId, layerId, running.shadowVector)
          return {
            kind: 'conflict',
            status: this.statusOf(layerId, layer.vector_name, running, remaining),
          }
        }

        // The provider may be the organization's own or the installation-wide
        // default, which is the one row with a NULL org_id. Same rule the
        // policy on that table encodes; repeated here because a caller naming
        // another tenant's provider must get "no such provider" rather than a
        // reindex onto a model they cannot reach.
        const { rows: providers } = await client.query<{ model: string; dimensions: number }>(
          `SELECT model, dimensions FROM embedding_providers
            WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`,
          [providerId, auth.orgId],
        )
        const provider = providers[0]
        if (provider === undefined) return { kind: 'unknown_provider' }

        const shadow = vectorName(provider.model, provider.dimensions)
        if (shadow === layer.vector_name) {
          return { kind: 'already_current', vectorName: shadow }
        }

        // Counted now, and it is a starting figure rather than a bound.
        // Documents ingested during the reindex have no shadow vector either,
        // so the same pass picks them up and `done` can pass `total` — which is
        // why the progress ratio is clamped rather than trusted.
        // Which half this layer starts in.
        //
        // A named vector cannot be added to a live Qdrant collection, so the
        // slot has to already exist. If the organization's collection has it —
        // because an earlier reindex made it — this layer goes straight to
        // embedding. If not, the collection has to be rebuilt with room for it
        // first, and that is org-wide work the worker does.
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return undefined

        const present = await this.vectors.vectorsOf(collection)
        const width = present[shadow]
        if (width !== undefined && width !== provider.dimensions) {
          // Same name, different width. The name is derived from model and
          // dimensions so this cannot come from the API — it means the vector
          // was made by hand, and writing 768 values into a 1024-wide slot is
          // the kind of failure that surfaces months later as bad recall.
          return { kind: 'unknown_provider' }
        }
        const phase = width === undefined ? ('copying' as const) : ('embedding' as const)

        // One copy at a time for an organization. Two layers starting reindexes
        // onto two different models would otherwise each rebuild the
        // collection, and the second would throw away the first's work along
        // with the pointer that made it live.
        if (phase === 'copying') {
          const { rows: busy } = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM layers
              WHERE org_id = $1 AND deleted_at IS NULL
                AND reindex_state ->> 'status' = 'running'
                AND reindex_state ->> 'phase' = 'copying'`,
            [auth.orgId],
          )
          if (Number(busy[0]?.n ?? 0) > 0) {
            const other = fromStateJson(layer.reindex_state) ?? {
              status: 'running' as const,
              phase: 'copying' as const,
              shadowVector: shadow,
              providerId,
              startedAt: new Date().toISOString(),
              total: 0,
              done: 0,
              failed: 0,
            }
            return { kind: 'conflict', status: this.statusOf(layerId, layer.vector_name, other, 0) }
          }
        }

        const total = await this.remaining(client, auth.orgId, layerId, shadow)

        const state: ReindexState = {
          status: 'running',
          phase,
          shadowVector: shadow,
          providerId,
          startedAt: new Date().toISOString(),
          total,
          done: 0,
          failed: 0,
        }

        await client.query(
          'UPDATE layers SET reindex_state = $3::jsonb WHERE org_id = $1 AND id = $2',
          [auth.orgId, layerId, JSON.stringify(toStateJson(state))],
        )

        // `remaining = total`: nothing has been reindexed yet, so `done` is 0.
        // Passing 0 here said `done: total, progress: 1` on the 202 — a reindex
        // reporting itself finished in the same breath as starting.
        return {
          kind: 'started',
          status: this.statusOf(layerId, layer.vector_name, state, total),
        }
      },
      this.scope,
    )
  }

  async status(auth: AuthContext, layerId: string): Promise<ReindexStatus | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<ReindexStatus | undefined> => {
        // `read` here, not `admin`. Knowing that the layer you can search is
        // being migrated is not an administrative fact — it explains why a
        // result set moved — and hiding it from someone who can already read
        // the layer buys nothing.
        const plan = resolve(await contextFor(client, auth), 'read')
        if (plan.kind === 'none') return undefined

        const { rows } = await client.query<{
          id: string
          vector_name: string
          reindex_state: unknown
        }>(
          `SELECT id, vector_name, reindex_state FROM layers
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, layerId],
        )
        const layer = rows[0]
        if (layer === undefined) return undefined
        if (plan.kind === 'scoped' && !plan.layers.includes(layer.id)) return undefined

        const state = fromStateJson(layer.reindex_state)
        if (state === undefined) return undefined

        // The live remaining count rather than a stored `done`, because the
        // worker never writes one — the number is derived, so there is nothing
        // to go stale between batches.
        const left = await this.remaining(client, auth.orgId, layerId, state.shadowVector)
        return this.statusOf(layerId, layer.vector_name, state, left)
      },
      this.scope,
    )
  }

  /**
   * Live documents in the layer that do not yet carry this vector.
   *
   * The same predicate the worker's claim uses and the same one the switch is
   * guarded by. Three places, one meaning — and if they ever disagree, the
   * switch is the one that is right, because it is the only one inside the
   * statement that performs it.
   */
  private async remaining(
    client: PoolClient,
    orgId: string,
    layerId: string,
    shadowVector: string,
  ): Promise<number> {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents
        WHERE org_id = $1 AND layer_id = $2 AND deleted_at IS NULL AND chunk_count > 0
          AND reindexed_vector IS DISTINCT FROM $3`,
      [orgId, layerId, shadowVector],
    )
    return Number(rows[0]?.n ?? 0)
  }

  private statusOf(
    layerId: string,
    currentVector: string,
    state: ReindexState,
    remaining: number,
  ): ReindexStatus {
    const done = state.status === 'complete' ? state.total : Math.max(0, state.total - remaining)
    const live: ReindexState = { ...state, done }
    return {
      layerId,
      status: state.status,
      phase: state.phase,
      shadowVector: state.shadowVector,
      currentVector,
      providerId: state.providerId,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt ?? null,
      total: state.total,
      done,
      failed: state.failed,
      progress: reindexProgress(live),
      error: state.error ?? null,
    }
  }
}
