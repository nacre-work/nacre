import { describe, expect, it } from 'vitest'

import { Problem } from '../errors.js'
import { encodeCursor, readPage } from '../pagination.js'

/**
 * A cursor from one collection refused by another, as a refusal a caller can
 * read rather than a cast failure.
 *
 * Every paged collection here seeks on a uuid except the audit log, whose key
 * is a bigserial — and each adapter casts its bound to exactly one type. The
 * decoder used to accept either shape from any listing, so an audit cursor
 * pasted into `/v1/layers` (or the mirror) passed it and then died in the
 * cast: `invalid input syntax for type bigint`, a `500`, and an audit row
 * saying `error` for what is a caller holding a cursor the 400's own message
 * tells them not to construct.
 */

const UUID = '11111111-1111-1111-1111-111111111111'
const at = '2026-01-01T00:00:00.000000+00:00'

const read = (cursor: string, shape: 'uuid' | 'sequence') =>
  readPage(new URLSearchParams({ cursor }), '/test', 'r-1', shape)

describe('cursor id shapes', () => {
  it('accepts the shape the collection seeks on', () => {
    expect(read(encodeCursor({ createdAt: at, id: UUID }), 'uuid')).not.toBeInstanceOf(Problem)
    expect(read(encodeCursor({ createdAt: at, id: '42' }), 'sequence')).not.toBeInstanceOf(Problem)
  })

  it("refuses the other collection's shape as a 400, before it can reach a cast", () => {
    const wrongForAudit = read(encodeCursor({ createdAt: at, id: UUID }), 'sequence')
    expect(wrongForAudit).toBeInstanceOf(Problem)
    expect((wrongForAudit as Problem).status).toBe(400)

    const wrongForLayers = read(encodeCursor({ createdAt: at, id: '42' }), 'uuid')
    expect(wrongForLayers).toBeInstanceOf(Problem)
    expect((wrongForLayers as Problem).status).toBe(400)
  })
})
