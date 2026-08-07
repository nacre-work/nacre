import {
  buildFilter,
  cachedEffectivePrincipals,
  documentKey,
  effectivePrincipals,
  fromStateJson,
  loadGrants,
  loadGroupsVersion,
  loadScopeTree,
  PostgresGroupGraph,
  referenceAllows,
  reindexProgress,
  activeResolver,
  admitIngest,
  toStateJson,
  VectorStore,
  vectorName,
  withOrg,
  endpointUrl,
  type CacheStore,
  type Hit,
  type Metadata,
  type Narrowing,
  type Permission,
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
  ReferenceQueries,
  ReferenceQuery,
  AuditEvent,
  AuditQuery,
  AuditReader,
  AuditRecord,
  AuditWriter,
  Documents,
  GrantInput,
  GrantRecord,
  Grants,
  Ingest,
  IngestOutcome,
  IngestRefused,
  IngestRequest,
  Job,
  Jobs,
  Layer,
  LayerOutcome,
  DocumentView,
  Layers,
  Page,
  PageResult,
  Workspace,
  WorkspaceOutcome,
  Workspaces,
  SearchHit,
  SearchOptions,
  SearchService,
} from './server.js'
import { administers, delegatedLayers, withinDelegation, type AuthContext } from './auth.js'

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
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
    /**
     * Where a `source_url` comes from, when a deployment has object storage.
     *
     * Absent leaves the field off the response entirely, which is what every
     * deployment without a bucket should see: a document whose bytes are in
     * `documents.source_ref` has nothing to link to.
     */
    private readonly presign?: { url(key: string): string },
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
        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'read')
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
          source_type: string
          source_ref: string | null
          error: string | null
        }>(
          `SELECT d.id, d.title, d.layer_id, l.slug AS layer, d.status, d.chunk_count,
                  d.updated_at, d.metadata, d.source_type, d.source_ref, d.error
             FROM documents d
             JOIN layers l ON l.id = d.layer_id AND l.org_id = d.org_id
            WHERE d.org_id = $1 AND d.id = $2 AND d.deleted_at IS NULL`,
          [orgId, documentId],
        )
        const row = rows[0]
        if (row === undefined) return undefined

        // Outside the delegation's narrowing is invisible, on every path that
        // returns a document and not only on search. Fetching by id is exactly
        // how a narrowing gets walked around otherwise: the search would refuse
        // the layer and this would hand over the same document a request later.
        // `undefined` here becomes the 404 an unreachable document gets, which
        // is invariant 6 — the caller learns nothing about why.
        if (!withinDelegation(auth, row.layer_id, 'read')) return undefined

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
          // Why it failed, which the worker has always written and nothing has
          // ever read back. An operator with five failed documents and this
          // field empty has one route left, and it is `docker logs` — so the
          // answer was reachable only by whoever holds the host.
          //
          // Only on `failed`. The column keeps the last error across a retry
          // that succeeded, and reporting that beside `indexed` would describe
          // a document that is fine as a document with a problem.
          error: row.status === 'failed' ? row.error : null,
          // Minted here and nowhere earlier: everything above this line is the
          // permission check, so a link exists only for a caller who has just
          // been found to hold `read` on this document. `write` alone does not
          // reach here — rule 6 — and neither does a denied document.
          //
          // Only for `s3`. An `inline` document has no object, and a `url` one
          // is somebody else's address that this system has no business
          // signing.
          ...(this.presign !== undefined && row.source_type === 's3' && row.source_ref !== null
            ? { source_url: this.presign.url(row.source_ref) }
            : {}),
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

        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'write')
        if (plan.kind === 'none') return false

        const { rows } = await client.query<{ layer_id: string }>(
          `SELECT layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, documentId],
        )
        const layerId = rows[0]?.layer_id
        if (layerId === undefined) return false

        // The narrowing, same as everywhere a layer id and a document meet.
        if (!withinDelegation(auth, layerId, 'write')) return false

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
  /** See `principalsFor`. Absent means recompute the closure every time. */
  readonly principalsCache?: PrincipalsCache
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

        const principals = await principalsFor(client, auth, this.deps.principalsCache)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(
          client,
          auth.orgId,
          grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
        )
        const plan = activeResolver().resolve(
          { orgId: auth.orgId, role: auth.role, principals, grants, tree, ...ceilingOf(auth) },
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

    // The delegation's own narrowing, intersected last so nothing a caller
    // sends can widen it.
    //
    // Applied here rather than to the plan, and **not** intersected with
    // `plan.layers` on the way in: a document-scoped grant reaches a document in
    // a layer the plan does not list, and the person who narrowed this
    // delegation to layer L meant that document too if it is in L. As a `must`
    // beside the permission constraint the index answers that exactly, which is
    // also why this is not a post-filter — invariant 2 holds because the clause
    // is inside the traversal and `top_k` still returns k permitted results.
    // `read`, because this is the search path and there is no other verb it
    // could be asking about. A layer the person gave the application `write`
    // and not `read` is absent from this set, which is exactly rule 6: an
    // ingest-only layer is not searchable, and it never was for a principal
    // holding `write` alone either.
    const delegated = delegatedLayers(auth, 'read')
    if (delegated !== undefined) {
      const both = narrow?.layers === undefined ? [...delegated] : narrow.layers.filter((id) => delegated.includes(id))
      // The caller named layers and none of them survive the narrowing. Empty,
      // with no query and no error naming a layer — a delegation must not be a
      // way to learn which layers its user can reach.
      if (both.length === 0) return []
      narrow = { ...narrow, layers: both }
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
export class PostgresAudit implements AuditWriter {
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

    // Forwarding to a module's sinks is deliberately *not* here. It is
    // `withAuditSinks`, applied to whatever port a surface was handed, because
    // a sink wants every recorded event and not every event this adapter
    // happened to record.
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
    const response = await fetch(endpointUrl(this.endpoint, 'embeddings'), {
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
  /** See `principalsFor`. Absent means recompute the closure every time. */
  readonly principalsCache?: PrincipalsCache
  /**
   * What takes a document out of results. Narrower than `VectorStore` on
   * purpose: the delete path has no business searching, and a port that could
   * would let a later change reach the index without a plan.
   */
  readonly tombstone: DocumentTombstone
  /**
   * Where document bytes go, when a deployment has object storage.
   *
   * Absent is the supported default and not a degraded mode: bytes then live in
   * `documents.source_ref`, which is what every deployment did before this. The
   * difference is what a Postgres dump weighs — with this set it holds
   * references, without it, every document in full.
   */
  readonly objects?: ObjectStore
  readonly role?: string
}

export interface ObjectStore {
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>
  remove(key: string): Promise<void>
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
    const principals = await principalsFor(client, auth, this.deps.principalsCache)
    const grants = await loadGrants(client, auth.orgId, principals)
    const tree = await loadScopeTree(
      client,
      auth.orgId,
      grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
    )
    const plan = activeResolver().resolve(
      { orgId: auth.orgId, role: auth.role, principals, grants, tree, ...ceilingOf(auth) },
      'write',
    )
    if (plan.kind === 'none') return undefined

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM layers WHERE org_id = $1 AND slug = $2 AND deleted_at IS NULL`,
      [auth.orgId, layerSlug],
    )
    const id = rows[0]?.id
    if (id === undefined) return undefined

    // Outside the delegation's narrowing is the same answer as not writable.
    // "The narrowing narrows scopes, never verbs" cuts both ways: a person who
    // restricted an application to one layer restricted what it can *put*
    // there too, and an ingest is the one verb where the layer arrives named
    // rather than being discovered by a query.
    if (!withinDelegation(auth, id, 'write')) return undefined

    // A layer that exists but is not writable and a layer that does not exist
    // return the same thing, so the caller cannot tell them apart.
    if (plan.kind === 'all') return id
    return plan.layers.includes(id) ? id : undefined
  }

  async queue(auth: AuthContext, request: IngestRequest): Promise<IngestOutcome | IngestRefused | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const layerId = await this.writableLayer(client, auth, request.layer)
        if (layerId === undefined) return undefined

        const inline = request.content !== undefined
        const binary = request.bytes !== undefined
        if (binary && this.deps.objects === undefined) {
          // The handler refuses this at the edge, naming NACRE_S3_*; reaching
          // here means a second surface started passing bytes without the
          // check. Refusing keeps the invariant local: the bytes' only home is
          // the bucket, and there is no bucket.
          throw new Error('binary ingest requires object storage, and this deployment has none')
        }
        const source = binary ? undefined : inline ? (request.content as string) : (request.url as string)

        // For a binary source the hash is over the uploaded bytes — the worker
        // computes the same, so the upsert's idempotency semantics hold across
        // both halves: re-sending the same file is a no-op, a changed file
        // re-indexes. For text it stays over the text, which is the same
        // statement.
        const hash = binary
          ? createHash('sha256').update(request.bytes as Uint8Array).digest('hex')
          : createHash('sha256').update(source as string, 'utf8').digest('hex')

        // A module's ingest gate, after write is established and before anything
        // is stored, so a refusal leaves neither a row nor an object behind. No
        // gate registered is the open core admitting every document a caller may
        // write, which is what it did before this point existed. A refusal
        // becomes the handler's 4xx; it is not `undefined`, because that would
        // read as "unwritable" and hide the layer the caller just wrote against.
        const refusal = await admitIngest({
          orgId: auth.orgId,
          layerId,
          principal: auth.principal,
          role: auth.role,
          externalId: request.externalId,
          bytes: binary
            ? (request.bytes as Uint8Array).byteLength
            : new TextEncoder().encode(source as string).byteLength,
        })
        if (refusal !== undefined) {
          return { refused: true, status: refusal.status, reason: refusal.reason }
        }

        // Bytes to object storage before the row, never after.
        //
        // The reverse fails unrecoverably, which is the same argument the
        // delete path is ordered by: a row that names an object which was never
        // written is a document the worker fails on every attempt, forever,
        // with the API having answered `queued`. A PUT with no row is a stray
        // object at a deterministic key that the next ingest overwrites.
        //
        // Only for inline content. A `url` document is a reference already, and
        // copying somebody else's URL into our bucket at ingest time would be
        // a fetch on the request path — which is exactly what the worker does
        // later, with a timeout and a sandbox.
        let sourceType: 'inline' | 'url' | 's3' = binary ? 's3' : inline ? 'inline' : 'url'
        let sourceRef = source as string
        if (binary) {
          // A binary source has exactly one home. The bytes go up with their
          // real Content-Type, so a presigned GET later answers with the type
          // the caller sent rather than a lie a browser would act on.
          const key = documentKey(auth.orgId, layerId, request.externalId)
          await (this.deps.objects as ObjectStore).put(
            key,
            request.bytes as Uint8Array,
            request.contentType as string,
          )
          sourceRef = key
        } else if (inline && this.deps.objects !== undefined) {
          const key = documentKey(auth.orgId, layerId, request.externalId)
          await this.deps.objects.put(key, new TextEncoder().encode(source as string), 'text/plain')
          sourceType = 's3'
          sourceRef = key
        }

        const { rows } = await client.query<{ id: string; content_hash: string; status: string }>(
          `INSERT INTO documents
             (org_id, layer_id, external_id, source_type, source_ref, title, content_hash, metadata, content_type, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')
           ON CONFLICT (layer_id, external_id) DO UPDATE SET
             -- Only touch the row when the content actually changed. A repeat
             -- with the same bytes must not re-queue work: every client that
             -- times out retries, and re-embedding is what that costs.
             source_ref   = CASE WHEN documents.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                                 THEN EXCLUDED.source_ref ELSE documents.source_ref END,
             title        = COALESCE(EXCLUDED.title, documents.title),
             content_hash = EXCLUDED.content_hash,
             metadata     = EXCLUDED.metadata,
             -- The worker dispatches on this. A document re-sent as a different
             -- format carries a different hash too, so the status CASE below
             -- already re-queues it; this just keeps the row telling the truth.
             content_type = EXCLUDED.content_type,
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
            sourceRef,
            request.title ?? null,
            `sha256:${hash}`,
            JSON.stringify(request.metadata),
            binary ? (request.contentType as string) : 'text/plain',
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

        const principals = await principalsFor(client, auth, this.deps.principalsCache)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(client, auth.orgId, [documentId])
        const plan = activeResolver().resolve(
          { orgId: auth.orgId, role: auth.role, principals, grants, tree, ...ceilingOf(auth) },
          'write',
        )
        if (plan.kind === 'none') return false

        const { rows } = await client.query<{ layer_id: string }>(
          `SELECT layer_id FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, documentId],
        )
        const layerId = rows[0]?.layer_id
        if (layerId === undefined) return false
        // The narrowing. A delegation restricted to one layer must not be able
        // to delete out of another, and this is a `write` path so rule 6 does
        // not help: the person's own `read` never came into it.
        if (!withinDelegation(auth, layerId, 'write')) return false
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
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
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
        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'read')
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

