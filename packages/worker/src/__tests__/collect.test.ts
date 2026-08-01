import { describe, expect, it } from 'vitest'

import { collectOnce, type CollectPorts, type PurgeTarget } from '../collect.js'

/**
 * The garbage collector.
 *
 * The property that matters most here is not that it collects — it is that
 * nothing depends on it collecting. Invariant I5 is held by `deleted = false`
 * in every query, and this job only reclaims space. So the cases below are
 * mostly about failure: a sweep that marks before it purges, or that drops a
 * target it could not delete, leaves points nobody will ever look for again.
 */

const target = (n: number): PurgeTarget => ({
  orgId: 'org-1',
  orgSlug: 'acme',
  documentId: `doc-${n}`,
  deletedAgeSeconds: 7200,
})

function ports(overrides: Partial<CollectPorts> = {}) {
  const state = { order: [] as string[], purged: [] as string[], marked: [] as string[], errors: 0 }
  const base: CollectPorts = {
    claim: async (limit) => Array.from({ length: Math.min(limit, 3) }, (_, i) => target(i)),
    purge: async (_slug, id) => {
      state.order.push(`purge:${id}`)
      state.purged.push(id)
    },
    markPurged: async (_org, id) => {
      state.order.push(`mark:${id}`)
      state.marked.push(id)
    },
    onError: () => {
      state.errors++
    },
  }
  return { ports: { ...base, ...overrides }, state }
}

describe('collectOnce', () => {
  it('an empty queue is not an error and touches nothing', async () => {
    const { ports: p, state } = ports({ claim: async () => [] })
    expect(await collectOnce(p, 10, 3600)).toEqual({ purged: 0, failed: 0 })
    expect(state.order).toEqual([])
  })

  it('purges the points before marking the row', async () => {
    const { ports: p, state } = ports({ claim: async () => [target(1)] })
    await collectOnce(p, 10, 3600)

    // Marking first and then failing takes the document out of the queue
    // permanently while its points are still there — an orphan nothing will
    // ever look for again, because the only thing that looks is this query.
    expect(state.order).toEqual(['purge:doc-1', 'mark:doc-1'])
  })

  it('a failed purge leaves the row unmarked, so it comes back', async () => {
    const { ports: p, state } = ports({
      claim: async () => [target(1)],
      purge: async () => {
        throw new Error('qdrant is unreachable')
      },
    })

    expect(await collectOnce(p, 10, 3600)).toEqual({ purged: 0, failed: 1 })
    expect(state.marked).toEqual([])
    expect(state.errors).toBe(1)
  })

  it('a failed mark does not count as a purge', async () => {
    const { ports: p } = ports({
      claim: async () => [target(1)],
      markPurged: async () => {
        throw new Error('the database went away')
      },
    })

    // The points are gone but the row still says otherwise. Counting this as
    // success would report progress the next sweep has to redo — and redoing
    // it is harmless, which is why the row is left alone.
    expect(await collectOnce(p, 10, 3600)).toEqual({ purged: 0, failed: 1 })
  })

  it('one failure does not stop the rest of the sweep', async () => {
    const { ports: p, state } = ports({
      claim: async () => [target(1), target(2), target(3)],
      purge: async (_slug, id) => {
        if (id === 'doc-2') throw new Error('nope')
        state.purged.push(id)
      },
    })

    expect(await collectOnce(p, 10, 3600)).toEqual({ purged: 2, failed: 1 })
    expect(state.marked).toEqual(['doc-1', 'doc-3'])
  })

  it('the grace period reaches the claim rather than being filtered after', async () => {
    let seen: { limit: number; grace: number } | undefined
    const { ports: p } = ports({
      claim: async (limit, grace) => {
        seen = { limit, grace }
        return []
      },
    })

    await collectOnce(p, 20, 900)

    // Claiming everything and discarding the young ones would scan the whole
    // tombstone history on every pass, and the index is built for the
    // narrowed query.
    expect(seen).toEqual({ limit: 20, grace: 900 })
  })

  it('refuses a batch below one, and a negative grace', async () => {
    const { ports: p } = ports()
    // Zero batch claims nothing and reports {purged: 0} — indistinguishable
    // from a drained queue, so the backlog would grow while the logs stayed
    // clean.
    await expect(collectOnce(p, 0, 3600)).rejects.toThrow(/batch/)
    // Negative grace reads as "delete things deleted in the future", which is
    // a sign the caller computed it rather than meant it.
    await expect(collectOnce(p, 10, -1)).rejects.toThrow(/grace/)
  })

  it('zero grace is allowed, because an operator may mean it', async () => {
    const { ports: p } = ports({ claim: async () => [target(1)] })
    await expect(collectOnce(p, 10, 0)).resolves.toEqual({ purged: 1, failed: 0 })
  })
})
