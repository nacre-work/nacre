import { NacreClient, type AuditRecord } from '@nacre.work/sdk'

import { integer, option, UsageError } from './args.js'
import { render, requireClient, type Context } from './commands.js'

/**
 * The `org_admin` surface: people, teams, keys, and the access log.
 *
 * Every one of these already existed in the API and in the admin UI, and none
 * of them was reachable from a terminal — so an administrator scripting an
 * onboarding went back to `curl` with a hand-assembled body and a token in a
 * variable. That is the same shape of hole `/v1/users` itself closed: the model
 * offers something the product gives no route to, and people find `psql`. One
 * level up, the route they found instead was `curl`.
 *
 * Separate from `commands.ts` because the two answer different questions. That
 * file is the first mile — from a clean installation to a first search — and
 * this is administration of one that already runs. They share `Context` and
 * nothing else.
 *
 * Nothing here holds a second idea of what the API is; it is the SDK with
 * argument parsing and a table in front of it.
 */

/**
 * A secret this command is the only chance to read.
 *
 * A generated password and a service account key are returned once, by an
 * endpoint that stores a scrypt hash, so neither is recoverable from the
 * database or from a backup. Printing it under a line that says so is not
 * decoration — the alternative is somebody assuming they can look it up.
 */
function once(what: string, secret: string): string {
  return `${what}: ${secret}\n\nNot shown again and not recoverable — it is stored hashed.`
}

/** A row is missing, or the caller may not see it. The server does not say which, so neither does this. */
function refused(what: string, id: string): Error {
  return new Error(
    `No ${what} ${JSON.stringify(id)} you can administer. Not finding it and not being ` +
      'allowed to act on it are the same answer here.',
  )
}

export async function users(context: Context): Promise<string> {
  const client = requireClient(context)
  const [, verb, argument] = context.parsed.positional

  if (verb === 'create') return createUser(context, client, argument)
  if (verb === 'disable') return disableUser(context, client, argument)
  if (verb === 'password') return resetPassword(context, client, argument)
  if (verb === 'role') return setRole(context, client, argument)
  if (verb !== undefined) throw new UsageError(`Unknown: nacre users ${verb}`)

  const list = await client.users.list()

  return render(context, list, () => {
    if (list.length === 0) return 'No users. This needs org_admin — a member sees nothing here.'

    const width = Math.max(...list.map((user) => user.email.length))
    return list
      .map((user) => {
        const state = user.disabledAt === null ? '' : '  disabled'
        // An account with no local password signs in through the SSO module,
        // and an administrator looking at this list is usually asking exactly
        // that: why can this person not sign in.
        const sso = user.hasPassword ? '' : '  sso-only'
        return `${user.email.padEnd(width)}  ${user.role.padEnd(9)}  ${user.id}${state}${sso}`
      })
      .join('\n')
  })
}

async function createUser(context: Context, client: NacreClient, email?: string): Promise<string> {
  if (email === undefined) throw new UsageError('nacre users create <email> [--admin]')

  // Deliberately no `--password`. The endpoint generates one and refuses to
  // accept one, on two arguments: an argument ends up in a shell history, and a
  // password an administrator chose is a password they know.
  if (option(context.parsed, 'password') !== undefined) {
    throw new UsageError(
      'A password is generated, never given. It is printed once by this command. ' +
        '`nacre users password <id>` issues a new one.',
    )
  }

  const created = await client.users.create(email, context.parsed.options.has('admin') ? 'org_admin' : 'member')

  return render(context, created, () =>
    `Created ${created.email} (${created.role})\nid: ${created.id}\n\n${once('Password', created.password)}`,
  )
}

async function disableUser(context: Context, client: NacreClient, id?: string): Promise<string> {
  if (id === undefined) throw new UsageError('nacre users disable <id>')

  // A refusal to strand the organization without an administrator arrives as a
  // `409` and is not a `404`, so it travels as its own error rather than being
  // flattened into "no such user" — the two need opposite responses.
  const done = await client.users.disable(id)
  if (!done) throw refused('user', id)

  return render(context, { id, disabled: true }, () => `Disabled ${id}. The row is kept: the access log names this id.`)
}

async function resetPassword(context: Context, client: NacreClient, id?: string): Promise<string> {
  if (id === undefined) throw new UsageError('nacre users password <id>')

  const password = await client.users.resetPassword(id)
  if (password === undefined) throw refused('user', id)

  return render(context, { id, password }, () => once(`New password for ${id}`, password))
}

async function setRole(context: Context, client: NacreClient, id?: string): Promise<string> {
  const role = context.parsed.positional[3]
  if (id === undefined || role === undefined) throw new UsageError('nacre users role <id> <member|org_admin>')
  if (role !== 'member' && role !== 'org_admin') {
    throw new UsageError(
      `Role is member or org_admin, not ${JSON.stringify(role)}. platform_admin spans tenants and ` +
        'is refused from an endpoint scoped to one organization.',
    )
  }

  const done = await client.users.update(id, { role })
  if (!done) throw refused('user', id)

  return render(context, { id, role }, () => `${id} is now ${role}.`)
}

