import { createHash } from 'node:crypto'

import { createPool, loadConfig, VectorStore, withOrg, ConfigError } from '@nacre.work/core'

import { HttpEmbedder, NacreSearchService, PostgresAudit, PostgresDocuments } from './adapters.js'
import { createApi } from './server.js'

/**
 * The REST API process.
 *
 * Configuration is read and validated before anything is constructed, so a
 * missing variable is a refusal to start rather than an error rate. Nothing
 * below this line has a fallback.
 */

const APP_ROLE = 'nacre_app'

function jwtKey(config: { jwtSecret?: string }): Uint8Array {
  // Development uses a symmetric secret. Production is meant to load an Ed25519
  // key through NACRE_JWT_PRIVATE_KEY_REF; until that lands, refusing is the
  // honest behaviour — a hardcoded fallback here would be a signing key anyone
  // reading the source can forge tokens with.
  const secret = process.env.NACRE_JWT_SECRET
  if (secret === undefined || secret.length < 32) {
    throw new ConfigError([
      'NACRE_JWT_SECRET is not set, or is shorter than 32 bytes. ' +
        'Asymmetric keys through NACRE_JWT_PRIVATE_KEY_REF are not implemented yet; ' +
        'until they are, this is required and there is no default.',
    ])
  }
  void config
  return new TextEncoder().encode(secret)
}

async function main(): Promise<void> {
  const config = loadConfig()
  const key = jwtKey({})

  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
  const embedder = new HttpEmbedder(config.embeddingEndpoint, config.embeddingModel, config.embeddingDim)

  // Slugs change rarely and are read on every search. A tiny cache keyed on the
  // organization keeps a search from costing an extra round trip; it is not
  // permission data, so staleness here cannot widen access.
  const slugs = new Map<string, string>()
  const orgSlug = async (orgId: string): Promise<string | undefined> => {
    const cached = slugs.get(orgId)
    if (cached !== undefined) return cached

    const found = await withOrg(
      pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ slug: string }>(
          'SELECT slug FROM organizations WHERE id = $1 AND deleted_at IS NULL',
          [orgId],
        )
        return rows[0]?.slug
      },
      { role: APP_ROLE },
    )

    if (found !== undefined) slugs.set(orgId, found)
    return found
  }

  const server = createApi({
    verify: { key, issuer: config.jwtIssuer, audience: config.jwtAudience },
    documents: new PostgresDocuments(pool, APP_ROLE),
    search: new NacreSearchService({
      pool,
      vectors,
      embedder,
      orgSlug,
      vectorName: `v_${config.embeddingModel.replace(/[^a-z0-9]/gi, '_')}_${config.embeddingDim}`,
      role: APP_ROLE,
    }),
    audit: new PostgresAudit(pool, APP_ROLE),
  })

  const port = Number(process.env.PORT ?? 8080)
  server.listen(port, () => {
    // The fingerprint, never the secret. An operator needs to know which key is
    // in use when two environments disagree; nobody needs the key in a log.
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 12)
    console.log(
      JSON.stringify({
        msg: 'api listening',
        port,
        env: config.env,
        issuer: config.jwtIssuer,
        jwt_key: `sha256:${fingerprint}`,
      }),
    )
  })

  const shutdown = (signal: string) => {
    console.log(JSON.stringify({ msg: 'shutting down', signal }))
    // Stop accepting, let in-flight requests finish, then release the pool.
    // Dropping a request mid-flight would leave its audit event unwritten.
    server.close(() => {
      void pool.end().then(() => process.exit(0))
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
