import { describe, expect, it } from 'vitest'

import type { Grant, PrincipalRef } from '../../types.js'
import { effectivePrincipals, MemoryGroupGraph } from '../principals.js'
import { resolve } from '../resolve.js'
import { deny, grant, ORG, tree, user } from './helpers.js'

const alice = user('alice')

describe('adversarial', () => {
  it('T13 · a grant issued and revoked in one transaction gives no access', () => {
    // Both rows are present and applicable. Rule 5 is not "the later one wins"
    // and not "the more specific one wins" — any deny beats any allow.
    const p = resolve({
      orgId: ORG,
      role: 'member',
      principals: new Set<PrincipalRef>(['user:alice']),
      grants: [
        grant(alice, 'read', 'layer', 'contracts'),
        deny(alice, 'read', 'layer', 'contracts'),
      ],
      tree,
    }, 'read')

    expect(p).toEqual({ kind: 'none' })
  })

  it('T14 · cyclic group nesting terminates and resolves correctly', () => {
    // A ⊂ B ⊂ A. The membership graph comes from someone else's directory over
    // SCIM, so this is a shape to survive rather than to reject: throwing here
    // would surface as a permission evaluation failure, which denies, and a
    // customer's directory hygiene would read as an outage.
    const graph = new MemoryGroupGraph({
      membership: {
        'user:alice': ['a'],
        'group:a': ['b'],
        'group:b': ['a'],
      },
    })

    const principals = effectivePrincipals(alice, graph)
    expect([...principals].sort()).toEqual(['group:a', 'group:b', 'user:alice'])
  })

  it('T14 · a self-referencing group terminates', () => {
    const graph = new MemoryGroupGraph({
      membership: { 'user:alice': ['loop'], 'group:loop': ['loop'] },
    })
    expect([...effectivePrincipals(alice, graph)].sort()).toEqual(['group:loop', 'user:alice'])
  })

  it('T15 · 10 000 principals resolve without pathological slowdown', () => {
    const principals = new Set<PrincipalRef>(['user:alice'])
    const grants: Grant[] = []
    for (let i = 0; i < 10_000; i++) {
      principals.add(`group:g${i}`)
      grants.push(grant({ type: 'group', id: `g${i}` }, 'read', 'document', `doc-${i}`))
    }
    grants.push(grant(alice, 'read', 'layer', 'contracts'))

    const started = performance.now()
    const p = resolve({ orgId: ORG, role: 'member', principals, grants, tree }, 'read')
    const elapsed = performance.now() - started

    // A generous ceiling. This is not a benchmark — it is a guard against a
    // quadratic scan sneaking into the resolver, which at this size would take
    // orders of magnitude longer rather than a little.
    expect(elapsed).toBeLessThan(1000)
    expect(p.kind).toBe('scoped')
    if (p.kind !== 'scoped') return

    // The 10 000 document grants name documents that are not in the tree, so
    // they cannot be checked against their ancestors and are refused. That is
    // rule I3 applied to an unplaceable scope, not an oversight.
    expect(p.extraDocs).toEqual([])
    expect(p.layers).toEqual(['contracts'])
  })

  it('a document whose layer is unknown is refused rather than allowed', () => {
    const p = resolve({
      orgId: ORG,
      role: 'member',
      principals: new Set<PrincipalRef>(['user:alice']),
      grants: [grant(alice, 'read', 'document', 'doc-that-moved-away')],
      tree,
    }, 'read')

    expect(p).toEqual({ kind: 'none' })
  })
})
