import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { MAX_AUDITED_QUERY, queryAudit } from '../audit.js'

const sha256 = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`

describe('queryAudit', () => {
  it('records the hash and not the query by default', () => {
    // `docs/audit.md`: never full query text with NACRE_AUDIT_QUERY_TEXT=false,
    // which is the default. A hash instead.
    expect(queryAudit('what did legal decide about the merger', false)).toEqual({
      query_hash: sha256('what did legal decide about the merger'),
    })
  })

  it('has no query key at all when the text is off, rather than an empty one', () => {
    // `{query: ''}` in a journal reads as "they searched for nothing", which is
    // a different claim from "we did not record what they searched for".
    expect('query' in queryAudit('x', false)).toBe(false)
  })

  it('records the text when a deployment asked for it', () => {
    expect(queryAudit('merger terms', true)).toEqual({
      query_hash: sha256('merger terms'),
      query: 'merger terms',
    })
  })

  it('is the same hash whether or not the text is stored', () => {
    // Otherwise an installation that turned the flag on could not compare its
    // new records against its old ones, which is most of what a hash is for.
    expect(queryAudit('q', true).query_hash).toBe(queryAudit('q', false).query_hash)
  })

  it('distinguishes queries that differ by one character', () => {
    expect(queryAudit('contract', false).query_hash).not.toBe(queryAudit('contracts', false).query_hash)
  })

  it('truncates a stored query but hashes the whole of it', () => {
    // The hash is of what was asked, not of what fitted. Hashing the truncation
    // would mean two records of the same long query do not match each other,
    // which is exactly the comparison an investigation makes.
    const long = 'a'.repeat(MAX_AUDITED_QUERY + 500)
    const audit = queryAudit(long, true)

    expect(audit.query_hash).toBe(sha256(long))
    expect(audit.query).toHaveLength(MAX_AUDITED_QUERY + 1)
    expect(audit.query?.endsWith('…')).toBe(true)
  })

  it('leaves a query at exactly the bound alone', () => {
    const exact = 'a'.repeat(MAX_AUDITED_QUERY)
    expect(queryAudit(exact, true).query).toBe(exact)
  })

  it('hashes an empty query rather than throwing', () => {
    expect(queryAudit('', false).query_hash).toBe(sha256(''))
  })
})
