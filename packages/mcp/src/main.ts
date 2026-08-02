import {
  Counter,
  Histogram,
  ConfigError,
  installGuards,
  loadConfig,
  loadJwtKeys,
  onListenError,
  Redis,
  Registry,
} from '@nacre.work/core'
import { RateLimiter, type LimitPolicy, type Resource } from '@nacre.work/api'
import { createHash } from 'node:crypto'

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
  const { key, alsoAccept } = loadJwtKeys()
  const { pool, layers, tools, serviceKeys } = buildServices(config)

  // The same Redis, the same policies, the same keys the REST surface uses.
  //
  // `NACRE_RATE_*` applied to REST only, so this transport was unlimited: a
  // client that had spent its search budget could point at port 8081 and carry
  // on. Two doors into one authorization service, one of them with a lock.
  //
  // Shared buckets rather than one per surface, deliberately. Separate counters
  // would hand a caller twice the documented allowance for holding two clients,
  // which is the same hole one level up.
  const redis = new Redis({ url: config.redisUrl })
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
      console.warn(
        JSON.stringify({
          msg: 'rate limit check unavailable; request allowed',
          resource,
          error: String(error).slice(0, 200),
        }),
      )
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
  }

  const server = createMcpServer({
    // serviceKeys is not optional here in practice. An agent connecting over
    // Streamable HTTP is the case this transport exists for, and a service
    // account key is how an agent authenticates; leaving it out made every
    // `nacre_sk_` token 401 on this transport while the same key worked over
    // STDIO and REST — one credential, three surfaces, two of them agreeing.
    verify: {
      key,
      ...(alsoAccept.length === 0 ? {} : { alsoAccept }),
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
      serviceKeys,
    },
    layers,
    tools,
    // Discovery lives on the API host, never on the apex — static hosting there
    // intercepts /.well-known/* before the API sees it.
    resourceMetadataUrl: new URL('/.well-known/oauth-protected-resource', config.canonicalUrl).toString(),
    limits,
    limitPolicies,
    metrics: registry,
    ...(config.metricsToken === undefined ? {} : { metricsToken: config.metricsToken }),
    observe,
  })

  const port = Number(process.env.PORT ?? 8081)
  server.listen(port, () => {
    // The fingerprint, never the secret, and for a sharper reason here than on
    // the API. This process and the API verify tokens with the *same* symmetric
    // secret, and there is no dual-key window — so a rotation that reaches one
    // of them and not the other produces 401s on part of the traffic and not
    // the rest, which is the hardest failure of the set to read from the
    // outside. Comparing two printed fingerprints is how an operator sees it in
    // one line. The API has printed its own since it existed; this one did not,
    // which made the comparison impossible from the half that needed it.
    const print = (k: Uint8Array) => `sha256:${createHash('sha256').update(k).digest('hex').slice(0, 12)}`
    console.log(
      JSON.stringify({
        msg: 'mcp listening',
        port,
        env: config.env,
        jwt_key: print(key),
        ...(alsoAccept.length === 0 ? {} : { jwt_key_previous: alsoAccept.map(print) }),
      }),
    )
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
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
