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

import { createHash, createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_EMBED_BATCH } from './endpoint.js'
import type { MailConfig } from './mail.js'
import { DEFAULT_EMBED_MAX_TOKENS } from './text/tokens.js'

export interface Config {
  readonly env: 'development' | 'production'
  readonly canonicalUrl: string
  /**
   * What the MCP transport calls itself, when it is not behind the same origin
   * as the API.
   *
   * `/.well-known/oauth-protected-resource` names a resource identifier, and
   * RFC 9728 has the client check it against the URL it actually reached. The
   * API and the MCP transport serve **one** document so the two can never
   * disagree about the audience a token is bound to — which is right, and which
   * makes the identifier wrong for whichever of them is not at
   * `NACRE_CANONICAL_URL`.
   *
   * A deployment behind one origin needs nothing here. One publishing two ports
   * — which is what `docker compose up` does — sets this on the MCP process to
   * the URL clients use for it, and a client connecting there stops being told
   * the resource is somewhere else.
   *
   * It moves *only* the discovery document. The audience a token must carry is
   * `NACRE_JWT_AUDIENCE` and the issuer is `NACRE_JWT_ISSUER`; both stay
   * identical across the processes, because this one verifies what the other
   * signed.
   */
  readonly mcpCanonicalUrl: string
  /**
   * Whether `NACRE_MCP_CANONICAL_URL` was set, as opposed to inherited.
   *
   * The value above always resolves — it falls back to `NACRE_CANONICAL_URL` —
   * so "configured" and "defaulted" are indistinguishable from it, and the MCP
   * transport needs to tell them apart: unpinned, it builds the discovery
   * document from the `Host` the client actually reached, which is what RFC
   * 9728 asks the identifier to match. Pinned, the operator's value wins,
   * because behind a proxy that rewrites `Host` they are the only one who
   * knows.
   */
  readonly mcpCanonicalUrlPinned: boolean
  /**
   * Where a browser is sent to choose which agent a client will act as.
   *
   * The admin UI's consent screen. Defaults to `/#/consent` on the canonical
   * URL, which is right for every deployment that serves the bundle on the
   * API's origin — the arrangement `docs/quickstart.md` describes for
   * production and the one an ingress produces. The Compose stack publishes the
   * admin UI on its own port, so it sets this.
   *
   * A default naming a *path* on a host the deployment already declared is not
   * the "silent default for a URL" rule being bent: the host is the operator's
   * own `NACRE_CANONICAL_URL`, and the only guess is where the bundle sits
   * under it.
   */
  readonly consentUrl: string
  /**
   * Browser origins the MCP transport answers.
   *
   * Empty by default and that is the safe default: validating `Origin` is a
   * MUST in the specification and the attack it names is DNS rebinding, where
   * a page in somebody's browser reaches an MCP server on their network. An
   * agent sends no `Origin` and is unaffected, so an empty list refuses
   * browsers and nothing else.
   */
  /**
   * Extra embedder origins a tenant `POST /v1/embedding-providers` may name,
   * from `NACRE_EMBED_ALLOWED_HOSTS`. The installation's configured default is
   * trusted without this; the list is for a *second* internal embedder an
   * operator runs deliberately. Empty by default — the safe state, in which the
   * only internal endpoint a tenant may name is the configured default itself.
   */
  readonly embedAllowedHosts: readonly string[]
  /**
   * Whether a tenant `org_admin` may create an embedding provider at all, from
   * `NACRE_EMBED_TENANT_PROVIDERS`. Default **true**, which is the open core: a
   * single-organization operator *is* the `org_admin` and manages their own
   * embedders. A managed multi-tenant platform sets it **false** — there
   * `org_admin` is a customer, embedding is a service the platform provides,
   * and `POST /v1/embedding-providers` answers `404` so no tenant can point the
   * shared worker anywhere. When false the SSRF surface does not exist; when
   * true the egress guard bounds it.
   */
  readonly embedTenantProviders: boolean
  readonly mcpAllowedOrigins: readonly string[]
  /**
   * Browser origins the REST API answers, from `NACRE_API_ALLOWED_ORIGINS`.
   *
   * Separate from the MCP list because they are separate processes with
   * separate configuration and, on a split deployment, separate hostnames — one
   * variable would force a deployment to admit an origin on a surface it did
   * not mean to.
   */
  readonly apiAllowedOrigins: readonly string[]
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

  /**
   * Packages to import at startup so they can register extensions.
   *
   * Named rather than imported, because this repository's CI fails if its
   * source mentions the commercial package at all — see `extensions.ts`. Empty
   * is the default and is the whole open-core product.
   */
  readonly modules: readonly string[]

