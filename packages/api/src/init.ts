import {
  collectionName,
  ConfigError,
  createPool,
  hashPassword,
  loadConfig,
  loadJwtKeys,
  vectorName,
  VectorStore,
} from '@nacre.work/core'
import { SignJWT } from 'jose'
import type { Pool } from 'pg'
import { randomInt } from 'node:crypto'
import { pathToFileURL } from 'node:url'

/**
 * Create the first organization.
 *
 * Everything else in this repository assumes an organization, a user, an
 * embedding provider, a workspace and a Qdrant collection already exist.
 * Nothing created them. A new installation could start every process, get
 * `{"status":"ok"}` from health, and have no way to reach a single endpoint
 * that does anything — the quickstart began one step after where a real
 * installation begins.
 *
 * A one-shot command rather than an endpoint, because an HTTP route that
 * creates the first organization has to be reachable before any organization
 * exists, which means unauthenticated, which means it has to be disabled again
 * afterwards. Every version of that is a race between the first deploy and the
 * internet. A command runs where the operator already has credentials.
 *
 * Idempotent: run it twice and the second run reports what already existed and
 * changes nothing. Half-finished state is the normal outcome of a first
 * install — the collection created, the process killed before the workspace —
 * and refusing to continue from it would leave no way forward but manual SQL.
 */

export interface Options {
  readonly slug: string
  readonly name: string
  readonly email: string
  readonly workspace: string
  /**
   * Set on the administrator, when there is one to set.
   *
   * Passed in already hashed rather than as a plaintext to hash here: `init`
   * runs in a terminal and its arguments end up in a shell history and in
   * `ps`, so the password is generated rather than accepted, and the plaintext
   * exists in exactly one place — the line printed at the end.
   */
  readonly passwordHash?: string
}

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
  // The slug becomes the Qdrant collection name, so the characters it may
  // contain are not a matter of taste.
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
    return `--org must be 2-40 characters of lowercase letters, digits and hyphens, not starting or ending with one: ${slug}`
  }
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

export interface InitResult {
  readonly orgId: string
  readonly userId: string
  readonly workspaceId: string
  /** False when the organization was already there — the run changed nothing. */
  readonly created: boolean
  /**
   * Whether **this run** set the administrator's password.
   *
   * False on every re-run, because the upsert deliberately leaves an existing
   * hash alone. The caller needs to know because it generated a plaintext
   * before calling, and printing one the database did not accept is worse than
   * printing nothing: an operator writes it down, discards the real one, and
   * finds out an hour later when the token from the first run expires.
   */
  readonly passwordSet: boolean
}

/**
 * The database half, in one transaction.
 *
 * Separate from `main` so it can be tested: idempotency is the property that
 * matters here and the one that regresses silently, because the second run of
 * something non-idempotent usually still exits zero.
 */
