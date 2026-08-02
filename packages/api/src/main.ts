import { createHash } from 'node:crypto'

import {
  collectDatabaseGauges,
  createMetrics,
  createPool,
  loadConfig,
  Redis,
  Registry,
  VectorStore,
  vectorName,
  withOrg,
  ConfigError,
} from '@nacre.work/core'

import {
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresDocuments,
  PostgresGrants,
  PostgresJobs,
  PostgresLayers,
} from './adapters.js'
import { Idempotency } from './idempotency.js'
import { Login } from './login.js'
import { rerankerFor } from './rerank.js'
import { RateLimiter, type LimitPolicy, type Resource } from './limits.js'
import { PostgresServiceAccounts, PostgresServiceKeys } from './service-keys.js'
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

  const registry = new Registry()
  const metrics = createMetrics(registry)
  registry.collect(collectDatabaseGauges(pool, metrics, APP_ROLE))

  // Redis has been required configuration, and in every Compose profile with
  // the API waiting on its healthcheck, since before anything connected to it.
  // Rate limiting and Idempotency-Key are what it was declared for.
  const redis = new Redis({ url: config.redisUrl })

  const limitPolicies: Record<Resource, LimitPolicy> = {
    search: { limit: config.rateSearchPerMin, windowSeconds: 60 },
    ingest: { limit: config.rateIngestPerHour, windowSeconds: 3600 },
    // Per address rather than per organization — there is no organization until
    // the sign-in succeeds, and what this defends is one account's password.
    login: { limit: config.rateLoginPer15Min, windowSeconds: 900 },
  }

  const limits = new RateLimiter({
    redis,
    policies: limitPolicies,
    onDegraded: (resource, error) => {
      // Allowed through, and said so. A rate limit is availability protection
      // rather than an authorization control, so failing closed here would
      // trade a rare over-serve for a certain outage — the opposite of the
      // rule for permissions, and deliberately so.
      console.warn(
        JSON.stringify({
          msg: 'rate limit check unavailable; request allowed',
          resource,
          error: String(error).slice(0, 200),
        }),
      )
    },
  })

  // Undefined unless the deployment configured one — `minimal` has no
  // reranker by definition, which is what keeps it runnable without a GPU.
  const reranker = rerankerFor(config)

  const idempotency = new Idempotency({
    redis,
    onDegraded: (error) => {
      console.warn(
        JSON.stringify({
          msg: 'idempotency cache unavailable; request processed uncached',
          error: String(error).slice(0, 200),
        }),
      )
    },
  })

  const login = new Login({
    pool,
    key,
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    role: APP_ROLE,
  })

  // What this process cannot serve a request without. S3 is in the documented
  // list and is not checked, because nothing in the tree reads it yet — a probe
  // that reported on a dependency the code never uses would be reporting on
  // nothing. The embedder is not checked either: it is an external endpoint an
  // operator supplies, a search fails loudly without it, and making readiness
  // depend on somebody else's uptime turns their outage into a rollout that
  // never completes.
  const ready = async (): Promise<Record<string, boolean>> => {
    const [postgres, qdrant, redisUp] = await Promise.all([
      withOrg(pool, '00000000-0000-0000-0000-000000000000', async (c) => {
        await c.query('SELECT 1')
        return true
      }, { role: APP_ROLE }).catch(() => false),
      vectors.ready().catch(() => false),
      redis.ping().catch(() => false),
    ])
    return { postgres, qdrant, redis: redisUp }
  }

  const server = createApi({
    verify: {
      key,
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      serviceKeys: new PostgresServiceKeys(pool, APP_ROLE),
    },
    metrics: registry,
    ready,
    maxBodyBytes: config.maxDocumentBytes,
    limits,
    limitPolicies,
    idempotency,
    login,
    documents: new PostgresDocuments(pool, APP_ROLE),
    search: new NacreSearchService({
      pool,
      vectors,
      embedder,
      orgSlug,
      vectorName: vectorName(config.embeddingModel, config.embeddingDim),
      role: APP_ROLE,
      ...(reranker === undefined ? {} : { reranker }),
      rerankCandidates: config.rerankCandidates,
      onRerankFailed: (error) => {
        // Answered in fusion order rather than not at all. Reranking decides
        // ordering over candidates the index already filtered by permission,
        // so this is a quality degradation and not a permissions one — and an
        // operator who turned it on is entitled to know it is not running.
        console.warn(
          JSON.stringify({
            msg: 'reranking failed; results are in fusion order',
            error: String(error).slice(0, 200),
          }),
        )
      },
    }),
    ingest: new NacreIngest({ pool, tombstone: vectors, orgSlug, role: APP_ROLE }),
    audit: new PostgresAudit(pool, APP_ROLE),
    jobs: new PostgresJobs(pool, APP_ROLE),
    layers: new PostgresLayers(pool, APP_ROLE),
    grants: new PostgresGrants(pool, APP_ROLE),
    serviceAccounts: new PostgresServiceAccounts(pool, APP_ROLE),
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
      redis.close()
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
