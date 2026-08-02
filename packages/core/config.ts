/**
 * Configuration, validated whole at startup.
 *
 * Two rules from docs/config.md, and both are about the same failure:
 *
 * **Validate everything at boot and exit if anything is missing or
 * contradictory.** Not on first use. A service that starts and then fails the
 * first request that needs the missing value looks healthy to an orchestrator,
 * gets traffic, and reports the problem as an error rate.
 *
 * **No silent defaults for secrets or URLs.** A default that quietly points at
 * localhost is how a production deployment ends up talking to nothing and
 * reporting success. Defaults are fine for tunables — a cache TTL has an
 * obviously right value — and never fine for anything naming a host or
 * carrying a credential.
 */

export interface Config {
  readonly env: 'development' | 'production'
  readonly canonicalUrl: string
  readonly logLevel: string
  readonly logFormat: 'json' | 'text'

  readonly pgUrl: string
  readonly pgPoolMax: number
  readonly qdrantUrl: string
  readonly qdrantApiKey: string | undefined
  readonly vectorTenancy: 'collection' | 'shared'
  readonly redisUrl: string

  readonly embeddingEndpoint: string
  readonly embeddingModel: string
  readonly embeddingDim: number
  readonly parserEndpoint: string
  readonly rerankerEndpoint: string | undefined
  readonly rerankerEnabled: boolean
  readonly rerankCandidates: number

  readonly jwtIssuer: string
  readonly jwtAudience: string
  readonly accessTokenTtl: number

  readonly aclCacheTtl: number
  readonly aclPropagationSla: number
  readonly aclTagHashBytes: number

  /**
   * How long a tombstoned document keeps its vectors before the sweep removes
   * them. A tunable, so a default is fine — and it is not a correctness knob:
   * invariant I5 is held by `deleted = false` in every query, not by this.
   */
  readonly gcGrace: number

  /**
   * How long a claimed document may stay claimed before another worker may take
   * it back. Must exceed the slowest legitimate indexing run, because a lease
   * that expires while the work is still going produces two workers on one
   * document — wasteful rather than wrong, since ingest is idempotent, but it
   * is the wrong direction to be wrong in.
   */
  readonly indexLease: number

  /**
   * Claims after which a document is failed instead of requeued. Bounded so a
   * document that reliably kills the worker takes itself out of the queue
   * rather than the queue out of service.
   */
  readonly indexMaxAttempts: number

  readonly rateSearchPerMin: number
  readonly rateIngestPerHour: number
  readonly maxDocumentBytes: number

  readonly auditRetentionDays: number
  readonly auditQueryText: boolean
}

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    super(
      `configuration is not usable:\n${problems.map((p) => `  - ${p}`).join('\n')}\n` +
        'Every one of these is required at startup. See docs/config.md.',
    )
    this.name = 'ConfigError'
    this.problems = problems
  }
}

type Env = Readonly<Record<string, string | undefined>>

class Reader {
  readonly problems: string[] = []
  constructor(private readonly env: Env) {}

  /** Required, with no fallback. Used for anything naming a host or a secret. */
  required(key: string): string {
    const value = this.env[key]?.trim()
    if (value === undefined || value === '') {
      this.problems.push(`${key} is not set`)
      return ''
    }
    return value
  }

  optional(key: string): string | undefined {
    const value = this.env[key]?.trim()
    return value === undefined || value === '' ? undefined : value
  }

  /** A default is allowed here: a tunable has an obviously right value. */
  number(key: string, fallback: number, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}): number {
    const raw = this.env[key]?.trim()
    if (raw === undefined || raw === '') return fallback

    const value = Number(raw)
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
      this.problems.push(`${key} must be an integer between ${min} and ${max}, got ${JSON.stringify(raw)}`)
      return fallback
    }
    return value
  }

  boolean(key: string, fallback: boolean): boolean {
    const raw = this.env[key]?.trim().toLowerCase()
    if (raw === undefined || raw === '') return fallback
    if (raw === 'true' || raw === 'false') return raw === 'true'
    this.problems.push(`${key} must be true or false, got ${JSON.stringify(raw)}`)
    return fallback
  }

  oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
    const raw = this.env[key]?.trim()
    if (raw === undefined || raw === '') return fallback
    if ((allowed as readonly string[]).includes(raw)) return raw as T
    this.problems.push(`${key} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`)
    return fallback
  }

  url(key: string, { required = true } = {}): string {
    const raw = required ? this.required(key) : (this.optional(key) ?? '')
    if (raw === '') return ''
    try {
      new URL(raw)
    } catch {
      this.problems.push(`${key} is not a URL: ${JSON.stringify(raw)}`)
    }
    return raw
  }
}

