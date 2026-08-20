import type { Effect, Grant, Permission, Principal, ScopeType } from '../../types.js'
import { MemoryScopeTree } from '../scope-tree.js'

export const ORG = 'org-a'
export const OTHER_ORG = 'org-b'

export const user = (id: string): Principal => ({ type: 'user', id })
export const service = (id: string): Principal => ({ type: 'service_account', id })

/**
 * `grant(alice, 'read', 'layer', 'contracts')` reads close enough to the
 * tuple in the specification — (principal, scope, permission, effect) — that a
 * reviewer can check a test against the truth table without decoding it.
 */
export function grant(
  principal: Principal,
  permission: Permission,
  scopeType: ScopeType,
  scopeId: string,
  effect: Effect = 'allow',
  orgId: string = ORG,
): Grant {
  return { orgId, principal, permission, scope: { type: scopeType, id: scopeId }, effect }
}

export const deny = (
  principal: Principal,
  permission: Permission,
  scopeType: ScopeType,
  scopeId: string,
): Grant => grant(principal, permission, scopeType, scopeId, 'deny')

/**
 * One workspace, two layers, two documents each. Small enough to hold in the
 * head while reading a test, and big enough that "leaked a neighbour" is
 * visible.
 */
export const tree = new MemoryScopeTree({
  layers: { ws: ['contracts', 'handbook'], 'ws-other': ['finance'] },
  documents: {
    'doc-contract-1': 'contracts',
    'doc-contract-2': 'contracts',
    'doc-handbook-1': 'handbook',
    'doc-finance-1': 'finance',
  },
})
