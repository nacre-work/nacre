import { randomUUID } from 'node:crypto'

import {
  contextFor,
  delegatedLayers,
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresDocuments,
  rerankerFor,
  type AuthContext,
  type PrincipalsCache,
  PostgresJobs,
  PostgresSkills,
  decodeCursor,
  type SkillLevel,
  type SkillWrite,
} from '@nacre.work/api'
import {
  createPool,
  parseFilters,
  parseMetadata,
  readSkillZip,
  activeResolver,
  withAuditSinks,
  logger,
  queryAudit,
  S3,
  VectorStore,
  vectorStoreOptions,
  withOrg,
  type Config,
} from '@nacre.work/core'
import { postgresVerification, TICKET_TTL_SECONDS, uploadDescriptor, type UploadTicketStore } from '@nacre.work/api'
import type { Pool } from 'pg'

import { adminTools, type AdminRunner } from './admin-services.js'
import { ToolArgumentError, type Layers, type SkillSource, type ToolRunner } from './factory.js'
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

/** Literal, so `lint:audit-actions` can see that each is recorded. */
const SKILL_AUDIT = {
  updated: { action: 'skill.updated' },
  cleared: { action: 'skill.cleared' },
} as const

export interface Services {
  readonly pool: Pool
  /**
   * The database-backed halves of `VerifyOptions`: service account keys, which
   * is what local mode authenticates with, and the delegation lookup a
   * delegated token is checked against on every request.
   *
   * One object from one function rather than a field per port, so a port added
   * to a Postgres verifier arrives on both transports instead of on whichever
   * the author remembered. See the API's verification.ts.
   */
  readonly verification: ReturnType<typeof postgresVerification>
  readonly layers: Layers
  readonly tools: ToolRunner
  readonly skills: SkillSource
  /** The administrative MCP's tools. Served on Streamable HTTP only. */
  readonly admin: AdminRunner
}

/**
 * Upload tickets, as the MCP surface needs them: the store, and where a
 * ticket's URL points — the **API's** canonical origin, never this transport's,
 * because the ticket is redeemed on the API by whoever holds the bytes.
 */
export interface UploadTickets {
  readonly store: UploadTicketStore
  readonly baseUrl: string
  readonly maxBytes: number
}

/**
 * The layer catalog, per caller.
 *
 * It runs the same resolve() the search does and lists only what the plan
 * reaches. The catalog is permission data — a layer name is a fact about the
 * organization — which is why tools/list is cached per user and never
 * globally.
 *
 * Through `contextFor`, which is what puts a delegation's **ceiling** into the
 * resolve input, and narrowed by the delegation's **narrowing** before the
 * statement. It built its own input with neither, so a connection narrowed to
 * layer L was listed M too — name, description, document count — and a
 * `{write}` connection was listed every layer its person reads, while
 * `GET /v1/layers` answered the same token with the ceiling applied. Every
 * other resolve input in the product came from `contextFor`; this one was the
 * fourth copy its own comment said a compile error would catch. T40.
 *
 * Exported so the authorization suite can ask it directly, rather than
 * through a server whose other halves it would have to stub.
 */
