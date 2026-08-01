import { describe, expect, it } from 'vitest'

import type { Permission } from '../../types.js'
import { implied, satisfies } from '../permissions.js'

const ALL: readonly Permission[] = ['read', 'write', 'admin']

/**
 * The whole 3x3 matrix, written out rather than generated. A generated table
 * would be derived from the same assumption the code is, so it would agree
 * with a wrong implementation just as happily.
 *
 * Source: docs/authz.md section 3.2, rules 6 and 7.
 */
const EXPECTED: Record<Permission, Record<Permission, boolean>> = {
  //         requested: read   write  admin
  read: { read: true, write: false, admin: false },
  write: { read: false, write: true, admin: false },
  admin: { read: true, write: true, admin: true },
}

describe('permission implication', () => {
  for (const granted of ALL) {
    for (const requested of ALL) {
      const expected = EXPECTED[granted][requested]
      it(`${granted} ${expected ? 'satisfies' : 'does not satisfy'} ${requested}`, () => {
        expect(satisfies(granted, requested)).toBe(expected)
      })
    }
  }

  it('write does not imply read (invariant 6)', () => {
    expect(satisfies('write', 'read')).toBe(false)
  })

  it('admin implies read and write (rule 7)', () => {
    expect(satisfies('admin', 'read')).toBe(true)
    expect(satisfies('admin', 'write')).toBe(true)
  })

  it('every permission satisfies itself', () => {
    for (const p of ALL) expect(satisfies(p, p)).toBe(true)
  })

  it('mutating a returned set cannot widen anyone else"s permissions', () => {
    // A caller that gets a set back and mutates it must not be able to reach
    // the table every other caller reads from.
    ;(implied('read') as Set<Permission>).add('admin')

    expect(satisfies('read', 'admin')).toBe(false)
    expect([...implied('read')]).toEqual(['read'])
  })
})