/**
 * Where the effective-principals cache is consulted, and the only place.
 *
 * `NACRE_ACL_CACHE_TTL` was validated at startup and read by nothing: the cache
 * in `packages/core/authz/cache.ts` was written, tested and never called, so
 * every request recomputed the transitive group closure. `docs/authz.md` went
 * further and described the cache as the reason T11 is satisfied *more strongly*
 * than specified — a claim about a code path that did not run.
 *
 * The safety of caching a permission input at all rests on one property, and it
 * is structural rather than temporal: **the key carries
 * `organizations.groups_version`**, which database triggers bump on every change
 * to `groups`, `group_members` and `grants`. A revoked grant is not served
 * stale, it is not served at all — the next request composes a different key.
 * Checked against a running database rather than read: create a group, add a
 * member, remove one, grant, revoke, delete the group; the version moved for
 * every one.
 *
 * So the TTL is a memory bound. It is not what makes revocation take effect,
 * and lowering it does not make anything safer.
 *
 * Absent cache means compute it. That is the pre-existing behaviour and it is
 * the slow direction, never the permissive one — which is also why
 * `cachedEffectivePrincipals` may swallow a Redis failure without touching
 * invariant I3: the fallback computes the same answer from the same rows.
 */
export interface PrincipalsCache {
  readonly store: CacheStore
  readonly ttlSeconds: number
}