export function layerCatalog(pool: Pool, principalsCache?: PrincipalsCache): Layers {
  return {
    forCaller: async (
      auth: AuthContext,
      page: { readonly limit: number; readonly afterId?: string },
    ): Promise<{ readonly layers: readonly Layer[]; readonly nextCursor: string | null }> =>
      withOrg(
        pool,
        auth.orgId,
        async (client) => {
          // Through the registry, not the built-in directly: this catalog is
          // permission data, so a module's resolver has to reach it or the
          // layer list and the search would answer from two different models.
          const plan = activeResolver().resolve(await contextFor(client, auth, principalsCache), 'read')
          if (plan.kind === 'none') return { layers: [], nextCursor: null }

          // The narrowing, intersected with the plan rather than applied to
          // the rows — the same arithmetic `GET /v1/layers` does, for the same
          // reason: a delegation must not be a way to learn which layers its
          // person reaches.
          const narrowing = delegatedLayers(auth, 'read')
          const ids: readonly string[] | undefined =
            narrowing === undefined
              ? plan.kind === 'all' ? undefined : plan.layers
              : plan.kind === 'all' ? narrowing : plan.layers.filter((id) => narrowing.includes(id))
          if (ids !== undefined && ids.length === 0) return { layers: [], nextCursor: null }

          // A page, ordered by id with an id seek — the same shape every REST
          // listing uses, minus the timestamp, because a catalog has no
          // recency to order by. `limit + 1` is how the page knows whether
          // there is another one without a count over the table. The per-layer
          // document count stays a correlated subquery because it is now
          // bounded by the page rather than by the organization.
          const bounded = Math.min(Math.max(1, page.limit), 500)
          const { rows } = await client.query<{
            id: string
            slug: string
            name: string
            description: string
            documents: string
            has_skill: boolean
          }>(
            `SELECT l.id, l.slug, l.name, l.description,
                    (SELECT count(*) FROM documents d
                      WHERE d.layer_id = l.id AND d.deleted_at IS NULL) AS documents,
                    -- The newest version decides: a cleared skill is no skill.
                    COALESCE((SELECT s.name IS NOT NULL FROM skill_versions s
                               WHERE s.org_id = l.org_id AND s.layer_id = l.id
                               ORDER BY s.version DESC LIMIT 1), false) AS has_skill
               FROM layers l
              WHERE l.org_id = $1 AND l.deleted_at IS NULL
                AND ($2::uuid[] IS NULL OR l.id = ANY($2::uuid[]))
                AND ($3::uuid IS NULL OR l.id > $3::uuid)
              ORDER BY l.id
              LIMIT $4`,
            [auth.orgId, ids === undefined ? null : [...ids], page.afterId ?? null, bounded + 1],
          )

          const slice = rows.slice(0, bounded)
          const last = slice[slice.length - 1]
          return {
            layers: slice.map((r) => ({
              id: r.id,
              slug: r.slug,
              name: r.name,
              description: r.description,
              documentCount: Number(r.documents),
              hasSkill: r.has_skill,
            })),
            nextCursor: rows.length > bounded && last !== undefined ? last.id : null,
          }
        },
        { role: APP_ROLE },
      ),
  }
}