  readonly pgUrl: string
  readonly pgPoolMax: number
  readonly qdrantUrl: string
  readonly qdrantApiKey: string | undefined
  /**
   * Shards per collection, and copies of each shard.
   *
   * Both are **fixed when a collection is created** and Qdrant cannot change
   * either afterwards, so these decide the shape a deployment will live with
   * until it copies every point into a new collection. That copy is real work
   * and it is also machinery that exists — a model migration does exactly it,
   * moving vectors without recomputing them — so getting this wrong is
   * expensive rather than fatal.
   *
   * Both default to 1, which is what every collection created before these
   * existed has. Raising shards on a single node is worse than leaving it: more
   * segments, no more parallelism, and nowhere to rebalance to. Raising the
   * replication factor above the number of nodes leaves the collection unable
   * to meet it.
   */
  readonly qdrantShards: number
  readonly qdrantReplicationFactor: number
  readonly vectorTenancy: 'collection' | 'shared'
  readonly redisUrl: string

  /**
   * What a **new** organization's embedding provider is made of, and read by
   * `init` alone.
   *
   * Optional here, and that is a fix rather than a relaxation. These three were
   * `required`, so the API, the MCP transport and the worker each refused to
   * start without three values none of them reads — every one of those
   * processes takes its endpoint, model and width from the layer's
   * `embedding_providers` row, which is the whole point of that table. The
   * effect was an operator having to invent an embedder to run a stack whose
   * embedder was already configured in the database, and the values they
   * invented then looked authoritative and were not.
   *
   * `init` refuses by name when they are missing, which is where the
   * requirement actually is.
   */
  readonly embeddingEndpoint: string | undefined
  readonly embeddingModel: string | undefined
  readonly embeddingDim: number
  /**
   * How many chunks go to an embedding endpoint in one request.
   *
   * Defaults to Text Embeddings Inference's own `--max-client-batch-size`,
   * because TEI is what every Compose profile here starts and 413 is what it
   * answers above that. A hosted vendor accepts far more and can be told so;
   * nothing is gained by guessing on its behalf.
   */
  readonly embedBatch: number
  /**
   * The most tokens one input may cost the embedding endpoint.
   *
   * Chunking is bounded by this as well as by the layer's character size, and
   * a character is not a token: 800 characters of English costs 149 and 800 of
   * Korean costs 1094, so before this existed a Cyrillic or CJK corpus failed
   * every document while the API answered `queued`.
   */
  readonly embedMaxTokens: number
  readonly parserEndpoint: string
  readonly rerankerEndpoint: string | undefined
  readonly rerankerEnabled: boolean
  readonly rerankCandidates: number

  readonly jwtIssuer: string
  readonly jwtAudience: string
  readonly accessTokenTtl: number
  readonly refreshTokenTtl: number

  readonly aclCacheTtl: number

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
  readonly signing: KeyObject | Uint8Array
  /**
   * What a token is verified against.
   *
   * The same value as `signing` for a shared secret, and the **public half**
   * for Ed25519 — which is the whole reason the asymmetric mode is worth
   * having. A process that only verifies never needs the private key, so the
   * blast radius of reading a container's environment stops at "can check
   * tokens" instead of "can mint them".
   */
  readonly verification: KeyObject | Uint8Array
  /** Accepted on verification, never used to sign. Empty outside a rotation. */
  readonly alsoAccept: readonly (KeyObject | Uint8Array)[]
  /**
   * Pinned, and passed to `jwtVerify` rather than left to the token's header.
   *
   * A verifier that accepts whatever `alg` a token claims is the classic JWT
   * mistake. `jose` already refuses the worst shapes — `none`, and an HMAC
   * algorithm against an asymmetric `KeyObject` — but "the library happens to
   * stop it" is not the same statement as "this deployment accepts exactly one
   * algorithm", and only the second one survives a dependency upgrade.
   */
  readonly algorithm: 'HS256' | 'EdDSA'
  /**
   * The current key's `kid`, put in the header of every token this process
   * signs so a JWKS consumer can select rather than try each. Absent for HMAC,
   * where it would name nothing anyone could fetch.
   */
  readonly keyId?: string
  /**
   * What `/.well-known/jwks.json` serves. Absent for HMAC.
   *
   * A shared secret has no publishable half, and serving one would be serving
   * the signing key — so this is optional rather than always present, and the
   * endpoint exists only when there is something safe to put in it.
   *
   * The retired key is in here too during a rotation, for the same reason it is
   * still accepted: there are tokens in the wild signed with it, and a verifier
   * outside this process has to be able to check them. Assembled here rather
   * than by each caller, because a JWKS missing the previous key is a rotation
   * that breaks every external verifier at the restart.
   */
  readonly jwks?: readonly Record<string, unknown>[]
}

/**
 * What a process that only *verifies* tokens needs — the verification key, the
 * keys still accepted during a rotation, and the one algorithm it will honour.
 * No `signing`, no `jwks` to publish: a resource server such as the MCP
 * transport checks tokens and never mints them, and `loadJwtVerification` lets
 * it be configured with only the public half, so reading its environment gets
 * an attacker to "can check tokens" and no further.
 */