export async function groups(context: Context): Promise<string> {
  const client = requireClient(context)
  const [, verb, argument] = context.parsed.positional

  if (verb === 'create') return createGroup(context, client, argument)
  if (verb === 'delete') return deleteGroup(context, client, argument)
  if (verb === 'members') return listMembers(context, client, argument)
  if (verb === 'add' || verb === 'remove') return changeMembership(context, client, verb, argument)
  if (verb !== undefined) throw new UsageError(`Unknown: nacre groups ${verb}`)

  const list = await client.groups.list()

  return render(context, list, () => {
    if (list.length === 0) return 'No groups. `nacre groups create <name>` makes one; grants can name it.'

    const width = Math.max(...list.map((group) => group.name.length))
    return list
      .map((group) => `${group.name.padEnd(width)}  ${group.memberCount} members  ${group.id}`)
      .join('\n')
  })
}

async function createGroup(context: Context, client: NacreClient, name?: string): Promise<string> {
  if (name === undefined) throw new UsageError('nacre groups create <name>')
  const created = await client.groups.create(name)
  return render(context, created, () => `Created group ${created.name}\nid: ${created.id}`)
}

async function deleteGroup(context: Context, client: NacreClient, id?: string): Promise<string> {
  if (id === undefined) throw new UsageError('nacre groups delete <id>')

  const done = await client.groups.remove(id)
  if (!done) throw refused('group', id)

  // Deleted rather than disabled, which is the asymmetry with a user and is
  // structural: the access log names a user id and `grants.created_by`
  // references one, so a deleted user is an unresolvable reference in the one
  // record that must not have them. Nothing points at a group that way — and
  // nothing would remove its grants either, so the endpoint takes them in the
  // same transaction.
  return render(context, { id, deleted: true }, () => `Deleted group ${id}, and the grants naming it.`)
}

async function listMembers(context: Context, client: NacreClient, id?: string): Promise<string> {
  if (id === undefined) throw new UsageError('nacre groups members <id>')

  // `undefined` is no such group; an empty array is a group with nobody in it.
  // Collapsing the two would report an invisible group as an empty one.
  const members = await client.groups.members(id)
  if (members === undefined) throw refused('group', id)

  return render(context, members, () => {
    if (members.length === 0) return 'No members. `nacre groups add <group-id> user:<id>` puts somebody in.'
    return members.map((member) => `${member.type.padEnd(5)}  ${member.label}  ${member.id}`).join('\n')
  })
}

async function changeMembership(
  context: Context,
  client: NacreClient,
  verb: 'add' | 'remove',
  id?: string,
): Promise<string> {
  const member = context.parsed.positional[3]
  if (id === undefined || member === undefined) {
    throw new UsageError(`nacre groups ${verb} <group-id> <user:id|group:id>`)
  }

  const at = member.indexOf(':')
  const type = at === -1 ? '' : member.slice(0, at)
  const memberId = at === -1 ? '' : member.slice(at + 1)
  if ((type !== 'user' && type !== 'group') || memberId === '') {
    throw new UsageError(`A member is user:<id> or group:<id>, not ${JSON.stringify(member)}`)
  }

  const done =
    verb === 'add'
      ? await client.groups.addMember(id, { type, id: memberId })
      : await client.groups.removeMember(id, { type, id: memberId })
  if (!done) throw refused('group or member', `${id}/${member}`)

  return render(context, { group: id, member: { type, id: memberId }, [verb]: true }, () =>
    verb === 'add' ? `${member} is in ${id}.` : `${member} is out of ${id}.`,
  )
}

export async function serviceAccounts(context: Context): Promise<string> {
  const client = requireClient(context)
  const [, verb, argument] = context.parsed.positional

  if (verb === 'create') return createServiceAccount(context, client, argument)
  if (verb === 'revoke') return revokeServiceAccount(context, client, argument)
  if (verb !== undefined) throw new UsageError(`Unknown: nacre service-accounts ${verb}`)

  const list = await client.serviceAccounts.list()

  return render(context, list, () => {
    if (list.length === 0) return 'No service accounts. `nacre service-accounts create <name>` mints one.'

    const width = Math.max(...list.map((account) => account.name.length))
    return list
      .map((account) => {
        const used = account.lastUsedAt === null ? 'never used' : `used ${account.lastUsedAt}`
        const state = account.revokedAt === null ? '' : '  revoked'
        return `${account.name.padEnd(width)}  ${account.keyPrefix}…  ${used}  ${account.id}${state}`
      })
      .join('\n')
  })
}

