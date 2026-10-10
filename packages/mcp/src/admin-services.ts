import {
  AdminNames,
  administers,
  applyProposal,
  AUDIT_GROUPINGS,
  cancelProposal,
  coreAdminWrites,
  decodeCursor,
  notificationTools,
  PostgresNotifications,
  encodeCursor,
  PostgresAccess,
  PostgresAuditReader,
  PostgresGrants,
  PostgresGroups,
  PostgresLayers,
  PostgresOAuthConsents,
  PostgresProposals,
  PostgresReindex,
  PostgresServiceAccounts,
  PostgresSkills,
  PostgresUsers,
  PostgresWorkspaces,
  recordProposal,
  recordRefusedProposal,
  writeLookup,
  type AccessSubject,
  type AuditGrouping,
  type AuditQuery,
  type AuthContext,
  type PrincipalsCache,
  type Reach,
  type SkillLevel,
} from '@nacre.work/api'
import {
  classifyIngestFailure,
  isRetryable,
  MetadataError,
  mcpTools,
  withoutHosts,
  logger,
  McpToolRefusal,
  withOrg,
  type AuditWriter,
  type McpPanelOffer,
  type McpReadTool,
  type McpTool,
  type McpWriteTool,
} from '@nacre.work/core'
import type { Pool } from 'pg'

import {
  ADMIN_CATALOG,
  AdminResult,
  AUTHORED_NOTICE,
  DECIDE_CATALOG,
  PANEL_META,
  PROPOSAL_META,
  readDefinition,
  skillNotice,
  writeDefinition,
  type AdminToolDefinition,
} from './admin-tools.js'
import { ToolArgumentError, type ToolRunner } from './factory.js'

/**
 * What the administrative tools do. docs/mcp-admin.md.
 *
 * Every read goes through the adapter the REST surface uses for the same
 * question — the user, group, grant, workspace, skill, connection and audit
 * ports — so the administrative MCP holds no second idea of who may see what.
 * What is here is the part an agent needs and a screen does not: resolving a
 * person by email and a layer by slug rather than by uuid, putting a name
 * beside every id, and opening each result that carries somebody else's text
 * with a sentence saying what that text is.
 *
 * Every write **proposes**. The tool resolves what the model named, writes the
 * sentence a person reads, stores it, and answers with it; the change is made
 * by `apply` when the person presses Apply — in the panel, through the app-only
 * `apply_proposal` below, or on the console's Proposals screen through the API.
 * The core's writes and every module's are found by the same lookup and go the
 * same way, so a module cannot add a write that skips the person.
 *
 * Two reads are written here rather than borrowed, and both are behind
 * `administers` at the top of `call`: the layer listing, because the
 * administrative one carries what the ordinary one deliberately does not (the
 * model, failures, whether a skill is set), and the name lookups, because no
 * port resolves an email. Each names the organization in its own literal.
 */

export const APP_ROLE = 'nacre_app'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Literal, so `lint:audit-actions` can see each is recorded. */
const RECORDED = {
  read: { action: 'mcp_admin.read' },
  log: { action: 'audit.read' },
} as const

const DAY_MS = 86_400_000
const MAX_WINDOW_DAYS = 366

export interface AdminDeps {
  readonly pool: Pool
  readonly audit: AuditWriter
  readonly principalsCache?: PrincipalsCache
  /**
   * The vector store, for the two layer writes: creating one asks which named
   * vectors the collection has, and deleting one stops its points matching
   * before its rows go. The same port the API hands its layers adapter.
   */
  readonly vectors: ConstructorParameters<typeof PostgresLayers>[1]
  /**
   * The console's address, where a person applies a proposal from a client
   * that renders no panel — the consent URL without its route. Absent, the
   * answer says "the console" without a link.
   */
  readonly consoleUrl?: string
  /**
   * Whether the installation has a mail relay. The notification tools are
   * offered only where it does: a tool that queues a message nothing will send
   * is a tool that says it did something it did not. This process never sends —
   * the worker does — so it is told the fact, not handed a sender.
   */
  readonly notifications?: boolean
}

/** The runner, and the catalog it answers for — composed once, at startup. */
export interface AdminRunner extends ToolRunner {
  readonly catalog: readonly AdminToolDefinition[]
}


/** The sentence a refusal gave its caller, or nothing for a failure that was not one. */
function refusalOf(error: unknown): string | undefined {
  return error instanceof McpToolRefusal || error instanceof ToolArgumentError || error instanceof MetadataError
    ? error.message
    : undefined
}

