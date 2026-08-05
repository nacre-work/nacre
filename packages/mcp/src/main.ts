import {
  configureLogging,
  Counter,
  Histogram,
  ConfigError,
  installGuards,
  loadConfig,
  loadedExtensions,
  loadModules,
  loadJwtVerification,
  keyFingerprint,
  onListenError,
  protectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
  logger,
  Redis,
  RedisCache,
  Registry,
} from '@nacre.work/core'
import { RateLimiter, type LimitPolicy, type Resource } from '@nacre.work/api'
import { createMcpServer } from './server.js'
import { buildServices } from './services.js'

/**
 * The MCP process, Streamable HTTP.
 *
 * It shares the API's authorization service rather than reimplementing it. That
 * is the whole point of the boundary in docs/mcp.md: EMA and OAuth authorize
 * the *connection*, and permission on a document is computed per call by the
 * same code the REST surface uses. Two implementations would be two places for
 * rule 6 to drift.
 *
 * The tools themselves live in services.ts, shared with the STDIO transport.
 */

async function main(): Promise<void> {
  const config = loadConfig()

  // Before anything else logs. `NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` had been
  // validated here and read by nothing, so every process wrote JSON at one level
  // whatever the deployment asked for.
  configureLogging({ level: config.logLevel, format: config.logFormat })

  // Same order and the same reason as the API: this transport shares the
  // authorization service, so a resolver registered here and not there — or
  // there and not here — is rule 6 drifting between two surfaces, which is
  // exactly what the shared service exists to prevent. Both processes read the
  // same `NACRE_MODULES`.
  await loadModules(config.modules)

  const jwt = loadJwtVerification()
  // The one Redis this process opens, shared by the rate limiter and the
  // effective-principals cache. Two connections for two uses of the same server
  // is a connection to leak on shutdown, and `close()` below only knows about
  // one.
  const redis = new Redis({ url: config.redisUrl })

  const { pool, layers, tools, serviceKeys } = buildServices(config, {
    principalsCache: { store: new RedisCache(redis), ttlSeconds: config.aclCacheTtl },
  })

  // The same Redis, the same policies, the same keys the REST surface uses.
  //
  // `NACRE_RATE_*` applied to REST only, so this transport was unlimited: a
  // client that had spent its search budget could point at port 8081 and carry
  // on. Two doors into one authorization service, one of them with a lock.
  //
  // Shared buckets rather than one per surface, deliberately. Separate counters
  // would hand a caller twice the documented allowance for holding two clients,
  // which is the same hole one level up.
  const limitPolicies: Record<Resource, LimitPolicy> = {
    search: { limit: config.rateSearchPerMin, windowSeconds: 60 },
    ingest: { limit: config.rateIngestPerHour, windowSeconds: 3600 },
    login: { limit: config.rateLoginPer15Min, windowSeconds: 900 },
    login_source: { limit: config.rateLoginSourcePer15Min, windowSeconds: 900 },
  }
  const limits = new RateLimiter({
    redis,
    policies: limitPolicies,
    onDegraded: (resource, error) => {
      // Allowed through and said so, exactly as on REST. A rate limit is
      // availability protection rather than an authorization control, so
      // failing closed would trade a rare over-serve for a certain outage.
      // Counted too, on the same series REST uses, because a failed-open
      // request leaves no other trace to alert on.
      observe.rateLimitUnavailable.inc({ resource })
      logger.warn('rate limit check unavailable; request allowed', { resource,
          error: String(error).slice(0, 200) })
    },
  })

  // This process recorded nothing at all — no registry, no /metrics — so every
  // claim in docs/config.md about search latency and denials was true of REST
  // and silent here, on the transport the product is actually for. An agent's
  // search was not slow or failing; it was absent.
  //
  // Its own registry with its own metric names. Not the database gauges: those
  // are one process's job, and a second exporter publishing the same series
  // would be two answers to one question.
  const registry = new Registry()
  const observe = {
    toolDuration: registry.register(
      new Histogram('nacre_mcp_tool_duration_seconds', 'MCP tool latency, by tool', [
        0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5,
      ]),
    ),
    toolCalls: registry.register(
      new Counter('nacre_mcp_tool_calls_total', 'MCP tool calls, by tool and outcome'),
    ),
    // The same name and the same reason string as the REST surface, or the two
    // do not add up on one dashboard.
    aclDenials: registry.register(
      new Counter('nacre_acl_denials_total', 'Access denials, by reason'),
    ),
    authFailures: registry.register(
      new Counter(
        'nacre_auth_failures_total',
        'Rejected credentials, by the kind presented: missing, jwt, service_key. Never by reason — the 401 is deliberately one answer',
      ),
    ),
    // Same name and reason as the REST surface, or the two do not add up on one
    // dashboard — MCP and REST share the rate limiter, so a Redis outage
    // degrades both and both must count it.
    rateLimitUnavailable: registry.register(
      new Counter(
        'nacre_rate_limit_unavailable_total',
        'Requests allowed because the rate-limit check could not run (Redis unreachable), by resource',
      ),
    ),
  }

  const server = createMcpServer({
    // serviceKeys is not optional here in practice. An agent connecting over
    // Streamable HTTP is the case this transport exists for, and a service
    // account key is how an agent authenticates; leaving it out made every
    // `nacre_sk_` token 401 on this transport while the same key worked over
    // STDIO and REST — one credential, three surfaces, two of them agreeing.
    verify: {
      key: jwt.verification,
      ...(jwt.alsoAccept.length === 0 ? {} : { alsoAccept: jwt.alsoAccept }),
      algorithms: [jwt.algorithm],
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      serviceKeys,
    },
    layers,
    tools,
    // Discovery lives on the API host, never on the apex — static hosting there
    // intercepts /.well-known/* before the API sees it.
    // This transport's own URL, which is the canonical one unless a deployment
    // publishes the two on different origins — as `docker compose up` does.
    // RFC 9728 has the client compare the identifier against where it actually
    // connected, so a document naming the API refuses every client that came
    // here instead.
    resourceMetadataUrl: new URL(PROTECTED_RESOURCE_PATH, config.mcpCanonicalUrl).toString(),
    resourceMetadata: protectedResourceMetadata({
      canonicalUrl: config.mcpCanonicalUrl,
      // The authorization server is the **API's** origin, never this one: the
      // transport verifies tokens and issues none, and the consent flow lives
      // where sign-in does.
      authorizationServer:
        config.oauthAuthorizationServer === ''
          ? config.canonicalUrl.replace(/\/+$/, '')
          : config.oauthAuthorizationServer,
    }),
    // Unpinned, the identifier follows the request. The Compose default named
    // localhost, which is the right answer only for a client on the server's
    // own machine and a refusal before the first token for everyone else.
    ...(config.mcpCanonicalUrlPinned
      ? {}
      : {
          resourceFromRequest: (origin: string) =>
            protectedResourceMetadata({
              canonicalUrl: origin,
              authorizationServer:
                config.oauthAuthorizationServer === ''
                  ? config.canonicalUrl.replace(/\/+$/, '')
                  : config.oauthAuthorizationServer,
            }),
        }),
    allowedOrigins: config.mcpAllowedOrigins,
    limits,
    limitPolicies,
    metrics: registry,
    ...(config.metricsToken === undefined ? {} : { metricsToken: config.metricsToken }),
    observe,
  })

  const port = Number(process.env.PORT ?? 8081)
  server.listen(port, () => {
    // The fingerprint, never the secret, and for a sharper reason here than on
    // the API. This process verifies tokens the API signed, so the two must
    // agree on which key is current — on a shared secret they hold the same one
    // and there is no dual-key window, and on Ed25519 this process holds only
    // the public half (or, during a rotation, the current and previous public
    // halves). Either way a rotation that reaches one process and not the other
    // produces 401s on part of the traffic and not the rest, the hardest
    // failure of the set to read from outside. Comparing two printed
    // fingerprints is how an operator sees it in one line; the API has printed
    // its own since it existed, this one did not.
    logger.info('mcp listening', { port,
        env: config.env,
        jwt_alg: jwt.algorithm,
        jwt_key: keyFingerprint(jwt.verification),
        ...(jwt.alsoAccept.length === 0
          ? {}
          : { jwt_key_previous: jwt.alsoAccept.map(keyFingerprint) }),
        extensions: loadedExtensions() })
  })

  onListenError(server, 'mcp', port)

  installGuards({
    service: 'mcp',
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
