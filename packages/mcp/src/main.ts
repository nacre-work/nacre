import {
  HttpEmbedder,
  NacreSearchService,
  PostgresAudit,
  PostgresDocuments,
  type AuthContext,
} from '@nacre.work/api'
import {
  ConfigError,
  createPool,
  effectivePrincipals,
  loadGrants,
  loadScopeTree,
  loadConfig,
  PostgresGroupGraph,
  resolve,
  VectorStore,
  vectorName,
  withOrg,
} from '@nacre.work/core'

import { createMcpServer, type Layers, type ToolRunner } from './server.js'
import type { Layer } from './tools.js'

/**
 * The MCP process.
 *
 * It shares the API's authorization service rather than reimplementing it. That
 * is the whole point of the boundary in docs/mcp.md: EMA and OAuth authorize
 * the *connection*, and permission on a document is computed per call by the
 * same code the REST surface uses. Two implementations would be two places for
 * rule 6 to drift.
 */

const APP_ROLE = 'nacre_app'

function jwtKey(): Uint8Array {
  const secret = process.env.NACRE_JWT_SECRET
  if (secret === undefined || secret.length < 32) {
    throw new ConfigError([
      'NACRE_JWT_SECRET is not set, or is shorter than 32 bytes. There is no default.',
    ])
  }
  return new TextEncoder().encode(secret)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const key = jwtKey()
  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
  const embedder = new HttpEmbedder(config.embeddingEndpoint, config.embeddingModel, config.embeddingDim)

  const slugs = new Map<string, string>()
  const orgSlug = async (orgId: string): Promise<string | undefined> => {
    const cached = slugs.get(orgId)
    if (cached !== undefined) return cached
    const found = await withOrg(
      pool,
      orgId,
      async (c) =>
        (await c.query<{ slug: string }>('SELECT slug FROM organizations WHERE id = $1', [orgId])).rows[0]
          ?.slug,
      { role: APP_ROLE },
    )
    if (found !== undefined) slugs.set(orgId, found)
    return found
  }

  const search = new NacreSearchService({
    pool,
    vectors,
    embedder,
    orgSlug,
    vectorName: vectorName(config.embeddingModel, config.embeddingDim),
    role: APP_ROLE,
  })
  const documents = new PostgresDocuments(pool, APP_ROLE)
  const audit = new PostgresAudit(pool, APP_ROLE)

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
          const graph = await PostgresGroupGraph.load(client, auth.orgId)
          const principals = effectivePrincipals(auth.principal, graph)
          const grants = await loadGrants(client, auth.orgId, principals)
          const tree = await loadScopeTree(
            client,
            auth.orgId,
            grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
          )
          const plan = resolve({ orgId: auth.orgId, role: auth.role, principals, grants, tree }, 'read')
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

  const tools: ToolRunner = {
    call: async (name, args, auth) => {
      switch (name) {
        case 'search': {
          const query = args.query
          if (typeof query !== 'string' || query.length === 0) throw new Error('query is required')
          const topK = typeof args.top_k === 'number' ? args.top_k : 10
          const hits = await search.search(auth, query, topK)
          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'search',
            result: 'allow',
            detail: { surface: 'mcp', returned: hits.length },
            requestId: 'mcp',
          })
          return hits
        }
        case 'list_layers':
          return layers.forCaller(auth)
        case 'get_document': {
          const id = args.document_id
          if (typeof id !== 'string') throw new Error('document_id is required')
          const document = await documents.read(auth.orgId, id)
          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'get_document',
            result: document === undefined ? 'deny' : 'allow',
            detail: { surface: 'mcp', document_id: id },
            requestId: 'mcp',
          })
          // Undefined, not an error mentioning the id. A tool must not reveal
          // that an inaccessible object exists, and the transport turns this
          // into the same answer it gives for one that never did.
          if (document === undefined) throw new Error('not found')
          return document
        }
        default:
          throw new Error(`unknown tool: ${name}`)
      }
    },
  }

  const server = createMcpServer({
    verify: { key, issuer: config.jwtIssuer, audience: config.jwtAudience },
    layers,
    tools,
    // Discovery lives on the API host, never on the apex — static hosting there
    // intercepts /.well-known/* before the API sees it.
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', config.canonicalUrl).toString(),
  })

  const port = Number(process.env.PORT ?? 8081)
  server.listen(port, () => {
    console.log(JSON.stringify({ msg: 'mcp listening', port, env: config.env }))
  })

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }))
    server.close(() => {
      void pool.end().then(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