async function createServiceAccount(context: Context, client: NacreClient, name?: string): Promise<string> {
  if (name === undefined) throw new UsageError('nacre service-accounts create <name>')

  const created = await client.serviceAccounts.create(name)

  return render(context, created, () =>
    `Created ${created.name}\nid: ${created.id}\n\n${once('Key', created.key)}\n\n` +
      'It holds nothing until it is granted something:\n' +
      `  nacre grant write layer:<slug> --to service_account:${created.id}`,
  )
}

async function revokeServiceAccount(context: Context, client: NacreClient, id?: string): Promise<string> {
  if (id === undefined) throw new UsageError('nacre service-accounts revoke <id>')

  const done = await client.serviceAccounts.revoke(id)
  if (!done) throw refused('service account', id)

  return render(context, { id, revoked: true }, () => `Revoked ${id}. Requests carrying that key now fail.`)
}

/**
 * The access log, walked to the end of what was asked for.
 *
 * **It follows the cursor** rather than printing one page, and that is the
 * point rather than a convenience. A page is a page whatever the cursor does,
 * so a client that asks for one cannot tell a working cursor from a stuck one —
 * which is exactly how this API's pagination shipped broken twice, once
 * repeating a row forever and once skipping every event between a truncated
 * bound and the real value. `--limit` is a number of records, not of pages.
 *
 * What appears here is what the deployment decided to store. A search leaves a
 * `query_hash` always and the query text only where `NACRE_AUDIT_QUERY_TEXT`
 * says so; this command does not choose that and does not filter it back out.
 */
export async function audit(context: Context): Promise<string> {
  const client = requireClient(context)
  const limit = integer(context.parsed, 'limit') ?? 50

  const RESULTS = ['allow', 'deny', 'error'] as const
  const given = option(context.parsed, 'result')
  if (given !== undefined && !RESULTS.includes(given as (typeof RESULTS)[number])) {
    throw new UsageError(`--result is allow, deny or error, not ${JSON.stringify(given)}`)
  }
  const result = given as (typeof RESULTS)[number] | undefined

  const query = {
    ...(option(context.parsed, 'action') === undefined ? {} : { action: option(context.parsed, 'action') as string }),
    ...(option(context.parsed, 'actor') === undefined ? {} : { actorId: option(context.parsed, 'actor') as string }),
    ...(option(context.parsed, 'from') === undefined ? {} : { from: option(context.parsed, 'from') as string }),
    ...(option(context.parsed, 'to') === undefined ? {} : { to: option(context.parsed, 'to') as string }),
    ...(result === undefined ? {} : { result }),
  }

  const records: AuditRecord[] = []
  let cursor: string | undefined

  while (records.length < limit) {
    const page = await client.audit.read({
      ...query,
      limit: Math.min(100, limit - records.length),
      ...(cursor === undefined ? {} : { cursor }),
    })

    records.push(...page.items)

    // The end of the log, not the end of a page. A server that stopped
    // advancing would otherwise spin here, so an empty page ends it too.
    if (page.nextCursor === undefined || page.items.length === 0) break
    cursor = page.nextCursor
  }

  return render(context, records, () => {
    if (records.length === 0) {
      // Two different situations with one output, and saying the wrong one
      // sends the reader to the wrong place. An unfiltered empty log is a
      // question about the caller's role; a filtered one is almost always a
      // filter that matches nothing — `--action user.create` returns nothing
      // and looks identical to no permission, which is how this message got
      // written the second time.
      if (Object.keys(query).length === 0) {
        return 'Nothing in the log. org_admin sees document reads; platform_admin sees administration and never those.'
      }
      return (
        'Nothing matches those filters. --action takes the name as it is recorded — ' +
        '`create_user`, `disable_user`, `audit.read` — and the log does not spell them all one way.'
      )
    }

    return records
      .map((record) => {
        const who = record.actor.label ?? record.actor.id ?? 'anonymous'
        const where = record.surface === null ? '' : ` via ${record.surface}`
        // **Both**, and this is the whole of what running it found. The record
        // carries two objects for one idea — what was acted on — and which one
        // a handler fills depends on the handler: `audit.read` writes `target`
        // and every administrative event writes `detail`. So a renderer reading
        // one of them prints nothing about the object for half the log, which
        // is what the first version of this did for `create_user`,
        // `disable_user`, `reset_password` and every other line an
        // administrator opens this command to read.
        //
        // No test could have caught it. A fixture written beside this code
        // fills the field the code reads.
        const target = Object.entries({ ...record.target, ...record.detail })
          .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
          .join(' ')
        // `allow` is every other line and marking it would hide the two that
        // matter. A denial is what somebody reading a log came for.
        const outcome = record.result === 'allow' ? '' : `  ${record.result.toUpperCase()}`
        return `${record.occurredAt}  ${record.action.padEnd(18)}${outcome}  ${who}${where}  ${target}`.trimEnd()
      })
      .join('\n')
  })
}
