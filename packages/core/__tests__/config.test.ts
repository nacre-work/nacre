import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

import {
  ConfigError,
  loadConfig,
  loadJwtKeys,
  loadJwtVerification,
  keyFingerprint,
} from '../config.js'

const COMPLETE = {
  NACRE_CANONICAL_URL: 'https://api.nacre.test',
  NACRE_PG_URL: 'postgres://nacre:x@postgres:5432/nacre',
  NACRE_QDRANT_URL: 'http://qdrant:6333',
  NACRE_REDIS_URL: 'redis://redis:6379/0',
  NACRE_DEFAULT_EMBEDDING_ENDPOINT: 'http://embedder:8080',
  NACRE_DEFAULT_EMBEDDING_MODEL: 'bge-m3',
  NACRE_PARSER_ENDPOINT: 'http://parser:8090',
  NACRE_RERANKER_ENDPOINT: 'http://reranker:8081',
  NACRE_JWT_ISSUER: 'https://api.nacre.test',
  NACRE_JWT_AUDIENCE: 'nacre',
}

const problems = (env: Record<string, string | undefined>): readonly string[] => {
  try {
    loadConfig(env)
    return []
  } catch (e) {
    return e instanceof ConfigError ? e.problems : [String(e)]
  }
}

describe('configuration', () => {
  it('a complete environment loads', () => {
    const config = loadConfig(COMPLETE)
    expect(config.pgUrl).toBe(COMPLETE.NACRE_PG_URL)
    expect(config.embeddingDim).toBe(1024)
  })

  it('reports every problem at once, not the first', () => {
    // One restart per missing variable is how a deployment takes an afternoon.
    const found = problems({})
    expect(found.length).toBeGreaterThan(5)
    expect(found.join('\n')).toContain('NACRE_PG_URL is not set')
    expect(found.join('\n')).toContain('NACRE_REDIS_URL is not set')
  })

  it('no URL or credential gets a silent default', () => {
    for (const key of [
      'NACRE_PG_URL',
      'NACRE_QDRANT_URL',
      'NACRE_REDIS_URL',
      'NACRE_DEFAULT_EMBEDDING_ENDPOINT',
      'NACRE_PARSER_ENDPOINT',
      'NACRE_CANONICAL_URL',
    ]) {
      const env = { ...COMPLETE, [key]: undefined }
      expect(problems(env).join('\n'), `${key} must be required`).toContain(key)
    }
  })

  it('an empty string counts as unset', () => {
    // A compose file with `NACRE_PG_URL=` is the common way this arrives.
    expect(problems({ ...COMPLETE, NACRE_PG_URL: '   ' }).join('\n')).toContain('NACRE_PG_URL is not set')
  })

  it('tunables keep their defaults', () => {
    const config = loadConfig(COMPLETE)
    expect(config.aclCacheTtl).toBe(60)
    expect(config.maxDocumentBytes).toBe(52_428_800)
    expect(config.auditQueryText, 'query text is off by default').toBe(false)
  })

  it('a malformed number is a problem, not a coercion', () => {
    expect(problems({ ...COMPLETE, NACRE_PG_POOL_MAX: 'twenty' }).join('\n')).toContain('NACRE_PG_POOL_MAX')
    expect(problems({ ...COMPLETE, NACRE_PG_POOL_MAX: '0' }).join('\n')).toContain('NACRE_PG_POOL_MAX')
  })

  it('a malformed boolean is a problem, not a truthy string', () => {
    // 'false' as a truthy string is the classic way audit query text gets
    // turned on by a config that meant to turn it off.
    expect(problems({ ...COMPLETE, NACRE_AUDIT_QUERY_TEXT: 'yes' }).join('\n')).toContain(
      'NACRE_AUDIT_QUERY_TEXT',
    )
    expect(loadConfig({ ...COMPLETE, NACRE_AUDIT_QUERY_TEXT: 'false' }).auditQueryText).toBe(false)
  })

  // `NACRE_ACL_CACHE_TTL` no longer has an SLA to be compared against, and the
  // comparison was the last thing keeping `NACRE_ACL_PROPAGATION_SLA` alive.
  // Both the SLA and `NACRE_ACL_TAG_HASH_BYTES` went with the tag cache in
  // migration 0016 — there is no propagation to bound, because the plan is
  // computed per request and the cache that remains is keyed on the permission
  // epoch rather than expiring.
  it('accepts a cache TTL that would once have been refused against the SLA', () => {
    expect(problems({ ...COMPLETE, NACRE_ACL_CACHE_TTL: '120' })).toEqual([])
  })

  it('refuses a setting that would silently do nothing', () => {
    // The dangerous half of eight variables that were validated here and read
    // nowhere. An operator who asks for shared collections and gets per-org
    // ones has been overruled without being told — which is the same failure
    // as a silent default, with a value supplied.
    expect(problems({ ...COMPLETE, NACRE_VECTOR_TENANCY: 'shared' }).join(' ')).toMatch(
      /not implemented/,
    )

    // The defaults still boot, which is the whole point of refusing only these.
    expect(problems({ ...COMPLETE, NACRE_VECTOR_TENANCY: 'collection' })).toEqual([])
  })

  it('reranking on without an endpoint is refused', () => {
    const { NACRE_RERANKER_ENDPOINT: _drop, ...withoutEndpoint } = COMPLETE
    void _drop
    expect(
      problems({ ...withoutEndpoint, NACRE_RERANKER_ENABLED: 'true' }).join('\n'),
    ).toContain('NACRE_RERANKER_ENDPOINT')

    // Turning it off deliberately is fine.
    expect(() => loadConfig({ ...withoutEndpoint, NACRE_RERANKER_ENABLED: 'false' })).not.toThrow()
  })

  it('reranking is off by default, so the minimal profile boots', () => {
    // COMPLETE does not set NACRE_RERANKER_ENABLED at all, which is the point:
    // this asserts the default rather than a value.
    const { NACRE_RERANKER_ENDPOINT: _drop, ...bare } = COMPLETE
    void _drop

    // The `minimal` profile has no reranker — that is what keeps it runnable on
    // a laptop without a GPU. A default of true made the documented starting
    // profile refuse to boot until the operator turned off a feature they had
    // never asked for, and one that is not on the search path yet either.
    const config = loadConfig(bare)
    expect(config.rerankerEnabled).toBe(false)
  })

  it('production refuses a plaintext or localhost issuer', () => {
    const prod = { ...COMPLETE, NACRE_ENV: 'production' }

    // The canonical URL is the OAuth issuer and is baked into every token ever
    // issued; over plaintext it is also what an attacker rewrites.
    expect(problems({ ...prod, NACRE_CANONICAL_URL: 'http://api.nacre.test' }).join('\n')).toContain('https')
    expect(problems({ ...prod, NACRE_CANONICAL_URL: 'https://localhost:8080' }).join('\n')).toContain(
      'localhost',
    )
    expect(() => loadConfig(prod)).not.toThrow()
  })

  it('development tolerates what production does not', () => {
    expect(() =>
      loadConfig({ ...COMPLETE, NACRE_ENV: 'development', NACRE_CANONICAL_URL: 'http://localhost:8080' }),
    ).not.toThrow()
  })

  it('the error names every problem and points at the reference', () => {
    try {
      loadConfig({})
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as ConfigError).message).toContain('docs/config.md')
    }
  })

  /**
   * `.env.example` must leave exactly one thing for the operator to supply.
   *
   * The assertion used to be "copying it is enough to start", and that was
   * weaker than it looked: it passed with the embedding endpoint defaulted to
   * `http://embedder:80`, a service only the `full` profile runs. The
   * documented `minimal` first run therefore came up healthy, reported ready,
   * accepted a document, and failed to index it against a hostname that does
   * not exist — which is the exact failure the "no silent defaults for URLs"
   * rule at the top of config.ts is about.
   *
   * So the file now ships that one variable empty, and this pins the list.
   * Anything else going missing still fails here; anything else acquiring a
   * placeholder default has to come past this test and say why.
   */
  const envExample = async (): Promise<Record<string, string>> => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const text = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8')

    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1] as string] = match[2] as string
    }
    return env
  }

  it('.env.example leaves exactly one variable for the operator', async () => {
    const env = await envExample()

    // Named, not counted: a second blank appearing silently is the regression
    // this catches, and "one problem" would not say which.
    expect(problems(env)).toEqual(['NACRE_DEFAULT_EMBEDDING_ENDPOINT is not set'])
  })

  it('and supplying that one is enough to boot in development', async () => {
    const env = await envExample()
    expect(
      problems({ ...env, NACRE_DEFAULT_EMBEDDING_ENDPOINT: 'http://embedder:80' }),
      'copying .env.example and naming an embedder must be enough to start',
    ).toEqual([])
  })
})

