import { describe, expect, it } from 'vitest'

import {
  MAX_METADATA_KEYS,
  parseFilters,
  MAX_METADATA_LIST,
  MAX_METADATA_VALUE_LENGTH,
  MetadataError,
  parseMetadata,
} from '../metadata.js'

/**
 * One validator for both ends, so these are the bounds on what a caller may
 * write *and* on what they may narrow a search by. Two validators would drift,
 * and the drift would show up as a filter on a key that could never have been
 * stored.
 */
describe('metadata', () => {
  it('accepts scalars and lists of them', () => {
    expect(
      parseMetadata({ source: 'confluence', year: 2026, archived: false, team: ['risk', 'audit'] }),
    ).toEqual({ source: 'confluence', year: 2026, archived: false, team: ['risk', 'audit'] })
  })

  it('is empty for absent, null, and an empty object', () => {
    expect(parseMetadata(undefined)).toEqual({})
    expect(parseMetadata(null)).toEqual({})
    expect(parseMetadata({})).toEqual({})
  })

  it('refuses keys that are payload paths rather than names', () => {
    // A key becomes a Qdrant payload field name, and Qdrant reads `.` as nested
    // access and `[]` as array indexing — so `a.b` would filter on something
    // other than what the caller wrote.
    for (const key of ['a.b', 'a[0]', 'Upper', '9lives', '', 'has space', 'dash-ed']) {
      expect(() => parseMetadata({ [key]: 'x' }), key).toThrow(MetadataError)
    }
  })

  it('refuses nested objects rather than flattening them', () => {
    // Flattening would invent a path syntax, and a path is a way to reach a
    // field the caller did not name.
    expect(() => parseMetadata({ a: { b: 1 } })).toThrow(/nested objects are not accepted/i)
    expect(() => parseMetadata({ a: [{ b: 1 }] })).toThrow(MetadataError)
  })

  it('refuses numbers with no JSON representation', () => {
    // They would be written as `null`, which is a value nothing can filter for.
    for (const n of [Number.NaN, Infinity, -Infinity]) {
      expect(() => parseMetadata({ n })).toThrow(/finite/)
    }
  })

  it('bounds keys, values and lists, because this is stored per point', () => {
    // A key is written into the payload of every chunk of a document, so a
    // thousand-chunk document multiplies whatever arrives here by a thousand.
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_METADATA_KEYS + 1 }, (_, i) => [`k${i}`, 'v']),
    )
    expect(() => parseMetadata(tooMany)).toThrow(/more than 32 keys/)

    expect(() => parseMetadata({ k: 'x'.repeat(MAX_METADATA_VALUE_LENGTH + 1) })).toThrow(
      /over 256 characters/,
    )
    expect(() => parseMetadata({ k: Array.from({ length: MAX_METADATA_LIST + 1 }, () => 'v') })).toThrow(
      /more than 32 entries/,
    )
    expect(() => parseMetadata({ ['k'.repeat(65)]: 'v' })).toThrow(/over 64 characters/)
  })

  it('refuses an array or a scalar where an object belongs', () => {
    expect(() => parseMetadata([1, 2], 'filters')).toThrow(/'filters' must be an object/)
    expect(() => parseMetadata('x')).toThrow(/'metadata' must be an object/)
  })

  it('names the parameter it was given, because both ends use it', () => {
    expect(() => parseMetadata(7, 'filters')).toThrow(/'filters'/)
    expect(() => parseMetadata(7)).toThrow(/'metadata'/)
  })

  it('is at the limits rather than under them', () => {
    // The bounds are inclusive; a document with exactly 32 keys is fine.
    const exact = Object.fromEntries(Array.from({ length: MAX_METADATA_KEYS }, (_, i) => [`k${i}`, 'v']))
    expect(Object.keys(parseMetadata(exact))).toHaveLength(MAX_METADATA_KEYS)
    expect(parseMetadata({ k: 'x'.repeat(MAX_METADATA_VALUE_LENGTH) }).k).toHaveLength(
      MAX_METADATA_VALUE_LENGTH,
    )
  })

  it('an empty list is a value on ingest and a refusal in a filter', () => {
    // A document may be tagged with no teams. "team is one of nothing" is a
    // restriction that matches nothing, and buildFilter refuses to encode it —
    // so the decision about what that means is made here, as a 400 naming the
    // key, rather than as an empty result that hides the client's bug.
    expect(parseMetadata({ team: [] })).toEqual({ team: [] })
    expect(() => parseFilters({ team: [] })).toThrow(/can match nothing/)
  })

  it('parseFilters carries every bound parseMetadata has', () => {
    expect(() => parseFilters({ 'a.b': 1 })).toThrow(MetadataError)
    expect(() => parseFilters([1])).toThrow(/'filters' must be an object/)
    expect(parseFilters({ source: 'confluence' })).toEqual({ source: 'confluence' })
  })
})
