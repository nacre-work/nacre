import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig, loadJwtKeys } from '../config.js'

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
    expect(config.aclPropagationSla).toBe(60)
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

  it('a cache that outlives the propagation SLA is refused', () => {
    // Both values parse. Together they promise a 60-second revocation and serve
    // a stale grant for 120, while the metric reports compliance.
    const found = problems({
      ...COMPLETE,
      NACRE_ACL_CACHE_TTL: '120',
      NACRE_ACL_PROPAGATION_SLA: '60',
    })
    // The refusal stands; its reason changed when the cache was wired in. It is
    // keyed on the permission epoch, so it cannot delay a revocation — what a
    // value above the SLA reveals is that it was read as though it could.
    expect(found.join('\n')).toContain('does not delay a revocation')
  })

  it('refuses a setting that would silently do nothing', () => {
    // The dangerous half of eight variables that were validated here and read
    // nowhere. An operator who asks for shared collections and gets per-org
    // ones has been overruled without being told — which is the same failure
    // as a silent default, with a value supplied.
    expect(problems({ ...COMPLETE, NACRE_VECTOR_TENANCY: 'shared' }).join(' ')).toMatch(
      /not implemented/,
    )
    expect(problems({ ...COMPLETE, NACRE_ACL_TAG_HASH_BYTES: '16' }).join(' ')).toMatch(
      /fixed at 8 bytes/,
    )

    // The defaults still boot, which is the whole point of refusing only these.
    expect(problems({ ...COMPLETE, NACRE_VECTOR_TENANCY: 'collection' })).toEqual([])
    expect(problems({ ...COMPLETE, NACRE_ACL_TAG_HASH_BYTES: '8' })).toEqual([])
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
    expect(new TextDecoder().decode(keys.key)).toBe(CURRENT)
    expect(keys.alsoAccept.map((k) => new TextDecoder().decode(k))).toEqual([PREVIOUS])
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
