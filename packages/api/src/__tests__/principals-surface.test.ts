import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type Groups, type Users } from '../index.js'

/**
 * `/v1/users` and `/v1/groups` — the principals a grant is issued to.
 *
 * Storage is injected. What is under test is what this layer decides: the
 * `org_admin` gate and the `404` it wears, the refusal to mint a
 * `platform_admin`, the last-administrator guard, and that every refusal —
 * including the ones that surface as `404` — leaves a `deny` in the journal.
 * Whether Postgres writes the row is the adapter's business and is checked
 * against a real one.
 */

const SECRET = new TextEncoder().encode('a'.repeat(32))
const ISSUER = 'https://api.nacre.test'
const AUDIENCE = 'nacre'

const ORG = '11111111-1111-1111-1111-111111111111'
const USER = 'cccccccc-0000-4000-8000-000000000001'
const LAST_ADMIN = 'cccccccc-0000-4000-8000-000000000002'
const GROUP = 'bbbbbbbb-0000-4000-8000-000000000001'
const ABSENT = 'bbbbbbbb-0000-4000-8000-0000000000ff'

const audited: AuditEvent[] = []

const users: Users = {
  list: async () => ({
    nextCursor: null,
    items: [
      {
        id: USER,
        email: 'dana@example.test',
        role: 'member',
        createdAt: '2026-01-01T00:00:00.000Z',
        disabledAt: null,
        hasPassword: true,
      },
    ],
  }),
  create: async (_a, email, role) =>
    email === 'taken@example.test'
      ? undefined
      : {
          password: 'reef-lustre-tide-keel-prism-shoal-42',
          user: {
            id: USER,
            email,
            role,
            createdAt: '2026-01-01T00:00:00.000Z',
            disabledAt: null,
            hasPassword: true,
          },
        },
  update: async (_a, id) => (id === LAST_ADMIN ? 'last-admin' : id === USER ? 'updated' : 'no-user'),
  resetPassword: async (_a, id) => (id === USER ? 'brine-coral-fathom-sound-mantle-drift-19' : undefined),
}

const groups: Groups = {
  list: async () => ({
    nextCursor: null,
    items: [{ id: GROUP, name: 'legal', createdAt: '2026-01-01T00:00:00.000Z', memberCount: 2 }],
  }),
  create: async (_a, name) =>
    name === 'legal'
      ? undefined
      : { id: GROUP, name, createdAt: '2026-01-01T00:00:00.000Z', memberCount: 0 },
  remove: async (_a, id) => id === GROUP,
  members: async (_a, id) =>
    id !== GROUP
      ? undefined
      : {
          nextCursor: null,
          items: [{ type: 'user', id: USER, label: 'dana@example.test' }],
        },
  addMember: async (_a, groupId, member) =>
    groupId !== GROUP ? 'no-group' : member.id === ABSENT ? 'no-member' : 'added',
  removeMember: async (_a, groupId, member) => groupId === GROUP && member.id === USER,
}

let server: Server
let base: string

