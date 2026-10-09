/**
 * Skills: storage, who sees which, who writes which. docs/skills.md is the
 * specification and every rule below is quoted from it rather than restated.
 *
 * One port for every surface. The REST handlers, the MCP tools and the
 * `instructions` an agent reads on connecting all ask this, so "who may see a
 * layer's skill" has one answer and it is the resolver's — the same
 * `contextFor` the document paths use, which is the whole argument for this
 * file reaching into `adapters.ts` for it rather than holding a second copy.
 */
import {
  activeResolver,
  checkSkill,
  DEFAULT_SKILL,
  withOrg,
  type Permission,
  type SkillFiles,
} from '@nacre.work/core'
import type { Pool, PoolClient } from 'pg'

import { contextFor, type PrincipalsCache } from './adapters.js'
import { administers, administersTenants, delegatedLayers, withinDelegation, type AuthContext } from './auth.js'
import { encodeCursor, type Page, type PageResult } from './pagination.js'

/** Which skill. The installation's belongs to no organization. */
export type SkillLevel =
  | { readonly kind: 'installation' }
  | { readonly kind: 'organization' }
  | { readonly kind: 'layer'; readonly layerId: string }

/** Through which door a write came — recorded on the version, see docs/skills.md. */
export type SkillSurface = 'rest' | 'mcp' | 'mcp-admin'

export interface SkillVersionMeta {
  readonly version: number
  readonly name: string | null
  readonly description: string | null
  readonly hasScripts: boolean
  readonly fileCount: number
  /** `{type}:{id}`, as the access log writes it. */
  readonly principal: string
  readonly surface: SkillSurface
  readonly connectionId: string | null
  /**
   * Written by an agent rather than by a person at a screen: through MCP,
   * through a delegation, or by a service account. What the console and the
   * panel mark, because a skill is instructions every later agent follows.
   */
  readonly byAgent: boolean
  readonly restoredFrom: number | null
  readonly createdAt: string
}

export interface SkillVersion extends SkillVersionMeta {
  readonly files: SkillFiles
}

/** One entry of what a caller sees — the base skill, or a layer's. */
export interface SkillEntry {
  readonly level: 'default' | 'installation' | 'organization' | 'layer'
  readonly layerId: string | null
  readonly layerSlug: string | null
  readonly name: string
  readonly description: string
  readonly version: number | null
  readonly hasScripts: boolean
  readonly paths: readonly string[]
}

export interface EffectiveBase extends SkillEntry {
  readonly files: SkillFiles
}

export type SkillWrite =
  | { readonly kind: 'written'; readonly version: SkillVersionMeta; readonly cleared: boolean }
  /** No such level, or one the caller may not see — one answer, invariant 4. */
  | { readonly kind: 'not_found' }
  /** Visible, and the caller may not write it. */
  | { readonly kind: 'forbidden' }
  /** `based_on` is not the current version; nothing was written. */
  | { readonly kind: 'conflict'; readonly current: number }
  | { readonly kind: 'refused'; readonly reason: string }

export interface Skills {
  /** The base skill for this caller: organization ?? installation ?? default. */
  base(auth: AuthContext): Promise<EffectiveBase>
  /**
   * The base skill and a page of the layer skills the caller may see, in the
   * order layers were created. Paged, because a listing that answers the first
   * fifty of a million layers and says nothing reads as the whole set.
   */
  list(auth: AuthContext, page: Page): Promise<{ readonly base: SkillEntry; readonly layers: PageResult<SkillEntry> }>
  /** A layer id for a slug the caller may see a skill on, or `undefined`. */
  layerBySlug(auth: AuthContext, slug: string): Promise<string | undefined>
  /** The current version, or `undefined` when there is none or the caller may not see it. */
  current(auth: AuthContext, level: SkillLevel): Promise<SkillVersion | undefined>
  /** History, newest first. `undefined` unless the caller may write the level. */
  versions(auth: AuthContext, level: SkillLevel, page: Page): Promise<PageResult<SkillVersionMeta> | undefined>
  version(auth: AuthContext, level: SkillLevel, n: number): Promise<SkillVersion | undefined>
  write(
    auth: AuthContext,
    level: SkillLevel,
    files: unknown,
    basedOn: number,
    surface: SkillSurface,
  ): Promise<SkillWrite>
  restore(auth: AuthContext, level: SkillLevel, n: number, basedOn: number, surface: SkillSurface): Promise<SkillWrite>
}