const CURRENT = 'a'.repeat(40)
const PREVIOUS = 'b'.repeat(40)

describe('object storage', () => {
  const S3 = {
    NACRE_S3_ENDPOINT: 'http://minio:9000',
    NACRE_S3_BUCKET: 'nacre',
    NACRE_S3_ACCESS_KEY: 'key',
    NACRE_S3_SECRET_KEY: 'secret',
  }

  it('is absent when nothing is set, which is a supported deployment', () => {
    // Not a degraded mode. Document bytes then live in `documents.source_ref`,
    // which is what every deployment did before object storage existed.
    expect(loadConfig(COMPLETE).s3).toBeUndefined()
  })

  it('loads as a block when all four are set', () => {
    expect(loadConfig({ ...COMPLETE, ...S3 }).s3).toEqual({
      endpoint: 'http://minio:9000',
      bucket: 'nacre',
      region: 'us-east-1',
      accessKey: 'key',
      secretKey: 'secret',
      forcePathStyle: true,
    })
  })

  it('refuses half of it, naming both what is set and what is missing', () => {
    // The failure this exists to prevent: an endpoint with no credential parses
    // as six independent optionals and fails later, as an ingest that cannot
    // store bytes, on a deployment whose configuration looked accepted.
    const said = problems({ ...COMPLETE, NACRE_S3_ENDPOINT: S3.NACRE_S3_ENDPOINT }).join(' ')
    expect(said).toContain('half configured')
    expect(said).toContain('NACRE_S3_ENDPOINT')
    expect(said).toContain('NACRE_S3_SECRET_KEY')
  })

  it('refuses a credential with no bucket just as firmly as a bucket with no credential', () => {
    for (const missing of Object.keys(S3)) {
      const env: Record<string, string | undefined> = { ...COMPLETE, ...S3 }
      delete env[missing]
      expect(problems(env).join(' ')).toContain('half configured')
    }
  })

  it('treats an empty string as unset, not as configured-with-nothing', () => {
    expect(loadConfig({ ...COMPLETE, NACRE_S3_ENDPOINT: '', NACRE_S3_BUCKET: '' }).s3).toBeUndefined()
  })

  it('refuses an endpoint that is not http or https', () => {
    // `new URL('minio:9000')` parses — `minio:` is the scheme and `9000` the
    // path, with an empty host — so "is it a URL" accepts the likeliest typo in
    // this variable and every request afterwards goes nowhere.
    expect(problems({ ...COMPLETE, ...S3, NACRE_S3_ENDPOINT: 'minio:9000' }).join(' ')).toContain(
      'must be an http or https URL',
    )
    expect(problems({ ...COMPLETE, ...S3, NACRE_S3_ENDPOINT: 's3://nacre' }).join(' ')).toContain(
      'must be an http or https URL',
    )
  })

  it('still refuses something that is not a URL at all', () => {
    expect(problems({ ...COMPLETE, ...S3, NACRE_S3_ENDPOINT: 'not a url' }).join(' ')).toContain(
      'NACRE_S3_ENDPOINT is not a URL',
    )
  })

  it('defaults the region and path style, and lets AWS turn path style off', () => {
    const config = loadConfig({
      ...COMPLETE,
      ...S3,
      NACRE_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
      NACRE_S3_REGION: 'eu-west-1',
      NACRE_S3_FORCE_PATH_STYLE: 'false',
    })
    expect(config.s3?.region).toBe('eu-west-1')
    expect(config.s3?.forcePathStyle).toBe(false)
  })
})

