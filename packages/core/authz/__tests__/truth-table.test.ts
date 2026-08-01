import { describe, expect, it } from 'vitest'

import type { Grant, Permission, PrincipalRef } from '../../types.js'
import { referenceAllows } from '../reference.js'
import { resolve } from '../resolve.js'
import { deny, grant, ORG, tree, user } from './helpers.js'

const alice = user('alice')
const principals = new Set<PrincipalRef>(['user:alice'])
const DOC = 'doc-contract-1'
const LAYER = 'contracts'
const WS = 'ws'

/**
 * The truth table from docs/authz.md 3.2, transcribed row by row.
 *
 * Written out by hand, deliberately. A table generated from either
 * implementation would agree with whichever one produced it, including when
 * that one is wrong — which is the entire failure mode this is here to catch.
 */
const ROWS: readonly {
  readonly label: string
  readonly grants: readonly Grant[]
  readonly read: boolean
  readonly write: boolean
}[] = [
  { label: 'allow read on workspace', read: true, write: false,
    grants: [grant(alice, 'read', 'workspace', WS)] },

  { label: 'allow read on workspace, deny read on layer', read: false, write: false,
    grants: [grant(alice, 'read', 'workspace', WS), deny(alice, 'read', 'layer', LAYER)] },

  { label: 'allow read on workspace, deny read on document', read: false, write: false,
    grants: [grant(alice, 'read', 'workspace', WS), deny(alice, 'read', 'document', DOC)] },

  { label: 'allow read on layer, deny read on document', read: false, write: false,
    grants: [grant(alice, 'read', 'layer', LAYER), deny(alice, 'read', 'document', DOC)] },

  { label: 'deny on workspace beats allow on layer and document', read: false, write: false,
    grants: [
      deny(alice, 'read', 'workspace', WS),
      grant(alice, 'read', 'layer', LAYER),
      grant(alice, 'read', 'document', DOC),
    ] },

  { label: 'allow write on workspace gives write, not read', read: false, write: true,
    grants: [grant(alice, 'write', 'workspace', WS)] },

  { label: 'allow admin on workspace gives read and write', read: true, write: true,
    grants: [grant(alice, 'admin', 'workspace', WS)] },

  { label: 'allow admin, deny read: write survives, read does not', read: false, write: true,
    grants: [grant(alice, 'admin', 'workspace', WS), deny(alice, 'read', 'layer', LAYER)] },

  { label: 'allow read on the document only', read: true, write: false,
    grants: [grant(alice, 'read', 'document', DOC)] },

  { label: 'no grants', read: false, write: false, grants: [] },
]

/** Does the plan reach this one document? */
function planReaches(grants: readonly Grant[], permission: Permission): boolean {
  const plan = resolve({ orgId: ORG, role: 'member', principals, grants, tree }, permission)
  if (plan.kind === 'none') return false
  if (plan.kind === 'all') return true
  if (plan.deniedDocs.includes(DOC)) return false
  return plan.layers.includes(LAYER) || plan.extraDocs.includes(DOC)
}

describe('truth table', () => {
  for (const row of ROWS) {
    it(`${row.label} · read=${row.read} write=${row.write}`, () => {
      expect(planReaches(row.grants, 'read')).toBe(row.read)
      expect(planReaches(row.grants, 'write')).toBe(row.write)
    })

    it(`${row.label} · reference agrees`, () => {
      const input = { orgId: ORG, role: 'member' as const, principals, grants: row.grants, tree }
      const scope = { type: 'document' as const, id: DOC }
      expect(referenceAllows(input, scope, 'read')).toBe(row.read)
      expect(referenceAllows(input, scope, 'write')).toBe(row.write)
    })
  }
})
