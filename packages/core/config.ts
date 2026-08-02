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
  /**
   * The identity provider in front of this installation, if there is one.
   *
   * Optional and empty by default, because a self-hosted Nacre usually has no
   * OAuth authorization server at all: sign-in is email and password, and an
   * agent presents a service account key. Named here only so the RFC 9728
   * discovery document can point a client at the right place when a deployment
   * *does* have one — see packages/core/oauth.ts for why pointing it at
   * ourselves would be worse than leaving it out.
   */
  readonly oauthAuthorizationServer: string
  // The union rather than `string`. `oneOf` already refuses anything else at
  // startup, and typing it loosely meant the one consumer had to re-narrow a
  // value that was never wider than this.
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
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
  readonly refreshTokenTtl: number

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
  readonly rateLoginPer15Min: number
  readonly rateLoginSourcePer15Min: number
  readonly trustProxy: number
  readonly metricsToken: string | undefined
  readonly maxDocumentBytes: number

  readonly auditRetentionDays: number
  readonly auditQueryText: boolean
  /** The reindex rollback window: how long a superseded collection survives. */
  readonly collectionRetentionDays: number

  /**
   * The recall a reindex must reach before its layer switches, as a fraction.
   *
   * Read from a whole-number percentage. Applies only to a layer that has a
   * reference query set — there is no gate without one.
   */
  readonly reindexMinRecall: number

  /** How long a presigned link to a document's bytes stays valid. */
  readonly presignTtl: number

  /**
   * Object storage, or `undefined` when a deployment has none.
   *
   * Absent is a supported configuration and not a degraded one: document bytes
   * then live in `documents.source_ref`, which is what every deployment did
   * before this existed. What is *not* supported is half of it — see the
   * cross-field check, and the reason it is a check rather than a set of
   * independent optionals.
   */
  readonly s3:
    | {
        readonly endpoint: string
        readonly bucket: string
        readonly region: string
        readonly accessKey: string
        readonly secretKey: string
        readonly forcePathStyle: boolean
      }
    | undefined
}

/**
 * The keys a token may be verified against, and the one it is signed with.
 *
 * Here rather than in each process because `api` and `mcp` verify with the same
 * secret and must never disagree about which keys are current. Two copies of
 * this function are two chances for a rotation to reach one and not the other,
 * which produces 401s on part of the traffic and not the rest — the hardest
 * failure of the set to read from outside.
 */
export interface JwtKeys {
  /** Everything issued from now on is signed with this. */
  readonly key: Uint8Array
  /** Accepted on verification, never used to sign. Empty outside a rotation. */
  readonly alsoAccept: readonly Uint8Array[]
}