describe('signing keys', () => {
  it('carries no second key outside a rotation', () => {
    expect(loadJwtKeys({ NACRE_JWT_SECRET: CURRENT }).alsoAccept).toEqual([])
  })

  it('accepts the previous key alongside the current one', () => {
    // The whole of a rotation with no outage: tokens signed with the key on its
    // way out keep verifying until they expire, and everything issued from now
    // on is signed with the new one.
    const keys = loadJwtKeys({
      NACRE_JWT_SECRET: CURRENT,
      NACRE_JWT_SECRET_PREVIOUS: PREVIOUS,
    })
    expect(new TextDecoder().decode(keys.signing as Uint8Array)).toBe(CURRENT)
    // The same value verifies, which is what "symmetric" means and is the
    // difference from the Ed25519 path below.
    expect(keys.verification).toBe(keys.signing)
    expect(keys.alsoAccept.map((k) => new TextDecoder().decode(k as Uint8Array))).toEqual([PREVIOUS])
  })

  it('refuses a previous key equal to the current one', () => {
    // What an operator does when they mean to rotate and copy the wrong line.
    // Deduplicating it silently would leave an installation that believes it
    // has rotated and has not.
    expect(() =>
      loadJwtKeys({ NACRE_JWT_SECRET: CURRENT, NACRE_JWT_SECRET_PREVIOUS: CURRENT }),
    ).toThrow(ConfigError)
  })

  it('holds the previous key to the same length floor', () => {
    expect(() =>
      loadJwtKeys({ NACRE_JWT_SECRET: CURRENT, NACRE_JWT_SECRET_PREVIOUS: 'short' }),
    ).toThrow(/shorter than 32 bytes/)
  })

  it('treats an empty previous key as unset, which is how a rotation ends', () => {
    // `NACRE_JWT_SECRET_PREVIOUS=` in an env file is how the second restart is
    // usually written, and it has to mean the same as removing the line.
    expect(loadJwtKeys({ NACRE_JWT_SECRET: CURRENT, NACRE_JWT_SECRET_PREVIOUS: '' }).alsoAccept).toEqual(
      [],
    )
  })

  it('still requires the current key', () => {
    expect(() => loadJwtKeys({ NACRE_JWT_SECRET_PREVIOUS: PREVIOUS })).toThrow(ConfigError)
  })
})

