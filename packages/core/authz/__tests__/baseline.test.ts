import { describe, expect, it } from 'vitest'

import type { PrincipalRef } from '../../types.js'
import { buildFilter } from '../filter.js'
import { effectivePrincipals, MemoryGroupGraph } from '../principals.js'
import { resolve, type AccessPlan } from '../resolve.js'
import { deny, grant, ORG, OTHER_ORG, service, tree, user } from './helpers.js'

const alice = user('alice')
const principals = new Set<PrincipalRef>(['user:alice'])

const plan = (grants: Parameters<typeof resolve>[0]['grants'], permission = 'read' as const) =>
  resolve({ orgId: ORG, role: 'member', principals, grants, tree }, permission)

const layersOf = (p: AccessPlan) => (p.kind === 'scoped' ? p.layers : [])
const docsOf = (p: AccessPlan) => (p.kind === 'scoped' ? p.extraDocs : [])

describe('baseline', () => {
  it('T1 · a grant from another organization is discarded, not weighed', () => {
    const foreign = grant(alice, 'read', 'workspace', 'ws', 'allow', OTHER_ORG)
    expect(plan([foreign])).toEqual({ kind: 'none' })

    // And it does not become usable by sitting next to a valid one.
    const mixed = plan([foreign, grant(alice, 'read', 'layer', 'handbook')])
    expect(layersOf(mixed)).toEqual(['handbook'])
  })

  it('T3 · deny on a layer removes it from a workspace-wide read', () => {
    const p = plan([
      grant(alice, 'read', 'workspace', 'ws'),
      deny(alice, 'read', 'layer', 'contracts'),
    ])
    expect(layersOf(p)).toEqual(['handbook'])
    expect(layersOf(p)).not.toContain('contracts')
  })

  it('T3 · deny wins from above, not from the nearest scope', () => {
    // The truth-table row people get wrong: deny at the top, allow below it.
    // "Most specific wins" would grant this; the specification denies it.
    const p = plan([
      deny(alice, 'read', 'workspace', 'ws'),
      grant(alice, 'read', 'layer', 'contracts'),
      grant(alice, 'read', 'document', 'doc-contract-1'),
    ])
    expect(p).toEqual({ kind: 'none' })
  })

  it('T4 · write does not imply read', () => {
    const grants = [grant(service('ingest'), 'write', 'layer', 'contracts')]
    const svc = new Set<PrincipalRef>(['service_account:ingest'])
    const input = { orgId: ORG, role: 'member' as const, principals: svc, grants, tree }

    expect(resolve(input, 'write').kind).toBe('scoped')
    expect(resolve(input, 'read')).toEqual({ kind: 'none' })
  })

  it('T4 · admin implies both', () => {
    const grants = [grant(alice, 'admin', 'layer', 'contracts')]
    const input = { orgId: ORG, role: 'member' as const, principals, grants, tree }

    expect(layersOf(resolve(input, 'read'))).toEqual(['contracts'])
    expect(layersOf(resolve(input, 'write'))).toEqual(['contracts'])
  })

  it('T5 · a document grant reaches that document and not its neighbours', () => {
    const p = plan([grant(alice, 'read', 'document', 'doc-contract-1')])
    expect(layersOf(p)).toEqual([])
    expect(docsOf(p)).toEqual(['doc-contract-1'])
    expect(docsOf(p)).not.toContain('doc-contract-2')
  })

  it('T6 · removing the user from a group removes what the group granted', () => {
    const grants = [grant({ type: 'group', id: 'legal' }, 'read', 'layer', 'contracts')]
    const member = effectivePrincipals(alice, new MemoryGroupGraph({
      membership: { 'user:alice': ['legal'] },
    }))
    const removed = effectivePrincipals(alice, new MemoryGroupGraph({ membership: {} }))

    expect(layersOf(resolve({ orgId: ORG, role: 'member', principals: member, grants, tree }, 'read')))
      .toEqual(['contracts'])
    expect(resolve({ orgId: ORG, role: 'member', principals: removed, grants, tree }, 'read'))
      .toEqual({ kind: 'none' })
  })

  it('T7 · every filter excludes deleted documents', () => {
    const scoped = plan([grant(alice, 'read', 'layer', 'contracts')])
    if (scoped.kind === 'none') throw new Error('fixture should grant access')

    for (const p of [scoped, { kind: 'all' } as const]) {
      expect(buildFilter(ORG, p).must).toContainEqual({
        key: 'deleted',
        match: { value: false },
      })
    }
  })

  it('T7 · every filter pins the organization', () => {
    const scoped = plan([grant(alice, 'read', 'layer', 'contracts')])
    if (scoped.kind === 'none') throw new Error('fixture should grant access')

    for (const p of [scoped, { kind: 'all' } as const]) {
      expect(buildFilter(ORG, p).must).toContainEqual({
        key: 'org_id',
        match: { value: ORG },
      })
    }
  })

  it('rule 2 · platform_admin reads nothing, whatever it was granted', () => {
    const grants = [grant(alice, 'admin', 'workspace', 'ws')]
    expect(resolve({ orgId: ORG, role: 'platform_admin', principals, grants, tree }, 'read'))
      .toEqual({ kind: 'none' })
  })

  it('rule 3 · org_admin reaches everything without a grant', () => {
    expect(resolve({ orgId: ORG, role: 'org_admin', principals, grants: [], tree }, 'read'))
      .toEqual({ kind: 'all' })
  })

  it('rule 8 · no grant is no access', () => {
    expect(plan([])).toEqual({ kind: 'none' })
  })

  it('a scoped filter constrains rather than merely scoring', () => {
    const p = plan([grant(alice, 'read', 'layer', 'contracts')])
    if (p.kind !== 'scoped') throw new Error('fixture should be scoped')

    // `should` in Qdrant means at least one must match. The thing to guard is
    // that it is never empty: an empty list is no constraint, and the filter
    // would fall back to `must` and return the whole collection.
    const filter = buildFilter(ORG, p)
    expect(filter.should?.length ?? 0).toBeGreaterThan(0)
    expect(filter.should).toContainEqual({ key: 'layer_id', match: { any: ['contracts'] } })
  })

  it('a scoped plan that reaches nothing is refused, not turned into a filter', () => {
    // resolve() never produces this — it returns kind: 'none'. A hand-built one
    // would otherwise become a filter with no `should` at all, which returns
    // every point in the collection.
    expect(() =>
      buildFilter(ORG, { kind: 'scoped', layers: [], extraDocs: [], deniedDocs: [] }),
    ).toThrow(/reaches no layer and no document/)
  })
})
