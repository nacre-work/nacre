import {
  configureLogging,
  collectDatabaseGauges,
  createMetrics,
  createPool,
  loadConfig,
  loadedExtensions,
  loadModules,
  logger,
  loadJwtKeys,
  keyFingerprint,
  protectedResourceMetadata,
  Redis,
  RedisCache,
  Registry,
  S3,
  VectorStore,
  pendingMigrations,
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
  PostgresReferenceQueries,
  PostgresReindex,
  PostgresEmbeddingProviders,
  PostgresWorkspaces,
} from './adapters.js'
import { SignJWT } from 'jose'

import { Idempotency } from './idempotency.js'
import { Login } from './login.js'
import {
  PostgresOAuthAuthorizations,
  PostgresOAuthClients,
  PostgresOAuthConsents,
  PostgresOAuthRefreshTokens,
} from './oauth-store.js'
import { rerankerFor } from './rerank.js'
import { RateLimiter, type LimitPolicy, type Resource } from './limits.js'
import { PostgresGroups, PostgresUsers } from './principals.js'
import { PostgresServiceAccounts } from './service-keys.js'
import { postgresVerification } from './verification.js'
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

  // Before anything else logs. `NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` had been
  // validated here and read by nothing, so every process wrote JSON at one level
  // whatever the deployment asked for.
  configureLogging({ level: config.logLevel, format: config.logFormat })

  // Before anything is composed, and after the logger so a module's own startup
  // lines obey the deployment's level. Registration closes when this returns, so
  // everything below reads a registry that can no longer change — a module that
  // registered later would be configured, look present, and never be consulted.
  await loadModules(config.modules)

  const jwt = loadJwtKeys()

  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const vectors = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
  // Absent when a deployment has none, which is supported and is the default:
  // document bytes then live in `documents.source_ref`. `loadConfig` refuses a
  // half-configured block, so this is either fully usable or not there at all.
  const objects = config.s3 === undefined ? undefined : new S3(config.s3)

  const registry = new Registry()
  const metrics = createMetrics(registry)
  registry.collect(collectDatabaseGauges(pool, metrics, APP_ROLE))

  // Redis has been required configuration, and in every Compose profile with
  // the API waiting on its healthcheck, since before anything connected to it.
  // Rate limiting and Idempotency-Key are what it was declared for.
  const redis = new Redis({ url: config.redisUrl })

  // The effective-principals cache, shared with MCP through Redis so both
  // surfaces answer from one place. `NACRE_ACL_CACHE_TTL` had been validated at
  // startup and read by nothing since it was added: the cache existed, was
  // tested, and was never called, so every request recomputed the transitive
  // group closure.
  //
  // Safe to cache because the key carries `organizations.groups_version`, which
  // triggers bump on every change to groups, group_members and grants — a
  // revoked grant is not served stale, the next request simply looks somewhere
  // else. The TTL bounds memory, not correctness.
  const principalsCache = { store: new RedisCache(redis), ttlSeconds: config.aclCacheTtl }


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
      //
      // Counted as well as logged: the whole point of failing open is that the
      // request still succeeds, so a log line is the only trace, and an
      // operator cannot alert on the absence of one. The counter is what
      // `docs/config.md` names as the signal.
      metrics.rateLimitUnavailable.inc({ resource })
      logger.warn('rate limit check unavailable; request allowed', { resource,
          error: String(error).slice(0, 200) })
    },
  })

  // Undefined unless the deployment configured one — `minimal` has no
  // reranker by definition, which is what keeps it runnable without a GPU.
  const reranker = rerankerFor(config)

  const idempotency = new Idempotency({
    redis,
    onDegraded: (error) => {
      logger.warn('idempotency cache unavailable; request processed uncached', { error: String(error).slice(0, 200) })
    },
  })

  const login = new Login({
    pool,
    // The signing key, which for Ed25519 is the private half — the only place
    // in this process that needs it. Everything else verifies with the public
    // one.
    key: jwt.signing,
    algorithm: jwt.algorithm,
    ...(jwt.keyId === undefined ? {} : { keyId: jwt.keyId }),
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    accessTokenTtl: config.accessTokenTtl,
    refreshTokenTtl: config.refreshTokenTtl,
    role: APP_ROLE,
  })

  // What this process cannot serve a request without.
  //
  // S3 is checked now, and only when a deployment configured it: ingest writes
  // document bytes there before it writes the row, so a bucket that is
  // unreachable or a credential that is wrong is a surface that accepts nothing.
  // A deployment without object storage reports no s3 key at all rather than a
  // `true` that means "not asked" — those must not look the same.
  //
  // The embedder is still not checked: it is an external endpoint an operator
  // supplies, a search fails loudly without it, and making readiness depend on
  // somebody else's uptime turns their outage into a rollout that never
  // completes.
  const ready = async (): Promise<Record<string, boolean>> => {
    const [postgres, qdrant, redisUp, s3Up, schema] = await Promise.all([
      withOrg(pool, '00000000-0000-0000-0000-000000000000', async (c) => {
        await c.query('SELECT 1')
        return true
      }, { role: APP_ROLE }).catch(() => false),
      vectors.ready().catch(() => false),
      redis.ping().catch(() => false),
      objects === undefined ? Promise.resolve(undefined) : objects.ready().catch(() => false),
      // Does this database carry every migration this build ships?
      //
      // Everything above asks whether a dependency answers. None of them asks
      // the question that actually decides whether this process can serve: a
      // pod started against a database the migrator has not reached reports
      // ready and then fails every request — and under an orchestrator that is
      // worse than an error, because the rollout believes the answer and
      // carries on replacing working pods with broken ones.
      //
      // A database that is *ahead* stays ready. That is the middle of a
      // rolling upgrade, where the old replica has to keep serving.
      //
      // Outside `withOrg`, and allowed to be: `schema_migrations` is not a
      // tenant table. It has no `org_id`, no policy and nothing to scope to —
      // its rows are the file names and checksums of SQL that ships in a
      // public repository. The rule that raw queries must say what permits
      // them is why this paragraph exists; migration 0022 is what grants the
      // application role the SELECT, because before it there was none.
      //
      // The name is logged and never sent: the body of this endpoint is
      // unauthenticated, and which migration a deployment is missing is more
      // than a probe needs to be told.
      pendingMigrations(pool)
        .then((pending) => {
          if (pending.length === 0) return true
          logger.warn('schema is behind this build', {
            pending: pending.length,
            next: pending[0],
          })
          return false
        })
        .catch((error: unknown) => {
          // No table, no privilege, no connection — the same conclusion by a
          // different route, and the right one: a database whose ledger cannot
          // be read is not one to serve against.
          logger.warn('could not read the migration ledger', { error: String(error) })
          return false
        }),
    ])
    return {
      postgres,
      qdrant,
      redis: redisUp,
      schema,
      ...(s3Up === undefined ? {} : { s3: s3Up }),
    }
  }

  const server = createApi({
    verify: {
      key: jwt.verification,
      // Empty outside a rotation. During one it carries the key being retired,
      // so tokens already in the wild keep verifying until they expire.
      ...(jwt.alsoAccept.length === 0 ? {} : { alsoAccept: jwt.alsoAccept }),
      algorithms: [jwt.algorithm],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      // Both database-backed ports, from the one function that knows what a
      // Postgres verifier is. See verification.ts — this used to be assembled
      // by hand in three processes.
      ...postgresVerification(pool, APP_ROLE),
    },
    metrics: registry,
    resourceMetadata: protectedResourceMetadata({
      canonicalUrl: config.canonicalUrl,
      // An operator's identity provider wins. Failing that, **this
      // installation** — which reverses the position this field held, and the
      // reversal is the point rather than a slip: it was empty because pointing
      // a client at a token endpoint that did not exist would have been a dead
      // end one redirect further along, and the endpoint exists now. The
      // argument was right; what it described changed.
      authorizationServer:
        config.oauthAuthorizationServer === ''
          ? config.canonicalUrl.replace(/\/+$/, '')
          : config.oauthAuthorizationServer,
    }),
    // Only when there is a public half. A deployment on NACRE_JWT_SECRET serves
    // 404 here, because a shared secret has nothing publishable and an endpoint
    // that produced something anyway would be publishing the key that mints
    // tokens.
    ...(jwt.jwks === undefined ? {} : { jwks: jwt.jwks }),
    // The request path writes what it measures. Four of these were registered
    // and never written, so /metrics served zeros forever — which reads as
    // health rather than as absence.
    observe: metrics,
    ready,
    maxBodyBytes: config.maxDocumentBytes,
    // The same fact that builds the S3 client, as a boolean: the handler
    // refuses a PDF at the edge when there is no bucket for its bytes.
    objectStorage: objects !== undefined,
    limits,
    limitPolicies,
    trustProxy: config.trustProxy,
    ...(config.metricsToken === undefined ? {} : { metricsToken: config.metricsToken }),
    idempotency,
    login,
    auditReader: new PostgresAuditReader(pool, APP_ROLE, principalsCache),
    reindex: new PostgresReindex(pool, vectors, APP_ROLE, principalsCache),
    referenceQueries: new PostgresReferenceQueries(pool, APP_ROLE, principalsCache),
    documents: new PostgresDocuments(
      pool,
      vectors,
      APP_ROLE,
      principalsCache,
      objects === undefined
        ? undefined
        : { url: (key: string) => objects.presign(key, config.presignTtl) },
    ),
    search: new NacreSearchService({
      principalsCache,
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
        logger.warn('reranking failed; results are in fusion order', { error: String(error).slice(0, 200) })
      },
    }),
    ingest: new NacreIngest({
      pool,
      principalsCache,
      tombstone: vectors,
      ...(objects === undefined ? {} : { objects }),
      role: APP_ROLE,
    }),
    audit: new PostgresAudit(pool, APP_ROLE),
    auditQueryText: config.auditQueryText,
    jobs: new PostgresJobs(pool, APP_ROLE, principalsCache),
    layers: new PostgresLayers(pool, vectors, APP_ROLE, principalsCache),
    workspaces: new PostgresWorkspaces(pool, APP_ROLE, principalsCache),
    embeddingProviders: new PostgresEmbeddingProviders(pool, APP_ROLE),
    grants: new PostgresGrants(pool, APP_ROLE, principalsCache),
    serviceAccounts: new PostgresServiceAccounts(pool, APP_ROLE),
    users: new PostgresUsers(pool, APP_ROLE),
    groups: new PostgresGroups(pool, APP_ROLE),

    /**
     * The authorization server.
     *
     * On by default, because the alternative for anyone connecting an agent is
     * "make a service account by hand, copy its key, paste it into a config
     * file" — which is the gap this closes. A deployment that would rather use
     * its own identity provider names it in
     * `NACRE_OAUTH_AUTHORIZATION_SERVER`, and then the discovery document
     * points there and this flow is simply not the one clients take.
     */
    oauth: {
      issuer: config.canonicalUrl.replace(/\/+$/, ''),
      // The admin UI's consent screen. Same origin as the API in every
      // deployment that puts an ingress in front; the Compose stack publishes
      // the admin bundle separately, which is why this is a variable and not a
      // path appended to the issuer.
      consentUrl: config.consentUrl,
      clients: new PostgresOAuthClients(pool, APP_ROLE),
      authorizations: new PostgresOAuthAuthorizations(pool, APP_ROLE),
      consents: new PostgresOAuthConsents(pool, APP_ROLE),
      refreshTokens: new PostgresOAuthRefreshTokens(pool, APP_ROLE),
      // The same lifetimes a person's own session uses. An application's
      // connection is not a different kind of thing from a browser session —
      // both are "this holder keeps working until somebody ends it" — so
      // inventing a second pair of knobs would be two answers to one question.
      refreshTtlSeconds: config.refreshTokenTtl,
      accessTtlSeconds: config.accessTokenTtl,
      /**
       * A token for whatever the connection acts as.
       *
       * For an **agent**: `principal_type: 'service_account'` and `sub` is the
       * account — the same claims a service account key resolves to, so
       * everything downstream treats this exactly as it treats one and there is
       * no second notion of what an agent is. `role` is `member` because a
       * service account has no organization-wide role: everything it reaches,
       * it reaches by grant.
       *
       * For a **delegation**: `principal_type: 'user'` and `sub` is the person,
       * plus `del` naming the connection. The permitted set is deliberately not
       * in here — a token carrying one would keep answering with the access its
       * holder had at consent, and every revocation would wait for it to
       * expire. `role` is carried for shape and is **not** what the request
       * runs as: `authenticate` takes the role from the connection's row, so a
       * demotion applies without waiting for the token to expire.
       */
      mint: async (approved) => {
        const ttl = config.accessTokenTtl
        const now = Math.floor(Date.now() / 1000)
        const delegated = approved.subject.actsAs === 'user'
        const accessToken = await new SignJWT({
          org: approved.orgId,
          principal_type: delegated ? 'user' : 'service_account',
          role: 'member',
          ...(delegated ? { del: approved.consentId } : {}),
        })
          .setProtectedHeader({
            alg: jwt.algorithm,
            ...(jwt.keyId === undefined ? {} : { kid: jwt.keyId }),
          })
          .setSubject(
            approved.subject.actsAs === 'user'
              ? approved.subject.userId
              : approved.subject.serviceAccountId,
          )
          .setIssuer(config.jwtIssuer)
          .setAudience(config.jwtAudience)
          .setIssuedAt(now)
          .setExpirationTime(now + ttl)
          .sign(jwt.signing)
        return { accessToken, expiresIn: ttl }
      },
    },
  })

  const port = Number(process.env.PORT ?? 8080)
  server.listen(port, () => {
    // The fingerprint, never the secret. An operator needs to know which key is
    // in use when two environments disagree; nobody needs the key in a log.
    logger.info('api listening', { port,
        env: config.env,
        issuer: config.jwtIssuer,
        jwt_alg: jwt.algorithm,
        jwt_key: keyFingerprint(jwt.verification),
        // Present only during a rotation, which is exactly when an operator is
        // reading this line. Its absence is how they know the rotation is
        // finished and the old key is out.
        ...(jwt.alsoAccept.length === 0
          ? {}
          : { jwt_key_previous: jwt.alsoAccept.map(keyFingerprint) }),
        // What `NACRE_MODULES` actually produced, not what it named. A module
        // that loads and registers nothing is the failure worth seeing here:
        // the deployment is paying for it and the process is running without
        // it, which is invisible everywhere else.
        extensions: loadedExtensions() })
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
  logger.error('failed to start', { error: String(error) })
  process.exit(1)
})
