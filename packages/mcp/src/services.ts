import { randomUUID } from 'node:crypto'

import {
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresDocuments,
  rerankerFor,
  type AuthContext,
  type PrincipalsCache,
} from '@nacre.work/api'
import {
  createPool,
  effectivePrincipals,
  loadGrants,
  loadScopeTree,
  parseFilters,
  parseMetadata,
  PostgresGroupGraph,
  activeResolver,
  withAuditSinks,
  cachedEffectivePrincipals,
  loadGroupsVersion,
  logger,
  queryAudit,
  S3,
  VectorStore,
  withOrg,
  type Config,
} from '@nacre.work/core'
import { PostgresServiceKeys } from '@nacre.work/api'
import type { Pool } from 'pg'

import type { Layers, ToolRunner } from './server.js'
import type { Layer } from './tools.js'

/**
 * Everything behind the MCP tools, independent of how a client reached us.
 *
 * Built once and shared by both transports. Streamable HTTP and STDIO differ in
 * how a request arrives and how the caller is authenticated, and in nothing
 * else — a second copy of the tool bodies would be a second place for the
 * permission rules to drift, which is the failure docs/mcp.md is written
 * against.
 */

export const APP_ROLE = 'nacre_app'

export interface Services {
  readonly pool: Pool
  /** Resolves service account keys, which is what local mode authenticates with. */
  readonly serviceKeys: PostgresServiceKeys
  readonly layers: Layers
  readonly tools: ToolRunner
}