/** Bytes above which `instructions` carry a pointer rather than the body. */
export const INSTRUCTIONS_SKILL_LIMIT = 16 * 1024

interface VersionRow {
  version: number
  files: Record<string, string>
  name: string | null
  description: string | null
  has_scripts: boolean
  principal: string
  surface: SkillSurface
  connection_id: string | null
  restored_from: number | null
  created_at_text: string
}

const projection = (alias = ''): string =>
  ['version', 'files', 'name', 'description', 'has_scripts', 'principal', 'surface', 'connection_id', 'restored_from']
    .map((column) => `${alias}${column}`)
    .concat(`${alias}created_at::text AS created_at_text`)
    .join(', ')

/** `installation_skill_versions` has no `connection_id`; it reads as NULL. */
const PROJECTION = projection()
const INSTALLATION_PROJECTION = PROJECTION.replace('connection_id', 'NULL::uuid AS connection_id')

const byAgent = (row: VersionRow): boolean =>
  row.surface !== 'rest' || row.connection_id !== null || row.principal.startsWith('service_account:')

const meta = (row: VersionRow): SkillVersionMeta => ({
  version: row.version,
  name: row.name,
  description: row.description,
  hasScripts: row.has_scripts,
  fileCount: Object.keys(row.files).length,
  principal: row.principal,
  surface: row.surface,
  connectionId: row.connection_id,
  byAgent: byAgent(row),
  restoredFrom: row.restored_from,
  createdAt: row.created_at_text,
})

const full = (row: VersionRow): SkillVersion => ({ ...meta(row), files: row.files })

const actor = (auth: AuthContext): string => `${auth.principal.type}:${auth.principal.id}`

/** A catalog entry, which names a skill's files and does not carry them. */
function withoutFiles(skill: EffectiveBase): SkillEntry {
  const { files, ...entry } = skill
  void files
  return entry
}

/** The default skill as an entry, for an installation nobody has configured. */
function defaultEntry(): EffectiveBase {
  const check = checkSkill({ ...DEFAULT_SKILL })
  // `skill.test.ts` holds this; a default the format refuses is a release bug.
  if (check.kind !== 'skill') throw new Error('the default skill does not pass checkSkill')
  return {
    level: 'default',
    layerId: null,
    layerSlug: null,
    name: check.skill.name,
    description: check.skill.description,
    version: null,
    hasScripts: check.skill.hasScripts,
    paths: Object.keys(DEFAULT_SKILL),
    files: DEFAULT_SKILL,
  }
}

export class PostgresSkills implements Skills {
  constructor(
    private readonly pool: Pool,
    private readonly role?: string,
    private readonly principalsCache?: PrincipalsCache,
  ) {}

  private get scope(): { role?: string } {
    return this.role === undefined ? {} : { role: this.role }
  }

  // ── who sees and who writes ────────────────────────────────────────────────

