import { describe, expect, it } from 'vitest'

import { ConfigError, loadConfig } from '../config.js'

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
    expect(found.join('\n')).toContain('would still be served after the SLA')
  })

  it('reranking on without an endpoint is refused', () => {
    const { NACRE_RERANKER_ENDPOINT: _drop, ...withoutEndpoint } = COMPLETE
    void _drop
    expect(problems(withoutEndpoint).join('\n')).toContain('NACRE_RERANKER_ENDPOINT')

    // Turning it off deliberately is fine.
    expect(() => loadConfig({ ...withoutEndpoint, NACRE_RERANKER_ENABLED: 'false' })).not.toThrow()
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

  it('.env.example is enough to boot in development', async () => {
    // The file the quickstart tells people to copy. If it is missing something
    // required, the first thing a new user sees is a crash.
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const text = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8')

    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (match) env[match[1] as string] = match[2] as string
    }

    expect(problems(env), 'copying .env.example must be enough to start').toEqual([])
  })
})