export function loadConfig(env: Env = process.env): Config {
  const r = new Reader(env)

  const config: Config = {
    env: r.oneOf('NACRE_ENV', ['development', 'production'] as const, 'development'),
    canonicalUrl: r.url('NACRE_CANONICAL_URL'),
    logLevel: r.oneOf('NACRE_LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    logFormat: r.oneOf('NACRE_LOG_FORMAT', ['json', 'text'] as const, 'json'),

    pgUrl: r.required('NACRE_PG_URL'),
    pgPoolMax: r.number('NACRE_PG_POOL_MAX', 20, { min: 1, max: 1000 }),
    qdrantUrl: r.url('NACRE_QDRANT_URL'),
    qdrantApiKey: r.optional('NACRE_QDRANT_API_KEY'),
    vectorTenancy: r.oneOf('NACRE_VECTOR_TENANCY', ['collection', 'shared'] as const, 'collection'),
    redisUrl: r.required('NACRE_REDIS_URL'),

    embeddingEndpoint: r.url('NACRE_DEFAULT_EMBEDDING_ENDPOINT'),
    embeddingModel: r.required('NACRE_DEFAULT_EMBEDDING_MODEL'),
    embeddingDim: r.number('NACRE_DEFAULT_EMBEDDING_DIM', 1024, { min: 8, max: 16384 }),
    parserEndpoint: r.url('NACRE_PARSER_ENDPOINT'),
    rerankerEndpoint: r.optional('NACRE_RERANKER_ENDPOINT'),
    // False, and it was true. `minimal` has no reranker by definition — the
    // profile exists to run on a laptop without a GPU — so a default of true
    // meant the documented starting profile refused to boot until the operator
    // turned off a feature they had not asked for.
    rerankerEnabled: r.boolean('NACRE_RERANKER_ENABLED', false),
    // The candidate set a cross-encoder reorders. 50 is what
    // docs/architecture.md specifies. The maximum is bounded because every
    // candidate is a row hydrated from Postgres and a text sent to the model:
    // this is the one tunable here that trades latency for quality directly,
    // and there is a value at which a search stops answering in time.
    rerankCandidates: r.number('NACRE_RERANK_CANDIDATES', 50, { min: 1, max: 500 }),

    jwtIssuer: r.required('NACRE_JWT_ISSUER'),
    jwtAudience: r.required('NACRE_JWT_AUDIENCE'),
    accessTokenTtl: r.number('NACRE_ACCESS_TOKEN_TTL', 900, { min: 60, max: 86_400 }),

    aclCacheTtl: r.number('NACRE_ACL_CACHE_TTL', 60, { min: 0, max: 3600 }),
    aclPropagationSla: r.number('NACRE_ACL_PROPAGATION_SLA', 60, { min: 1, max: 3600 }),
    gcGrace: r.number('NACRE_GC_GRACE', 3600, { min: 0, max: 2_592_000 }),
    // 15 minutes: long enough for a large PDF through parse, chunk, embed, and
    // upsert, short enough that a drained node's documents are not stuck for an
    // afternoon. The minimum is 60 rather than 0 — a zero lease reclaims a
    // document the instant it is claimed, which is a loop, not a setting.
    indexLease: r.number('NACRE_INDEX_LEASE', 900, { min: 60, max: 86_400 }),
    indexMaxAttempts: r.number('NACRE_INDEX_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),
    aclTagHashBytes: r.number('NACRE_ACL_TAG_HASH_BYTES', 8, { min: 4, max: 32 }),

    rateSearchPerMin: r.number('NACRE_RATE_SEARCH_PER_MIN', 60, { min: 1 }),
    rateIngestPerHour: r.number('NACRE_RATE_INGEST_PER_HOUR', 600, { min: 1 }),
    maxDocumentBytes: r.number('NACRE_MAX_DOCUMENT_BYTES', 52_428_800, { min: 1024 }),

    auditRetentionDays: r.number('NACRE_AUDIT_RETENTION_DAYS', 400, { min: 1 }),
    auditQueryText: r.boolean('NACRE_AUDIT_QUERY_TEXT', false),
  }

  // Cross-field checks. Each one is a combination that parses fine and is
  // wrong, which is exactly the class a per-variable check cannot catch.

  if (config.rerankerEnabled && config.rerankerEndpoint === undefined) {
    r.problems.push(
      'NACRE_RERANKER_ENABLED is true but NACRE_RERANKER_ENDPOINT is not set. ' +
        'Turning reranking on is worth more than any chunking tuning, and it ' +
        'needs somewhere to send the request — the full profile provides one.',
    )
  }

  if (config.aclCacheTtl > config.aclPropagationSla) {
    // The cache would still be serving a revoked grant after the SLA has
    // passed, and nacre_acl_propagation_lag_seconds would report compliance.
    r.problems.push(
      `NACRE_ACL_CACHE_TTL (${config.aclCacheTtl}) is longer than ` +
        `NACRE_ACL_PROPAGATION_SLA (${config.aclPropagationSla}); a revoked grant ` +
        'would still be served after the SLA it promises.',
    )
  }

  if (config.env === 'production' && config.canonicalUrl.startsWith('http://')) {
    // The canonical URL is the OAuth issuer and goes into every token ever
    // issued. Over plaintext it is also the thing an attacker rewrites.
    r.problems.push('NACRE_CANONICAL_URL must be https in production; it is the OAuth issuer')
  }

  if (config.env === 'production' && /(^|\/\/)(localhost|127\.0\.0\.1)/.test(config.canonicalUrl)) {
    r.problems.push('NACRE_CANONICAL_URL points at localhost in production')
  }

  if (r.problems.length > 0) throw new ConfigError(r.problems)
  return config
}