export async function initialize(
  pool: Pool,
  options: Options,
  provider: { endpoint: string; model: string; dimensions: number },
  collection: string,
  log: (msg: string, extra?: Record<string, unknown>) => void = () => undefined,
): Promise<InitResult> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: orgs } = await client.query<{ id: string; existed: boolean }>(
      `WITH ins AS (
         INSERT INTO organizations (slug, name, vector_collection)
         VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING
         RETURNING id
       )
       SELECT id, false AS existed FROM ins
       UNION ALL
       SELECT id, true AS existed FROM organizations WHERE slug = $1
       LIMIT 1`,
      [options.slug, options.name, collection],
    )
    const org = orgs[0]
    if (org === undefined) throw new Error('the organization insert returned no row')
    log(org.existed ? 'organization already existed' : 'organization created', {
      org_id: org.id,
      slug: options.slug,
    })

    // RLS is forced on every tenant table, so everything below this line needs
    // the organization in the transaction-local setting. The organizations row
    // itself is not covered — it is the tenant registry, not tenant data.
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', org.id])

    const { rows: users } = await client.query<{ id: string; password_set: boolean }>(
      // The password is set only when this run generated one — re-running init
      // against an existing organization must not silently reset the
      // administrator's password and lock them out of their own installation.
      //
      // `password_set` reports whether the COALESCE above took this run's value
      // or kept the stored one, by comparing the row as written against what
      // was offered. The caller has a plaintext in hand either way and must not
      // print it when the answer is no: the hash carries its own salt, so two
      // hashes of the same password differ, and equality here can only mean
      // this statement is what put it there.
      `INSERT INTO users (org_id, email, role, password_hash) VALUES ($1,$2,'org_admin',$3)
       ON CONFLICT (org_id, email) DO UPDATE
         SET email = EXCLUDED.email,
             password_hash = COALESCE(users.password_hash, EXCLUDED.password_hash)
       RETURNING id, ($3 IS NOT NULL AND password_hash IS NOT DISTINCT FROM $3) AS password_set`,
      [org.id, options.email, options.passwordHash ?? null],
    )
    const userId = users[0]?.id
    if (userId === undefined) throw new Error('the user insert returned no row')
    log('admin user ready', {
      user_id: userId,
      email: options.email,
      password_set: users[0]?.password_set === true,
    })

    // Shared across organizations by default: one endpoint serves every tenant
    // in a self-hosted install, and a per-organization provider is the
    // exception rather than the shape to create on day one.
    //
    // This row carries `org_id = NULL`, and since 0019 a tenant-scoped role
    // cannot write one — the RESTRICTIVE policies on `embedding_providers`
    // require `org_id = current_setting('app.current_org')`, which NULL fails.
    // That is the point: the installation default is not a tenant's to change.
    // Writing it is a bootstrap act, so this one statement runs under
    // `nacre_worker`, the BYPASSRLS role the worker's queue already uses;
    // `nacre_app` is a member of it (migration 0008), so the switch is
    // available wherever init connects. `SET LOCAL` reverts at COMMIT, and it
    // is reset immediately below so nothing after it bypasses RLS.
    await client.query('SET LOCAL ROLE nacre_worker')
    const { rows: providers } = await client.query<{ id: string }>(
      `WITH ins AS (
         INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
         SELECT NULL,'default',$1,$2,$3
         WHERE NOT EXISTS (SELECT 1 FROM embedding_providers WHERE org_id IS NULL)
         RETURNING id
       )
       SELECT id FROM ins
       UNION ALL
       SELECT id FROM embedding_providers WHERE org_id IS NULL
       LIMIT 1`,
      [provider.endpoint, provider.model, provider.dimensions],
    )
    await client.query('RESET ROLE')
    const providerId = providers[0]?.id
    if (providerId === undefined) throw new Error('the embedding provider insert returned no row')
    log('embedding provider ready', { provider_id: providerId, model: provider.model })

    const { rows: workspaces } = await client.query<{ id: string }>(
      `WITH ins AS (
         -- slug and name take separate parameters despite the same value: slug
         -- is citext, name is text, and Postgres refuses to deduce one type for
         -- a parameter feeding both.
         INSERT INTO workspaces (org_id, slug, name) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, slug) DO NOTHING
         RETURNING id
       )
       SELECT id FROM ins
       UNION ALL
       SELECT id FROM workspaces WHERE org_id = $1 AND slug = $2
       LIMIT 1`,
      [org.id, options.workspace, options.workspace],
    )
    const workspaceId = workspaces[0]?.id
    if (workspaceId === undefined) throw new Error('the workspace insert returned no row')
    log('workspace ready', { workspace_id: workspaceId, slug: options.workspace })

    await client.query('COMMIT')
    return {
      orgId: org.id,
      userId,
      workspaceId,
      created: !org.existed,
      passwordSet: users[0]?.password_set === true,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/**
 * Six words and a number, from the CSPRNG.
 *
 * Roughly 70 bits with this list, which is more than a person would choose and
 * still something they can read off a terminal and type into a form once. A
 * base64 string of the same strength gets copied wrong, and the recovery from
 * that is re-running init against a live installation.
 */
function generatePassword(): string {
  const words = [
    'abalone', 'anchor', 'aurora', 'basalt', 'beacon', 'bramble', 'cinder', 'clover',
    'compass', 'coral', 'crest', 'current', 'delta', 'drift', 'ember', 'estuary',
    'fathom', 'ferry', 'fjord', 'granite', 'harbor', 'haven', 'iris', 'kelp',
    'lantern', 'ledger', 'lichen', 'mantle', 'marlin', 'meadow', 'mica', 'nacre',
    'nautilus', 'obsidian', 'onyx', 'opal', 'orbit', 'pearl', 'pelagic', 'pillar',
    'plover', 'quarry', 'quartz', 'reef', 'ripple', 'salt', 'sextant', 'shale',
    'shoal', 'silt', 'slate', 'spindrift', 'stratum', 'tide', 'trawler', 'trench',
    'vellum', 'wharf', 'willow', 'zephyr',
  ] as const

  // randomInt rather than Math.random or a modulo of randomBytes: one is not a
  // CSPRNG and the other is biased unless the range divides evenly.
  const chosen = Array.from({ length: 6 }, () => words[randomInt(words.length)])
  return `${chosen.join('-')}-${String(randomInt(10, 100))}`
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
  const vector = vectorName(config.embeddingModel, config.embeddingDim)
  const collection = collectionName(parsed.slug)

  try {
    const ids = await initialize(
      pool,
      { ...parsed, passwordHash },
      {
        endpoint: config.embeddingEndpoint,
        model: config.embeddingModel,
        dimensions: config.embeddingDim,
      },
      collection,
      say,
    )

    // Qdrant after Postgres commits. The reverse order can leave a collection
    // belonging to an organization that was rolled back, and the next run with
    // the same slug would then adopt it.
    //
    // `ensureCollection` is already idempotent and already creates the payload
    // indexes, which is the part worth not reimplementing: a filter that falls
    // back to a scan is a latency problem that only appears at volume.
    const vectors = new VectorStore(
      config.qdrantApiKey === undefined
        ? { url: config.qdrantUrl }
        : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
    )
    await vectors.ensureCollection(parsed.slug, vector, config.embeddingDim)
    say('collection ready', { collection, vector, dimensions: config.embeddingDim })

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

// Only when run as a command. This module is also imported — `initialize` is
// the part with a test on it — and an unguarded call here runs the whole
// command on import, which under a test runner means `process.exit(2)` in the
// middle of somebody else's suite.
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