export function loadJwtKeys(env: NodeJS.ProcessEnv = process.env): JwtKeys {
  // Development uses a symmetric secret. Production is meant to load an Ed25519
  // key through NACRE_JWT_PRIVATE_KEY_REF; until that lands, refusing is the
  // honest behaviour — a hardcoded fallback here would be a signing key anyone
  // reading the source can forge tokens with.
  const secret = env.NACRE_JWT_SECRET
  if (secret === undefined || secret.length < 32) {
    throw new ConfigError([
      'NACRE_JWT_SECRET is not set, or is shorter than 32 bytes. ' +
        'Asymmetric keys through NACRE_JWT_PRIVATE_KEY_REF are not implemented yet; ' +
        'until they are, this is required and there is no default.',
    ])
  }

  const previous = env.NACRE_JWT_SECRET_PREVIOUS
  if (previous === undefined || previous === '') {
    return { key: new TextEncoder().encode(secret), alsoAccept: [] }
  }

  if (previous.length < 32) {
    throw new ConfigError([
      'NACRE_JWT_SECRET_PREVIOUS is set but shorter than 32 bytes. It holds the ' +
        'key being rotated out, so it is held to the same floor as the one ' +
        'replacing it. Unset it to finish the rotation.',
    ])
  }

  if (previous === secret) {
    // Refused rather than deduplicated. Setting both to the same value is what
    // an operator does when they mean to rotate and copy the wrong line, and
    // it leaves an installation that believes it has rotated and has not.
    throw new ConfigError([
      'NACRE_JWT_SECRET_PREVIOUS is the same value as NACRE_JWT_SECRET. That is ' +
        'not a rotation: it accepts one key twice. Set NACRE_JWT_SECRET to the ' +
        'new key and NACRE_JWT_SECRET_PREVIOUS to the one it replaces.',
    ])
  }

  return {
    key: new TextEncoder().encode(secret),
    alsoAccept: [new TextEncoder().encode(previous)],
  }
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

  /**
   * An optional secret with a floor on its length.
   *
   * Unset is fine and means the feature is off. Set to something short is not:
   * a short token reads as protection and is a moment's guessing, which is
   * worse than no token because it stops anyone looking again.
   */
  secret(key: string, minLength: number): string | undefined {
    const value = this.optional(key)
    if (value === undefined) return undefined
    if (value.length < minLength) {
      this.problems.push(`${key} must be at least ${minLength} characters, or unset`)
      return undefined
    }
    return value
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

/** The protocol, or an empty string when the value does not parse at all. */
function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

/**
 * The object-storage block, present only when a deployment configured one.
 *
 * Written as a group because it *is* one. Six independent optionals would
 * accept an endpoint with no credential, or a credential with no bucket, and
 * every one of those parses — the failure arrives later, as an ingest that
 * cannot store bytes, on a deployment whose configuration looked accepted.
 *
 * `NACRE_S3_*` spent its whole life in `docs/config.md` and in the `full`
 * Compose profile without `loadConfig` mentioning it once, so a wrong endpoint
 * or a missing key was silent while MinIO sat there talking to nobody. That is
 * the specific failure this shape exists to make impossible.
 */
function s3From(r: Reader, env: Env): Config['s3'] {
  const keys = [
    'NACRE_S3_ENDPOINT',
    'NACRE_S3_BUCKET',
    'NACRE_S3_ACCESS_KEY',
    'NACRE_S3_SECRET_KEY',
  ] as const

  const present = keys.filter((k) => (env[k] ?? '').trim() !== '')
  if (present.length === 0) return undefined

  if (present.length < keys.length) {
    const missing = keys.filter((k) => !present.includes(k))
    r.problems.push(
      `object storage is half configured: ${present.join(', ')} set, ` +
        `${missing.join(', ')} missing. Set all four to store document bytes in ` +
        'object storage, or none to keep them in Postgres. There is no partial ' +
        'mode — the endpoint without the credential is a deployment that accepts ' +
        'documents and cannot store them.',
    )
    return undefined
  }

  // `r.url` only asks whether `new URL` parses, and `minio:9000` does — it
  // reads as the scheme `minio:` with the path `9000`, with an empty host. That
  // would start, and then every request would be built against a URL with
  // nowhere to send it. A missing `http://` is the likeliest thing to be wrong
  // in this variable, so it is the one thing worth checking twice.
  const endpoint = r.url('NACRE_S3_ENDPOINT')
  if (endpoint !== '' && !/^https?:$/.test(safeProtocol(endpoint))) {
    r.problems.push(
      `NACRE_S3_ENDPOINT must be an http or https URL, and is ${JSON.stringify(endpoint)}. ` +
        'A bare host and port parses as a URL — the host ends up empty and every ' +
        'request goes nowhere.',
    )
  }

  return {
    endpoint,
    bucket: r.required('NACRE_S3_BUCKET'),
    // A default is fine here and nowhere else in this block: the region names
    // no host and carries no credential, MinIO ignores it entirely, and it is
    // signed into every request so it has to be *something*.
    region: r.optional('NACRE_S3_REGION') ?? 'us-east-1',
    accessKey: r.required('NACRE_S3_ACCESS_KEY'),
    secretKey: r.required('NACRE_S3_SECRET_KEY'),
    // True by default because the default deployment is self-hosted: MinIO, or
    // an endpoint reached by a name that is not a wildcard DNS entry. AWS
    // proper is the case that has to say so.
    forcePathStyle: r.boolean('NACRE_S3_FORCE_PATH_STYLE', true),
  }
}

export function loadConfig(env: Env = process.env): Config {
  const r = new Reader(env)

  const config: Config = {
    env: r.oneOf('NACRE_ENV', ['development', 'production'] as const, 'development'),
    canonicalUrl: r.url('NACRE_CANONICAL_URL'),
    oauthAuthorizationServer: r.url('NACRE_OAUTH_AUTHORIZATION_SERVER', { required: false }),
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
    // 30 days. The upper bound is a year rather than unbounded: a refresh token
    // is the credential a stolen laptop still holds, and "never expires" is a
    // choice nobody makes deliberately.
    refreshTokenTtl: r.number('NACRE_REFRESH_TOKEN_TTL', 2_592_000, { min: 300, max: 31_536_000 }),

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
    // Ten attempts per quarter hour, counted per email address. Low enough that
    // guessing is not a strategy, high enough that someone who genuinely cannot
    // remember which password they used is not locked out for the afternoon.
    rateLoginPer15Min: r.number('NACRE_RATE_LOGIN_PER_15MIN', 10, { min: 1, max: 1000 }),
    // The same window, counted per client instead of per address, because the
    // per-address limit does not bound the attack people actually run: one
    // password against ten thousand addresses never repeats a key. Six times
    // looser, because a whole office behind one NAT is one source here and the
    // job of this limit is to stop a directory being ground down, not to make
    // shared egress unusable.
    rateLoginSourcePer15Min: r.number('NACRE_RATE_LOGIN_SOURCE_PER_15MIN', 60, {
      min: 1,
      max: 10_000,
    }),
    // How many proxies sit in front of this process. Zero — the default — means
    // X-Forwarded-For is ignored entirely and the socket address is the client.
    //
    // Neither default is safe, which is why this is configuration rather than a
    // guess. Trusting the header unconditionally keys the limit above on a
    // string the attacker picks, which is worse than having no limit: a fresh
    // value per request costs a Redis round trip and accomplishes nothing.
    // Ignoring it unconditionally means that behind an ingress every request
    // carries the proxy's address, so one bad client rate-limits everybody.
    trustProxy: r.number('NACRE_TRUST_PROXY', 0, { min: 0, max: 8 }),
    // Optional, and off by default. Requiring a token would break every
    // existing scrape config for a product people self-host, and the default is
    // right for the deployment this is designed around — the port is on an
    // internal network. It stops being right the moment somebody puts the API
    // behind a public ingress without carving /metrics out, so the operator who
    // knows they are in that situation has a way to say so.
    //
    // A minimum length, because a two-character scrape token is worse than none
    // — it reads as protection and is a moment's guessing.
    metricsToken: r.secret('NACRE_METRICS_TOKEN', 16),
    maxDocumentBytes: r.number('NACRE_MAX_DOCUMENT_BYTES', 52_428_800, { min: 1024 }),

    // The floor is 30 and it is not a tunable. Retention is now enforced —
    // `prune_audit_events` deletes past this horizon — and the database refuses
    // anything shorter, because below a month "retention" stops meaning
    // retention and becomes a way to make recent events go away, which is the
    // thing the append-only grant exists to prevent. Refused here rather than
    // raised hourly by the worker: a value the deployment can never act on
    // should stop the deployment, not fill a log.
    auditRetentionDays: r.number('NACRE_AUDIT_RETENTION_DAYS', 400, { min: 30 }),
    auditQueryText: r.boolean('NACRE_AUDIT_QUERY_TEXT', false),

    // How long a superseded collection survives a model migration.
    //
    // It is a rollback window and nothing else. The cheap rollback in
    // `rollback-layer-reindex.md` is "move the pointer back", which works for
    // exactly as long as the collection it points back to still exists; past
    // this horizon that option is gone and a rollback means reindexing.
    //
    // The floor is 1 rather than 0 because a collection deleted the instant the
    // pointer moved would make a migration irreversible at the moment it is
    // most likely to be found wrong. Setting it high costs disk: each retained
    // collection is a full copy of the organization's vectors.
    collectionRetentionDays: r.number('NACRE_COLLECTION_RETENTION_DAYS', 7, { min: 1 }),

    // The floor a reindex's recall check must reach before the layer switches.
    //
    // A whole-number percentage rather than a fraction, because this reader
    // takes integers and `0.8` typed into an environment file is a value two
    // different parsers would disagree about. Divided here so everything
    // downstream works in the [0, 1] the arithmetic produces.
    //
    // The default is 80 and it gates nothing on its own: a layer with no
    // reference query set has no check at all, so this applies to deployments
    // that went and wrote one — which is a deployment asking for a gate.
    //
    // 0 is allowed and means measure without blocking. That is arithmetic
    // rather than a special case for "disabled": every recall is at least 0, so
    // the comparison passes and the number is still recorded. `min: 1` would be
    // wrong here for exactly the reason it is right on the retention window
    // above — there the low value destroys something, here it destroys nothing.
    reindexMinRecall: r.number('NACRE_REINDEX_MIN_RECALL', 80, { min: 0, max: 100 }) / 100,

    // How long a `source_url` outlives the permission check that minted it.
    //
    // A presigned URL is a bearer capability: whoever holds it fetches that
    // object without a Nacre credential, and a revocation inside the window
    // does not reach it. So the ceiling is a week — SigV4's own maximum, and
    // already far longer than any reason to hand one out — and the floor is a
    // minute, because a link that expires while the client is still following
    // the redirect is a link that never worked.
    presignTtl: r.number('NACRE_PRESIGN_TTL', 900, { min: 60, max: 604_800 }),

    // All of it or none of it — see the cross-field check below. Read here so
    // that a malformed endpoint is a startup problem like any other; whether
    // the *set* is coherent is a question no per-variable check can answer.
    s3: s3From(r, env),
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

  // ─── settings that would silently do nothing ───
  //
  // Eight variables were validated here and read nowhere. Most of those are
  // quality-of-life and are documented as unimplemented; these two are not,
  // because ignoring them changes something an operator is relying on.
  //
  // Refusing at startup rather than warning: an operator who sets these has
  // made a decision about isolation or about collision probability, and a
  // process that starts anyway has silently overruled them. `docs/config.md`
  // already says a silent default is how a deployment talks to nothing and
  // reports success — this is the same failure with a value supplied.
  if (config.vectorTenancy !== 'collection') {
    r.problems.push(
      'NACRE_VECTOR_TENANCY=shared is not implemented. Every collection is named ' +
        'per organization (org_{slug}) and there is no code path that shares one, ' +
        'so accepting this would give you a single-collection deployment that ' +
        'believes it is isolated. Use `collection`, which is the default.',
    )
  }

  if (config.aclTagHashBytes !== 8) {
    r.problems.push(
      'NACRE_ACL_TAG_HASH_BYTES is not implemented: the tag width is fixed at 8 ' +
        'bytes in the code that writes and matches tags. Setting it changes the ' +
        'collision probability you think you have and nothing else. Leave it at 8.',
    )
  }

  if (config.refreshTokenTtl <= config.accessTokenTtl) {
    r.problems.push(
      'NACRE_REFRESH_TOKEN_TTL is not longer than NACRE_ACCESS_TOKEN_TTL. A refresh ' +
        'token that expires no later than the access token it renews cannot renew ' +
        'anything, so every session would end at the first refresh.',
    )
  }

  if (config.aclCacheTtl > config.aclPropagationSla) {
    // Kept, and the reason it is kept has changed.
    //
    // It used to say a longer TTL would serve a revoked grant past the SLA.
    // That is not true of the cache that now runs: the key carries
    // `organizations.groups_version`, which triggers bump on every change to
    // groups, group_members and grants, so a revoked grant is never served —
    // the next request composes a different key. The TTL bounds memory.
    //
    // What it still catches is an operator who believes otherwise. Setting this
    // above the SLA is what someone does when they have read it as "how long a
    // stale permission may live", and a deployment configured on that belief
    // has a misunderstanding worth interrupting at boot rather than a setting
    // worth honouring.
    r.problems.push(
      `NACRE_ACL_CACHE_TTL (${config.aclCacheTtl}) is longer than ` +
        `NACRE_ACL_PROPAGATION_SLA (${config.aclPropagationSla}). The cache is keyed ` +
        'on the permission epoch, so this does not delay a revocation — but a value ' +
        'above the SLA usually means it was read as though it did.',
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