export function adminTools(deps: AdminDeps): AdminRunner {
  const { pool, audit, principalsCache } = deps
  const users = new PostgresUsers(pool, APP_ROLE)
  const accounts = new PostgresServiceAccounts(pool, APP_ROLE)
  const groups = new PostgresGroups(pool, APP_ROLE)
  const workspaces = new PostgresWorkspaces(pool, APP_ROLE, principalsCache)
  const grants = new PostgresGrants(pool, APP_ROLE, principalsCache)
  const access = new PostgresAccess(pool, APP_ROLE, principalsCache)
  const skills = new PostgresSkills(pool, APP_ROLE, principalsCache)
  const consents = new PostgresOAuthConsents(pool, APP_ROLE)
  const log = new PostgresAuditReader(pool, APP_ROLE, principalsCache)
  const known = new AdminNames(pool, APP_ROLE)
  const proposals = new PostgresProposals(pool, APP_ROLE)
  const reindexes = new PostgresReindex(pool, deps.vectors, APP_ROLE, principalsCache)

  const notify = deps.notifications === true
    ? notificationTools({ audit, names: known, notifications: new PostgresNotifications(pool, APP_ROLE) })
    : []
  const coreReads = notify.filter((t): t is McpReadTool => t.kind === 'read')

  const writes = [
    ...coreAdminWrites({
    pool,
    role: APP_ROLE,
    audit,
    grants,
    groups,
    users,
    workspaces,
    layers: new PostgresLayers(pool, deps.vectors, APP_ROLE, principalsCache),
    skills,
    consents,
    }),
    ...notify.filter((t): t is McpWriteTool => t.kind === 'write'),
  ]
  const lookupWrite = writeLookup(writes)

  const inOrg = <T>(auth: AuthContext, run: (client: import('pg').PoolClient) => Promise<T>): Promise<T> =>
    withOrg(pool, auth.orgId, run, { role: APP_ROLE })

  // ── names ──────────────────────────────────────────────────────────────
  //
  // `AdminNames`, shared with the API so the console resolves the same names
  // the MCP process proposed with. Its refusals are `McpToolRefusal`, which
  // reaches the caller as their own words.

  const principal = (auth: AuthContext, args: Record<string, unknown>): Promise<AccessSubject> => known.principal(auth, args)
  const lookup = (auth: AuthContext, kind: 'person' | 'group' | 'service_account', ref: string) => known.lookup(auth, kind, ref)
  const layer = async (auth: AuthContext, ref: string): Promise<{ id: string; slug: string }> => {
    const found = await known.layer(auth, ref)
    return { id: found.id, slug: found.slug }
  }
  const workspace = async (auth: AuthContext, ref: string): Promise<string> => (await known.workspace(auth, ref)).id
  const names = (auth: AuthContext, ids: Iterable<string>): Promise<ReadonlyMap<string, string>> => known.names(auth, ids)

  const idOfRef = (ref: string | null): string => (ref ?? '').split(':')[1] ?? ''

  // ── arguments ──────────────────────────────────────────────────────────

  const pageOf = (args: Record<string, unknown>, shape: 'uuid' | 'sequence') => {
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.trunc(args.limit))) : 50
    if (typeof args.cursor !== 'string' || args.cursor === '') return { limit, after: undefined }
    const after = decodeCursor(args.cursor, shape)
    if (after === undefined) throw new ToolArgumentError('That cursor is not one this tool returned.')
    return { limit, after }
  }

  const instant = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined
    const at = typeof value === 'string' ? new Date(value) : new Date(Number.NaN)
    if (Number.isNaN(at.getTime())) throw new ToolArgumentError(`'${field}' must be an ISO 8601 time.`)
    return at.toISOString()
  }

  /** The window every log read names, and the filters on it. Bounded; seven days by default. */
  const auditQuery = async (
    auth: AuthContext,
    args: Record<string, unknown>,
  ): Promise<AuditQuery & { from: string; to: string }> => {
    const to = instant(args.to, 'to') ?? new Date().toISOString()
    const from = instant(args.from, 'from') ?? new Date(Date.parse(to) - 7 * DAY_MS).toISOString()
    if (Date.parse(from) >= Date.parse(to)) throw new ToolArgumentError("'from' must be before 'to'.")
    if (Date.parse(to) - Date.parse(from) > MAX_WINDOW_DAYS * DAY_MS) {
      throw new ToolArgumentError(`A window is at most ${String(MAX_WINDOW_DAYS)} days.`)
    }

    let actorId: string | undefined
    if (typeof args.actor === 'string' && args.actor !== '') {
      const ref = args.actor.trim()
      const found = (await lookup(auth, 'person', ref)) ?? (await lookup(auth, 'service_account', ref))
      if (found === undefined) throw new ToolArgumentError(`No person or service account "${ref}" in this organization.`)
      actorId = found.id
    }
    const connection = typeof args.connection === 'string' && args.connection !== '' ? args.connection.trim() : undefined
    if (connection !== undefined && !UUID.test(connection.replace(/^connection:/, ''))) {
      throw new ToolArgumentError("'connection' is a connection id, as list_connections gives it.")
    }

    return {
      from,
      to,
      ...(actorId === undefined ? {} : { actorId }),
      ...(typeof args.action === 'string' && args.action !== '' ? { action: args.action } : {}),
      ...(args.result === 'allow' || args.result === 'deny' || args.result === 'error' ? { result: args.result } : {}),
      ...(typeof args.layer === 'string' && args.layer !== '' ? { layer: await layer(auth, args.layer) } : {}),
      ...(typeof args.document === 'string' && args.document !== '' ? { documentId: args.document } : {}),
      ...(connection === undefined ? {} : { client: `connection:${connection.replace(/^connection:/, '')}` }),
      ...(typeof args.surface === 'string' && args.surface !== ''
        ? { surface: args.surface as NonNullable<AuditQuery['surface']> }
        : {}),
    }
  }

  // ── recording ──────────────────────────────────────────────────────────

  const recorded = async (
    auth: AuthContext,
    requestId: string,
    tool: string,
    detail: Record<string, unknown>,
  ): Promise<void> => {
    const logRead = tool === 'query_audit' || tool === 'summarize_audit'
    await audit.write({
      orgId: auth.orgId,
      actor: `${auth.principal.type}:${auth.principal.id}`,
      ...(logRead ? RECORDED.log : RECORDED.read),
      result: 'allow',
      surface: 'mcp-admin',
      target: { tool },
      detail,
      requestId,
    })
  }

  /**
   * A read that was refused or failed, recorded like one that answered: what an
   * agent asked for and did not get is part of what it did. The reason is the
   * sentence the caller was given, and nothing for a failure — an error's own
   * message is not something to keep.
   */
  const refused = async (auth: AuthContext, requestId: string, tool: string, error: unknown): Promise<void> => {
    const reason = refusalOf(error)
    await audit.write({
      orgId: auth.orgId,
      actor: `${auth.principal.type}:${auth.principal.id}`,
      ...(tool === 'query_audit' || tool === 'summarize_audit' ? RECORDED.log : RECORDED.read),
      result: reason === undefined ? 'error' : 'deny',
      surface: 'mcp-admin',
      target: { tool },
      detail: reason === undefined ? {} : { reason: reason.slice(0, 300) },
      requestId,
    })
  }

  // ── the tools ──────────────────────────────────────────────────────────

  const tools: Record<string, (auth: AuthContext, args: Record<string, unknown>) => Promise<{ result: unknown; detail: Record<string, unknown> }>> = {
    list_people: async (auth, args) => {
      const page = await users.list(auth, pageOf(args, 'uuid'))
      return {
        result: {
          people: page.items.map((u) => ({
            id: u.id,
            email: u.email,
            role: u.role,
            disabled: u.disabledAt !== null,
            sso_only: !u.hasPassword,
            shared: u.shared,
            created_at: u.createdAt,
          })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length },
      }
    },

    list_service_accounts: async (auth, args) => {
      const page = await accounts.list(auth, pageOf(args, 'uuid'))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          service_accounts: page.items.map((a) => ({
            id: a.id,
            name: a.name,
            key_prefix: a.keyPrefix,
            last_used_at: a.lastUsedAt,
            revoked: a.revokedAt !== null,
            created_at: a.createdAt,
          })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length },
      }
    },

    list_groups: async (auth, args) => {
      const page = await groups.list(auth, pageOf(args, 'uuid'))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          groups: page.items.map((g) => ({ id: g.id, name: g.name, members: g.memberCount, created_at: g.createdAt })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length },
      }
    },

    get_group: async (auth, args) => {
      const subject = await principal(auth, { group: args.group })
      const members = await groups.members(auth, subject.id, { limit: 200, after: undefined })
      const issued = await grants.list(auth, { limit: 200, after: undefined }, {
        principalType: 'group',
        principalId: subject.id,
      })
      const named = await names(auth, [subject.id, ...issued.items.map((g) => g.scopeId)])
      return {
        result: {
          notice: AUTHORED_NOTICE,
          group: { id: subject.id, name: named.get(subject.id) ?? null },
          members: (members?.items ?? []).map((m) => ({ type: m.type, id: m.id, name: m.label })),
          more_members: members?.nextCursor !== null && members?.nextCursor !== undefined,
          grants: issued.items.map((g) => ({
            id: g.id,
            scope: { type: g.scopeType, id: g.scopeId, name: named.get(g.scopeId) ?? null },
            permission: g.permission,
            effect: g.effect,
          })),
        },
        detail: { group: subject.id },
      }
    },

    list_workspaces: async (auth, args) => {
      const page = await workspaces.list(auth, pageOf(args, 'uuid'))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          workspaces: page.items.map((w) => ({ id: w.id, slug: w.slug, name: w.name, layers: w.layerCount })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length },
      }
    },

    list_layers: async (auth, args) => {
      const { limit, after } = pageOf(args, 'uuid')
      const rows = await inOrg(auth, async (client) => {
        const { rows } = await client.query<{
          id: string
          slug: string
          name: string
          description: string | null
          workspace: string
          model: string | null
          documents: string
          failed: string
          pending: string
          has_skill: boolean
          created_at_text: string
        }>(
          `SELECT l.id, l.slug, l.name, l.description, w.slug AS workspace, p.model,
                  (SELECT count(*) FROM documents d WHERE d.org_id = l.org_id AND d.layer_id = l.id AND d.deleted_at IS NULL) AS documents,
                  (SELECT count(*) FROM documents d WHERE d.org_id = l.org_id AND d.layer_id = l.id AND d.deleted_at IS NULL AND d.status = 'failed') AS failed,
                  (SELECT count(*) FROM documents d WHERE d.org_id = l.org_id AND d.layer_id = l.id AND d.deleted_at IS NULL AND d.status NOT IN ('indexed', 'failed')) AS pending,
                  COALESCE((SELECT s.name IS NOT NULL FROM skill_versions s
                             WHERE s.org_id = l.org_id AND s.layer_id = l.id
                             ORDER BY s.version DESC LIMIT 1), false) AS has_skill,
                  l.created_at::text AS created_at_text
             FROM layers l
             JOIN workspaces w ON w.id = l.workspace_id AND w.org_id = l.org_id
             LEFT JOIN embedding_providers p ON p.id = l.provider_id
            WHERE l.org_id = $1 AND l.deleted_at IS NULL
              AND ($2::timestamptz IS NULL OR (l.created_at, l.id) > ($2::timestamptz, $3::uuid))
            ORDER BY l.created_at, l.id
            LIMIT $4`,
          [auth.orgId, after?.createdAt ?? null, after?.id ?? null, limit + 1],
        )
        return rows
      })
      const items = rows.slice(0, limit)
      const last = items[items.length - 1]
      return {
        result: {
          notice: AUTHORED_NOTICE,
          layers: items.map((l) => ({
            id: l.id,
            slug: l.slug,
            name: l.name,
            description: l.description ?? '',
            workspace: l.workspace,
            model: l.model,
            documents: Number(l.documents),
            failed: Number(l.failed),
            pending: Number(l.pending),
            has_skill: l.has_skill,
          })),
          next_cursor:
            rows.length > limit && last !== undefined
              ? encodeCursor({ createdAt: last.created_at_text, id: last.id })
              : null,
        },
        detail: { returned: items.length },
      }
    },

    layer_status: async (auth, args) => {
      if (typeof args.layer !== 'string' || args.layer.trim() === '') {
        throw new ToolArgumentError("'layer' is required: a layer's slug or id.")
      }
      const layer = await known.layer(auth, args.layer.trim())
      const found = await inOrg(auth, async (client) => {
        const { rows: about } = await client.query<{
          name: string
          description: string | null
          workspace: string
          model: string | null
          vector_name: string
        }>(
          `SELECT l.name, l.description, w.slug AS workspace, p.model, l.vector_name
             FROM layers l
             JOIN workspaces w ON w.id = l.workspace_id AND w.org_id = l.org_id
             LEFT JOIN embedding_providers p ON p.id = l.provider_id
            WHERE l.org_id = $1 AND l.id = $2`,
          [auth.orgId, layer.id],
        )
        const { rows: counts } = await client.query<{ status: string; n: string }>(
          `SELECT status, count(*)::text AS n FROM documents
            WHERE org_id = $1 AND layer_id = $2 AND deleted_at IS NULL
            GROUP BY status`,
          [auth.orgId, layer.id],
        )
        // The most recent failures, and only the stored error's redacted
        // form ever leaves: the raw string carries the embedder's and the
        // parser's addresses, which `withoutHosts` exists to take out.
        const { rows: failed } = await client.query<{
          id: string
          external_id: string | null
          title: string | null
          error: string | null
          attempts: number
          failed_at: string
        }>(
          `SELECT id, external_id, title, error, attempts, updated_at::text AS failed_at
             FROM documents
            WHERE org_id = $1 AND layer_id = $2 AND deleted_at IS NULL AND status = 'failed'
            ORDER BY updated_at DESC, id
            LIMIT 50`,
          [auth.orgId, layer.id],
        )
        const { rows: refs } = await client.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM reference_queries WHERE org_id = $1 AND layer_id = $2`,
          [auth.orgId, layer.id],
        )
        return { about: about[0], counts, failed, references: Number(refs[0]?.n ?? 0) }
      })
      const reindex = await reindexes.status(auth, layer.id)
      const by = Object.fromEntries(found.counts.map((c) => [c.status, Number(c.n)]))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          layer: {
            id: layer.id,
            slug: layer.slug,
            name: found.about?.name ?? layer.slug,
            description: found.about?.description ?? '',
            workspace: found.about?.workspace ?? null,
            model: found.about?.model ?? null,
            vector: found.about?.vector_name ?? null,
          },
          documents: {
            indexed: by.indexed ?? 0,
            pending: (by.pending ?? 0) + (by.parsing ?? 0) + (by.indexing ?? 0),
            failed: by.failed ?? 0,
          },
          failures: found.failed.map((d) => {
            const failure = classifyIngestFailure(d.error ?? '')
            return {
              id: d.id,
              external_id: d.external_id,
              title: d.title,
              reason: failure.reason,
              // Whether waiting is the answer. A transient failure is
              // retried by the worker on its own; the rest need somebody to
              // fix the cause and then re-send the document or retry it
              // through the API, which this surface does not do: its
              // connection holds no `write`, because it changes no documents.
              recovers_by_itself: isRetryable(failure.reason),
              detail: withoutHosts(d.error ?? ''),
              attempts: d.attempts,
              failed_at: d.failed_at,
            }
          }),
          reindex:
            reindex === undefined
              ? null
              : {
                  status: reindex.status,
                  phase: reindex.phase,
                  current_vector: reindex.currentVector,
                  shadow_vector: reindex.shadowVector,
                  done: reindex.done,
                  total: reindex.total,
                  failed: reindex.failed,
                  progress: reindex.progress,
                  error: reindex.error === null ? null : withoutHosts(reindex.error),
                  check:
                    reindex.check === null
                      ? null
                      : { recall: reindex.check.recall, floor: reindex.check.floor, passed: reindex.check.passed, queries: reindex.check.queries },
                },
          reference_queries: found.references,
        },
        detail: { layer_id: layer.id },
      }
    },

    list_grants: async (auth, args) => {
      const hasPrincipal = ['person', 'group', 'service_account'].some((k) => typeof args[k] === 'string')
      const subject = hasPrincipal ? await principal(auth, args) : undefined
      if (typeof args.layer === 'string' && typeof args.workspace === 'string') {
        throw new ToolArgumentError('Name a layer or a workspace, not both.')
      }
      const scope =
        typeof args.layer === 'string'
          ? { scopeType: 'layer' as const, scopeId: (await layer(auth, args.layer)).id }
          : typeof args.workspace === 'string'
            ? { scopeType: 'workspace' as const, scopeId: await workspace(auth, args.workspace) }
            : {}
      const page = await grants.list(auth, pageOf(args, 'uuid'), {
        ...(subject === undefined ? {} : { principalType: subject.type, principalId: subject.id }),
        ...scope,
      })
      const named = await names(auth, page.items.flatMap((g) => [g.principalId, g.scopeId]))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          grants: page.items.map((g) => ({
            id: g.id,
            principal: { type: g.principalType, id: g.principalId, name: named.get(g.principalId) ?? null },
            scope: { type: g.scopeType, id: g.scopeId, name: named.get(g.scopeId) ?? null },
            permission: g.permission,
            effect: g.effect,
            source: g.source,
          })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length },
      }
    },

    effective_access: async (auth, args) => {
      const subject = await principal(auth, args)
      const found = await access.effective(auth, subject)
      if (found === undefined) throw new ToolArgumentError('That principal is not in this organization.')
      const ids = [
        subject.id,
        ...found.groups,
        ...found.read.layers,
        ...found.write.layers,
        ...found.admin.layers,
        ...found.grants.flatMap((g) => [idOfRef(g.principal), g.scopeId]),
      ]
      const named = await names(auth, ids)
      const reach = (r: Reach) =>
        r.all
          ? { every_layer: true }
          : {
              every_layer: false,
              layers: r.layers.map((id) => named.get(id) ?? id),
              ...(r.moreLayers === 0 ? {} : { more_layers: r.moreLayers }),
              ...(r.extraDocuments === 0 ? {} : { documents_outside_those_layers: r.extraDocuments }),
              ...(r.deniedDocuments === 0 ? {} : { documents_denied_inside_them: r.deniedDocuments }),
            }
      return {
        result: {
          notice: AUTHORED_NOTICE,
          principal: { type: subject.type, id: subject.id, name: named.get(subject.id) ?? null, role: found.role },
          ...(found.role === 'org_admin'
            ? { note: 'An organization administrator reaches every layer by role, whatever the grants say.' }
            : {}),
          groups: found.groups.map((id) => ({ id, name: named.get(id) ?? null })),
          read: reach(found.read),
          write: reach(found.write),
          admin: reach(found.admin),
          deciding_grants: found.grants.map((g) => ({
            through: g.principal === `${subject.type}:${subject.id}` ? 'directly' : `group ${named.get(idOfRef(g.principal)) ?? idOfRef(g.principal)}`,
            scope: { type: g.scopeType, id: g.scopeId, name: named.get(g.scopeId) ?? null },
            permission: g.permission,
            effect: g.effect,
          })),
        },
        detail: { principal: `${subject.type}:${subject.id}` },
      }
    },

    list_skills: async (auth) => {
      const listed = await skills.list(auth, { limit: 200, after: undefined })
      const entry = (e: typeof listed.base) => ({
        level: e.level,
        layer: e.layerSlug,
        name: e.name,
        description: e.description,
        version: e.version,
        has_scripts: e.hasScripts,
        files: e.paths,
      })
      return {
        result: {
          notice: `${AUTHORED_NOTICE} Skills here are listed for review; this surface follows none of them.`,
          organization: entry(listed.base),
          layers: listed.layers.items.map(entry),
          more_layers: listed.layers.nextCursor !== null,
        },
        detail: { returned: listed.layers.items.length + 1 },
      }
    },

    get_skill: async (auth, args) => {
      const level: SkillLevel =
        typeof args.layer === 'string' && args.layer !== ''
          ? { kind: 'layer', layerId: (await layer(auth, args.layer)).id }
          : { kind: 'organization' }
      const version =
        typeof args.version === 'number'
          ? await skills.version(auth, level, Math.trunc(args.version))
          : await skills.current(auth, level)
      const where = level.kind === 'layer' ? `layer ${String(args.layer)}'s` : "organization's"
      if (version === undefined) {
        return {
          result: { level: where, version: null, note: `The ${where} skill is not set${typeof args.version === 'number' ? ' at that version' : ''}.` },
          detail: { level: level.kind },
        }
      }
      const author = await names(auth, [idOfRef(version.principal)])
      const by = author.get(idOfRef(version.principal))
      return {
        result: {
          // First, and the whole point: a model reads this before it reads
          // the files, and the files may say anything. T39.
          notice: skillNotice({
            level: where,
            version: version.version,
            principal: by === undefined ? version.principal : `${by} (${version.principal})`,
            byAgent: version.byAgent,
          }),
          under_review: true,
          version: version.version,
          name: version.name,
          description: version.description,
          written_by: version.principal,
          written_through: version.surface,
          by_agent: version.byAgent,
          has_scripts: version.hasScripts,
          created_at: version.createdAt,
          files: version.files,
        },
        detail: { level: level.kind, version: version.version },
      }
    },

    list_connections: async (auth) => {
      const listed = await consents.list(auth)
      const named = await names(auth, listed.flatMap((c) => c.layers.map((l) => l.id)))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          connections: listed.map((c) => ({
            id: c.id,
            application: c.clientName,
            administrative: c.surface === 'admin',
            acts_as:
              c.subject.actsAs === 'user'
                ? { person: c.approvedByEmail ?? c.approvedBy }
                : { service_account: c.serviceAccountName ?? c.subject.serviceAccountId },
            approved_by: c.approvedByEmail ?? c.approvedBy,
            approver_disabled: c.approverDisabled,
            ceiling: c.permissions,
            layers:
              c.layers.length === 0
                ? 'every layer the person reaches'
                : c.layers.map((l) => ({ layer: named.get(l.id) ?? l.id, ...(l.permissions === undefined ? {} : { ceiling: l.permissions }) })),
            created_at: c.createdAt,
            last_refreshed_at: c.lastRefreshedAt,
            revoked: c.revokedAt !== null,
          })),
        },
        detail: { returned: listed.length },
      }
    },

    query_audit: async (auth, args) => {
      const query = await auditQuery(auth, args)
      const page = await log.read(auth, query, pageOf(args, 'sequence'))
      const named = await names(auth, page.items.map((r) => r.actorId ?? ''))
      return {
        result: {
          notice: AUTHORED_NOTICE,
          window: { from: query.from, to: query.to },
          events: page.items.map((r) => ({
            at: r.occurredAt,
            actor: { type: r.actorType, id: r.actorId, name: r.actorId === null ? null : (named.get(r.actorId) ?? null) },
            action: r.action,
            result: r.result,
            surface: r.surface,
            connection: r.client,
            target: r.target,
            detail: r.detail,
            request_id: r.requestId,
          })),
          next_cursor: page.nextCursor,
        },
        detail: { returned: page.items.length, from: query.from, to: query.to },
      }
    },

    summarize_audit: async (auth, args) => {
      const by = args.by
      if (typeof by !== 'string' || !(AUDIT_GROUPINGS as readonly string[]).includes(by)) {
        throw new ToolArgumentError(`'by' is one of ${AUDIT_GROUPINGS.join(', ')}.`)
      }
      const query = await auditQuery(auth, args)
      const limit = typeof args.limit === 'number' ? Math.trunc(args.limit) : 20
      const buckets = await log.summarize(auth, query, by as AuditGrouping, limit)
      const named = by === 'actor' ? await names(auth, buckets.map((b) => idOfRef(b.key))) : new Map<string, string>()
      return {
        result: {
          notice: AUTHORED_NOTICE,
          window: { from: query.from, to: query.to },
          by,
          groups: buckets.map((b) => ({
            key: b.key,
            ...(by === 'actor' && b.key !== null ? { name: named.get(idOfRef(b.key)) ?? null } : {}),
            events: b.events,
            denied: b.denied,
            errors: b.errors,
            first: b.first,
            last: b.last,
          })),
        },
        detail: { by, groups: buckets.length, from: query.from, to: query.to },
      }
    },
  }

  // ── composing the catalog ──────────────────────────────────────────────
  //
  // The core's reads and writes, each module's, and the panel's two buttons.
  // A name twice is a startup failure naming both: a tool silently shadowed is
  // a tool somebody believes they called.

  const modules = mcpTools('admin')
  const owners = new Map<string, string>()
  const claim = (name: string, owner: string): void => {
    const taken = owners.get(name)
    if (taken !== undefined) {
      throw new Error(`the administrative tool ${name} is registered twice — by ${taken} and by ${owner}`)
    }
    owners.set(name, owner)
  }
  for (const d of ADMIN_CATALOG) claim(d.name, 'the core')
  for (const r of coreReads) claim(r.name, 'the core')
  for (const w of writes) claim(w.name, 'the core')
  for (const d of DECIDE_CATALOG) claim(d.name, 'the core')
  for (const m of modules) claim(m.tool.name, m.module)

  const catalog: readonly AdminToolDefinition[] = [
    ...ADMIN_CATALOG,
    ...coreReads.map(readDefinition),
    ...writes.map(writeDefinition),
    ...modules.map((m) => (m.tool.kind === 'write' ? writeDefinition(m.tool) : readDefinition(m.tool))),
    ...DECIDE_CATALOG,
  ]
  const moduleOf = new Map<string, { readonly module: string; readonly tool: McpTool }>(modules.map((m) => [m.tool.name, m]))

  /**
   * A read panel's `_meta`: the tool to ask again after a change, and the
   * writes its form may offer. An offer survives only if it names a write in
   * this catalog — a module offering `apply_proposal`, a read, or a tool no
   * longer loaded is dropped here, before the panel could show it — and its
   * fixed arguments are text. A press on what is left proposes, exactly as the
   * model's call would, and the person applies it.
   */
  const writeNames = new Set(catalog.filter((d) => d.kind === 'write').map((d) => d.name))
  const admissible = (offer: McpPanelOffer): boolean =>
    typeof offer.tool === 'string' &&
    writeNames.has(offer.tool) &&
    typeof offer.label === 'string' &&
    offer.label.trim() !== '' &&
    (offer.document === 'none' || offer.document === 'optional' || offer.document === 'required') &&
    typeof offer.fixed === 'object' &&
    offer.fixed !== null &&
    Object.values(offer.fixed).every((v) => typeof v === 'string')
  const panelled = (name: string, result: unknown, offers: () => readonly McpPanelOffer[]): AdminResult => {
    let offered: readonly McpPanelOffer[] = []
    try {
      offered = offers().filter(admissible)
    } catch (error) {
      // An offer is a convenience on a panel; a module whose offers throw
      // still answers the read, and the panel shows no form.
      logger.warn('a panel offer could not be built', { tool: name, error: String(error) })
    }
    return new AdminResult(result, { [PANEL_META]: { tool: name, offers: offered } })
  }

  /** The core's own reads that open a panel with something to offer from it. */
  const coreOffers: Readonly<Record<string, (args: Record<string, unknown>) => readonly McpPanelOffer[]>> = {
    // Listed by a layer or a workspace, the panel can give access on that
    // scope; listed by a person alone, there is no scope to fix and no form.
    list_grants: (args) =>
      typeof args.layer === 'string'
        ? [{ tool: 'issue_grant', label: 'Give access', document: 'none', fixed: { layer: args.layer } }]
        : typeof args.workspace === 'string'
          ? [{ tool: 'issue_grant', label: 'Give access', document: 'none', fixed: { workspace: args.workspace } }]
          : [],
  }
  const proposalWord = (deps.consoleUrl === undefined ? 'the console' : `${deps.consoleUrl.replace(/#.*$/, '')}#/proposals`)

  /**
   * A write: propose, store, record, and answer with what would happen.
   *
   * The answer is for the model and the person both. Its text says what is
   * proposed and where it is decided. The proposal's id and the key that
   * applies it are in `_meta`, for the panel — and the key is nowhere else: the
   * id is in the access log, which this surface reads, so the id alone must not
   * be enough to apply anything.
   */
  const propose = async (
    auth: AuthContext,
    requestId: string,
    entry: { readonly tool: McpTool & { readonly kind: 'write' }; readonly module: string | null },
    args: Record<string, unknown>,
  ): Promise<AdminResult> => {
    let proposal
    try {
      proposal = await entry.tool.propose({ auth, requestId }, args)
    } catch (error) {
      await recordRefusedProposal({ audit }, auth, { tool: entry.tool.name, module: entry.module }, refusalOf(error), requestId)
      throw error
    }
    const stored = await recordProposal({ proposals, audit }, auth, { tool: entry.tool.name, module: entry.module, proposal }, requestId)
    return new AdminResult(
      {
        proposed: proposal.summary,
        details: proposal.details,
        status: 'Waiting for the person to apply it. Nothing has changed.',
        expires_at: stored.expiresAt,
        how_it_is_applied:
          'The person applies or cancels it in the panel shown with this result. A client that shows no panel ' +
          `leaves it on the console's Proposals screen: ${proposalWord}. You cannot apply it, and should not ` +
          'say it is done.',
      },
      { [PROPOSAL_META]: { id: stored.id, key: stored.panelKey, expires_at: stored.expiresAt } },
    )
  }

  /** The panel's buttons, for this connection's own proposals and nothing else. */
  const decide = async (auth: AuthContext, requestId: string, name: string, args: Record<string, unknown>): Promise<unknown> => {
    const id = typeof args.proposal === 'string' ? args.proposal : ''
    const key = typeof args.key === 'string' ? args.key : ''
    const consentId = auth.delegation?.id as string
    const by = { through: 'panel' as const, consentId, key }
    const outcome =
      name === 'apply_proposal'
        ? await applyProposal({ proposals, audit, writes: lookupWrite }, auth, id, by, requestId)
        : await cancelProposal({ proposals, audit }, auth, id, by, requestId)
    switch (outcome.kind) {
      case 'applied':
        return { applied: true, result: outcome.result }
      case 'cancelled':
        return { cancelled: true }
      case 'refused':
        throw new McpToolRefusal(outcome.reason)
      default:
        throw new McpToolRefusal('That proposal is no longer open: it was applied, cancelled or has expired.')
    }
  }

  return {
    catalog,
    async call(name, args, auth, requestId) {
      // Authentication admitted only an organization administrator's
      // administrative connection to this surface. Asked again here because
      // a runner that trusts its caller's wiring is one `createMcpServer`
      // option away from serving somebody else.
      if (!administers(auth) || auth.delegation?.surface !== 'admin') throw new Error('not an administrative caller')

      const read = tools[name]
      if (read !== undefined) {
        let done
        try {
          done = await read(auth, args)
        } catch (error) {
          await refused(auth, requestId, name, error)
          throw error
        }
        await recorded(auth, requestId, name, done.detail)
        const offers = coreOffers[name]
        return offers === undefined ? done.result : panelled(name, done.result, () => offers(args))
      }

      if (name === 'apply_proposal' || name === 'cancel_proposal') return decide(auth, requestId, name, args)

      // The core's reads written in the module shape — the notification
      // tools, present only where there is a relay.
      const coreRead = coreReads.find((r) => r.name === name)
      if (coreRead !== undefined) {
        let result
        try {
          result = await coreRead.run({ auth, requestId }, args)
        } catch (error) {
          await refused(auth, requestId, name, error)
          throw error
        }
        await recorded(auth, requestId, name, {})
        return result
      }

      const core = writes.find((w) => w.name === name)
      if (core !== undefined) return propose(auth, requestId, { tool: core, module: null }, args)

      const added = moduleOf.get(name)
      if (added !== undefined) {
        if (added.tool.kind === 'write') return propose(auth, requestId, { tool: added.tool, module: added.module }, args)
        let result
        try {
          result = await added.tool.run({ auth, requestId }, args)
        } catch (error) {
          await refused(auth, requestId, name, error)
          throw error
        }
        await recorded(auth, requestId, name, { module: added.module })
        const panel = added.tool.panel
        return panel === undefined ? result : panelled(name, result, () => panel.offers?.(args) ?? [])
      }

      throw new Error(`no administrative tool ${name}`)
    },
  }
}