async function tokenFor(role: 'member' | 'org_admin'): Promise<string> {
  return new SignJWT({ org: ORG, principal_type: 'user', role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(role)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime('5m')
    .sign(SECRET)
}

const admin = async () => ({
  authorization: `Bearer ${await tokenFor('org_admin')}`,
  'content-type': 'application/json',
})

const member = async () => ({
  authorization: `Bearer ${await tokenFor('member')}`,
  'content-type': 'application/json',
})

const last = () => audited[audited.length - 1]

describe('users and groups', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: {
        write: async (event) => {
          audited.push(event)
        },
      },
      users,
      groups,
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    audited.length = 0
  })

  it('lists users for an org_admin', async () => {
    const res = await fetch(`${base}/v1/users`, { headers: await admin() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { email: string; has_password: boolean }[] }
    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.email).toBe('dana@example.test')
    // Whether one is set, and never anything derived from it. A hash reaching
    // this response would be an offline attack handed to every administrator.
    expect(body.items[0]).not.toHaveProperty('password_hash')
    expect(body.items[0]?.has_password).toBe(true)
  })

  it('a member gets 404 on every principal path, and the refusal is journalled', async () => {
    for (const path of ['/v1/users', '/v1/groups', `/v1/groups/${GROUP}/members`]) {
      audited.length = 0
      const res = await fetch(`${base}${path}`, { headers: await member() })

      // 404 and not 403: whether this organization has a user directory is not
      // something a member is told, which is invariant 4 applied to a
      // collection rather than to an object.
      expect(res.status).toBe(404)

      // The easiest event to miss, because the code path producing it is an
      // early return that reads like routing.
      expect(last()).toMatchObject({ action: 'administer_principals', result: 'deny' })
    }
  })

  it('creates a user and returns the password exactly once', async () => {
    const res = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ email: 'dana@example.test', role: 'member' }),
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { password: string; role: string }
    expect(body.password).toBe('reef-lustre-tide-keel-prism-shoal-42')
    expect(body.role).toBe('member')

    const event = last()
    expect(event).toMatchObject({ action: 'create_user', result: 'allow' })
    // The address and the role, never the password. This row is readable by
    // anyone holding the audit log, and the password is not recoverable from
    // anywhere else by design — putting it here would undo that.
    expect(JSON.stringify(event?.detail)).not.toContain('reef-lustre')
  })

  it('refuses to mint a platform_admin from inside an organization', async () => {
    const res = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ email: 'root@example.test', role: 'platform_admin' }),
    })

    // 400 rather than a silent downgrade to `member`. That role administers the
    // installation and spans tenants in the multi-tenancy module, so accepting
    // it here would be an escalation out of the organization the token names —
    // and quietly ignoring it would leave the caller believing they made one.
    expect(res.status).toBe(400)
    expect(((await res.json()) as { detail: string }).detail).toContain('platform_admin')
  })

  it('a duplicate address is 409, not 500 and not 404', async () => {
    const res = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ email: 'taken@example.test' }),
    })

    // The caller has proved they administer the organization, so this is a fact
    // about the resource rather than about what they can see.
    expect(res.status).toBe(409)
    expect(last()).toMatchObject({ action: 'create_user', result: 'deny' })
  })

  it('refuses to strand the organization without an administrator', async () => {
    for (const [method, body] of [
      ['DELETE', undefined],
      ['PATCH', JSON.stringify({ role: 'member' })],
    ] as const) {
      const res = await fetch(`${base}/v1/users/${LAST_ADMIN}`, {
        method,
        headers: await admin(),
        ...(body === undefined ? {} : { body }),
      })

      // Both spellings go through one call, so the guard cannot be walked
      // around by picking the other verb. 409 rather than 404: the caller is
      // looking straight at this user.
      expect(res.status).toBe(409)
      expect(((await res.json()) as { detail: string }).detail).toContain('org_admin')
      expect(last()?.result).toBe('deny')
    }
  })

  it('disables a user, and a password reset says nothing about the value', async () => {
    const disabled = await fetch(`${base}/v1/users/${USER}`, {
      method: 'DELETE',
      headers: await admin(),
    })
    expect(disabled.status).toBe(204)
    expect(last()).toMatchObject({ action: 'disable_user', result: 'allow' })

    const reset = await fetch(`${base}/v1/users/${USER}/password`, {
      method: 'POST',
      headers: await admin(),
    })
    expect(reset.status).toBe(200)
    expect(((await reset.json()) as { password: string }).password).toContain('brine')

    const event = last()
    expect(event).toMatchObject({ action: 'reset_password', result: 'allow' })
    expect(JSON.stringify(event?.detail)).not.toContain('brine')
  })

  it('a reset for a user that is not here is 404 and a deny', async () => {
    const res = await fetch(`${base}/v1/users/${ABSENT}/password`, {
      method: 'POST',
      headers: await admin(),
    })
    expect(res.status).toBe(404)
    expect(last()).toMatchObject({ action: 'reset_password', result: 'deny' })
  })

  it('creates a group, and a duplicate name is 409', async () => {
    const created = await fetch(`${base}/v1/groups`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ name: 'finance' }),
    })
    expect(created.status).toBe(201)
    expect((await created.json()) as { name: string }).toMatchObject({ name: 'finance', member_count: 0 })
    expect(last()).toMatchObject({ action: 'create_group', result: 'allow' })

    const dup = await fetch(`${base}/v1/groups`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ name: 'legal' }),
    })
    expect(dup.status).toBe(409)
    expect(last()).toMatchObject({ action: 'create_group', result: 'deny' })
  })

  it('adds and removes a member, and both ends of a bad edge are 404', async () => {
    const added = await fetch(`${base}/v1/groups/${GROUP}/members`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ type: 'user', id: USER }),
    })
    expect(added.status).toBe(204)
    expect(last()).toMatchObject({ action: 'add_group_member', result: 'allow' })

    const noGroup = await fetch(`${base}/v1/groups/${ABSENT}/members`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ type: 'user', id: USER }),
    })
    expect(noGroup.status).toBe(404)

    const noMember = await fetch(`${base}/v1/groups/${GROUP}/members`, {
      method: 'POST',
      headers: await admin(),
      body: JSON.stringify({ type: 'user', id: ABSENT }),
    })
    expect(noMember.status).toBe(404)
    expect(last()).toMatchObject({ action: 'add_group_member', result: 'deny' })

    // The type is in the path because the edge is keyed by which member column
    // it uses. A bare uuid does not identify one.
    const removed = await fetch(`${base}/v1/groups/${GROUP}/members/user/${USER}`, {
      method: 'DELETE',
      headers: await admin(),
    })
    expect(removed.status).toBe(204)
    expect(last()).toMatchObject({ action: 'remove_group_member', result: 'allow' })
  })

  it('lists direct members, and an unknown group is 404 rather than an empty page', async () => {
    const res = await fetch(`${base}/v1/groups/${GROUP}/members`, { headers: await admin() })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { items: unknown[] }).items).toHaveLength(1)

    // An empty group and a group that is not here are different answers, and
    // they are allowed to be: the caller is an org_admin who can list every
    // group, so this tells them nothing `GET /v1/groups` would not.
    const absent = await fetch(`${base}/v1/groups/${ABSENT}/members`, { headers: await admin() })
    expect(absent.status).toBe(404)
  })

  it('deletes a group', async () => {
    const res = await fetch(`${base}/v1/groups/${GROUP}`, {
      method: 'DELETE',
      headers: await admin(),
    })
    expect(res.status).toBe(204)
    expect(last()).toMatchObject({ action: 'delete_group', result: 'allow' })
  })

  it('answers 404 for the whole surface where the ports are absent', async () => {
    // Not a 501 and not a 500: a capability a build does not carry is
    // indistinguishable from a path that does not exist, which is the same rule
    // every other optional port here follows.
    const bare = createApi({
      verify: { key: SECRET, issuer: ISSUER, audience: AUDIENCE },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: { queue: async () => undefined, remove: async () => false },
      audit: { write: async () => undefined },
    })
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve))
    const at = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`

    try {
      for (const path of ['/v1/users', '/v1/groups', `/v1/groups/${GROUP}/members`]) {
        const res = await fetch(`${at}${path}`, { headers: await admin() })
        expect(res.status).toBe(404)
      }
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()))
    }
  })
})
