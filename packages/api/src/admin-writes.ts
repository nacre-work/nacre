import {
  looksLikeEmail,
  McpToolRefusal,
  readSkillZip,
  withOrg,
  type AuditWriter,
  type McpProposal,
  type McpToolCall,
  type McpWriteTool,
} from '@nacre.work/core'
import type { Pool } from 'pg'

import { AdminNames, isUuid } from './admin-names.js'
import type { AuthContext } from './auth.js'
import type { OAuthConsents } from './oauth-store.js'
import type { Groups, Users } from './principals.js'
import type { Grants, Layers, Workspaces } from './server.js'
import type { SkillLevel, Skills } from './skills.js'

/**
 * The core's writes on the administrative MCP. docs/mcp-admin.md, "Tools".
 *
 * Every one is two halves, which is the whole design: `propose` resolves what
 * the model named into ids and writes the sentence a person reads, and `apply`
 * makes the change — only ever called when that person presses Apply, in the
 * panel or on the console's Proposals screen. A module's write registered
 * through `registerMcpTools` has exactly this shape, so the core's and a
 * module's go past a person the same way.
 *
 * `apply` goes through the port the REST surface uses for the same change, as
 * the person deciding — so every check that endpoint makes is made again here,
 * ten minutes later at most, and a role lost in between is what decides. It
 * records the same action the REST handler records, on the administrative
 * surface, naming the proposal.
 *
 * What is not here, and why, is in the document: passwords and keys (a
 * plaintext returned to a conversation stays in it), second factors (never on
 * anybody's behalf), and anything above the organization.
 */

export interface AdminWritePorts {
  readonly pool: Pool
  readonly role: string
  readonly audit: AuditWriter
  readonly grants: Grants
  readonly groups: Groups
  readonly users: Users
  readonly workspaces: Workspaces
  readonly layers: Layers
  readonly skills: Skills
  readonly consents: OAuthConsents
}

type Args = Readonly<Record<string, unknown>>

const auth = (call: McpToolCall): AuthContext => call.auth as AuthContext

const text = (args: Args, key: string, what: string, max = 200): string => {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') throw new McpToolRefusal(`'${key}' is required: ${what}.`)
  if (value.length > max) throw new McpToolRefusal(`'${key}' is at most ${String(max)} characters.`)
  return value.trim()
}

