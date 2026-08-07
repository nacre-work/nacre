import {
  ConfigError,
  createPool,
  generatePassword,
  hashPassword,
  loadConfig,
  loadJwtKeys,
  organizationSlugError,
  provisionOrganization,
  VectorStore,
  vectorStoreOptions,
} from '@nacre.work/core'
import type { ProvisionOptions } from '@nacre.work/core'
import { SignJWT } from 'jose'
import { pathToFileURL } from 'node:url'

/**
 * Create the first organization — the command, not the provisioning.
 *
 * What a new organization is made of lives in `provisionOrganization`, in the
 * core, because this command is one caller and not the definition. Everything
 * here is what a *terminal* needs and an API caller does not: parsing
 * arguments, generating a password that must never come from one, minting a
 * token to get through the quickstart, and printing all of it.
 *
 * A one-shot command rather than an endpoint, because an HTTP route that
 * creates the *first* organization has to be reachable before any organization
 * exists, which means unauthenticated, which means it has to be disabled again
 * afterwards. Every version of that is a race between the first deploy and the
 * internet. A command runs where the operator already has credentials.
 *
 * Idempotent, because the function it calls is: run it twice and the second run
 * reports what already existed and changes nothing.
 */

export type Options = ProvisionOptions

export function parseArgs(argv: readonly string[]): Options | string {
  const values = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      return 'usage: nacre-init --org <slug> --email <address> [--name <display name>] [--workspace <slug>]'
    }
    values.set(key.slice(2), value)
  }

  const slug = values.get('org')
  const email = values.get('email')
  if (slug === undefined || email === undefined) {
    return 'usage: nacre-init --org <slug> --email <address> [--name <display name>] [--workspace <slug>]'
  }
  // The same rule `provisionOrganization` applies, asked here only to turn it
  // into a usage message. The function refuses regardless, which is what keeps
  // this from being the copy that drifts.
  const wrong = organizationSlugError(slug)
  if (wrong !== undefined) return `--org ${wrong}`
  if (!email.includes('@')) return `--email does not look like an address: ${email}`

  return {
    slug,
    email,
    name: values.get('name') ?? slug,
    workspace: values.get('workspace') ?? 'default',
  }
}

const say = (msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ msg, ...extra }))
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') throw new ConfigError([parsed])

  const config = loadConfig()
  // Through the same loader the API uses rather than reading the secret here.
  // Two readers of "what signs a token" is how a deployment ends up with an
  // `init` that mints HS256 while the API verifies EdDSA, which reads as a
  // wrong password rather than as a misconfiguration.
  const jwt = loadJwtKeys()

  // Generated, never taken from an argument: `init` runs in a terminal, and an
  // argument ends up in the shell history and in `ps` on a shared machine. Six
  // words from the CSPRNG rather than a random string, because this is typed
  // by a person into a sign-in form at least once.
  const password = generatePassword()
  const passwordHash = await hashPassword(password)

  const pool = createPool({ connectionString: config.pgUrl, max: 2 })
  const vectors = new VectorStore(vectorStoreOptions(config))

  try {
    // Both stores, in the order that survives a failure between them, and with
    // the collection's slot named after the provider that was actually
    // resolved rather than after this process's configuration. See
    // `provisionOrganization`.
    const ids = await provisionOrganization(
      pool,
      vectors,
      { ...parsed, passwordHash },
      {
        endpoint: config.embeddingEndpoint,
        model: config.embeddingModel,
        dimensions: config.embeddingDim,
      },
      say,
    )

    // A short life on purpose. It is signed by the same key the API verifies
    // with, printed to a terminal and probably into a shell history; it exists
    // to get through the quickstart, not to be the credential an installation
    // runs on.
    const token = await new SignJWT({
      org: ids.orgId,
      principal_type: 'user',
      role: 'org_admin',
    })
      .setProtectedHeader({
        alg: jwt.algorithm,
        ...(jwt.keyId === undefined ? {} : { kid: jwt.keyId }),
      })
      .setSubject(ids.userId)
      .setIssuer(config.jwtIssuer)
      .setAudience(config.jwtAudience)
      .setExpirationTime('1h')
      .sign(jwt.signing)

    console.log('')
    console.log(`Organization ${parsed.slug} is ready.`)
    console.log('')
    console.log(`  Workspace id  ${ids.workspaceId}`)
    console.log(`  Admin user    ${parsed.email}`)
    console.log('')
    console.log('An administrator token, valid for one hour:')
    console.log('')
    console.log(`  export NACRE_TOKEN=${token}`)
    console.log('')

    // Only when this run is what set it.
    //
    // A re-run generates a plaintext like any other run and the database
    // deliberately keeps the stored hash, so the string in hand belongs to
    // nothing. Printing it under "a password for signing in" is the most
    // damaging thing this command could say: an operator writes it down,
    // discards the one that works, and finds out an hour later when the token
    // above expires. Found by running init twice and trying both.
    if (ids.passwordSet) {
      console.log('And a password for signing in, which is not printed again:')
      console.log('')
      console.log(`  ${password}`)
      console.log('')
      console.log(`  curl -X POST ${config.canonicalUrl}/v1/auth/login \\`)
      console.log(`    -H 'Content-Type: application/json' \\`)
      console.log(`    -d '{"email":"${parsed.email}","password":"…"}'`)
      console.log('')
    } else {
      console.log(`${parsed.email} already has a password and it is unchanged.`)
      console.log('')
      console.log('  This run set nothing. A re-run must not reset an administrator\'s')
      console.log('  password, or anyone who can run init can lock out the person who did.')
      console.log('')
    }
    console.log('Create a layer with it, then follow docs/quickstart.md:')
    console.log('')
    console.log(`  curl -X POST ${config.canonicalUrl}/v1/layers \\`)
    console.log(`    -H "Authorization: Bearer $NACRE_TOKEN" -H 'Content-Type: application/json' \\`)
    console.log(
      `    -d '{"workspace_id":"${ids.workspaceId}","slug":"handbook","name":"Handbook"}'`,
    )
    console.log('')
  } finally {
    await pool.end()
  }
}

// Only when run as a command. This module is also imported — `parseArgs` is the
// part with a test on it — and an unguarded call here runs the whole command on
// import, which under a test runner means `process.exit(2)` in the middle of
// somebody else's suite.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      console.error(error.message)
      process.exit(2)
    }
    console.error(JSON.stringify({ msg: 'init failed', error: String(error) }))
    process.exit(1)
  })
}
