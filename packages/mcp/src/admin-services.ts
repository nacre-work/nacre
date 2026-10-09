import {
  administers,
  AUDIT_GROUPINGS,
  decodeCursor,
  encodeCursor,
  PostgresAccess,
  PostgresAuditReader,
  PostgresGrants,
  PostgresGroups,
  PostgresOAuthConsents,
  PostgresServiceAccounts,
  PostgresSkills,
  PostgresUsers,
  PostgresWorkspaces,
  type AccessSubject,
  type AuditGrouping,
  type AuditQuery,
  type AuthContext,
  type PrincipalsCache,
  type Reach,
  type SkillLevel,
} from '@nacre.work/api'
import { withOrg, type AuditWriter } from '@nacre.work/core'
import type { Pool } from 'pg'

import { AUTHORED_NOTICE, skillNotice } from './admin-tools.js'
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
}

export function adminTools(deps: AdminDeps): ToolRunner {
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

  const inOrg = <T>(auth: AuthContext, run: (client: import('pg').PoolClient) => Promise<T>): Promise<T> =>
    withOrg(pool, auth.orgId, run, { role: APP_ROLE })

  // ── names ──────────────────────────────────────────────────────────────

  /** A principal named by email, name or id, in this organization — or a refusal naming the reference. */
  const principal = async (auth: AuthContext, args: Record<string, unknown>): Promise<AccessSubject> => {
    const given = (['person', 'group', 'service_account'] as const).filter((k) => typeof args[k] === 'string')
    if (given.length !== 1) {
      throw new ToolArgumentError('Name exactly one of person, group or service_account.')
    }
    const kind = given[0] as 'person' | 'group' | 'service_account'
    const ref = (args[kind] as string).trim()
    const found = await lookup(auth, kind, ref)
    if (found === undefined) throw new ToolArgumentError(`No ${kind.replace('_', ' ')} "${ref}" in this organization.`)
    return found
  }

  const lookup = (
    auth: AuthContext,
    kind: 'person' | 'group' | 'service_account',
    ref: string,
  ): Promise<AccessSubject | undefined> =>
    inOrg(auth, async (client) => {
      const byId = UUID.test(ref)
      const [table, column, type] =
        kind === 'person'
          ? (['users', 'lower(email)', 'user'] as const)
          : kind === 'group'
            ? (['groups', 'name', 'group'] as const)
            : (['service_accounts', 'name', 'service_account'] as const)
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM ${table} WHERE org_id = $1 AND ${byId ? 'id = $2::uuid' : `${column} = $2`} LIMIT 2`,
        [auth.orgId, byId ? ref : kind === 'person' ? ref.toLowerCase() : ref],
      )
      return rows.length === 1 && rows[0] !== undefined ? { type, id: rows[0].id } : undefined
    })

  /** A layer by slug or id, as both — the log records both shapes. */
  const layer = async (auth: AuthContext, ref: string): Promise<{ id: string; slug: string }> => {
    const found = await inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM layers WHERE org_id = $1 AND deleted_at IS NULL AND ${UUID.test(ref) ? 'id = $2::uuid' : 'slug = $2'}`,
        [auth.orgId, ref],
      )
      return rows[0]
    })
    if (found === undefined) throw new ToolArgumentError(`No layer "${ref}" in this organization.`)
    return found
  }

  const workspace = async (auth: AuthContext, ref: string): Promise<string> => {
    const found = await inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM workspaces WHERE org_id = $1 AND ${UUID.test(ref) ? 'id = $2::uuid' : 'slug = $2'}`,
        [auth.orgId, ref],
      )
      return rows[0]?.id
    })
    if (found === undefined) throw new ToolArgumentError(`No workspace "${ref}" in this organization.`)
    return found
  }

  /**
   * A name beside every id: an email for a person, a name for a group or a
   * service account, a slug for a layer or a workspace. Ids the organization
   * does not have come back unnamed rather than refused — a deleted layer is
   * still in last month's log.
   */
  const names = (auth: AuthContext, ids: Iterable<string>): Promise<ReadonlyMap<string, string>> => {
    const wanted = [...new Set([...ids].filter((id) => UUID.test(id)))]
    if (wanted.length === 0) return Promise.resolve(new Map())
    return inOrg(auth, async (client) => {
      const { rows } = await client.query<{ id: string; name: string }>(
        `SELECT id::text, email AS name FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, name FROM service_accounts WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, name FROM groups WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, slug FROM layers WHERE org_id = $1 AND id = ANY($2::uuid[])
         UNION ALL SELECT id::text, slug FROM workspaces WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [auth.orgId, wanted],
      )
      return new Map(rows.map((r) => [r.id, r.name]))
    })
  }

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

  return {
    async call(name, args, auth, requestId) {
      // Authentication admitted only an organization administrator's
      // administrative connection to this surface. Asked again here because
      // a runner that trusts its caller's wiring is one `createMcpServer`
      // option away from serving somebody else.
      if (!administers(auth) || auth.delegation?.surface !== 'admin') throw new Error('not an administrative caller')
      const tool = tools[name]
      if (tool === undefined) throw new Error(`no administrative tool ${name}`)
      const { result, detail } = await tool(auth, args)
      await recorded(auth, requestId, name, detail)
      return result
    },
  }
}
