import { describe, expect, it } from 'vitest'

import { reapOnce, type ReapPorts, type StrandedDocument } from '../reap.js'

/**
 * Reclaiming abandoned claims.
 *
 * The failure this exists for leaves no trace: a worker stops existing between
 * committing `status = 'parsing'` and finishing, and the row stays in a state
 * nothing claims. No error, no retry, no metric — a document that was accepted
 * with a `202` and never indexes.
 *
 * So the cases below are about the guard rails rather than the happy path. A
 * reaper without a ceiling turns a document that kills the worker into one that
 * kills every worker, in rotation, forever.
 */

const stranded = (n: number, attempts = 1): StrandedDocument => ({
  orgId: 'org-1',
  documentId: `doc-${n}`,
  heldSeconds: 1800,
  attempts,
})

function ports(overrides: Partial<ReapPorts> = {}) {
  const state = { asked: [] as { limit: number; lease: number; max: number }[], reaped: [] as string[] }
  const base: ReapPorts = {
    claim: async (limit, lease, max) => {
      state.asked.push({ limit, lease, max })
      return []
    },
    onReaped: (document, outcome) => {
      state.reaped.push(`${document.documentId}:${outcome}`)
    },
  }
  return { ports: { ...base, ...overrides }, state }
}

describe('reapOnce', () => {
  it('nothing stranded is the normal case and is not an event', async () => {
    const { ports: p, state } = ports()
    expect(await reapOnce(p, 10, 900, 5)).toEqual({ requeued: 0, failed: 0 })
    expect(state.reaped).toEqual([])
  })

  it('a document below the ceiling is requeued', async () => {
    const { ports: p, state } = ports({ claim: async () => [stranded(1, 2)] })
    expect(await reapOnce(p, 10, 900, 5)).toEqual({ requeued: 1, failed: 0 })
    expect(state.reaped).toEqual(['doc-1:requeued'])
  })

  it('a document at the ceiling is failed, not requeued', async () => {
    const { ports: p, state } = ports({ claim: async () => [stranded(1, 5)] })

    // The poison pill. Without this branch the document comes back, takes down
    // the worker that picks it up, and comes back again — a queue that gets
    // slower every cycle and an outage nobody can attribute to one row.
    expect(await reapOnce(p, 10, 900, 5)).toEqual({ requeued: 0, failed: 1 })
    expect(state.reaped).toEqual(['doc-1:failed'])
  })

  it('the boundary is >=, so the ceiling is a ceiling', async () => {
    const { ports: p } = ports({ claim: async () => [stranded(1, 6)] })
    expect(await reapOnce(p, 10, 900, 5)).toEqual({ requeued: 0, failed: 1 })
  })

  it('a mixed batch is counted by outcome, not by size', async () => {
    const { ports: p, state } = ports({
      claim: async () => [stranded(1, 1), stranded(2, 5), stranded(3, 3)],
    })
    expect(await reapOnce(p, 10, 900, 5)).toEqual({ requeued: 2, failed: 1 })
    expect(state.reaped).toEqual(['doc-1:requeued', 'doc-2:failed', 'doc-3:requeued'])
  })

  it('the lease and the ceiling reach the claim rather than being applied after', async () => {
    const { ports: p, state } = ports()
    await reapOnce(p, 25, 300, 3)

    // Both belong in the statement that writes the row: the requeue-or-fail
    // decision depends on the attempt count it increments, and splitting the
    // read from the write lets two reapers each see 4 and each write 5.
    expect(state.asked).toEqual([{ limit: 25, lease: 300, max: 3 }])
  })

  it('refuses a batch below one, a lease below a second, and a ceiling below one', async () => {
    const { ports: p } = ports()
    await expect(reapOnce(p, 0, 900, 5)).rejects.toThrow(/batch/)
    // A zero lease reclaims a document the instant it is claimed. Not a fast
    // reaper — a loop in which nothing ever finishes.
    await expect(reapOnce(p, 10, 0, 5)).rejects.toThrow(/lease/)
    // A zero ceiling fails every document on its first claim.
    await expect(reapOnce(p, 10, 900, 0)).rejects.toThrow(/maxAttempts/)
  })
})