async function principalsFor(
  client: import('pg').PoolClient,
  auth: AuthContext,
  cache: PrincipalsCache | undefined,
): Promise<ReadonlySet<import('@nacre.work/core').PrincipalRef>> {
  if (cache === undefined) {
    return effectivePrincipals(auth.principal, await PostgresGroupGraph.load(client, auth.orgId))
  }

  // In the same transaction as the grants that follow, so the key and the grant
  // set describe one instant. Read separately, there is a window where the
  // version says "fresh" about a set loaded before a change.
  const groupsVersion = await loadGroupsVersion(client, auth.orgId)
  return cachedEffectivePrincipals(
    {
      orgId: auth.orgId,
      principal: auth.principal,
      groupsVersion,
      ttlSeconds: cache.ttlSeconds,
    },
    cache.store,
    () => PostgresGroupGraph.load(client, auth.orgId),
  )
}

/** The per-request permission context, loaded once and asked several questions. */
async function contextFor(
  client: import('pg').PoolClient,
  auth: AuthContext,
  cache?: PrincipalsCache,
): Promise<{
  orgId: string
  role: AuthContext['role']
  principals: ReadonlySet<import('@nacre.work/core').PrincipalRef>
  grants: readonly import('@nacre.work/core').Grant[]
  tree: import('@nacre.work/core').ScopeTree
  ceiling?: readonly import('@nacre.work/core').Permission[]
}> {
  const principals = await principalsFor(client, auth, cache)
  const grants = await loadGrants(client, auth.orgId, principals)
  const tree = await loadScopeTree(
    client,
    auth.orgId,
    grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
  )
  return { orgId: auth.orgId, role: auth.role, principals, grants, tree, ...ceilingOf(auth) }
}

