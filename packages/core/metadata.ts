import type { MetadataValue } from './authz/filter.js'

/**
 * Document metadata: what a caller may write, and what they may narrow a search
 * by.
 *
 * One module for both ends on purpose. Ingest and search accept the same shape
 * from the same untrusted place, and two validators would drift — the ingest
 * side would grow a type the search side could not express, or the search side
 * would accept a key ingest had refused, and a caller would be filtering on a
 * field that can never exist.
 *
 * Everything here is a bound. Metadata is written into the vector payload of
 * *every chunk of a document*, so a key is stored once per point and a
 * thousand-chunk document multiplies whatever arrives here by a thousand. The
 * limits are deliberately small; a knowledge index wants `source`, `team`,
 * `updated_at`, not a document's worth of JSON a second time.
 */

/** Keys per document. */
export const MAX_METADATA_KEYS = 32
export const MAX_METADATA_KEY_LENGTH = 64
/** A string value, and every string inside a list value. */
export const MAX_METADATA_VALUE_LENGTH = 256
/** Values in one list. */
export const MAX_METADATA_LIST = 32

/**
 * Keys are `[a-z0-9_]`, lower case, and cannot start with a digit.
 *
 * Narrow because the key becomes a Qdrant payload field name, and Qdrant reads
 * `.` as nested access and `[]` as array indexing — a key containing either
 * would filter on something other than what the caller wrote. Refusing the
 * characters is one line; discovering that `a.b` and `a` `{b}` are the same
 * field is a support ticket.
 */
const KEY = /^[a-z_][a-z0-9_]*$/

export type Metadata = Readonly<Record<string, MetadataValue>>

export class MetadataError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetadataError'
  }
}

function checkScalar(key: string, value: unknown): string | number | boolean {
  if (typeof value === 'string') {
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new MetadataError(
        `metadata value for '${key}' is over ${MAX_METADATA_VALUE_LENGTH} characters`,
      )
    }
    return value
  }
  if (typeof value === 'number') {
    // NaN and the infinities have no JSON representation, so they arrive here
    // only from a caller building the body in code — and they would be written
    // as `null`, which is a value nothing can filter for.
    if (!Number.isFinite(value)) {
      throw new MetadataError(`metadata value for '${key}' is not a finite number`)
    }
    return value
  }
  if (typeof value === 'boolean') return value

  throw new MetadataError(
    `metadata value for '${key}' must be a string, number, boolean, or a list of those. ` +
      'Nested objects are not accepted: the filter surface would have to grow a path ' +
      'syntax, and a path is a way to reach a field the caller did not name.',
  )
}

/**
 * Validate and normalise metadata arriving from a request.
 *
 * Raises rather than dropping what it does not like. A silently discarded key
 * is a document a caller believes is tagged and a filter that will never match
 * it — the same class of failure as a search parameter read by nothing, and the
 * reason `filters` answered 400 rather than being ignored.
 */
export function parseMetadata(raw: unknown, what = 'metadata'): Metadata {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MetadataError(`'${what}' must be an object`)
  }

  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_METADATA_KEYS) {
    throw new MetadataError(`'${what}' has more than ${MAX_METADATA_KEYS} keys`)
  }

  const out: Record<string, MetadataValue> = {}
  for (const [key, value] of entries) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw new MetadataError(`metadata key '${key.slice(0, 20)}…' is over ${MAX_METADATA_KEY_LENGTH} characters`)
    }
    if (!KEY.test(key)) {
      throw new MetadataError(
        `metadata key '${key}' must match ${String(KEY)} — lower case letters, digits and ` +
          'underscores, not starting with a digit',
      )
    }
    // `undefined` survives an object literal in TypeScript but not JSON, so it
    // reaches here only from a caller assembling the body in code. Dropping it
    // is the one omission that is not a surprise: the key is absent either way.
    if (value === undefined) continue

    if (Array.isArray(value)) {
      if (value.length > MAX_METADATA_LIST) {
        throw new MetadataError(`metadata value for '${key}' has more than ${MAX_METADATA_LIST} entries`)
      }
      out[key] = value.map((v) => checkScalar(key, v))
    } else {
      out[key] = checkScalar(key, value)
    }
  }

  return out
}

/**
 * The same bounds, plus the one rule that belongs only to filtering.
 *
 * An empty list is a legitimate *value* — a document may be tagged with no
 * teams — and an impossible *restriction*: "team is one of nothing" matches
 * nothing at all. `buildFilter` refuses to encode it, deliberately, so that
 * what an impossible restriction means stays the caller's decision rather than
 * the query builder's. This is where that decision is made for a request: a 400
 * naming the key, because a client that built a list and put nothing in it has
 * a bug, and answering with an empty result would hide it.
 */
export function parseFilters(raw: unknown): Metadata {
  const parsed = parseMetadata(raw, 'filters')
  for (const [key, value] of Object.entries(parsed)) {
    if (Array.isArray(value) && value.length === 0) {
      throw new MetadataError(
        `filter on '${key}' has no values, so it can match nothing. Drop the key to ` +
          'search without that restriction.',
      )
    }
  }
  return parsed
}
