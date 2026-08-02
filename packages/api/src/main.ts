import { createHash } from 'node:crypto'

import {
  collectDatabaseGauges,
  createMetrics,
  createPool,
  loadConfig,
  loadJwtKeys,
  Redis,
  Registry,
  VectorStore,
  withOrg,
  ConfigError,
  installGuards,
  onListenError,
} from '@nacre.work/core'

import {
  HttpEmbedder,
  NacreIngest,
  NacreSearchService,
  PostgresAudit,
  PostgresAuditReader,
  PostgresDocuments,
  PostgresGrants,
  PostgresJobs,
  PostgresLayers,
  PostgresReindex,
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

async function main(): Promise<void> {
  const config = loadConfig()
  const { key, alsoAccept } = loadJwtKeys()

  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
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
    // And per client, which is what the address limit does not do: a spray
    // across ten thousand addresses never repeats a key. Looser on purpose,
    // because a whole office behind one NAT is one source here.
    login_source: { limit: config.rateLoginSourcePer15Min, windowSeconds: 900 },
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
      // Empty outside a rotation. During one it carries the key being retired,
      // so tokens already in the wild keep verifying until they expire.
      ...(alsoAccept.length === 0 ? {} : { alsoAccept }),
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      serviceKeys: new PostgresServiceKeys(pool, APP_ROLE),
    },
    metrics: registry,
    // The request path writes what it measures. Four of these were registered
    // and never written, so /metrics served zeros forever — which reads as
    // health rather than as absence.
    observe: metrics,
    ready,
    maxBodyBytes: config.maxDocumentBytes,
    limits,
    limitPolicies,
    trustProxy: config.trustProxy,
    ...(config.metricsToken === undefined ? {} : { metricsToken: config.metricsToken }),
    idempotency,
    login,
    auditReader: new PostgresAuditReader(pool, APP_ROLE),
    reindex: new PostgresReindex(pool, vectors, APP_ROLE),
    documents: new PostgresDocuments(pool, APP_ROLE),
    search: new NacreSearchService({
      pool,
      vectors,
      embedderFor: HttpEmbedder.pool(),
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
    ingest: new NacreIngest({ pool, tombstone: vectors, role: APP_ROLE }),
    audit: new PostgresAudit(pool, APP_ROLE),
    jobs: new PostgresJobs(pool, APP_ROLE),
    layers: new PostgresLayers(pool, vectors, APP_ROLE),
    grants: new PostgresGrants(pool, APP_ROLE),
    serviceAccounts: new PostgresServiceAccounts(pool, APP_ROLE),
  })

  const port = Number(process.env.PORT ?? 8080)
  server.listen(port, () => {
    // The fingerprint, never the secret. An operator needs to know which key is
    // in use when two environments disagree; nobody needs the key in a log.
    const print = (k: Uint8Array) => `sha256:${createHash('sha256').update(k).digest('hex').slice(0, 12)}`
    console.log(
      JSON.stringify({
        msg: 'api listening',
        port,
        env: config.env,
        issuer: config.jwtIssuer,
        jwt_key: print(key),
        // Present only during a rotation, which is exactly when an operator is
        // reading this line. Its absence is how they know the rotation is
        // finished and the old key is out.
        ...(alsoAccept.length === 0 ? {} : { jwt_key_previous: alsoAccept.map(print) }),
      }),
    )
  })

  onListenError(server, 'api', port)

  installGuards({
    service: 'api',
    // Stop accepting, let in-flight requests finish, then release the pool.
    // Dropping a request mid-flight would leave its audit event unwritten —
    // but `server.close` waits without a bound, so `installGuards` puts one on
    // it: one request stuck on a slow dependency used to mean the callback
    // never ran, the pool was never released, and the orchestrator SIGKILLed at
    // the end of its grace period. Every rolling deploy was an abrupt one.
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      redis.close()
      await pool.end()
    },
  })
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