describe('signing keys, Ed25519', () => {
  /**
   * `NACRE_JWT_PRIVATE_KEY_REF` was in `docs/config.md` from the beginning and
   * read by nothing, with the file's own comment saying so. These are about the
   * property that makes it worth having: **the key that verifies is not the key
   * that signs**, so a process that only checks tokens cannot mint one.
   */
  const dir = mkdtempSync(join(tmpdir(), 'nacre-jwt-'))
  const write = (name: string, key: KeyObject): string => {
    const path = join(dir, name)
    writeFileSync(path, key.export({ type: 'pkcs8', format: 'pem' }) as string)
    return pathToFileURL(path).href
  }

  const first = generateKeyPairSync('ed25519')
  const second = generateKeyPairSync('ed25519')
  const REF = write('first.pem', first.privateKey)
  const PREVIOUS_REF = write('second.pem', second.privateKey)

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('signs with the private half and verifies with the public one', () => {
    const keys = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF })

    expect((keys.signing as KeyObject).type).toBe('private')
    expect((keys.verification as KeyObject).type).toBe('public')
    expect(keys.algorithm).toBe('EdDSA')
  })

  it('publishes a JWKS with no private material in it', () => {
    // `d` is the private scalar. A JWK export of a private key carries it, and
    // this endpoint is unauthenticated — so its absence is the whole safety of
    // serving the document at all.
    const keys = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF })

    expect(keys.jwks).toHaveLength(1)
    expect(keys.jwks?.[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' })
    expect(keys.jwks?.[0]).not.toHaveProperty('d')
    expect(JSON.stringify(keys.jwks)).not.toContain('PRIVATE')
  })

  it('gives the key a kid, and the same one every time', () => {
    // Derived from the public bytes rather than configured, so two processes
    // agree without anyone keeping two settings in step.
    const a = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF })
    const b = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF })

    expect(a.keyId).toBeTruthy()
    expect(a.keyId).toBe(b.keyId)
    expect(a.jwks?.[0]?.kid).toBe(a.keyId)
  })

  it('publishes the retired key too, or a rotation breaks every outside verifier', () => {
    const keys = loadJwtKeys({
      NACRE_JWT_PRIVATE_KEY_REF: REF,
      NACRE_JWT_PREVIOUS_KEY_REF: PREVIOUS_REF,
    })

    expect(keys.alsoAccept).toHaveLength(1)
    expect(keys.jwks).toHaveLength(2)
    // The current one first, and it is the one that signs.
    expect(keys.jwks?.[0]?.kid).toBe(keys.keyId)
  })

  it('refuses a previous key that is the current one', () => {
    expect(() =>
      loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF, NACRE_JWT_PREVIOUS_KEY_REF: REF }),
    ).toThrow(/not a rotation/)
  })

  it('refuses a secret and a key ref together', () => {
    // Two answers to "what signs a token". Resolving it by precedence would
    // leave the other one configured, apparently in use, and ignored.
    expect(() =>
      loadJwtKeys({ NACRE_JWT_SECRET: CURRENT, NACRE_JWT_PRIVATE_KEY_REF: REF }),
    ).toThrow(/both set/)
  })

  it('refuses a key that is not Ed25519, by name', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const ref = write('rsa.pem', rsa.privateKey)
    expect(() => loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: ref })).toThrow(/rsa key/)
  })

  it('refuses a reference that is not a file:// URL, or names nothing', () => {
    expect(() => loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: '/run/secrets/k' })).toThrow(
      /file:\/\/ URL/,
    )
    expect(() => loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: 'vault://secret/jwt' })).toThrow(
      /file:\/\/ URL/,
    )
    expect(() =>
      loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: pathToFileURL(join(dir, 'nope.pem')).href }),
    ).toThrow(/cannot be read/)
  })

  it('refuses a file that is not a key', () => {
    const path = join(dir, 'not-a-key.pem')
    writeFileSync(path, 'this is not a key\n')
    expect(() => loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: pathToFileURL(path).href })).toThrow(
      /not a PEM private key/,
    )
  })

  it('fingerprints the public half, so both processes print the same value', () => {
    // The comparison this exists for: one process holds the private key and
    // another holds only the public one, and an operator reading two startup
    // lines has to be able to tell whether they agree.
    const keys = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: REF })
    expect(keyFingerprint(keys.signing)).toBe(keyFingerprint(keys.verification))
  })
})

