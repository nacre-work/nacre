import { describe, expect, it } from 'vitest'

import { AUDIT_ACTIONS, DOCUMENT_ACCESS_ACTIONS } from '../audit-actions.js'

/**
 * What a `platform_admin` is never shown.
 *
 * The reader withheld `document.get`, `document.read` and `chunk.read` —
 * names nothing records — and so showed every `get_document`. That list is
 * derived from the catalogue now; this pins the derivation's answer, and
 * `lint:audit-actions` pins the catalogue against every writer.
 */
describe('DOCUMENT_ACCESS_ACTIONS', () => {
  it('is exactly the two actions that record reading a document', () => {
    expect([...DOCUMENT_ACCESS_ACTIONS].sort()).toEqual(['get_document', 'search'])
  })

  it('names only actions in the catalogue', () => {
    const names = new Set(AUDIT_ACTIONS.map((a) => a.name))
    for (const action of DOCUMENT_ACCESS_ACTIONS) expect(names.has(action)).toBe(true)
  })
})