const optionalText = (args: Args, key: string, max: number): string | undefined => {
  const value = args[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new McpToolRefusal(`'${key}' must be a string.`)
  if (value.length > max) throw new McpToolRefusal(`'${key}' is at most ${String(max)} characters.`)
  return value
}

const oneOf = <T extends string>(args: Args, key: string, allowed: readonly T[]): T => {
  const value = args[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new McpToolRefusal(`'${key}' is one of ${allowed.join(', ')}.`)
  }
  return value as T
}

const ids = (input: Args, key: string): string => {
  const value = input[key]
  if (typeof value !== 'string' || !isUuid(value)) throw new Error(`a stored proposal is missing ${key}`)
  return value
}

const PRINCIPAL_PROPS = {
  person: { type: 'string', description: "A person's email address." },
  group: { type: 'string', description: "A group's name." },
  service_account: { type: 'string', description: "A service account's name." },
} as const

const LAYER_PROP = { type: 'string', description: "The layer's slug." } as const

const typeWord = (type: string): string =>
  type === 'user' ? 'person' : type === 'service_account' ? 'service account' : type

export function coreAdminWrites(ports: AdminWritePorts): readonly McpWriteTool[] {
  const names = new AdminNames(ports.pool, ports.role)

  const record = async (
    call: McpToolCall,
    action: { readonly action: string },
    result: 'allow' | 'deny',
    target: Record<string, unknown>,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    const a = auth(call)
    // Every call site names what it acted on, and this refuses one that does
    // not rather than writing an event the `gin (target)` index cannot find —
    // `lint:audit-target` reads `audit.write` literals and cannot see through a
    // helper, so the property it holds is held here instead.
    if (Object.keys(target).length === 0) throw new Error(`${action.action} was recorded with no target`)
    await ports.audit.write({
      orgId: a.orgId,
      actor: `${a.principal.type}:${a.principal.id}`,
      ...action,
      result,
      surface: 'mcp-admin',
      target: { ...target },
      detail: { ...detail, ...(call.proposal === undefined ? {} : { proposal: call.proposal.id, through: call.proposal.through }) },
      requestId: call.requestId,
    })
  }

  /** The level a skill tool names: a layer by slug, or the organization's when none. */
  const skillLevel = async (call: McpToolCall, args: Args): Promise<{ level: SkillLevel; where: string; layer?: string }> => {
    if (typeof args.layer === 'string' && args.layer !== '') {
      const layer = await names.layer(auth(call), args.layer)
      return { level: { kind: 'layer', layerId: layer.id }, where: `the layer ${layer.slug}'s skill`, layer: layer.id }
    }
    return { level: { kind: 'organization' }, where: "the organization's skill" }
  }

  const storedLevel = (input: Args): SkillLevel =>
    typeof input.layer_id === 'string' ? { kind: 'layer', layerId: ids(input, 'layer_id') } : { kind: 'organization' }

  const currentVersion = async (call: McpToolCall, level: SkillLevel): Promise<number> =>
    (await ports.skills.current(auth(call), level))?.version ?? 0

  const skillOutcome = async (
    call: McpToolCall,
    kind: { readonly action: string },
    level: SkillLevel,
    outcome: Awaited<ReturnType<Skills['write']>>,
  ): Promise<unknown> => {
    const target = level.kind === 'layer' ? { level: 'layer', layer_id: level.layerId } : { level: level.kind }
    if (outcome.kind === 'written') {
      await record(call, kind, 'allow', target, { version: outcome.version.version, has_scripts: outcome.version.hasScripts, surface: 'mcp-admin' })
      return { version: outcome.version.version, cleared: outcome.cleared }
    }
    await record(call, kind, 'deny', target, { outcome: outcome.kind })
    switch (outcome.kind) {
      case 'conflict':
        throw new McpToolRefusal(
          `The skill changed since this was proposed — it is at version ${String(outcome.current)} now. Read it again and propose afresh.`,
        )
      case 'refused':
        throw new McpToolRefusal(outcome.reason)
      default:
        throw new McpToolRefusal('That skill is not one you may write.')
    }
  }

  const SKILL = {
    updated: { action: 'skill.updated' },
    restored: { action: 'skill.restored' },
    cleared: { action: 'skill.cleared' },
  } as const

  const proposal = (summary: string, details: McpProposal['details'], input: McpProposal['input']): McpProposal => ({
    summary,
    details,
    input,
  })

  return [
    // ── grants ─────────────────────────────────────────────────────────────
    {
      kind: 'write',
      name: 'issue_grant',
      title: 'Grant access',
      description:
        'Propose giving a person, group or service account read, write or admin on one layer or workspace. ' +
        'Write does not include read; admin includes both. Nothing changes until the person approves it.',
      inputSchema: {
        type: 'object',
        properties: {
          ...PRINCIPAL_PROPS,
          layer: LAYER_PROP,
          workspace: { type: 'string', description: "The workspace's slug, to grant on every layer in it." },
          permission: { type: 'string', enum: ['read', 'write', 'admin'] },
        },
        required: ['permission'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const subject = await names.principal(a, args)
        if ((typeof args.layer === 'string') === (typeof args.workspace === 'string')) {
          throw new McpToolRefusal('Name a layer or a workspace — exactly one.')
        }
        const scope =
          typeof args.layer === 'string'
            ? { type: 'layer' as const, ...(await names.layer(a, args.layer)) }
            : { type: 'workspace' as const, ...(await names.workspace(a, args.workspace as string)) }
        const permission = oneOf(args, 'permission', ['read', 'write', 'admin'] as const)
        const named = (await names.names(a, [subject.id])).get(subject.id) ?? subject.id
        return proposal(
          `Give the ${typeWord(subject.type)} ${named} ${permission} on the ${scope.type} ${scope.slug}.`,
          [
            { label: typeWord(subject.type), value: named },
            { label: scope.type, value: scope.slug },
            { label: 'permission', value: permission },
            ...(permission === 'write'
              ? [{ label: 'note', value: 'Write does not include read: they can add documents here and not search them.' }]
              : permission === 'admin'
                ? [{ label: 'note', value: 'Admin includes read and write, and lets them grant access here to others.' }]
                : []),
          ],
          { principal_type: subject.type, principal_id: subject.id, scope_type: scope.type, scope_id: scope.id, permission },
        )
      },
      async apply(call, input) {
        const grant = {
          principalType: input.principal_type as 'user' | 'group' | 'service_account',
          principalId: ids(input, 'principal_id'),
          scopeType: input.scope_type as 'layer' | 'workspace',
          scopeId: ids(input, 'scope_id'),
          permission: input.permission as 'read' | 'write' | 'admin',
        }
        const issued = await ports.grants.issue(auth(call), grant)
        await record(call, { action: 'issue_grant' }, issued === undefined ? 'deny' : 'allow', {
          principal: `${grant.principalType}:${grant.principalId}`,
          scope: `${grant.scopeType}:${grant.scopeId}`,
          permission: grant.permission,
        })
        if (issued === undefined) throw new McpToolRefusal('That scope is not one you may administer, or it no longer exists.')
        return { grant_id: issued.id }
      },
    },
    {
      kind: 'write',
      name: 'revoke_grant',
      title: 'Revoke a grant',
      description: 'Propose withdrawing one grant, by the id list_grants gives. Takes effect on the next request once applied.',
      inputSchema: {
        type: 'object',
        properties: { grant: { type: 'string', description: 'The grant id, from list_grants.' } },
        required: ['grant'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const id = text(args, 'grant', 'the grant id from list_grants', 64)
        const found = await names.grant(a, id)
        if (found === undefined) throw new McpToolRefusal(`No grant "${id}" in this organization.`)
        const named = await names.names(a, [found.principalId, found.scopeId])
        const who = named.get(found.principalId) ?? found.principalId
        const where = named.get(found.scopeId) ?? found.scopeId
        return proposal(
          `Withdraw the ${typeWord(found.principalType)} ${who}'s ${found.effect === 'deny' ? `${found.permission} deny` : found.permission} on the ${found.scopeType} ${where}.`,
          [
            { label: typeWord(found.principalType), value: who },
            { label: found.scopeType, value: where },
            { label: 'permission', value: found.permission },
            { label: 'effect', value: found.effect },
          ],
          { grant_id: id },
        )
      },
      async apply(call, input) {
        const id = ids(input, 'grant_id')
        const revoked = await ports.grants.revoke(auth(call), id)
        await record(call, { action: 'revoke_grant' }, revoked ? 'allow' : 'deny', { grant_id: id })
        if (!revoked) throw new McpToolRefusal('That grant is gone, or its scope is not one you may administer.')
        return { revoked: true }
      },
    },

    // ── groups ─────────────────────────────────────────────────────────────
    {
      kind: 'write',
      name: 'create_group',
      title: 'Create a group',
      description: 'Propose a new group, empty, with no grants.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The group name, unique in the organization.' } },
        required: ['name'],
        additionalProperties: false,
      },
      async propose(_call, args) {
        const name = text(args, 'name', 'the group name', 100)
        return proposal(`Create the group ${name}.`, [{ label: 'group', value: name }], { name })
      },
      async apply(call, input) {
        const name = String(input.name)
        const created = await ports.groups.create(auth(call), name)
        await record(call, { action: 'create_group' }, created === undefined ? 'deny' : 'allow', { name })
        if (created === undefined) throw new McpToolRefusal(`A group named ${name} already exists.`)
        return { group_id: created.id }
      },
    },
    {
      kind: 'write',
      name: 'delete_group',
      title: 'Delete a group',
      description: "Propose deleting a group. Its members stay; the grants it holds go with it.",
      inputSchema: {
        type: 'object',
        properties: { group: PRINCIPAL_PROPS.group },
        required: ['group'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const group = await names.principal(a, { group: args.group }, ['group'])
        const counts = await names.counts(a, { group: group.id })
        const name = (await names.names(a, [group.id])).get(group.id) ?? group.id
        return proposal(
          `Delete the group ${name}. Its ${String(counts.members)} member${counts.members === 1 ? '' : 's'} stay; its ${String(counts.grants)} grant${counts.grants === 1 ? '' : 's'} go with it, and whoever reached something only through it stops reaching it.`,
          [
            { label: 'group', value: name },
            { label: 'members', value: String(counts.members) },
            { label: 'grants removed', value: String(counts.grants) },
          ],
          { group_id: group.id },
        )
      },
      async apply(call, input) {
        const id = ids(input, 'group_id')
        const removed = await ports.groups.remove(auth(call), id)
        await record(call, { action: 'delete_group' }, removed ? 'allow' : 'deny', { group_id: id })
        if (!removed) throw new McpToolRefusal('That group is gone.')
        return { deleted: true }
      },
    },
    {
      kind: 'write',
      name: 'add_group_member',
      title: 'Add to a group',
      description: 'Propose adding a person, or another group, to a group.',
      inputSchema: {
        type: 'object',
        properties: {
          group: PRINCIPAL_PROPS.group,
          person: PRINCIPAL_PROPS.person,
          member_group: { type: 'string', description: 'A group to nest inside this one, by name.' },
        },
        required: ['group'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const group = await names.principal(a, { group: args.group }, ['group'])
        const member = await names.principal(a, { person: args.person, group: args.member_group }, ['person', 'group'])
        const named = await names.names(a, [group.id, member.id])
        return proposal(
          `Add the ${typeWord(member.type)} ${named.get(member.id) ?? member.id} to the group ${named.get(group.id) ?? group.id}. They reach whatever the group reaches.`,
          [
            { label: 'group', value: named.get(group.id) ?? group.id },
            { label: typeWord(member.type), value: named.get(member.id) ?? member.id },
          ],
          { group_id: group.id, member_type: member.type, member_id: member.id },
        )
      },
      async apply(call, input) {
        const groupId = ids(input, 'group_id')
        const member = { type: input.member_type as 'user' | 'group', id: ids(input, 'member_id') }
        const outcome = await ports.groups.addMember(auth(call), groupId, member)
        const ok = outcome === 'added' || outcome === 'already'
        await record(call, { action: 'add_group_member' }, ok ? 'allow' : 'deny', { group_id: groupId, member: `${member.type}:${member.id}` }, { outcome })
        if (outcome === 'no-group') throw new McpToolRefusal('That group is gone.')
        if (outcome === 'no-member') throw new McpToolRefusal('That member is gone.')
        return { added: outcome === 'added', already_a_member: outcome === 'already' }
      },
    },
    {
      kind: 'write',
      name: 'remove_group_member',
      title: 'Remove from a group',
      description: 'Propose removing a person, or a nested group, from a group.',
      inputSchema: {
        type: 'object',
        properties: {
          group: PRINCIPAL_PROPS.group,
          person: PRINCIPAL_PROPS.person,
          member_group: { type: 'string', description: 'A nested group, by name.' },
        },
        required: ['group'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const group = await names.principal(a, { group: args.group }, ['group'])
        const member = await names.principal(a, { person: args.person, group: args.member_group }, ['person', 'group'])
        const named = await names.names(a, [group.id, member.id])
        return proposal(
          `Remove the ${typeWord(member.type)} ${named.get(member.id) ?? member.id} from the group ${named.get(group.id) ?? group.id}. Whatever they reached only through it stops at once.`,
          [
            { label: 'group', value: named.get(group.id) ?? group.id },
            { label: typeWord(member.type), value: named.get(member.id) ?? member.id },
          ],
          { group_id: group.id, member_type: member.type, member_id: member.id },
        )
      },
      async apply(call, input) {
        const groupId = ids(input, 'group_id')
        const member = { type: input.member_type as 'user' | 'group', id: ids(input, 'member_id') }
        const removed = await ports.groups.removeMember(auth(call), groupId, member)
        await record(call, { action: 'remove_group_member' }, removed ? 'allow' : 'deny', { group_id: groupId, member: `${member.type}:${member.id}` })
        if (!removed) throw new McpToolRefusal('They are not in that group.')
        return { removed: true }
      },
    },

    // ── people ─────────────────────────────────────────────────────────────
    {
      kind: 'write',
      name: 'create_person',
      title: 'Add a person',
      description:
        'Propose an account for a person, as a member or an organization administrator. No password is handed out ' +
        'here: they set one with "Forgotten your password?" where mail is configured, or an administrator resets it ' +
        'in the console.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'Their email address.' },
          role: { type: 'string', enum: ['member', 'org_admin'], description: 'member by default.' },
        },
        required: ['email'],
        additionalProperties: false,
      },
      async propose(_call, args) {
        // Trimmed and otherwise kept as given, which is what `POST /v1/users`
        // stores — two routes that normalise one address two ways are two
        // answers about who `Dana@` is.
        const email = text(args, 'email', 'their email address', 254).trim()
        if (!looksLikeEmail(email)) throw new McpToolRefusal(`"${email}" is not an email address.`)
        const role = args.role === undefined ? 'member' : oneOf(args, 'role', ['member', 'org_admin'] as const)
        return proposal(
          `Add ${email} as ${role === 'org_admin' ? 'an organization administrator' : 'a member'}.`,
          [
            { label: 'email', value: email },
            { label: 'role', value: role },
            { label: 'password', value: 'none handed out — they set their own, or an administrator resets it in the console' },
          ],
          { email, role },
        )
      },
      async apply(call, input) {
        const email = String(input.email)
        const role = input.role === 'org_admin' ? 'org_admin' : 'member'
        // The generated password is discarded, deliberately: anything returned
        // here goes into a conversation, and conversations are stored.
        const created = await ports.users.create(auth(call), email, role)
        await record(call, { action: 'create_user' }, created === undefined ? 'deny' : 'allow', { email }, { role })
        if (created === undefined) throw new McpToolRefusal(`${email} already has an account here.`)
        return { person_id: created.user.id, password: 'not handed out' }
      },
    },
    ...(['set_person_role', 'disable_person', 'enable_person'] as const).map(
      (name): McpWriteTool => ({
        kind: 'write',
        name,
        title: name === 'set_person_role' ? "Change a person's role" : name === 'disable_person' ? 'Disable a person' : 'Enable a person',
        description:
          name === 'set_person_role'
            ? 'Propose making a person a member or an organization administrator. The last administrator cannot be demoted.'
            : name === 'disable_person'
              ? 'Propose disabling a person: they cannot sign in, and every application acting for them stops on its next request. Their grants stay.'
              : 'Propose enabling a disabled person again. Their grants and connections are as they were.',
        inputSchema: {
          type: 'object',
          properties: {
            person: PRINCIPAL_PROPS.person,
            ...(name === 'set_person_role' ? { role: { type: 'string', enum: ['member', 'org_admin'] } } : {}),
          },
          required: name === 'set_person_role' ? ['person', 'role'] : ['person'],
          additionalProperties: false,
        },
        async propose(call, args) {
          const a = auth(call)
          const person = await names.principal(a, { person: args.person }, ['person'])
          const email = (await names.names(a, [person.id])).get(person.id) ?? person.id
          if (name === 'set_person_role') {
            const role = oneOf(args, 'role', ['member', 'org_admin'] as const)
            return proposal(
              `Make ${email} ${role === 'org_admin' ? 'an organization administrator' : 'a member'}.`,
              [
                { label: 'person', value: email },
                { label: 'role', value: role },
                ...(role === 'org_admin'
                  ? [{ label: 'note', value: 'An organization administrator reaches every layer and can change everything here.' }]
                  : []),
              ],
              { person_id: person.id, role },
            )
          }
          const disabling = name === 'disable_person'
          return proposal(
            disabling
              ? `Disable ${email}. They cannot sign in, and every application acting for them stops on its next request.`
              : `Enable ${email} again.`,
            [{ label: 'person', value: email }, { label: 'state', value: disabling ? 'disabled' : 'enabled' }],
            { person_id: person.id, disabled: disabling },
          )
        },
        async apply(call, input) {
          const id = ids(input, 'person_id')
          const change =
            name === 'set_person_role'
              ? { role: input.role === 'org_admin' ? ('org_admin' as const) : ('member' as const) }
              : { disabled: input.disabled === true }
          const outcome = await ports.users.update(auth(call), id, change)
          await record(
            call,
            name === 'set_person_role' ? { action: 'update_user' } : { action: 'disable_user' },
            outcome === 'updated' ? 'allow' : 'deny',
            { user_id: id },
            { ...change, outcome },
          )
          switch (outcome) {
            case 'updated':
              return { updated: true }
            case 'last-admin':
              throw new McpToolRefusal('That would leave the organization with no active administrator.')
            case 'platform-admin':
              throw new McpToolRefusal('That account administers the installation and is not changed from an organization.')
            default:
              throw new McpToolRefusal('That person is gone.')
          }
        },
      }),
    ),

    // ── workspaces and layers ──────────────────────────────────────────────
    {
      kind: 'write',
      name: 'create_workspace',
      title: 'Create a workspace',
      description: 'Propose a workspace — a group of layers that can be granted together.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'Lower case, digits and hyphens.' },
          name: { type: 'string' },
        },
        required: ['slug', 'name'],
        additionalProperties: false,
      },
      async propose(_call, args) {
        const slug = text(args, 'slug', 'the workspace slug', 63)
        const name = text(args, 'name', 'the workspace name', 200)
        return proposal(`Create the workspace ${slug} ("${name}").`, [{ label: 'slug', value: slug }, { label: 'name', value: name }], { slug, name })
      },
      async apply(call, input) {
        const slug = String(input.slug)
        const outcome = await ports.workspaces.create(auth(call), { slug, name: String(input.name) })
        await record(call, { action: 'create_workspace' }, outcome.kind === 'created' ? 'allow' : 'deny', { slug }, { outcome: outcome.kind })
        if (outcome.kind === 'conflict') throw new McpToolRefusal(`A workspace with the slug ${slug} already exists.`)
        if (outcome.kind !== 'created') throw new McpToolRefusal('You may not create a workspace here.')
        return { workspace_id: outcome.workspace.id }
      },
    },
    {
      kind: 'write',
      name: 'create_layer',
      title: 'Create a layer',
      description:
        "Propose a layer in a workspace. Its embedding model is the organization's, or the provider named when " +
        'the organization runs more than one.',
      inputSchema: {
        type: 'object',
        properties: {
          workspace: { type: 'string', description: "The workspace's slug." },
          slug: { type: 'string', description: 'Lower case, digits and hyphens. Clients address the layer by it, so it does not change later.' },
          name: { type: 'string' },
          provider: { type: 'string', description: 'An embedding provider, by name — only where the organization runs more than one.' },
        },
        required: ['workspace', 'slug', 'name'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const workspace = await names.workspace(a, text(args, 'workspace', "the workspace's slug", 63))
        const slug = text(args, 'slug', 'the layer slug', 63)
        const name = text(args, 'name', 'the layer name', 200)
        let providerId: string | undefined
        let providerName: string | undefined
        if (typeof args.provider === 'string' && args.provider !== '') {
          const found = await withOrg(
            ports.pool,
            a.orgId,
            async (client) =>
              (
                await client.query<{ id: string; name: string }>(
                  `SELECT id, name FROM embedding_providers
                    WHERE (org_id = $1 OR org_id IS NULL) AND ${isUuid(args.provider as string) ? 'id = $2::uuid' : 'name = $2'}
                    ORDER BY org_id NULLS LAST LIMIT 1`,
                  [a.orgId, args.provider],
                )
              ).rows[0],
            { role: ports.role },
          )
          if (found === undefined) throw new McpToolRefusal(`No embedding provider "${args.provider}" here.`)
          providerId = found.id
          providerName = found.name
        }
        return proposal(
          `Create the layer ${slug} ("${name}") in the workspace ${workspace.slug}.`,
          [
            { label: 'workspace', value: workspace.slug },
            { label: 'slug', value: slug },
            { label: 'name', value: name },
            ...(providerName === undefined ? [] : [{ label: 'provider', value: providerName }]),
          ],
          { workspace_id: workspace.id, slug, name, ...(providerId === undefined ? {} : { provider_id: providerId }) },
        )
      },
      async apply(call, input) {
        const slug = String(input.slug)
        const outcome = await ports.layers.create(auth(call), {
          workspaceId: ids(input, 'workspace_id'),
          slug,
          name: String(input.name),
          ...(typeof input.provider_id === 'string' ? { providerId: input.provider_id } : {}),
        })
        await record(call, { action: 'create_layer' }, outcome.kind === 'created' ? 'allow' : 'deny', { workspace_id: input.workspace_id, slug }, { outcome: outcome.kind })
        switch (outcome.kind) {
          case 'created':
            return { layer_id: outcome.layer.id }
          case 'conflict':
            throw new McpToolRefusal(`A layer with the slug ${slug} already exists.`)
          case 'provider':
            throw new McpToolRefusal(outcome.detail)
          default:
            throw new McpToolRefusal('That workspace is not one you may administer, or it is gone.')
        }
      },
    },
    {
      kind: 'write',
      name: 'update_layer',
      title: 'Rename a layer',
      description: "Propose a layer's new name or description. The slug does not change — clients address the layer by it.",
      inputSchema: {
        type: 'object',
        properties: { layer: LAYER_PROP, name: { type: 'string' }, description: { type: 'string' } },
        required: ['layer'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const layer = await names.layer(auth(call), text(args, 'layer', "the layer's slug", 63))
        const name = optionalText(args, 'name', 200)
        const description = optionalText(args, 'description', 2000)
        if (name === undefined && description === undefined) throw new McpToolRefusal("Give a new 'name', a new 'description', or both.")
        return proposal(
          `Change the layer ${layer.slug}'s ${[name === undefined ? '' : 'name', description === undefined ? '' : 'description'].filter(Boolean).join(' and ')}.`,
          [
            { label: 'layer', value: layer.slug },
            ...(name === undefined ? [] : [{ label: 'name', value: name }]),
            ...(description === undefined ? [] : [{ label: 'description', value: description }]),
          ],
          { layer_id: layer.id, ...(name === undefined ? {} : { name }), ...(description === undefined ? {} : { description }) },
        )
      },
      async apply(call, input) {
        const id = ids(input, 'layer_id')
        const updated =
          ports.layers.update === undefined
            ? false
            : await ports.layers.update(auth(call), id, {
                ...(typeof input.name === 'string' ? { name: input.name } : {}),
                ...(typeof input.description === 'string' ? { description: input.description } : {}),
              })
        await record(call, { action: 'update_layer' }, updated ? 'allow' : 'deny', { layer_id: id }, { layer_id: id })
        if (!updated) throw new McpToolRefusal('That layer is not one you may administer, or it is gone.')
        return { updated: true }
      },
    },
    {
      kind: 'write',
      name: 'delete_layer',
      title: 'Delete a layer',
      description: 'Propose deleting a layer and every document in it. Searches stop returning them the moment it is applied.',
      inputSchema: {
        type: 'object',
        properties: { layer: LAYER_PROP },
        required: ['layer'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const layer = await names.layer(a, text(args, 'layer', "the layer's slug", 63))
        const counts = await names.counts(a, { layer: layer.id })
        return proposal(
          `Delete the layer ${layer.slug} and its ${String(counts.documents)} document${counts.documents === 1 ? '' : 's'}. Searches stop returning them at once; the ${String(counts.grants)} grant${counts.grants === 1 ? '' : 's'} on it go too. This cannot be undone.`,
          [
            { label: 'layer', value: layer.slug },
            { label: 'documents', value: String(counts.documents) },
            { label: 'grants removed', value: String(counts.grants) },
          ],
          { layer_id: layer.id },
        )
      },
      async apply(call, input) {
        const id = ids(input, 'layer_id')
        const removed = ports.layers.remove === undefined ? false : await ports.layers.remove(auth(call), id)
        await record(call, { action: 'delete_layer' }, removed ? 'allow' : 'deny', { layer_id: id }, { layer_id: id })
        if (!removed) throw new McpToolRefusal('That layer is not one you may administer, or it is gone.')
        return { deleted: true }
      },
    },

    // ── skills ─────────────────────────────────────────────────────────────
    {
      kind: 'write',
      name: 'write_skill',
      title: 'Write a skill',
      description:
        "Propose a new version of the organization's skill, or of a layer's. The files are a folder in Claude's skill " +
        'format, as files or as a base64 zip. Agents on the ordinary surface follow it; this surface never does.',
      inputSchema: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: "A layer's slug; the organization's skill when absent." },
          files: { type: 'object', additionalProperties: { type: 'string' }, description: 'Path to text, SKILL.md first.' },
          zip_base64: { type: 'string', description: 'The folder as the .zip Claude exports, base64.' },
        },
        additionalProperties: false,
      },
      async propose(call, args) {
        const { level, where, layer } = await skillLevel(call, args)
        if ((args.files === undefined) === (args.zip_base64 === undefined)) {
          throw new McpToolRefusal('Send the skill as files or as zip_base64 — exactly one.')
        }
        let files: unknown = args.files
        if (typeof args.zip_base64 === 'string') {
          const read = readSkillZip(Buffer.from(args.zip_base64, 'base64'))
          if ('error' in read) throw new McpToolRefusal(`Not a skill zip: ${read.error}.`)
          files = read.files
        }
        if (files === null || typeof files !== 'object' || Object.values(files).some((v) => typeof v !== 'string')) {
          throw new McpToolRefusal("'files' maps each path to its text.")
        }
        const paths = Object.keys(files as Record<string, string>).sort()
        const based = await currentVersion(call, level)
        return proposal(
          `Write ${where} as version ${String(based + 1)}: ${String(paths.length)} file${paths.length === 1 ? '' : 's'}${paths.some((p) => p.startsWith('scripts/')) ? ', including scripts' : ''}.`,
          [
            { label: 'skill', value: where },
            { label: 'version', value: `${String(based)} → ${String(based + 1)}` },
            { label: 'files', value: paths.join(', ').slice(0, 900) },
            { label: 'note', value: 'Written by an agent, and marked as such in the history.' },
          ],
          { ...(layer === undefined ? {} : { layer_id: layer }), files, based_on: based },
        )
      },
      async apply(call, input) {
        const level = storedLevel(input)
        const outcome = await ports.skills.write(auth(call), level, input.files, Number(input.based_on), 'mcp-admin')
        return skillOutcome(call, outcome.kind === 'written' && outcome.cleared ? SKILL.cleared : SKILL.updated, level, outcome)
      },
    },
    {
      kind: 'write',
      name: 'restore_skill',
      title: 'Restore a skill version',
      description: "Propose bringing back an earlier version of the organization's or a layer's skill, as a new version.",
      inputSchema: {
        type: 'object',
        properties: {
          layer: { type: 'string', description: "A layer's slug; the organization's skill when absent." },
          version: { type: 'integer', minimum: 1 },
        },
        required: ['version'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const { level, where, layer } = await skillLevel(call, args)
        const n = typeof args.version === 'number' ? Math.trunc(args.version) : Number.NaN
        if (!Number.isInteger(n) || n < 1) throw new McpToolRefusal("'version' is a version number from the skill's history.")
        const old = await ports.skills.version(auth(call), level, n)
        if (old === undefined) throw new McpToolRefusal(`${where} has no version ${String(n)}.`)
        const based = await currentVersion(call, level)
        return proposal(
          `Bring back version ${String(n)} of ${where} as version ${String(based + 1)}.`,
          [
            { label: 'skill', value: where },
            { label: 'restoring', value: `version ${String(n)}${old.name === null ? ' (empty)' : ` — ${old.name}`}` },
            { label: 'version', value: `${String(based)} → ${String(based + 1)}` },
          ],
          { ...(layer === undefined ? {} : { layer_id: layer }), version: n, based_on: based },
        )
      },
      async apply(call, input) {
        const level = storedLevel(input)
        const outcome = await ports.skills.restore(auth(call), level, Number(input.version), Number(input.based_on), 'mcp-admin')
        return skillOutcome(call, SKILL.restored, level, outcome)
      },
    },
    {
      kind: 'write',
      name: 'clear_skill',
      title: 'Clear a skill',
      description:
        "Propose clearing the organization's skill — agents fall back to the installation's — or a layer's, which " +
        'leaves the layer with none. The history stays.',
      inputSchema: {
        type: 'object',
        properties: { layer: { type: 'string', description: "A layer's slug; the organization's skill when absent." } },
        additionalProperties: false,
      },
      async propose(call, args) {
        const { level, where, layer } = await skillLevel(call, args)
        const based = await currentVersion(call, level)
        if (based === 0) throw new McpToolRefusal(`${where} is not set.`)
        return proposal(
          `Clear ${where}. The history stays, and any version can be restored.`,
          [{ label: 'skill', value: where }, { label: 'version', value: `${String(based)} → ${String(based + 1)} (empty)` }],
          { ...(layer === undefined ? {} : { layer_id: layer }), based_on: based },
        )
      },
      async apply(call, input) {
        const level = storedLevel(input)
        const outcome = await ports.skills.write(auth(call), level, {}, Number(input.based_on), 'mcp-admin')
        return skillOutcome(call, SKILL.cleared, level, outcome)
      },
    },

    // ── connections ────────────────────────────────────────────────────────
    {
      kind: 'write',
      name: 'revoke_connection',
      title: 'Revoke a connection',
      description: 'Propose ending a connected application, by the id list_connections gives. It stops on its next request.',
      inputSchema: {
        type: 'object',
        properties: { connection: { type: 'string', description: 'The connection id, from list_connections.' } },
        required: ['connection'],
        additionalProperties: false,
      },
      async propose(call, args) {
        const a = auth(call)
        const id = text(args, 'connection', 'the connection id from list_connections', 64).replace(/^connection:/, '')
        const found = (await ports.consents.list(a)).find((c) => c.id === id && c.revokedAt === null)
        if (found === undefined) throw new McpToolRefusal(`No live connection "${id}" in this organization.`)
        const who = found.subject.actsAs === 'user' ? (found.approvedByEmail ?? found.approvedBy) : (found.serviceAccountName ?? 'a service account')
        return proposal(
          `End ${found.clientName ?? 'the application'}'s ${found.surface === 'admin' ? 'administrative ' : ''}connection, acting as ${who}. It stops on its next request.`,
          [
            { label: 'application', value: found.clientName ?? id },
            { label: 'acts as', value: who },
            { label: 'surface', value: found.surface === 'admin' ? 'administrative MCP' : 'MCP and the API' },
            ...(id === a.delegation?.id ? [{ label: 'note', value: 'This is the connection proposing it.' }] : []),
          ],
          { connection_id: id },
        )
      },
      async apply(call, input) {
        const id = ids(input, 'connection_id')
        const revoked = await ports.consents.revoke(auth(call), id, 'mcp-admin')
        await record(call, { action: 'oauth.revoke' }, revoked ? 'allow' : 'deny', { connection_id: id })
        if (!revoked) throw new McpToolRefusal('That connection is already gone.')
        return { revoked: true }
      },
    },
  ]
}