  /**
   * The layers whose skill this caller sees: any permission on the layer,
   * `write` included, within the delegation's narrowing for that permission.
   *
   * `admin` implies both, so asking `read` and `write` covers it. A grant on a
   * single document is not a permission on its layer and does not count — the
   * skill describes the layer, and a document grant says nothing about it.
   */
  private async visibleLayers(client: PoolClient, auth: AuthContext): Promise<ReadonlySet<string>> {
    // Rule 2: administering tenants is not access to one tenant's anything.
    if (administersTenants(auth)) return new Set()
    const ctx = await contextFor(client, auth, this.principalsCache)
    const live = async (): Promise<string[]> => {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM layers WHERE org_id = $1 AND deleted_at IS NULL',
        [auth.orgId],
      )
      return rows.map((r) => r.id)
    }
    let all: string[] | undefined
    const seen = new Set<string>()
    for (const permission of ['read', 'write'] as const satisfies readonly Permission[]) {
      const plan = activeResolver().resolve(ctx, permission)
      if (plan.kind === 'none') continue
      const reached = plan.kind === 'all' ? (all ??= await live()) : plan.layers
      const narrowing = delegatedLayers(auth, permission)
      for (const id of reached) if (narrowing === undefined || narrowing.includes(id)) seen.add(id)
    }
    if (seen.size === 0) return seen
    // Deleted layers are not there, whatever a grant still names.
    const { rows } = await client.query<{ id: string }>(
      'SELECT id FROM layers WHERE org_id = $1 AND deleted_at IS NULL AND id = ANY($2::uuid[])',
      [auth.orgId, [...seen]],
    )
    return new Set(rows.map((r) => r.id))
  }

  /**
   * `may_write_layer_skill` in docs/skills.md: `admin` resolved on the layer,
   * and for a delegation the layer inside its narrowing for `admin`.
   *
   * The consent screen's per-layer `skill` box is the second clause of the
   * specification's disjunction and arrives with it; until then a delegation
   * writes a layer's skill only where its ceiling holds `admin` there, which
   * the ordinary consent screen never sets.
   */
  private async mayWriteLayer(client: PoolClient, auth: AuthContext, layerId: string): Promise<boolean> {
    if (administersTenants(auth)) return false
    const plan = activeResolver().resolve(await contextFor(client, auth, this.principalsCache), 'admin')
    if (plan.kind === 'none') return false
    if (plan.kind === 'scoped' && !plan.layers.includes(layerId)) return false
    return withinDelegation(auth, layerId, 'admin')
  }

  private mayReadLevel = async (client: PoolClient, auth: AuthContext, level: SkillLevel): Promise<boolean> => {
    switch (level.kind) {
      case 'installation':
        // Read by everybody it applies to, which is everybody: it is the base
        // skill of every organization that has not set its own.
        return true
      case 'organization':
        return !administersTenants(auth)
      case 'layer':
        return (await this.visibleLayers(client, auth)).has(level.layerId)
    }
  }

  private mayWriteLevel = async (client: PoolClient, auth: AuthContext, level: SkillLevel): Promise<boolean> => {
    switch (level.kind) {
      case 'installation':
        return administersTenants(auth)
      case 'organization':
        return administers(auth)
      case 'layer':
        return this.mayWriteLayer(client, auth, level.layerId)
    }
  }

  // ── reading ────────────────────────────────────────────────────────────────

  private async latest(client: PoolClient, auth: AuthContext, level: SkillLevel): Promise<VersionRow | undefined> {
    if (level.kind === 'installation') {
      const { rows } = await client.query<VersionRow>(
        `SELECT ${INSTALLATION_PROJECTION} FROM installation_skill_versions ORDER BY version DESC LIMIT 1`,
      )
      return rows[0]
    }
    const { rows } = await client.query<VersionRow>(
      `SELECT ${PROJECTION} FROM skill_versions
        WHERE org_id = $1 AND layer_id IS NOT DISTINCT FROM $2
        ORDER BY version DESC LIMIT 1`,
      [auth.orgId, level.kind === 'layer' ? level.layerId : null],
    )
    return rows[0]
  }

  private live = (row: VersionRow | undefined): row is VersionRow => row !== undefined && row.name !== null

  async base(auth: AuthContext): Promise<EffectiveBase> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const own = administersTenants(auth) ? undefined : await this.latest(client, auth, { kind: 'organization' })
        if (this.live(own)) return this.entry(own, 'organization', null, null)
        const installation = await this.latest(client, auth, { kind: 'installation' })
        if (this.live(installation)) return this.entry(installation, 'installation', null, null)
        return defaultEntry()
      },
      this.scope,
    )
  }

  private entry(row: VersionRow, level: SkillEntry['level'], layerId: string | null, layerSlug: string | null): EffectiveBase {
    return {
      level,
      layerId,
      layerSlug,
      name: row.name ?? '',
      description: row.description ?? '',
      version: row.version,
      hasScripts: row.has_scripts,
      paths: Object.keys(row.files),
      files: row.files,
    }
  }

  async list(auth: AuthContext, page: Page): Promise<{ base: SkillEntry; layers: PageResult<SkillEntry> }> {
    const base = withoutFiles(await this.base(auth))
    const layers = await withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<PageResult<SkillEntry>> => {
        const visible = await this.visibleLayers(client, auth)
        if (visible.size === 0) return { items: [], nextCursor: null }
        // The newest version per layer, and only layers whose newest is live:
        // a cleared layer skill is no layer skill. Seeking on the layer's own
        // `(created_at, id)`, so a page boundary does not move when a skill is
        // written in the middle of a walk.
        const { rows } = await client.query<
          VersionRow & { layer_id: string; slug: string; layer_created: string }
        >(
          `SELECT * FROM (
             SELECT DISTINCT ON (v.layer_id) v.layer_id, l.slug, l.created_at::text AS layer_created,
                    ${projection('v.')}
               FROM skill_versions v
               JOIN layers l ON l.id = v.layer_id AND l.org_id = v.org_id AND l.deleted_at IS NULL
              WHERE v.org_id = $1 AND v.layer_id = ANY($2::uuid[])
              ORDER BY v.layer_id, v.version DESC
           ) newest
           WHERE name IS NOT NULL
             AND ($3::timestamptz IS NULL OR (layer_created::timestamptz, layer_id) > ($3::timestamptz, $4::uuid))
           ORDER BY layer_created::timestamptz, layer_id
           LIMIT ${String(page.limit)}`,
          [auth.orgId, [...visible], page.after?.createdAt ?? null, page.after?.id ?? null],
        )
        const items = rows.map((r) => withoutFiles(this.entry(r, 'layer', r.layer_id, r.slug)))
        const last = rows[rows.length - 1]
        return {
          items,
          nextCursor:
            rows.length < page.limit || last === undefined
              ? null
              : encodeCursor({ createdAt: last.layer_created, id: last.layer_id }),
        }
      },
      this.scope,
    )
    return { base, layers }
  }

  async layerBySlug(auth: AuthContext, slug: string): Promise<string | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          'SELECT id FROM layers WHERE org_id = $1 AND slug = $2 AND deleted_at IS NULL',
          [auth.orgId, slug],
        )
        const id = rows[0]?.id
        if (id === undefined) return undefined
        // A slug the caller cannot see is a slug that is not there.
        return (await this.visibleLayers(client, auth)).has(id) ? id : undefined
      },
      this.scope,
    )
  }

  async current(auth: AuthContext, level: SkillLevel): Promise<SkillVersion | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        if (!(await this.mayReadLevel(client, auth, level))) return undefined
        const row = await this.latest(client, auth, level)
        return this.live(row) ? full(row) : undefined
      },
      this.scope,
    )
  }

  async versions(auth: AuthContext, level: SkillLevel, page: Page): Promise<PageResult<SkillVersionMeta> | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        // History says who wrote what and through which connection; it is
        // shown to whoever may write the level, not to everybody who reads it.
        if (!(await this.mayWriteLevel(client, auth, level))) return undefined
        const before = page.after === undefined ? null : Number(page.after.id)
        const { rows } =
          level.kind === 'installation'
            ? await client.query<VersionRow>(
                `SELECT ${INSTALLATION_PROJECTION} FROM installation_skill_versions
                  WHERE ($1::int IS NULL OR version < $1) ORDER BY version DESC LIMIT ${String(page.limit)}`,
                [before],
              )
            : await client.query<VersionRow>(
                `SELECT ${PROJECTION} FROM skill_versions
                  WHERE org_id = $1 AND layer_id IS NOT DISTINCT FROM $2 AND ($3::int IS NULL OR version < $3)
                  ORDER BY version DESC LIMIT ${String(page.limit)}`,
                [auth.orgId, level.kind === 'layer' ? level.layerId : null, before],
              )
        const items = rows.map(meta)
        const last = rows[rows.length - 1]
        return {
          items,
          nextCursor:
            rows.length < page.limit || last === undefined
              ? null
              : encodeCursor({ createdAt: last.created_at_text, id: String(last.version) }),
        }
      },
      this.scope,
    )
  }

  async version(auth: AuthContext, level: SkillLevel, n: number): Promise<SkillVersion | undefined> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client) => {
        if (!(await this.mayWriteLevel(client, auth, level))) return undefined
        const row = await this.at(client, auth, level, n)
        return row === undefined ? undefined : full(row)
      },
      this.scope,
    )
  }

  private async at(client: PoolClient, auth: AuthContext, level: SkillLevel, n: number): Promise<VersionRow | undefined> {
    const { rows } =
      level.kind === 'installation'
        ? await client.query<VersionRow>(`SELECT ${INSTALLATION_PROJECTION} FROM installation_skill_versions WHERE version = $1`, [n])
        : await client.query<VersionRow>(
            `SELECT ${PROJECTION} FROM skill_versions
              WHERE org_id = $1 AND layer_id IS NOT DISTINCT FROM $2 AND version = $3`,
            [auth.orgId, level.kind === 'layer' ? level.layerId : null, n],
          )
    return rows[0]
  }

  // ── writing ────────────────────────────────────────────────────────────────

  async write(auth: AuthContext, level: SkillLevel, files: unknown, basedOn: number, surface: SkillSurface): Promise<SkillWrite> {
    const check = checkSkill(files)
    if (check.kind === 'refused') return { kind: 'refused', reason: check.reason }
    const stored = check.kind === 'skill' ? check.skill : undefined
    return this.insert(auth, level, basedOn, surface, stored, null)
  }

  async restore(auth: AuthContext, level: SkillLevel, n: number, basedOn: number, surface: SkillSurface): Promise<SkillWrite> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<SkillWrite> => {
        const gate = await this.gate(client, auth, level, surface)
        if (gate !== undefined) return gate
        const row = await this.at(client, auth, level, n)
        if (row === undefined) return { kind: 'not_found' }
        const check = checkSkill(row.files)
        // A stored version passed the format when it was written; a version the
        // format now refuses is restored as written rather than silently dropped.
        const skill =
          check.kind === 'skill'
            ? check.skill
            : check.kind === 'cleared' || row.name === null
              ? undefined
              : { name: row.name, description: row.description ?? '', hasScripts: row.has_scripts, files: row.files }
        return this.insertIn(client, auth, level, basedOn, surface, skill, n)
      },
      this.scope,
    )
  }

  /** Visibility and permission, in that order, so an invisible level is `not_found`. */
  private async gate(client: PoolClient, auth: AuthContext, level: SkillLevel, surface: SkillSurface): Promise<SkillWrite | undefined> {
    if (level.kind === 'installation') {
      // Rights spanning tenants stay in the API and the console, by decision.
      if (surface !== 'rest') return { kind: 'not_found' }
      return administersTenants(auth) ? undefined : { kind: 'not_found' }
    }
    if (!(await this.mayReadLevel(client, auth, level))) return { kind: 'not_found' }
    if (level.kind === 'layer') {
      const { rows } = await client.query<{ id: string }>(
        'SELECT id FROM layers WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL',
        [auth.orgId, level.layerId],
      )
      if (rows.length === 0) return { kind: 'not_found' }
    }
    return (await this.mayWriteLevel(client, auth, level)) ? undefined : { kind: 'forbidden' }
  }

  private async insert(
    auth: AuthContext,
    level: SkillLevel,
    basedOn: number,
    surface: SkillSurface,
    skill: { name: string; description: string; hasScripts: boolean; files: SkillFiles } | undefined,
    restoredFrom: number | null,
  ): Promise<SkillWrite> {
    return withOrg(
      this.pool,
      auth.orgId,
      async (client): Promise<SkillWrite> => {
        const gate = await this.gate(client, auth, level, surface)
        if (gate !== undefined) return gate
        return this.insertIn(client, auth, level, basedOn, surface, skill, restoredFrom)
      },
      this.scope,
    )
  }

  private async insertIn(
    client: PoolClient,
    auth: AuthContext,
    level: SkillLevel,
    basedOn: number,
    surface: SkillSurface,
    skill: { name: string; description: string; hasScripts: boolean; files: SkillFiles } | undefined,
    restoredFrom: number | null,
  ): Promise<SkillWrite> {
    const current = (await this.latest(client, auth, level))?.version ?? 0
    // A write names the version it was based on, and any other is a conflict —
    // checked here, and again by the unique key, which is what holds when two
    // writers both read the same `current` and race to insert after it.
    if (basedOn !== current) return { kind: 'conflict', current }

    const values = [
      basedOn + 1,
      JSON.stringify(skill?.files ?? {}),
      skill?.name ?? null,
      skill?.description ?? null,
      skill?.hasScripts ?? false,
      actor(auth),
      surface,
      restoredFrom,
    ]
    try {
      await client.query('SAVEPOINT skill_write')
      const { rows } =
        level.kind === 'installation'
          ? await client.query<VersionRow>(
              `INSERT INTO installation_skill_versions
                 (version, files, name, description, has_scripts, principal, surface, restored_from)
               VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8) RETURNING ${INSTALLATION_PROJECTION}`,
              values,
            )
          : await client.query<VersionRow>(
              `INSERT INTO skill_versions
                 (version, files, name, description, has_scripts, principal, surface, restored_from,
                  org_id, layer_id, connection_id)
               VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${PROJECTION}`,
              [...values, auth.orgId, level.kind === 'layer' ? level.layerId : null, auth.delegation?.id ?? null],
            )
      await client.query('RELEASE SAVEPOINT skill_write')
      const row = rows[0] as VersionRow
      return { kind: 'written', version: meta(row), cleared: skill === undefined }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        await client.query('ROLLBACK TO SAVEPOINT skill_write')
        const now = (await this.latest(client, auth, level))?.version ?? 0
        return { kind: 'conflict', current: now }
      }
      throw error
    }
  }
}