export interface JwtVerification {
  readonly verification: KeyObject | Uint8Array
  readonly alsoAccept: readonly (KeyObject | Uint8Array)[]
  readonly algorithm: 'HS256' | 'EdDSA'
}

/** A stable identifier for a key, from its public bytes. Never from the secret. */
function fingerprint(der: Buffer): string {
  return createHash('sha256').update(der).digest('base64url').slice(0, 16)
}

/**
 * One public key as a JWK.
 *
 * `kid` is derived from the public bytes rather than configured, so it is
 * stable across restarts and identical in every process without anyone having
 * to keep two settings in step.
 */
function publicJwk(key: KeyObject): Record<string, unknown> {
  const der = key.export({ type: 'spki', format: 'der' })
  return {
    ...(key.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: fingerprint(der),
    use: 'sig',
    alg: 'EdDSA',
  }
}

/**
 * A short, non-reversible name for whichever key is in use, for a startup line.
 *
 * An operator needs to know *which* key a process loaded when two environments
 * disagree — and nobody needs the key itself in a log. `api` and `mcp` each had
 * their own copy of this, taking a `Uint8Array`; two copies of a function that
 * hashes a secret is two chances for one of them to log the wrong thing.
 *
 * For an asymmetric key it is a digest of the **public** half, which means the
 * value printed by a process holding the private key matches the one printed by
 * a process holding only the public key. That is precisely the comparison this
 * exists to let someone make.
 */
export function keyFingerprint(key: KeyObject | Uint8Array): string {
  if (key instanceof Uint8Array) {
    return `sha256:${createHash('sha256').update(key).digest('hex').slice(0, 12)}`
  }
  const der = (key.type === 'private' ? createPublicKey(key) : key).export({
    type: 'spki',
    format: 'der',
  })
  return `ed25519:${fingerprint(der)}`
}

/**
 * One Ed25519 key from a `file://` reference, plus its public half.
 *
 * `file://` only, and that is the whole of the scheme support. The variable is
 * named `_REF` because `docs/config.md` requires secrets to be references into
 * a secret store rather than values, and every platform that has one — Docker
 * secrets, Kubernetes, systemd credentials — presents it as a file. A `vault://`
 * or `aws-kms://` scheme would be a network client on the startup path, which
 * is a different feature with different failure modes.
 */
/**
 * Read the PEM a `file://` reference names. Shared by the private- and
 * public-key loaders so the `file://`-only rule and its error wording live in
 * one place; `kind` only changes the noun in the messages.
 */
function readPemRef(ref: string, variable: string, kind: 'private' | 'public'): string {
  let path: string
  try {
    const url = new URL(ref)
    if (url.protocol !== 'file:') {
      throw new Error(`scheme ${url.protocol} is not supported`)
    }
    path = fileURLToPath(url)
  } catch (cause) {
    throw new ConfigError([
      `${variable} is not a file:// URL: ${String(cause)}. ` +
        `It names a file holding a PEM ${kind} key, for example ` +
        'file:///run/secrets/jwt_ed25519.',
    ])
  }

  try {
    return readFileSync(path, 'utf8')
  } catch (cause) {
    throw new ConfigError([
      `${variable} names ${path}, which cannot be read: ${String(cause)}.`,
    ])
  }
}

/**
 * The public half of an Ed25519 key, from a `file://` reference to a PEM public
 * key. This is what a process that only *verifies* tokens needs — and all it
 * needs, which is the point: reading its environment gets an attacker to "can
 * check tokens" and no further. See `loadJwtVerification`.
 */
function loadEd25519Public(ref: string, variable: string): KeyObject {
  const pem = readPemRef(ref, variable, 'public')

  // `createPublicKey` will happily extract the public half from a *private* PEM,
  // which would let an operator paste the private key into the public-key
  // variable and never notice — leaving the file this variable exists to keep
  // off this process sitting right on it. Refuse it by name: the whole point of
  // a verify-only process is that the private key is nowhere near it.
  if (/PRIVATE KEY/.test(pem)) {
    throw new ConfigError([
      `${variable} names a file that contains a PRIVATE key. This variable is for ` +
        'the public half only — a process that verifies must not be given the ' +
        'signing key. Export the public half with ' +
        '`openssl pkey -in jwt_ed25519.pem -pubout -out jwt_ed25519.pub`.',
    ])
  }

  let key: KeyObject
  try {
    key = createPublicKey(pem)
  } catch (cause) {
    throw new ConfigError([
      `${variable} names a file that is not a PEM public key: ${String(cause)}. ` +
        'Export one from the signing key with ' +
        '`openssl pkey -in jwt_ed25519.pem -pubout -out jwt_ed25519.pub`.',
    ])
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    throw new ConfigError([
      `${variable} names a ${String(key.asymmetricKeyType)} public key. Only Ed25519 ` +
        'is accepted — it must match the signing key, which is Ed25519.',
    ])
  }

  return key
}

function loadEd25519(ref: string, variable: string): { private: KeyObject; public: KeyObject } {
  const pem = readPemRef(ref, variable, 'private')

  let key: KeyObject
  try {
    key = createPrivateKey(pem)
  } catch (cause) {
    throw new ConfigError([
      `${variable} names a file that is not a PEM private key: ${String(cause)}.`,
    ])
  }

  if (key.asymmetricKeyType !== 'ed25519') {
    // One algorithm, refused rather than adapted. RSA needs a size check and a
    // padding choice, and EC needs a curve-to-algorithm mapping — each a place
    // to be wrong about something a token's signature depends on. Ed25519 has
    // no parameters, and it is what `docs/config.md` has named in its example
    // since the variable was written.
    throw new ConfigError([
      `${variable} names a ${String(key.asymmetricKeyType)} key. Only Ed25519 is ` +
        'accepted: it has no parameters to get wrong, and it is what the example ' +
        'in docs/config.md names. Generate one with ' +
        '`openssl genpkey -algorithm ed25519 -out jwt_ed25519.pem`.',
    ])
  }

  return { private: key, public: createPublicKey(key) }
}

/**
 * The key a second factor's secret is sealed with, if a deployment has one.
 *
 * **Absent is a supported state and the whole feature is simply not offered.**
 * Not a degraded one: enrolment is refused, the console shows no control, and
 * nothing stores a TOTP secret in the clear "for now". A product that half-does
 * a second factor is worse than one that does none, because the operator
 * believes something.
 *
 * `file://` only and 32 bytes, on the same two arguments the token key makes: a
 * platform with a secret store presents one as a file, and a scheme that
 * fetched over the network would put a client on the startup path. Generate one
 * with `openssl rand -out nacre_2fa.key 32`.
 *
 * Losing it locks every enrolled person out of their second factor — which is
 * what recovery codes are for, and why they are minted at enrolment rather than
 * on demand.
 */
/**
 * The installation's sender, or none.
 *
 * All or nothing, validated as a group the way `NACRE_S3_*` is: a URL with no
 * `From:` parses and then fails on the first message, at which point the
 * failure is a log line nobody is reading rather than a refusal at startup.
 *
 * **Unset is a supported deployment and the feature is absent**, not degraded.
 * No sender means no recovery route mounted and no link on the sign-in screen,
 * because a control that answers "email is not configured" is a control that
 * tells an unauthenticated stranger about the deployment.
 */
export function loadMailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | undefined {
  const url = env.NACRE_SMTP_URL
  const from = env.NACRE_MAIL_FROM

  const set = [
    ['NACRE_SMTP_URL', url],
    ['NACRE_MAIL_FROM', from],
  ].filter(([, value]) => value !== undefined && value !== '')

  if (set.length === 0) return undefined
  if (set.length !== 2) {
    throw new ConfigError([
      'NACRE_SMTP_URL and NACRE_MAIL_FROM are set as a group or not at all. ' +
        `Only ${set.map(([name]) => String(name)).join(', ')} is set; a relay with no sender ` +
        'address parses and then fails on the first message, which is a log line rather than ' +
        'a refusal you would notice.',
    ])
  }

  let parsed: URL
  try {
    parsed = new URL(url as string)
  } catch (cause) {
    throw new ConfigError([`NACRE_SMTP_URL is not a URL: ${String(cause)}.`])
  }
  if (parsed.protocol !== 'smtp:' && parsed.protocol !== 'smtps:') {
    // By name, because `NACRE_S3_ENDPOINT=minio:9000` was accepted by `new URL`
    // as the scheme `minio:` with an empty host, and this is the same mistake
    // waiting in a different variable.
    throw new ConfigError([
      `NACRE_SMTP_URL has the scheme ${parsed.protocol} — it takes smtp:// or smtps://, ` +
        'for example smtps://nacre%40example.com:secret@smtp.example.com:465.',
    ])
  }
  if (parsed.hostname === '') {
    throw new ConfigError([`NACRE_SMTP_URL names no host: ${String(url)}.`])
  }

  return { url: url as string, from: from as string }
}

/**
 * The key that seals a second factor's secret, as a value and only as a value.
 *
 * **One variable, and there was deliberately never a second.** This started as a
 * pair — a value and a `NACRE_2FA_KEY_REF` naming a file — with a paragraph
 * about how a file is the better one where a platform offers it. That is true
 * and is not worth a second variable: an operator who wants the file has one
 * line of shell (`NACRE_2FA_KEY=$(cat /run/secrets/nacre_2fa.key)`), while the
 * product would have carried two ways to say the same thing forever, plus the
 * refusal for setting both, plus two spellings in every document and in the
 * message the console shows an operator who has set neither. Deleted before
 * 0.18.0 shipped, so nothing was ever configured with it and there is no
 * compatibility to keep — which is the only cheap moment to make this decision
 * and the reason it was made now.
 *
 * `NACRE_JWT_PRIVATE_KEY_REF` beside it is file-only for a different reason and
 * is not the same shape: a private signing key must not be in the environment at
 * all, so there is one form there too. The rule both follow is one form per
 * thing, not one form for everything.
 *
 * **Base64 or hex, and exactly 32 bytes.** Not an arbitrary string: a passphrase
 * somebody typed would be accepted, stretched by nothing, and every sealed
 * secret in the installation would be worth whatever that passphrase was. The
 * refusal names the command that produces a correct one.
 */
function decodeSecondFactorKey(value: string): Buffer {
  const text = value.trim()
  const advice = 'It takes 32 bytes as base64 or hex: `openssl rand -base64 32`.'

  if (/^[0-9a-f]{64}$/iu.test(text)) return Buffer.from(text, 'hex')

  if (/^[A-Za-z0-9+/_-]+={0,2}$/u.test(text)) {
    const bytes = Buffer.from(text, 'base64')
    if (bytes.length === 32) return bytes
    throw new ConfigError([
      `NACRE_2FA_KEY decodes to ${String(bytes.length)} bytes rather than 32. ${advice}`,
    ])
  }

  throw new ConfigError([`NACRE_2FA_KEY is not base64 or hex. ${advice}`])
}

export function loadSecondFactorKey(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const inline = env.NACRE_2FA_KEY
  if (inline === undefined || inline === '') return undefined
  return decodeSecondFactorKey(inline)
}

export function loadJwtKeys(env: NodeJS.ProcessEnv = process.env): JwtKeys {
  const secret = env.NACRE_JWT_SECRET
  const ref = env.NACRE_JWT_PRIVATE_KEY_REF

  if (secret !== undefined && secret !== '' && ref !== undefined && ref !== '') {
    // Refused rather than resolved by precedence. Whichever one this picked, the
    // other would be configured, apparently in use, and silently ignored — and
    // the operator would find out when the tokens they expected to be Ed25519
    // turned out to be HMAC, or the other way round.
    throw new ConfigError([
      'NACRE_JWT_SECRET and NACRE_JWT_PRIVATE_KEY_REF are both set. They are two ' +
        'answers to "what signs a token" and there is no order of precedence ' +
        'worth inventing. Set one.',
    ])
  }

  if (ref !== undefined && ref !== '') {
    const current = loadEd25519(ref, 'NACRE_JWT_PRIVATE_KEY_REF')
    const der = current.public.export({ type: 'spki', format: 'der' })

    const previousRef = env.NACRE_JWT_PREVIOUS_KEY_REF
    const previous =
      previousRef === undefined || previousRef === ''
        ? undefined
        : loadEd25519(previousRef, 'NACRE_JWT_PREVIOUS_KEY_REF')

    if (
      previous !== undefined &&
      previous.public.export({ type: 'spki', format: 'der' }).equals(der)
    ) {
      // The same refusal the symmetric path makes, for the same reason: this is
      // what an operator does when they mean to rotate and copy the wrong path,
      // and it leaves an installation that believes it has rotated and has not.
      throw new ConfigError([
        'NACRE_JWT_PREVIOUS_KEY_REF names the same key as NACRE_JWT_PRIVATE_KEY_REF. ' +
          'That is not a rotation: it accepts one key twice. Point ' +
          'NACRE_JWT_PRIVATE_KEY_REF at the new key and NACRE_JWT_PREVIOUS_KEY_REF ' +
          'at the one it replaces.',
      ])
    }

    return {
      signing: current.private,
      verification: current.public,
      alsoAccept: previous === undefined ? [] : [previous.public],
      algorithm: 'EdDSA',
      keyId: fingerprint(der),
      jwks: [
        publicJwk(current.public),
        ...(previous === undefined ? [] : [publicJwk(previous.public)]),
      ],
    }
  }

  // A symmetric secret is still supported and is still the default. It is what
  // a laptop and a Compose file want, and refusing it would make the asymmetric
  // path mandatory for a product whose first run is `docker compose up`.
  if (secret === undefined || secret.length < 32) {
    throw new ConfigError([
      'NACRE_JWT_SECRET is not set, or is shorter than 32 bytes. ' +
        'Set it, or point NACRE_JWT_PRIVATE_KEY_REF at an Ed25519 private key. ' +
        'There is no default: a signing key in the source is one anybody reading ' +
        'the source can forge tokens with.',
    ])
  }

  const previous = env.NACRE_JWT_SECRET_PREVIOUS
  if (previous === undefined || previous === '') {
    const key = new TextEncoder().encode(secret)
    return { signing: key, verification: key, alsoAccept: [], algorithm: 'HS256' }
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

  const key = new TextEncoder().encode(secret)
  return {
    signing: key,
    verification: key,
    alsoAccept: [new TextEncoder().encode(previous)],
    algorithm: 'HS256',
  }
}

/**
 * Verification-only key material, for a process that checks tokens and never
 * signs one — the MCP transport, which is a resource server.
 *
 * Three ways to name the key, exactly one of them at a time:
 *
 * - `NACRE_JWT_PUBLIC_KEY_REF` — the Ed25519 **public** key, and nothing else.
 *   This is the one that makes the asymmetric mode worth what it claims: the
 *   verifier holds no secret and no private key, so an attacker who reads its
 *   environment can check tokens and cannot mint them. `NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF`
 *   is its rotation overlap, mirroring the private side.
 * - `NACRE_JWT_PRIVATE_KEY_REF` — the private key, from which the public half is
 *   derived. Accepted so a process co-located with the signer, or one that
 *   simply has the private key, still verifies; it just does not get the
 *   separation the public-only path does.
 * - `NACRE_JWT_SECRET` — the shared secret. Verifying and signing are the same
 *   key here by definition, so there is no separation to be had and the process
 *   holds the secret regardless; this exists so a Compose deployment that runs
 *   on a shared secret still starts.
 *
 * Setting more than one is refused, for the same reason `loadJwtKeys` refuses
 * two answers to "what signs a token": whichever won, the others would be
 * configured, apparently in use, and ignored.
 */
export function loadJwtVerification(env: NodeJS.ProcessEnv = process.env): JwtVerification {
  const secret = env.NACRE_JWT_SECRET
  const publicRef = env.NACRE_JWT_PUBLIC_KEY_REF
  const privateRef = env.NACRE_JWT_PRIVATE_KEY_REF

  const named = [
    secret !== undefined && secret !== '' ? 'NACRE_JWT_SECRET' : undefined,
    publicRef !== undefined && publicRef !== '' ? 'NACRE_JWT_PUBLIC_KEY_REF' : undefined,
    privateRef !== undefined && privateRef !== '' ? 'NACRE_JWT_PRIVATE_KEY_REF' : undefined,
  ].filter((v): v is string => v !== undefined)

  if (named.length > 1) {
    throw new ConfigError([
      `${named.join(' and ')} are set together. They are ${named.length} answers to ` +
        '"what verifies a token" and there is no order of precedence worth ' +
        'inventing. A resource server needs exactly one: the public key ' +
        '(NACRE_JWT_PUBLIC_KEY_REF) if the deployment signs with Ed25519, or ' +
        'NACRE_JWT_SECRET if it signs with a shared secret.',
    ])
  }

  const sameSpki = (a: KeyObject, b: KeyObject): boolean =>
    a
      .export({ type: 'spki', format: 'der' })
      .equals(b.export({ type: 'spki', format: 'der' }))

  if (publicRef !== undefined && publicRef !== '') {
    const current = loadEd25519Public(publicRef, 'NACRE_JWT_PUBLIC_KEY_REF')
    const prevRef = env.NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF
    const previous =
      prevRef === undefined || prevRef === ''
        ? undefined
        : loadEd25519Public(prevRef, 'NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF')

    if (previous !== undefined && sameSpki(current, previous)) {
      throw new ConfigError([
        'NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF names the same key as ' +
          'NACRE_JWT_PUBLIC_KEY_REF. That is not a rotation: it accepts one key ' +
          'twice. Point NACRE_JWT_PUBLIC_KEY_REF at the new public key and ' +
          'NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF at the one it replaces.',
      ])
    }

    return {
      verification: current,
      alsoAccept: previous === undefined ? [] : [previous],
      algorithm: 'EdDSA',
    }
  }

  if (privateRef !== undefined && privateRef !== '') {
    const current = loadEd25519(privateRef, 'NACRE_JWT_PRIVATE_KEY_REF')
    const prevRef = env.NACRE_JWT_PREVIOUS_KEY_REF
    const previous =
      prevRef === undefined || prevRef === ''
        ? undefined
        : loadEd25519(prevRef, 'NACRE_JWT_PREVIOUS_KEY_REF')

    if (previous !== undefined && sameSpki(current.public, previous.public)) {
      throw new ConfigError([
        'NACRE_JWT_PREVIOUS_KEY_REF names the same key as NACRE_JWT_PRIVATE_KEY_REF. ' +
          'That is not a rotation: it accepts one key twice.',
      ])
    }

    return {
      verification: current.public,
      alsoAccept: previous === undefined ? [] : [previous.public],
      algorithm: 'EdDSA',
    }
  }

  if (secret === undefined || secret.length < 32) {
    throw new ConfigError([
      'no verification key is set, or NACRE_JWT_SECRET is shorter than 32 bytes. ' +
        'A resource server needs one of NACRE_JWT_PUBLIC_KEY_REF (Ed25519 public ' +
        'key), NACRE_JWT_PRIVATE_KEY_REF, or NACRE_JWT_SECRET — matching how the ' +
        'issuer signs.',
    ])
  }

  const previousSecret = env.NACRE_JWT_SECRET_PREVIOUS
  if (previousSecret !== undefined && previousSecret !== '') {
    if (previousSecret.length < 32) {
      throw new ConfigError([
        'NACRE_JWT_SECRET_PREVIOUS is set but shorter than 32 bytes. It holds the ' +
          'key being rotated out and is held to the same floor as the one replacing it.',
      ])
    }
    if (previousSecret === secret) {
      throw new ConfigError([
        'NACRE_JWT_SECRET_PREVIOUS is the same value as NACRE_JWT_SECRET. That is ' +
          'not a rotation: it accepts one key twice.',
      ])
    }
  }

  const key = new TextEncoder().encode(secret)
  return {
    verification: key,
    alsoAccept:
      previousSecret === undefined || previousSecret === ''
        ? []
        : [new TextEncoder().encode(previousSecret)],
    algorithm: 'HS256',
  }
}

export class ConfigError extends Error {
  readonly problems: readonly string[]

  constructor(problems: readonly string[]) {
    // Deduplicated, order kept: several readers each report the same missing
    // variable, and "NACRE_CANONICAL_URL is not set" three times reads as
    // three problems to fix rather than one.
    const distinct = [...new Set(problems)]
    super(
      `configuration is not usable:\n${distinct.map((p) => `  - ${p}`).join('\n')}\n` +
        'Every one of these is required at startup. See docs/config.md.',
    )
    this.name = 'ConfigError'
    this.problems = distinct
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

  /**
   * A comma-separated list, trimmed, with empty entries dropped.
   *
   * Absent and empty are the same answer — an empty list — because the one
   * consumer so far is an allow-list where "not set" and "set to nothing" both
   * mean "allow nothing", and inventing a difference between them would be a
   * distinction nobody could act on.
   */
  stringList(key: string): readonly string[] {
    return (this.optional(key) ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
  }

  /**
   * An origin allow-list, where `*` is refused by name.
   *
   * Nothing here treats `*` as a wildcard — an origin is admitted by exact
   * match — so an operator who writes one gets a list that matches nothing
   * while looking like it opened the surface to everybody. A value that is
   * configured, accepted and does nothing is the shape this repository keeps
   * removing, and on an *authorization* boundary the direction of the
   * misunderstanding is the dangerous one: they would believe they had opened
   * it, not that they had closed it.
   *
   * Refused rather than honoured, because with credentials never allowed a
   * wildcard would still be a choice nobody should make by typing one
   * character.
   */
  originList(key: string): readonly string[] {
    const origins = this.stringList(key)
    if (origins.includes('*')) {
      this.problems.push(
        `${key} contains "*", which this product does not treat as a wildcard — an origin is ` +
          'admitted by exact match. Name each origin, or leave it empty, which allows none.',
      )
    }
    return origins
  }

  /**
   * A URL, and **an http or https one** — the second half is the part that
   * catches anything.
   *
   * `new URL('embedder:80')` succeeds. It reads as the scheme `embedder:` with
   * the path `80` and an empty host, so a deployment that forgot `http://`
   * starts, reports itself healthy, and builds every request against a URL with
   * nowhere to send it. That is the likeliest thing to be wrong in any variable
   * naming a service, and it was checked for exactly one of the eight: the S3
   * endpoint, whose own comment said "so it is the one thing worth checking
   * twice" about a mistake that is no more likely there than in
   * `NACRE_QDRANT_URL` or `NACRE_PARSER_ENDPOINT`.
   *
   * One check that asks every caller, rather than a second copy beside the
   * first — which is this repository's standing answer to a fix that landed in
   * one place and not in its sibling.
   */
  url(key: string, { required = true } = {}): string {
    const raw = required ? this.required(key) : (this.optional(key) ?? '')
    if (raw === '') return ''
    try {
      new URL(raw)
    } catch {
      this.problems.push(`${key} is not a URL: ${JSON.stringify(raw)}`)
      return raw
    }
    if (!/^https?:$/.test(safeProtocol(raw))) {
      this.problems.push(
        `${key} must be an http or https URL, and is ${JSON.stringify(raw)}. ` +
          'A bare host and port parses as a URL — the host ends up empty and every ' +
          'request goes nowhere.',
      )
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

  // The `minio:9000` check that used to live here is inside `r.url` now, so it
  // asks every variable naming a service rather than this one. Two copies would
  // report one mistake twice.
  const endpoint = r.url('NACRE_S3_ENDPOINT')

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
    // Defaults to the canonical URL, which is correct for every deployment
    // behind a single origin and is what this was before the variable existed.
    mcpCanonicalUrl:
      r.url('NACRE_MCP_CANONICAL_URL', { required: false }) || r.url('NACRE_CANONICAL_URL'),
    mcpCanonicalUrlPinned: r.url('NACRE_MCP_CANONICAL_URL', { required: false }) !== '',
    consentUrl:
      r.url('NACRE_OAUTH_CONSENT_URL', { required: false }) ||
      `${r.url('NACRE_CANONICAL_URL').replace(/\/+$/, '')}/#/consent`,
    embedAllowedHosts: r.originList('NACRE_EMBED_ALLOWED_HOSTS'),
    embedTenantProviders: r.boolean('NACRE_EMBED_TENANT_PROVIDERS', true),
    mcpAllowedOrigins: r.originList('NACRE_MCP_ALLOWED_ORIGINS'),
    apiAllowedOrigins: r.originList('NACRE_API_ALLOWED_ORIGINS'),
    oauthAuthorizationServer: r.url('NACRE_OAUTH_AUTHORIZATION_SERVER', { required: false }),
    logLevel: r.oneOf('NACRE_LOG_LEVEL', ['debug', 'info', 'warn', 'error'] as const, 'info'),
    logFormat: r.oneOf('NACRE_LOG_FORMAT', ['json', 'text'] as const, 'json'),

    pgUrl: r.required('NACRE_PG_URL'),
    pgPoolMax: r.number('NACRE_PG_POOL_MAX', 20, { min: 1, max: 1000 }),
    qdrantUrl: r.url('NACRE_QDRANT_URL'),
    qdrantApiKey: r.optional('NACRE_QDRANT_API_KEY'),
    qdrantShards: r.number('NACRE_QDRANT_SHARDS', 1, { min: 1, max: 1024 }),
    qdrantReplicationFactor: r.number('NACRE_QDRANT_REPLICATION_FACTOR', 1, { min: 1, max: 16 }),
    vectorTenancy: r.oneOf('NACRE_VECTOR_TENANCY', ['collection', 'shared'] as const, 'collection'),
    redisUrl: r.required('NACRE_REDIS_URL'),

    // Still validated as a URL when it is set — an unparseable one is a
    // refusal here, not a surprise inside `init`.
    embeddingEndpoint: r.url('NACRE_DEFAULT_EMBEDDING_ENDPOINT', { required: false }) || undefined,
    embeddingModel: r.optional('NACRE_DEFAULT_EMBEDDING_MODEL'),
    embeddingDim: r.number('NACRE_DEFAULT_EMBEDDING_DIM', 1024, { min: 8, max: 16384 }),
    embedBatch: r.number('NACRE_EMBED_BATCH', DEFAULT_EMBED_BATCH, { min: 1, max: 2048 }),
    embedMaxTokens: r.number('NACRE_EMBED_MAX_TOKENS', DEFAULT_EMBED_MAX_TOKENS, {
      min: 16,
      max: 32_768,
    }),
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

    // Comma-separated, trimmed, empties dropped. A module that cannot be
    // imported fails startup rather than warning: naming one is a statement
    // that the deployment is paying for what it does, and coming up without it
    // would silently be a different product.
    modules: (env.NACRE_MODULES ?? '')
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m !== ''),

    jwtIssuer: r.required('NACRE_JWT_ISSUER'),
    jwtAudience: r.required('NACRE_JWT_AUDIENCE'),
    accessTokenTtl: r.number('NACRE_ACCESS_TOKEN_TTL', 900, { min: 60, max: 86_400 }),
    // 30 days. The upper bound is a year rather than unbounded: a refresh token
    // is the credential a stolen laptop still holds, and "never expires" is a
    // choice nobody makes deliberately.
    refreshTokenTtl: r.number('NACRE_REFRESH_TOKEN_TTL', 2_592_000, { min: 300, max: 31_536_000 }),

    aclCacheTtl: r.number('NACRE_ACL_CACHE_TTL', 60, { min: 0, max: 3600 }),
    gcGrace: r.number('NACRE_GC_GRACE', 3600, { min: 0, max: 2_592_000 }),
    // 15 minutes: long enough for a large PDF through parse, chunk, embed, and
    // upsert, short enough that a drained node's documents are not stuck for an
    // afternoon. The minimum is 60 rather than 0 — a zero lease reclaims a
    // document the instant it is claimed, which is a loop, not a setting.
    indexLease: r.number('NACRE_INDEX_LEASE', 900, { min: 60, max: 86_400 }),
    indexMaxAttempts: r.number('NACRE_INDEX_MAX_ATTEMPTS', 5, { min: 1, max: 100 }),

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

  if (config.refreshTokenTtl <= config.accessTokenTtl) {
    r.problems.push(
      'NACRE_REFRESH_TOKEN_TTL is not longer than NACRE_ACCESS_TOKEN_TTL. A refresh ' +
        'token that expires no later than the access token it renews cannot renew ' +
        'anything, so every session would end at the first refresh.',
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