/**
 * The delegation's permission ceiling, in the shape `ResolveInput` takes it.
 *
 * One function so the three places that build a resolve input cannot disagree,
 * and so adding a fourth is a compile error rather than a silently unbounded
 * token. `resolve` applies it before rule 3, which is the part that matters:
 * an `org_admin` reaches everything by role and by no grant at all, so a
 * ceiling consulted after that line would not bound the one principal it
 * exists for.
 */
function ceilingOf(auth: AuthContext): { ceiling?: readonly import('@nacre.work/core').Permission[] } {
  const ceiling = auth.delegation?.permissions
  return ceiling === undefined ? {} : { ceiling }
}

interface LayerRow {
  id: string
  slug: string
  name: string
  workspace_id: string
  description: string | null
  document_count: string
  failed_count: string
  created_at: Date
  /** Full precision, for the cursor. See `Position.createdAt`. */
  created_at_text: string
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
    private readonly vectors: {
      vectorsOf(collection: string): Promise<Record<string, number>>
      /** Deleting a layer needs its points to stop matching; see `remove`. */
      tombstoneLayer(collection: string, layerId: string): Promise<void>
    },
    private readonly role?: string,
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
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
        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'read')
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
        // `created_at::text` beside `created_at`, and the cursor is built from
        // it. See `Position.createdAt` — a timestamp that has been through a
        // JavaScript `Date` is truncated to milliseconds, and a truncated bound
        // matches the row it came from all over again.
        const projection = `l.id, l.slug, l.name, l.workspace_id, l.description, l.created_at,
              l.created_at::text AS created_at_text,
              (SELECT count(*) FROM documents d
                WHERE d.layer_id = l.id AND d.deleted_at IS NULL) AS document_count,
              (SELECT count(*) FROM documents d
                WHERE d.layer_id = l.id AND d.deleted_at IS NULL
                  AND d.status = 'failed') AS failed_count`

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
          failedCount: Number(r.failed_count),
          createdAt: r.created_at.toISOString(),
        }))

        return pageOf(layers, page, (l, i) => ({
          createdAt: (rows[i] as LayerRow).created_at_text,
          id: l.id,
        }))
      },
      this.scope,
    )
  }

  async update(
    auth: AuthContext,
    layerId: string,
    input: { name?: string; description?: string },
  ): Promise<boolean> {
    return updateLayer(this.pool, auth, layerId, input, this.role, this.principalsCache)
  }

  async remove(auth: AuthContext, layerId: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(layerId)) return false

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // The collection from the column that owns it, in the same transaction
        // as the check — the same reason the document delete reads it here
        // rather than deriving `org_${slug}`. A tombstone we cannot mirror into
        // the index is a layer that stays searchable while the API says it is
        // gone.
        const { rows: orgs } = await client.query<{ vector_collection: string }>(
          'SELECT vector_collection FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [auth.orgId],
        )
        const collection = orgs[0]?.vector_collection
        if (collection === undefined) return false

        const context = await contextFor(client, auth, this.principalsCache)

        const { rows } = await client.query<{ workspace_id: string }>(
          `SELECT workspace_id FROM layers
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, layerId],
        )
        const workspaceId = rows[0]?.workspace_id
        if (workspaceId === undefined) return false

        // Admin on the workspace, exactly as renaming asks. Checked after the
        // lookup so a caller who may not administer it gets the same answer
        // whether or not the layer exists.
        if (!referenceAllows(context, { type: 'workspace', id: workspaceId }, 'admin')) return false

        // The index first, then the rows — the same order the document delete
        // uses and for the same reason. One `setPayload` filtered on layer_id,
        // not a loop: a layer holds an unbounded number of documents, and a
        // per-document round trip would put that count on the request and
        // leave a half-invisible layer if it failed partway.
        await this.vectors.tombstoneLayer(collection, layerId)

        // Every document row, so the collector has its queue — it claims on
        // `documents.deleted_at`, which is what turns this into reclaimed
        // points and reclaimed bucket objects later. One statement.
        await client.query(
          `UPDATE documents SET deleted_at = now(), updated_at = now()
            WHERE org_id = $1 AND layer_id = $2 AND deleted_at IS NULL`,
          [auth.orgId, layerId],
        )

        await client.query(
          `UPDATE layers SET deleted_at = now() WHERE org_id = $1 AND id = $2`,
          [auth.orgId, layerId],
        )

        // Grants naming this layer. They resolve to nothing once the scope is
        // gone, so this changes no answer — it stops `GET /v1/grants` listing
        // rows that point at something a reader cannot look up. The trigger on
        // `grants` bumps `groups_version`, so the principals cache invalidates
        // itself rather than needing to be told.
        await client.query(
          `DELETE FROM grants WHERE org_id = $1 AND scope_type = 'layer' AND scope_id = $2`,
          [auth.orgId, layerId],
        )

        return true
      },
      this.role === undefined ? {} : { role: this.role },
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
        const context = await contextFor(client, auth, this.principalsCache)

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
            // A layer created a moment ago has nothing in it to have failed.
            failedCount: 0,
            createdAt: row.created_at.toISOString(),
          },
        }
      },
      this.scope,
    )
  }
}

/**
 * Workspaces.
 *
 * The missing link in the API's own flow: creating a layer takes a
 * `workspace_id`, and until this existed the only way to have one was the line
 * `init` printed. `docs/quickstart.md` said as much — "the workspace id is the
 * one `init` printed" — so a second administrator, a client library, or anyone
 * who closed that terminal had no way forward that did not involve reading the
 * database directly.
 */
export class PostgresWorkspaces implements Workspaces {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
  ) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  /**
   * The workspaces this caller can reach, newest last, cursor-paged.
   *
   * Two ways to reach one, and the second is the reason this endpoint had to
   * exist at all:
   *
   * 1. it holds a layer the read plan reaches — the ordinary case, and the same
   *    narrowing the layer listing does;
   * 2. the caller holds a grant on the workspace itself. An **empty** workspace
   *    has no layers to be reached through, so without this an administrator
   *    who had just been granted one could not see it, and therefore could not
   *    create the first layer in it. That is the exact deadlock this endpoint
   *    is here to break.
   *
   * Filtered in memory rather than in SQL because the second rule is the
   * resolver's to answer, not a join's, and an organization has tens of
   * workspaces rather than thousands. The listing is narrowed before it is
   * paged — a page assembled first and filtered second would leak the count.
   */
  async list(auth: AuthContext, page?: Page): Promise<PageResult<Workspace>> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const context = await contextFor(client, auth, this.principalsCache)

        // No early return on `plan.kind === 'none'`, and that is the whole
        // point of this endpoint.
        //
        // `resolve` flattens a grant set to the layers it reaches, so a
        // principal whose only grant is `admin` on an **empty** workspace
        // resolves to `none` — there are no layers for it to name. Bailing out
        // here left exactly that caller unable to list the workspace they
        // administer, and therefore unable to create the first layer in it,
        // which is the deadlock this endpoint was added to break. It was
        // written that way first and caught by running it.
        const plan = activeResolver().resolve(context, 'read')

        // Seek and limit in SQL.
        //
        // Neither was here: the statement fetched every workspace in the
        // organization, ignored `page.after` entirely, and handed the whole
        // list to `pageOf` — which then answered "there is another page"
        // because the list was at least as long as the limit. So
        // `GET /v1/workspaces` returned the same complete list on every page
        // and never terminated, and a client following `next_cursor` looped
        // forever. Found by a test that walked the listing one item at a time.
        const after = page?.after
        const seek = after === undefined ? '' : ' AND (w.created_at, w.id) > ($2::timestamptz, $3::uuid)'
        // One extra, because the filter below removes rows the caller may not
        // reach: without it a page whose last row is filtered out would report
        // itself as the end of the collection.
        const cap = page === undefined ? '' : ` LIMIT ${page.limit + 1}`

        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          created_at: Date
          /** Full precision, for the cursor. See `Position.createdAt`. */
          created_at_text: string
          layer_ids: string[] | null
        }>(
          `SELECT w.id, w.slug, w.name, w.created_at, w.created_at::text AS created_at_text,
                  (SELECT array_agg(l.id) FROM layers l
                    WHERE l.workspace_id = w.id AND l.deleted_at IS NULL) AS layer_ids
             FROM workspaces w
            WHERE w.org_id = $1 AND w.deleted_at IS NULL${seek}
            ORDER BY w.created_at, w.id${cap}`,
          after === undefined ? [auth.orgId] : [auth.orgId, after.createdAt, after.id],
        )

        const reachable = rows.filter((w) => {
          if (plan.kind === 'all') return true
          if (
            plan.kind === 'scoped' &&
            (w.layer_ids ?? []).some((id) => plan.layers.includes(id))
          ) {
            return true
          }
          // The grant on the workspace itself, which `admin` satisfies for
          // `read` — invariant 6's other half, and the only thing that answers
          // for a workspace with nothing in it yet.
          return referenceAllows(context, { type: 'workspace', id: w.id }, 'read')
        })

        /**
         * What this caller holds on **this workspace**, asked per request and
         * never derived from `users.role`.
         *
         * Authority over a workspace comes from a grant placed on the workspace
         * scope, or from the role, and `referenceAllows` is the one thing that
         * answers that — the same function the filter above uses for its third
         * branch.
         *
         * The plan is deliberately *not* consulted. `resolve` flattens a grant
         * set to the layers it reaches, so a workspace grant and a grant on a
         * layer inside that workspace produce the same scoped plan: asking the
         * plan cannot tell "admin on the workspace" from "admin on one layer in
         * it", and reporting the second as the first would put "New layer" in
         * front of a principal the server refuses. That was the first shape of
         * this function, and the T-case is what caught it.
         *
         * `read` is added rather than asked, and that is the one thing here
         * taken on trust from the filter above: a row only reaches this point
         * because the caller can see the workspace — through a grant on it, or
         * through a layer inside it, or by role. Either way `read` is true.
         */
        const permissionsOn = (w: { id: string }): Permission[] => {
          const held = new Set<Permission>(['read'])
          for (const permission of ['write', 'admin'] as const) {
            if (referenceAllows(context, { type: 'workspace', id: w.id }, permission)) {
              held.add(permission)
            }
          }
          return (['read', 'write', 'admin'] as const).filter((p) => held.has(p))
        }

        const fetched = page === undefined ? rows : rows.slice(0, page.limit)
        const items = reachable
          .filter((w) => fetched.some((f) => f.id === w.id))
          .map((w) => ({
            id: w.id,
            slug: w.slug,
            name: w.name,
            layerCount: (w.layer_ids ?? []).length,
            createdAt: w.created_at.toISOString(),
            permissions: permissionsOn(w),
          }))

        // From the last row **fetched**, not the last returned — the same rule
        // the grant listing follows and for the same reason: the filter above
        // removes rows the caller may not reach, and a cursor taken from a
        // survivor would skip everything the filter dropped after it.
        //
        // Which makes a short page normal here rather than a signal, and
        // `next_cursor` the only thing that says whether more exist.
        const lastFetched = fetched[fetched.length - 1]
        const nextCursor =
          page !== undefined && rows.length > page.limit && lastFetched !== undefined
            ? encodeCursor({ createdAt: lastFetched.created_at_text, id: lastFetched.id })
            : null

        return { items, nextCursor }
      },
      this.scope,
    )
  }

  /**
   * Create a workspace. `org_admin` only.
   *
   * There is no scope above a workspace to hold a grant on — `scope_type` is
   * one of workspace, layer, document — so there is no one to ask except the
   * role. `referenceAllows` would answer this with `role === 'org_admin'` and
   * nothing else, so the check is written plainly rather than routed through a
   * resolver call that can only return one thing.
   *
   * `platform_admin` is refused along with everyone else. Rule 2: it
   * administers organizations and reads no documents, and a workspace is where
   * documents live.
   */
  async create(
    auth: AuthContext,
    input: { slug: string; name: string },
  ): Promise<WorkspaceOutcome> {
    if (!administers(auth)) return { kind: 'denied' }

    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          created_at: Date
        }>(
          `INSERT INTO workspaces (org_id, slug, name) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING
           RETURNING id, slug, name, created_at`,
          [auth.orgId, input.slug, input.name],
        )

        const row = rows[0]
        // ON CONFLICT DO NOTHING returns nothing, and by here the caller is
        // org_admin — so the only way to get here is a slug already in use.
        // 409 rather than 404, as on layer create: the caller has proved they
        // administer the organization, so this is a fact about the resource
        // rather than about what they can see.
        if (row === undefined) return { kind: 'conflict' }

        return {
          kind: 'created',
          workspace: {
            id: row.id,
            slug: row.slug,
            name: row.name,
            layerCount: 0,
            createdAt: row.created_at.toISOString(),
            // Creating one is `org_admin`, and an `org_admin` reaches
            // everything by role — so this is the whole set rather than a
            // resolve call that could only agree with the check just made.
            permissions: ['read', 'write', 'admin'],
          },
        }
      },
      this.scope,
    )
  }
}

/**
 * Rename a layer, or change what it says it is for.
 *
 * `admin` on the workspace, which is what creating one takes — the same
 * question asked of the same resolver, so the two cannot drift into "who may
 * create" and "who may rename" meaning different things.
 *
 * The description is user-facing copy: it is what the MCP tool's generated
 * description is built from, so an agent's picture of what a layer holds
 * changes with it. That is the reason it is editable at all.
 */
async function updateLayer(
  pool: Pool,
  auth: AuthContext,
  layerId: string,
  input: { name?: string; description?: string },
  role?: string,
  principalsCache?: PrincipalsCache,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(layerId)) return false
  if (input.name === undefined && input.description === undefined) return false

  return withOrg(
    pool,
    auth.orgId,
    async (client) => {
      const context = await contextFor(client, auth, principalsCache)

      // The layer's workspace, before anything is decided — the grant is on the
      // workspace, so there is nothing to ask until we know which one.
      const { rows } = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM layers
          WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [auth.orgId, layerId],
      )
      const workspaceId = rows[0]?.workspace_id
      if (workspaceId === undefined) return false

      // `referenceAllows` on the workspace rather than a flattened plan, for
      // the reason layer creation gives: the question is "may this caller
      // administer this workspace", which the reference answers directly, and
      // inferring it from the layers a plan happens to contain gets an empty
      // workspace wrong.
      if (!referenceAllows(context, { type: 'workspace', id: workspaceId }, 'admin')) return false

      // COALESCE, so an absent field is left alone rather than blanked. PATCH
      // changes what it names; a missing key is not an instruction to erase.
      await client.query(
        `UPDATE layers
            SET name        = COALESCE($3, name),
                description = COALESCE($4, description)
          WHERE org_id = $1 AND id = $2`,
        [auth.orgId, layerId, input.name ?? null, input.description ?? null],
      )
      return true
    },
    role === undefined ? {} : { role },
  )
}

export class PostgresGrants implements Grants {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
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
        const context = await contextFor(client, auth, this.principalsCache)
        const plan = activeResolver().resolve(context, 'admin')
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
          created_at_text: string
        }>(
          `SELECT id, principal_type, principal_id, scope_type, scope_id, permission, effect, source,
                  created_at, created_at::text AS created_at_text
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
            ? encodeCursor({ createdAt: lastFetched.created_at_text, id: lastFetched.id })
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
        const context = await contextFor(client, auth, this.principalsCache)

        // Admin on the scope being granted, not admin in general. Otherwise
        // anyone holding admin on one layer could grant themselves another.
        if (!referenceAllows(context, { type: input.scopeType, id: input.scopeId }, 'admin')) {
          return undefined
        }

        // And the scope has to exist in this organization, which the check
        // above does not establish. `referenceAllows` returns `true` for
        // `org_admin` on its third line — rule 3, admin on every scope
        // implicitly — and it returns *before* the scope is placed, so an
        // administrator naming any uuid at all passed.
        //
        // Not a leak, and the reason is worth stating rather than assumed: a
        // grant on a scope that is not here becomes `should: layer_id = X`
        // beside an unconditional `must: org_id = <this tenant>`, and points
        // carrying layer X belong to another tenant and live in another
        // collection. The second line of defence holds. What got written was a
        // row that permits nothing and points at nothing.
        //
        // It still has to be refused. An administrator reading `/v1/grants`
        // sees a grant they cannot explain on an id they cannot look up, and
        // `404` stops meaning what invariant 4 says it means — "no permission"
        // and "no such object" are one answer, which requires that naming a
        // nonexistent object *reaches* that answer rather than succeeding.
        //
        // Written out per table rather than assembled, so the table name can
        // never come from a caller-supplied string. `scopeType` is a checked
        // union already; this makes it structural.
        const exists = await client.query(
          input.scopeType === 'workspace'
            ? `SELECT 1 FROM workspaces WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`
            : `SELECT 1 FROM layers WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [auth.orgId, input.scopeId],
        )
        if (exists.rowCount !== 1) return undefined

        // And the principal, for the same reason and on the same argument.
        //
        // The check above was added because an `org_admin` could name any uuid
        // as a scope; the other half of the row went on accepting any uuid as a
        // principal, which produces exactly the failure that comment describes
        // and is harder to notice. A grant to a principal that is not here
        // permits nothing and can never begin to — `effectivePrincipals` walks
        // from the caller, and nobody resolves to an id that names no row — so
        // it sits in `GET /v1/grants` forever looking like access somebody has.
        //
        // The mistake it catches is not hypothetical: `principal_type` and
        // `principal_id` are two fields, and picking `user` while pasting a
        // service account's id is a row that inserts cleanly and does nothing.
        //
        // Written out per table rather than assembled, like the scope check —
        // `principalType` is a checked union and this keeps it structural.
        const principalExists = await client.query(
          input.principalType === 'user'
            ? `SELECT 1 FROM users WHERE org_id = $1 AND id = $2`
            : input.principalType === 'group'
              ? `SELECT 1 FROM groups WHERE org_id = $1 AND id = $2`
              : `SELECT 1 FROM service_accounts WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
          [auth.orgId, input.principalId],
        )
        // A revoked service account is refused rather than accepted: its key
        // stopped working and is never reissued, so a grant to it is a row that
        // can never be exercised. A *disabled* user is accepted — disabling is
        // reversible and the grant is meant to survive it.
        if (principalExists.rowCount !== 1) return undefined

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

        const context = await contextFor(client, auth, this.principalsCache)
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
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
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
          `SELECT id::text, occurred_at, occurred_at::text AS occurred_at_text,
                  actor_type, actor_id, actor_label, action,
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

        // From the row rather than from the mapped record, because the record
        // carries an ISO string and this cursor needs full precision.
        //
        // This one **skips** rather than repeats, and that is the same bug seen
        // from the other side: the ordering is descending, so a bound truncated
        // downwards excludes the row it came from *and* everything between the
        // truncated value and the real one. On a listing that would lose a page
        // of layers; on the access log it silently loses events, in the one
        // place the product promises a precise answer.
        const lastRow = rows[Math.min(page.limit, rows.length) - 1]
        const last = items[items.length - 1]
        const nextCursor =
          rows.length > page.limit && last !== undefined && lastRow !== undefined
            ? encodeCursor({ createdAt: lastRow.occurred_at_text, id: last.id })
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
  /** Full precision, for the cursor. See `Position.createdAt`. */
  readonly occurred_at_text: string
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
    /** See `principalsFor`. Absent means recompute the closure every time. */
    private readonly principalsCache?: PrincipalsCache,
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
        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'admin')
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
        const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'read')
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
      check: state.check ?? null,
    }
  }
}

/**
 * The reference query set behind the reindex recall gate.
 *
 * `admin` on the layer for both operations, and that is a decision rather than
 * a copy of the reindex adapter above. Reading the set reveals which documents
 * an operator considers the canonical answers to a query, which is a statement
 * about the layer's contents; rule 7 makes `admin` the permission that implies
 * being allowed to see them, and rule 6 means `write` does not.
 */
export class PostgresReferenceQueries implements ReferenceQueries {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
    private readonly principalsCache?: PrincipalsCache,
  ) {}

  private get scope(): { role?: string } {
    return this.role === undefined ? {} : { role: this.role }
  }

  /**
   * The layer, if this caller may administer it.
   *
   * `undefined` for a layer that is not there and for one they may not touch —
   * one answer, which the handler turns into `404`. Deleted layers are not
   * there: a reference set on a deleted layer describes nothing.
   */
  private async administrable(
    client: PoolClient,
    auth: AuthContext,
    layerId: string,
  ): Promise<boolean> {
    const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'admin')
    if (plan.kind === 'none') return false
    if (plan.kind === 'scoped' && !plan.layers.includes(layerId)) return false

    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM layers WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL',
      [auth.orgId, layerId],
    )
    return rows.length > 0
  }

  async list(auth: AuthContext, layerId: string): Promise<readonly ReferenceQuery[] | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<readonly ReferenceQuery[] | undefined> => {
        if (!(await this.administrable(client, auth, layerId))) return undefined

        const { rows } = await client.query<{ id: string; query: string; expected: string[] }>(
          `SELECT id, query, expected FROM reference_queries
            WHERE org_id = $1 AND layer_id = $2 ORDER BY ordinal`,
          [auth.orgId, layerId],
        )
        return rows.map((r) => ({ id: r.id, query: r.query, expected: r.expected }))
      },
      this.scope,
    )
  }

  async replace(
    auth: AuthContext,
    layerId: string,
    queries: readonly { query: string; expected: readonly string[] }[],
  ): Promise<readonly ReferenceQuery[] | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<readonly ReferenceQuery[] | undefined> => {
        if (!(await this.administrable(client, auth, layerId))) return undefined

        // Delete then insert, in the transaction `withOrg` already opened. A
        // set is one statement about the layer, so there is no moment at which
        // half of the old one and half of the new one are both in the table —
        // which matters because the worker reads this to decide whether a layer
        // has a gate at all.
        await client.query('DELETE FROM reference_queries WHERE org_id = $1 AND layer_id = $2', [
          auth.orgId,
          layerId,
        ])

        const inserted: ReferenceQuery[] = []
        for (const [ordinal, q] of queries.entries()) {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO reference_queries (org_id, layer_id, query, expected, ordinal)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [auth.orgId, layerId, q.query, [...q.expected], ordinal],
          )
          inserted.push({
            id: rows[0]?.id as string,
            query: q.query,
            expected: [...q.expected],
          })
        }

        // The external ids are deliberately **not** validated against
        // `documents` here. A reference set is often written before the
        // documents it names are ingested, and refusing it then would make the
        // gate impossible to set up on a new layer. The check resolves them
        // when it runs, and an entry that resolves to nothing fails the reindex
        // by name — which is the moment it actually matters.
        return inserted
      },
      this.scope,
    )
  }
}
