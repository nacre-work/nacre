import { describe, expect, it } from 'vitest'

import type { PrincipalRef } from '../../types.js'
import { buildFilter } from '../filter.js'
import { aclTags, DEFAULT_TAG_BYTES, principalTag } from '../tags.js'

describe('baseline · acl tags', () => {
  it('a tag depends on the whole principal reference, type included', () => {
    // `user:x` and `group:x` are different principals. A tag scheme that hashed
    // only the id would hand one the other's grants.
    expect(principalTag('user:abc')).not.toBe(principalTag('group:abc'))
  })

  it('tags are stable across calls and across processes', () => {
    // An unstable tag makes every chunk look changed on every recomputation
    // pass, and nacre_acl_propagation_lag_seconds stops meaning anything.
    expect(principalTag('group:legal')).toBe(principalTag('group:legal'))
    expect(principalTag('group:legal')).toMatch(/^h:[0-9a-f]{16}$/)
  })

  it('the default width is 8 bytes, and it is a documented trade', () => {
    expect(DEFAULT_TAG_BYTES).toBe(8)
    expect(principalTag('user:a').length).toBe(2 + DEFAULT_TAG_BYTES * 2)
  })

  it('a wider tag is a different tag, so changing the width is a reindex', () => {
    // Worth failing loudly on: silently mixing widths in one collection means
    // tags that never match and a caller who sees nothing.
    expect(principalTag('user:a', 8)).not.toBe(principalTag('user:a', 16))
  })

  it('an unusable width is refused rather than truncated to something else', () => {
    expect(() => principalTag('user:a', 0)).toThrow(/between 1 and 32/)
    expect(() => principalTag('user:a', 64)).toThrow(/between 1 and 32/)
  })

  it('the tag list is sorted and free of duplicates', () => {
    const principals: PrincipalRef[] = ['group:b', 'user:a', 'group:b', 'group:a']
    const tags = aclTags(principals)

    expect(tags).toEqual([...tags].sort())
    expect(new Set(tags).size).toBe(tags.length)
    expect(tags).toHaveLength(3)
  })

  it('an empty principal set produces no tags, not a wildcard', () => {
    expect(aclTags([])).toEqual([])
  })

  it('truncation collides, and the layer bound is what makes that safe', () => {
    // Not a test of the hash — a record of why the width is allowed to be this
    // small. Two principals sharing a tag is expected at 8 bytes over a large
    // enough population; a false tag match inside a layer the caller may
    // already read changes nothing, and a layer they may not read is excluded
    // before tags are considered at all.
    //
    // Which is to say: buildFilter must never stop constraining by layer_id.
    // The filter it builds today has no acl_tags clause, so the property holds
    // trivially — this test exists so that stops being true loudly.
    const filter = buildFilter('org-1', {
      kind: 'scoped',
      layers: ['layer-a'],
      extraDocs: [],
      deniedDocs: [],
    })

    const clauses = JSON.stringify(filter)
    expect(clauses, 'the layer bound must be present').toContain('layer_id')
    if (clauses.includes('acl_tags')) {
      // If tags ever join the filter, they narrow — never widen — so they
      // belong in `must`, alongside org_id and deleted.
      expect(JSON.stringify(filter.must)).toContain('acl_tags')
    }
  })
})