describe('verification-only keys', () => {
  /**
   * A resource server — the MCP transport — verifies tokens and never signs
   * one, so it should be configurable with the public key alone. That is what
   * makes the asymmetric mode's promise true: reading this process's
   * environment gets an attacker to "can check tokens" and no private key to
   * mint them with.
   */
  const dir = mkdtempSync(join(tmpdir(), 'nacre-jwtverify-'))
  const first = generateKeyPairSync('ed25519')
  const second = generateKeyPairSync('ed25519')
  const writePub = (name: string, key: KeyObject): string => {
    const path = join(dir, name)
    writeFileSync(path, key.export({ type: 'spki', format: 'pem' }) as string)
    return pathToFileURL(path).href
  }
  const writePriv = (name: string, key: KeyObject): string => {
    const path = join(dir, name)
    writeFileSync(path, key.export({ type: 'pkcs8', format: 'pem' }) as string)
    return pathToFileURL(path).href
  }
  const PUB = writePub('first.pub', first.publicKey)
  const PREV_PUB = writePub('second.pub', second.publicKey)
  const PRIV = writePriv('first.pem', first.privateKey)
  const SECRET = 'x'.repeat(32)

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('verifies from the public key with no private material in reach', () => {
    const v = loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: PUB })
    expect((v.verification as KeyObject).type).toBe('public')
    expect(v.algorithm).toBe('EdDSA')
    expect(v.alsoAccept).toEqual([])
    // The whole object, serialized, carries nothing that could sign.
    expect(JSON.stringify(v)).not.toContain('PRIVATE')
  })

  it('the public-key verifier agrees with the private-key signer on the same key', () => {
    // The guarantee the split rests on: a token the API signs (private half)
    // verifies against the key MCP loads (public half). Proven here by the
    // fingerprints matching — same SPKI, same key, so the same tokens verify.
    const signer = loadJwtKeys({ NACRE_JWT_PRIVATE_KEY_REF: PRIV })
    const verifier = loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: PUB })
    expect(keyFingerprint(verifier.verification)).toBe(keyFingerprint(signer.verification))
    expect(keyFingerprint(verifier.verification)).toBe(keyFingerprint(signer.signing))
  })

  it('carries the previous public key through a rotation', () => {
    const v = loadJwtVerification({
      NACRE_JWT_PUBLIC_KEY_REF: PUB,
      NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF: PREV_PUB,
    })
    expect(v.alsoAccept).toHaveLength(1)
    expect(keyFingerprint(v.alsoAccept[0] as KeyObject)).toBe(
      keyFingerprint(second.publicKey),
    )
  })

  it('refuses a previous public key that is the current one', () => {
    expect(() =>
      loadJwtVerification({
        NACRE_JWT_PUBLIC_KEY_REF: PUB,
        NACRE_JWT_PREVIOUS_PUBLIC_KEY_REF: PUB,
      }),
    ).toThrow(/not a rotation/)
  })

  it('still verifies when handed the private key, for a co-located process', () => {
    const v = loadJwtVerification({ NACRE_JWT_PRIVATE_KEY_REF: PRIV })
    expect((v.verification as KeyObject).type).toBe('public')
    expect(v.algorithm).toBe('EdDSA')
  })

  it('verifies with a shared secret, where no separation is possible', () => {
    const v = loadJwtVerification({ NACRE_JWT_SECRET: SECRET })
    expect(v.algorithm).toBe('HS256')
    expect(v.verification).toBeInstanceOf(Uint8Array)
  })

  it('refuses more than one source at once', () => {
    expect(() =>
      loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: PUB, NACRE_JWT_PRIVATE_KEY_REF: PRIV }),
    ).toThrow(/answers to "what verifies a token"/)
    expect(() =>
      loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: PUB, NACRE_JWT_SECRET: SECRET }),
    ).toThrow(/answers to "what verifies a token"/)
  })

  it('refuses nothing at all', () => {
    expect(() => loadJwtVerification({})).toThrow(/no verification key is set/)
  })

  it('refuses a private key handed to the public-key variable, by name', () => {
    // The paste error the whole variable exists to catch: the private PEM into
    // the _PUBLIC_ ref. createPublicKey would silently extract the public half
    // and leave the private key file mounted on a process that must not have
    // it, so the loader refuses a file containing private material outright.
    expect(() => loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: PRIV })).toThrow(
      /contains a PRIVATE key/,
    )
  })

  it('refuses a non-Ed25519 public key, by name', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const ref = writePub('rsa.pub', rsa.publicKey)
    expect(() => loadJwtVerification({ NACRE_JWT_PUBLIC_KEY_REF: ref })).toThrow(
      /rsa public key/,
    )
  })
})