export function buildServices(
  config: Config,
  options: { principalsCache?: PrincipalsCache; uploads?: UploadTickets } = {},
): Services {
  const principalsCache = options.principalsCache
  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(vectorStoreOptions(config))
  // The same reranker the REST surface uses. Two surfaces over one index
  // answering in different orders is the kind of difference nobody reports as
  // a bug and everybody notices.
  const reranker = rerankerFor(config)

  const search = new NacreSearchService({
    ...(principalsCache === undefined ? {} : { principalsCache }),
    pool,
    vectors,
    embedderFor: HttpEmbedder.pool(undefined, config.embedBatch, config.embedAllowedHosts),
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

  // The same reader the REST job endpoint uses, for the same reason as the
  // presigner below: an agent asking what became of its ingest and an operator
  // asking through REST must not get two different answers about one document.
  const jobs = new PostgresJobs(pool, APP_ROLE, principalsCache)

  // The same port the REST surface uses, so "who sees which skill" has one
  // answer across both doors. docs/skills.md.
  const skills = new PostgresSkills(pool, APP_ROLE, principalsCache)

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

  const layers = layerCatalog(pool, principalsCache)

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
        case 'list_layers': {
          // The page the caller asked for, bounded. A cursor that is not a
          // uuid is refused rather than cast blind — the postgres cast error
          // would be a 500 wearing somebody else's message.
          const limit =
            typeof args.limit === 'number' && Number.isInteger(args.limit)
              ? Math.min(Math.max(1, args.limit), 500)
              : 100
          const cursor = typeof args.cursor === 'string' && args.cursor !== '' ? args.cursor : undefined
          if (cursor !== undefined && !/^[0-9a-f-]{36}$/i.test(cursor)) {
            throw new Error('cursor is not one this tool issued; start again without one')
          }
          const page = await layers.forCaller(auth, {
            limit,
            ...(cursor === undefined ? {} : { afterId: cursor }),
          })
          return { layers: page.layers, next_cursor: page.nextCursor }
        }
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

          // Undefined means the caller may not write to that layer — and it has
          // to mean the same for a layer that does not exist, or ingest becomes
          // the cheapest way to enumerate layer names. A refusal is a module's
          // ingest gate declining a document the caller may write — the same
          // gate the REST surface runs, because it lives in the shared queue, so
          // a quota holds whichever port a document arrives on.
          if (outcome === undefined) {
            await audit.write({
              orgId: auth.orgId,
              actor: `${auth.principal.type}:${auth.principal.id}`,
              action: 'ingest',
              result: 'deny',
              surface: 'mcp',
              target: { layer, document_id: null },
              detail: { layer },
              requestId,
            })
            throw new Error('not found')
          }
          if ('refused' in outcome) {
            await audit.write({
              orgId: auth.orgId,
              actor: `${auth.principal.type}:${auth.principal.id}`,
              action: 'ingest',
              result: 'deny',
              surface: 'mcp',
              target: { layer, document_id: null },
              detail: { layer, reason: outcome.reason },
              requestId,
            })
            throw new Error(outcome.reason)
          }

          await audit.write({
            orgId: auth.orgId,
            actor: `${auth.principal.type}:${auth.principal.id}`,
            action: 'ingest',
            result: 'allow',
            surface: 'mcp',
            target: { layer, document_id: outcome.documentId },
            detail: { layer },
            requestId,
          })
          return {
            document_id: outcome.documentId,
            job_id: outcome.jobId,
            status: outcome.unchanged ? 'indexed' : 'queued',
          }
        }
        case 'upload_file': {
          // The host renders the panel; the model gets a sentence. A layer
          // that is not writable is not refused here — the panel lists what
          // the person may write to, and the ticket refuses the rest.
          return {
            opened: true,
            note:
              'The upload panel is open in the conversation. The person picks the file there; ' +
              'the outcome arrives as context when the upload settles.',
          }
        }
        case 'request_upload': {
          const layer = args.layer
          if (typeof layer !== 'string' || layer === '') throw new Error('layer is required')
          // Absent on STDIO, where there is no Redis: the tool is in the
          // catalog and answers as a tool that cannot do its job here.
          const uploads = options.uploads
          if (uploads === undefined) throw new Error('upload tickets are not available on this transport')
          // Validated now, so a ticket never carries tags the upload would
          // refuse minutes later with nobody there to read the refusal.
          const metadata = parseMetadata(args.metadata)
          // The same write check `ingest_document` makes, with the same
          // answer for a layer the caller may not write to and one that does
          // not exist: a ticket tool that said "not writable" would be a
          // layer-name oracle reachable with no document at all.
          if (!(await ingest.writable(auth, layer))) {
            await audit.write({
              orgId: auth.orgId,
              actor: `${auth.principal.type}:${auth.principal.id}`,
              action: 'ingest',
              result: 'deny',
              surface: 'mcp',
              target: { layer, document_id: null },
              detail: { layer, ticket: 'refused' },
              requestId,
            })
            throw new Error('not found')
          }
          const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS
          const ticket = await uploads.store.mint({
            auth,
            layer,
            ...(typeof args.external_id === 'string' ? { externalId: args.external_id } : {}),
            ...(typeof args.title === 'string' ? { title: args.title } : {}),
            metadata,
            expiresAt,
          })
          return uploadDescriptor(ticket, expiresAt, uploads.baseUrl, uploads.maxBytes)
        }
        case 'ingest_status': {
          const jobId = args.job_id
          if (typeof jobId !== 'string' || jobId === '') throw new Error('job_id is required')

          // Absent, another organization's, and one this caller reaches by
          // neither `read` nor `write` all answer the same way — a job names a
          // document, so it is exactly as much of an oracle as the document is.
          const job = await jobs.read(auth, jobId)
          if (job === undefined) throw new Error('not found')

          return {
            job_id: job.jobId,
            document_id: job.documentId,
            status: job.status,
            chunk_count: job.chunkCount,
            ...(job.reason === undefined ? {} : { reason: job.reason }),
            ...(job.error === undefined ? {} : { error: job.error }),
          }
        }
        case 'list_skills': {
          const limit =
            typeof args.limit === 'number' && Number.isInteger(args.limit) ? Math.min(Math.max(1, args.limit), 200) : 50
          const raw = typeof args.cursor === 'string' && args.cursor !== '' ? args.cursor : undefined
          const after = raw === undefined ? undefined : decodeCursor(raw, 'uuid')
          if (raw !== undefined && after === undefined) {
            throw new ToolArgumentError('cursor is not one this tool issued; start again without one')
          }
          const listed = await skills.list(auth, { limit, after })
          return { base: listed.base, layers: listed.layers.items, next_cursor: listed.layers.nextCursor }
        }
        case 'get_skill': {
          const which = args.skill
          if (typeof which !== 'string' || which === '') throw new ToolArgumentError('skill is required')
          const path = typeof args.path === 'string' && args.path !== '' ? args.path : 'SKILL.md'
          // "base", or a layer the caller sees. A layer they cannot see and one
          // without a skill answer the same, or this is a layer-name oracle.
          const found =
            which === 'base'
              ? await skills.base(auth)
              : await (async () => {
                  const layerId = await skills.layerBySlug(auth, which)
                  if (layerId === undefined) return undefined
                  const current = await skills.current(auth, { kind: 'layer', layerId })
                  if (current === undefined) return undefined
                  // Whether this caller may write it, answered the way the
                  // console answers it: the history is shown to whoever may
                  // write the level and to nobody else. The panel offers a
                  // load only where this says so, rather than drawing a
                  // control the server would refuse.
                  const history = await skills.versions(auth, { kind: 'layer', layerId }, { limit: 1, after: undefined })
                  return {
                    level: 'layer' as const,
                    name: current.name ?? '',
                    description: current.description ?? '',
                    version: current.version,
                    hasScripts: current.hasScripts,
                    files: current.files,
                    byAgent: current.byAgent,
                    writable: history !== undefined,
                  }
                })()
          if (found === undefined) throw new Error('not found')
          const content = found.files[path]
          if (content === undefined) {
            // The skill is visible, so naming its files is not a leak.
            throw new ToolArgumentError(`this skill has no file ${path}; it has ${Object.keys(found.files).join(', ')}`)
          }
          return {
            skill: which,
            level: found.level,
            name: found.name,
            description: found.description,
            version: found.version,
            has_scripts: found.hasScripts,
            ...('byAgent' in found ? { by_agent: found.byAgent } : {}),
            // A layer's skill only: `update_skill` writes nothing else, so the
            // base is never writable from here whoever is asking.
            writable: 'writable' in found ? found.writable : false,
            paths: Object.keys(found.files),
            path,
            content,
          }
        }
        case 'update_skill': {
          const which = args.skill
          if (typeof which !== 'string' || which === '') throw new ToolArgumentError('skill is required')
          // A layer's, and only a layer's. The organization's skill is written
          // by an organization administrator in the console or through the
          // administrative MCP, and the installation's never over MCP at all —
          // rights spanning tenants stay where a person is doing it.
          if (which === 'base' || which === 'organization' || which === 'installation') {
            throw new ToolArgumentError(
              "this tool writes a layer's skill. The organization's is written in the console or through the " +
                "administrative MCP, and the installation's only through the API.",
            )
          }
          const basedOn = args.based_on
          if (typeof basedOn !== 'number' || !Number.isInteger(basedOn) || basedOn < 0) {
            throw new ToolArgumentError('based_on is required: the version you read, or 0 for a layer with no skill')
          }
          // The folder as files, or as the `.zip` Claude exports — exactly one.
          // The zip is read here, by the one bounded reader the REST surface
          // uses, rather than in the skill panel: a browser has no `zlib`, and
          // a second reader is a second place for a zip bomb to get through.
          // It reaches this tool from the panel through the host, never
          // through the model, which is why carrying bytes in an argument is
          // acceptable here when it is not for a document.
          const zip = args.zip_base64
          if ((args.files === undefined) === (zip === undefined)) {
            throw new ToolArgumentError('send the skill as files or as zip_base64, and exactly one of them')
          }
          let files: unknown = args.files
          if (typeof zip === 'string') {
            const read = readSkillZip(Buffer.from(zip, 'base64'))
            if ('error' in read) throw new ToolArgumentError(`not a skill zip: ${read.error}`)
            files = read.files
          }
          const layerId = await skills.layerBySlug(auth, which)
          const level: SkillLevel | undefined = layerId === undefined ? undefined : { kind: 'layer', layerId }
          const outcome: SkillWrite =
            level === undefined ? { kind: 'not_found' } : await skills.write(auth, level, files, basedOn, 'mcp')

          if (outcome.kind === 'written' || outcome.kind === 'not_found' || outcome.kind === 'forbidden') {
            const target = { skill: 'layer', layer_id: layerId ?? null, layer: which }
            await audit.write({
              orgId: auth.orgId,
              actor: `${auth.principal.type}:${auth.principal.id}`,
              ...(outcome.kind === 'written' && outcome.cleared ? SKILL_AUDIT.cleared : SKILL_AUDIT.updated),
              result: outcome.kind === 'written' ? 'allow' : 'deny',
              surface: 'mcp',
              target: { ...target },
              detail:
                outcome.kind === 'written'
                  ? {
                      ...target,
                      version: outcome.version.version,
                      file_count: outcome.version.fileCount,
                      has_scripts: outcome.version.hasScripts,
                      surface: 'mcp',
                      ...(auth.delegation === undefined ? {} : { connection_id: auth.delegation.id }),
                    }
                  : target,
              requestId,
            })
          }

          switch (outcome.kind) {
            case 'written':
              return {
                skill: which,
                version: outcome.version.version,
                cleared: outcome.cleared,
                has_scripts: outcome.version.hasScripts,
              }
            case 'not_found':
              throw new Error('not found')
            case 'forbidden':
              // The layer's skill is visible to this caller, so saying why the
              // write is refused names nothing they cannot already see.
              throw new ToolArgumentError(
                "writing this layer's skill needs admin on the layer, and for a connected application the " +
                  "person's consent to edit it",
              )
            case 'conflict':
              throw new ToolArgumentError(
                `this skill is at version ${String(outcome.current)}; read it again with get_skill, apply your ` +
                  'change to that version, and write naming it as based_on',
              )
            case 'refused':
              throw new ToolArgumentError(`not a skill: ${outcome.reason}`)
          }
          throw new Error('unreachable')
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
  return {
    pool,
    layers,
    tools,
    skills: { base: (auth) => skills.base(auth) },
    // The administrative surface's tools, over the same pool, audit writer and
    // principals cache — docs/mcp-admin.md. STDIO never serves them: it
    // authenticates with a service account key, which cannot hold the role.
    //
    // Composed after `loadModules`, which both entry points run first, so a
    // module's tools are in the catalog and a name it shares with the core
    // stops the process here rather than shadowing anything.
    admin: adminTools({
      pool,
      audit,
      vectors,
      consoleUrl: config.consentUrl,
      ...(principalsCache === undefined ? {} : { principalsCache }),
    }),
    verification: postgresVerification(pool, APP_ROLE),
  }
}