export function buildServices(
  config: Config,
  options: { principalsCache?: PrincipalsCache } = {},
): Services {
  const principalsCache = options.principalsCache
  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
  // The same reranker the REST surface uses. Two surfaces over one index
  // answering in different orders is the kind of difference nobody reports as
  // a bug and everybody notices.
  const reranker = rerankerFor(config)

  const search = new NacreSearchService({
    ...(principalsCache === undefined ? {} : { principalsCache }),
    pool,
    vectors,
    embedderFor: HttpEmbedder.pool(),
    role: APP_ROLE,
    ...(reranker === undefined ? {} : { reranker }),
    rerankCandidates: config.rerankCandidates,
    onRerankFailed: (error) => {
      logger.warn('reranking failed; results are in fusion order', { error: String(error).slice(0, 200) })
    },
  })
  // The same adapter the REST surface uses, so the two cannot drift on what a
  // write is allowed to do. `ingest_document` and `delete_document` were in the
  // tool catalog and in docs/mcp.md from the beginning with nothing behind them:
  // an agent listed the tools, called one, and was told it did not exist.
  // Same object storage as the API, for the same reason: MCP serves the same
  // ingest tool, and a document sent over MCP has to land where a document sent
  // over REST lands. Two surfaces disagreeing about where bytes live is the
  // shape of bug that only shows up on the transport nobody tested.
  const objects = config.s3 === undefined ? undefined : new S3(config.s3)
  const ingest = new NacreIngest({
    pool,
    ...(principalsCache === undefined ? {} : { principalsCache }),
    tombstone: vectors,
    ...(objects === undefined ? {} : { objects }),
    role: APP_ROLE,
  })

  // The same presigner as REST. `get_document` over MCP and `GET /v1/documents`
  // describe the same document, and one of them handing back a link while the
  // other does not is the two-surfaces divergence this repository keeps closing.
  const documents = new PostgresDocuments(
    pool,
    vectors,
    APP_ROLE,
    principalsCache,
    objects === undefined
      ? undefined
      : { url: (key: string) => objects.presign(key, config.presignTtl) },
  )
  // Wrapped for the same reason the API wraps its own: a module's sinks want
  // every recorded event, and this transport records its own. Without it a
  // deployment's SIEM would hold every REST search and no MCP one, which is
  // the surface the product is actually for.
  const audit = withAuditSinks(new PostgresAudit(pool, APP_ROLE), (sink, event, error) => {
    logger.warn('audit sink failed; the event is still in the table', {
      sink,
      action: event.action,
      error: String(error).slice(0, 200),
    })
  })

  /**
   * The layer catalog, per caller.
   *
   * It runs the same resolve() the search does and lists only what the plan
   * reaches. The catalog is permission data — a layer name is a fact about the
   * organization — which is why tools/list is cached per user and never
   * globally.
   */
  const layers: Layers = {
    forCaller: async (auth: AuthContext): Promise<readonly Layer[]> =>
      withOrg(
        pool,
        auth.orgId,
        async (client) => {
          // The same cache the REST surface uses, or the same recomputation
          // when there is none. Two surfaces resolving a principal differently
          // is the shape `NACRE_RATE_*` had before both shared a bucket.
          const principals =
            principalsCache === undefined
              ? effectivePrincipals(auth.principal, await PostgresGroupGraph.load(client, auth.orgId))
              : await cachedEffectivePrincipals(
                  {
                    orgId: auth.orgId,
                    principal: auth.principal,
                    groupsVersion: await loadGroupsVersion(client, auth.orgId),
                    ttlSeconds: principalsCache.ttlSeconds,
                  },
                  principalsCache.store,
                  () => PostgresGroupGraph.load(client, auth.orgId),
                )
          const grants = await loadGrants(client, auth.orgId, principals)
          const tree = await loadScopeTree(
            client,
            auth.orgId,
            grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
          )
          // Through the registry, not the built-in directly: this catalog is
          // permission data, so a module's resolver has to reach it or the
          // layer list and the search would answer from two different models.
          const plan = activeResolver().resolve(
            { orgId: auth.orgId, role: auth.role, principals, grants, tree },
            'read',
          )
          if (plan.kind === 'none') return []

          const { rows } = await client.query<{
            id: string
            slug: string
            name: string
            description: string
            documents: string
          }>(
            `SELECT l.id, l.slug, l.name, l.description,
                    (SELECT count(*) FROM documents d
                      WHERE d.layer_id = l.id AND d.deleted_at IS NULL) AS documents
               FROM layers l
              WHERE l.org_id = $1 AND l.deleted_at IS NULL
                AND ($2::boolean OR l.id = ANY($3::uuid[]))`,
            [auth.orgId, plan.kind === 'all', plan.kind === 'scoped' ? plan.layers : []],
          )

          return rows.map((r) => ({
            id: r.id,
            slug: r.slug,
            name: r.name,
            description: r.description,
            documentCount: Number(r.documents),
          }))
        },
        { role: APP_ROLE },
      ),
  }

  /**
   * The document this call is about, by id or by the caller's own identifier.
   *
   * `docs/mcp.md` has documented `{external_id, layer}` as an alternative to
   * `{document_id}` from the beginning, and both tools declared the fields and
   * then required the id — a declared parameter the server drops is worse than
   * one that was never offered.
   *
   * Resolution is not an authorization decision and must not become one: it
   * answers "which row is this" and nothing else. Every caller of it passes the
   * result to `documents.read` or `ingest.remove`, which resolve permissions
   * the same way they do for an id supplied directly. So a caller who names a
   * document they may not see gets the id resolved and then the same refusal a
   * nonexistent one gets — which is what invariant I4 asks for.
   */
  const resolveId = async (
    auth: AuthContext,
    args: Record<string, unknown>,
  ): Promise<string | undefined> => {
    if (typeof args.document_id === 'string' && args.document_id !== '') return args.document_id

    const externalId = args.external_id
    const layer = args.layer
    if (typeof externalId !== 'string' || typeof layer !== 'string') return undefined

    return withOrg(
      pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `SELECT d.id
             FROM documents d
             JOIN layers l ON l.id = d.layer_id AND l.org_id = d.org_id
            WHERE d.org_id = $1 AND d.external_id = $2 AND l.slug = $3
              AND d.deleted_at IS NULL AND l.deleted_at IS NULL`,
          [auth.orgId, externalId, layer],
        )
        return rows[0]?.id
      },
      { role: APP_ROLE },
    )
  }

  const tools: ToolRunner = {
    call: async (name, args, auth, requestId) => {
      switch (name) {
        case 'search': {
          const query = args.query
          if (typeof query !== 'string' || query.length === 0) throw new Error('query is required')
          // Clamped, like the REST surface: unbounded here reached Qdrant's
          // limit verbatim and decided how many rows to hydrate.
          const raw = args.top_k
          const topK =
            typeof raw !== 'number' || !Number.isFinite(raw)
              ? 10
              : Math.min(50, Math.max(1, Math.floor(raw)))
          // Every parameter the tool schema declares reaches the search path.
          // A declared parameter the server drops is worse than one that was
          // never offered — `layers` in particular, because a client scoping a
          // search to one layer and silently getting all of them believes it
          // narrowed the query.
          const layerSlugs = Array.isArray(args.layers)
            ? args.layers.filter((l): l is string => typeof l === 'string')
            : undefined

          // Applied, and narrowing only. `parseMetadata` is the same validator
          // the REST surface and the ingest path use, so an agent cannot filter
          // on a key that could never have been stored.
          const filters = parseFilters(args.filters)

          const hits = await search.search(auth, query, topK, {
            ...(args.rerank === false ? { rerank: false } : {}),
            ...(layerSlugs !== undefined && layerSlugs.length > 0 ? { layers: layerSlugs } : {}),
            ...(Object.keys(filters).length === 0 ? {} : { filters }),
            ...(args.include_content === false ? { includeContent: false } : {}),
          })
          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'search',
            result: 'allow',
            surface: 'mcp',
            target: {
              returned_docs: [...new Set(hits.map((h) => h.doc_id))],
              layers: [...new Set(hits.map((h) => h.layer))],
              top_k: topK,
            },
            // The same shape as the REST surface, from the same function. Two
            // doors into one authorization service must leave one journal.
            detail: {
              returned: hits.length,
              ...queryAudit(query, config.auditQueryText),
            },
            requestId,
          })
          return hits
        }
        case 'list_layers':
          return layers.forCaller(auth)
        case 'get_document': {
          const id = await resolveId(auth, args)
          if (id === undefined) throw new Error('not found')
          const document = await documents.read(auth, id)
          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'get_document',
            result: document === undefined ? 'deny' : 'allow',
            surface: 'mcp',
            target: { document_id: id },
            detail: { document_id: id },
            requestId,
          })
          // Undefined, not an error mentioning the id. A tool must not reveal
          // that an inaccessible object exists, and the transport turns this
          // into the same answer it gives for one that never did.
          if (document === undefined) throw new Error('not found')
          return document
        }
        case 'ingest_document': {
          const layer = args.layer
          if (typeof layer !== 'string' || layer === '') throw new Error('layer is required')
          const content = typeof args.content === 'string' ? args.content : undefined
          const url = typeof args.url === 'string' ? args.url : undefined
          if (content === undefined && url === undefined) {
            throw new Error('one of content or url is required')
          }

          const outcome = await ingest.queue(auth, {
            layer,
            // The schema calls this an idempotency key and does not require it.
            // Absent, the document is new every time, which is what a caller
            // who did not supply one has asked for.
            externalId: typeof args.external_id === 'string' ? args.external_id : randomUUID(),
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            ...(content === undefined ? {} : { content }),
            ...(url === undefined ? {} : { url }),
            // Advertised in the tool schema and dropped, exactly as it was on
            // the REST side. `parseMetadata` raises, and the transport turns
            // that into a tool error the agent can read and correct.
            metadata: parseMetadata(args.metadata),
          })

          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'ingest',
            result: outcome === undefined ? 'deny' : 'allow',
            surface: 'mcp',
            target: { layer, document_id: outcome?.documentId ?? null },
            detail: { layer },
            requestId,
          })

          // Undefined means the caller may not write to that layer — and it has
          // to mean the same for a layer that does not exist, or ingest becomes
          // the cheapest way to enumerate layer names.
          if (outcome === undefined) throw new Error('not found')
          return {
            document_id: outcome.documentId,
            job_id: outcome.jobId,
            status: outcome.unchanged ? 'indexed' : 'queued',
          }
        }
        case 'delete_document': {
          const id = await resolveId(auth, args)
          const removed = id === undefined ? false : await ingest.remove(auth, id)

          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'delete_document',
            result: removed ? 'allow' : 'deny',
            surface: 'mcp',
            target: { document_id: id ?? null },
            detail: { document_id: id ?? null },
            requestId,
          })

          // False for absent and for not-permitted alike, and the transport
          // turns both into the answer an unknown tool would get.
          if (!removed) throw new Error('not found')
          return { document_id: id, deleted: true }
        }
        default:
          throw new Error(`unknown tool: ${name}`)
      }
    },
  }
  return { pool, layers, tools, serviceKeys: new PostgresServiceKeys(pool, APP_ROLE) }
}
