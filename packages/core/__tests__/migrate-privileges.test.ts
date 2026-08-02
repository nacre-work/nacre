import { describe, expect, it } from 'vitest'

import { requireMigrationPrivileges, type RoleReader } from '../db/migrate.js'

/**
 * The premise of this check — that a plain table owner cannot run migrations
 * 0006, 0007, 0017 or 0018 because `FORCE ROW LEVEL SECURITY` applies the
 * policy to the owner and the policy reads an unset GUC — was established
 * against a real PostgreSQL, not here. Four migrations failed with
 * `unrecognized configuration parameter "app.current_org"`, all eighteen
 * applied once the role was given BYPASSRLS, and dropping FORCE was confirmed
 * to be what made the difference.
 *
 * What is worth pinning in a unit test is the decision and the message: which
 * roles are let through, and whether the refusal actually hands over a remedy
 * that works. The second is the part that was wrong in migration 0008's own
 * hint, which cannot be corrected in place because applied migrations are
 * checksummed.
 */
const role = (r: { superuser?: boolean; bypassrls?: boolean } | null): RoleReader => ({
  query: async <T,>() => ({
    rows: (r === null ? [] : [{ superuser: false, bypassrls: false, ...r }]) as T[],
  }),
})

/**
 * The refusal a plain owner gets. Throwing when it does *not* refuse matters:
 * a `.catch()` that returns undefined would leave every assertion below
 * checking a message that was never produced.
 */
async function refusal(): Promise<Error> {
  try {
    await requireMigrationPrivileges(role({}))
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a plain owner to be refused, and it was let through')
}

describe('migration privileges', () => {
  it('lets a superuser through', async () => {
    await expect(requireMigrationPrivileges(role({ superuser: true }))).resolves.toBeUndefined()
  })

  it('lets a role with BYPASSRLS through — the shape a deployment should use', async () => {
    await expect(requireMigrationPrivileges(role({ bypassrls: true }))).resolves.toBeUndefined()
  })

  it('refuses a plain owner', async () => {
    await expect(requireMigrationPrivileges(role({}))).rejects.toThrow(
      /neither bypass row-level security nor is a superuser/,
    )
  })

  it('hands the plain owner a remedy that is complete', async () => {
    // Both lines matter and each was found by running it. BYPASSRLS is what
    // the four tenant-reading migrations need. WITH ADMIN OPTION is what 0008
    // needs to run `GRANT nacre_worker TO nacre_app`, and plain membership is
    // demonstrably not enough — "permission denied to grant role" — which is
    // exactly what 0008's own hint tells an operator to do.
    const error = await refusal()

    expect(error.message).toContain('ALTER ROLE <the role in NACRE_PG_URL> BYPASSRLS;')
    expect(error.message).toContain('WITH ADMIN OPTION')
    expect(error.message).toContain('nacre_worker')
  })

  it('names the error the operator would otherwise have seen', async () => {
    // The whole point of failing here is that the real failure arrives five
    // migrations in and names a GUC rather than a role. Someone searching for
    // that string should land on this message.
    const error = await refusal()

    expect(error.message).toContain('app.current_org')
  })

  it('says the application role is a different role', async () => {
    // Without this the obvious reading is "give NACRE_PG_URL's role BYPASSRLS",
    // and a deployment with one credential would do exactly that — handing the
    // application a role that bypasses every policy in the schema.
    const error = await refusal()

    expect(error.message).toMatch(/not the role the application connects as/)
  })

  it('does not refuse when the role cannot be read at all', async () => {
    // `current_user` always matches a row in practice. If it somehow does not,
    // blocking every migration on a failed introspection query would be a
    // worse failure than the one being prevented — and the migration itself
    // still fails safely, in its own transaction, if the privileges are
    // genuinely missing.
    await expect(requireMigrationPrivileges(role(null))).resolves.toBeUndefined()
  })
})
