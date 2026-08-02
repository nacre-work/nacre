import { describe, expect, it } from 'vitest'

import { retagOnce, type RetagPorts, type StaleDocument } from '../retag.js'

/**
 * The recomputation pass.
 *
 * What is under test is the ordering and the failure handling, not the SQL —
 * `claimStale` has its own test against a real database. The two properties
 * that matter here both concern what happens when something goes wrong, because
 * the failure modes are silent: a document marked without being written reports
 * itself caught up while carrying a revoked grant, and a document dropped from
 * the retry set stops contributing to the lag that would have revealed it.
 */

const doc = (n: number): StaleDocument => ({
  orgId: 'org-1',
  collection: 'org_acme',
  documentId: `doc-${n}`,
  layerId: 'layer-1',
})

function ports(overrides: Partial<RetagPorts> = {}) {
  const state = {
    retagged: [] as { documentId: string; aclVersion: number; aclTags: readonly string[] }[],
    marked: [] as { id: string; version: number }[],
    errors: [] as { id: string; error: string }[],
    order: [] as string[],
    inFlight: 0,
    peak: 0,
  }

  const base: RetagPorts = {
    claim: async (limit) => Array.from({ length: Math.min(limit, 3) }, (_, i) => doc(i)),
    tagsFor: async () => ({ tags: ['h:aaaa'], version: 7 }),
    retag: async (input) => {
      state.order.push(`retag:${input.documentId}`)
      state.retagged.push({
        documentId: input.documentId,
        aclVersion: input.aclVersion,
        aclTags: input.aclTags,
      })
    },
    markTagged: async (_org, id, version) => {
      state.order.push(`mark:${id}`)
      state.marked.push({ id, version })
    },
    onError: (document, error) => {
      state.errors.push({ id: document.documentId, error: String(error) })
    },
  }

  return { ports: { ...base, ...overrides }, state }
}

describe('retagOnce', () => {
  it('an empty claim is not an error and does nothing', async () => {
    const { ports: p, state } = ports({ claim: async () => [] })
    expect(await retagOnce(p, 10, 2)).toEqual({ retagged: 0, failed: 0 })
    expect(state.order).toEqual([])
  })

  it('writes the payload before marking the row', async () => {
    const { ports: p, state } = ports({ claim: async () => [doc(1)] })
    await retagOnce(p, 10, 1)

    // The same order ingest uses, for the same reason. acl_version is a claim
    // that the points carry tags from that version, and marking first then
    // failing records a document as caught up while its points still carry the
    // grant that was revoked.
    expect(state.order).toEqual(['retag:doc-1', 'mark:doc-1'])
  })

  it('marks at the version the tags were read at', async () => {
    const { ports: p, state } = ports({
      claim: async () => [doc(1)],
      tagsFor: async () => ({ tags: ['h:bbbb'], version: 12 }),
    })
    await retagOnce(p, 10, 1)

    expect(state.retagged[0]?.aclVersion).toBe(12)
    expect(state.marked).toEqual([{ id: 'doc-1', version: 12 }])
  })

  it('a document whose payload write fails is not marked', async () => {
    const { ports: p, state } = ports({
      claim: async () => [doc(1)],
      retag: async () => {
        throw new Error('qdrant is unreachable')
      },
    })

    const result = await retagOnce(p, 10, 1)

    expect(result).toEqual({ retagged: 0, failed: 1 })
    // It keeps its old acl_version, stays in the next claim, and keeps
    // contributing to the lag. A document that silently stopped being retried
    // while the gauge reported health is the failure this whole subsystem is
    // built to make impossible.
    expect(state.marked).toEqual([])
  })

  it('one failure does not stop the rest of the batch', async () => {
    const { ports: p, state } = ports({
      claim: async () => [doc(1), doc(2), doc(3)],
      retag: async (input) => {
        if (input.documentId === 'doc-2') throw new Error('nope')
        state.retagged.push({
          documentId: input.documentId,
          aclVersion: input.aclVersion,
          aclTags: input.aclTags,
        })
      },
    })

    const result = await retagOnce(p, 10, 1)

    expect(result).toEqual({ retagged: 2, failed: 1 })
    expect(state.marked.map((m) => m.id)).toEqual(['doc-1', 'doc-3'])
    expect(state.errors).toHaveLength(1)
  })

  it('concurrency is bounded', async () => {
    const { ports: p, state } = ports({
      claim: async () => Array.from({ length: 12 }, (_, i) => doc(i)),
      retag: async () => {
        state.inFlight++
        state.peak = Math.max(state.peak, state.inFlight)
        await new Promise((r) => setTimeout(r, 5))
        state.inFlight--
      },
    })

    await retagOnce(p, 20, 3)

    // A revocation across a large layer touches every document in it. An
    // unbounded pass would take the vector store down at exactly the moment
    // correctness depends on it being reachable.
    expect(state.peak).toBeLessThanOrEqual(3)
    expect(state.marked).toHaveLength(12)
  })

  it('every claimed document is attempted exactly once', async () => {
    const { ports: p, state } = ports({
      claim: async () => Array.from({ length: 7 }, (_, i) => doc(i)),
    })

    await retagOnce(p, 20, 4)

    // The workers share an index rather than a slice each. An off-by-one in
    // that loop either skips a document — which stays stale forever while
    // looking claimed — or retags one twice, which is merely wasteful.
    const ids = state.retagged.map((r) => r.documentId).sort()
    expect(ids).toEqual([...new Set(ids)].sort())
    expect(ids).toHaveLength(7)
  })

  it('refuses a batch or concurrency below one', async () => {
    const { ports: p } = ports()
    // Zero concurrency spawns no workers, so the pass would return
    // {retagged: 0} having done nothing — indistinguishable from a drained
    // queue, and the lag would climb with the logs reporting success.
    await expect(retagOnce(p, 10, 0)).rejects.toThrow(/concurrency/)
    await expect(retagOnce(p, 0, 1)).rejects.toThrow(/batch/)
  })
})
