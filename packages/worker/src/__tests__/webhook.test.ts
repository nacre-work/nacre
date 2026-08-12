import { describe, expect, it, vi } from 'vitest'

import { body, deliver, sign, verify, type Completion } from '../webhook.js'

/**
 * The completion callback.
 *
 * Three of these are about what must **not** happen — the payload carrying
 * document text, a receiver's outage reaching the document, and a rejected
 * signature being retried as though it were a network blip.
 */

const SECRET = 'a'.repeat(32)

const indexed: Completion = {
  documentId: 'doc-1',
  externalId: 'handbook/onboarding.md',
  layerId: 'layer-1',
  orgId: 'org-1',
  status: 'indexed',
  chunkCount: 3,
  error: null,
}

// `null` and not `''`: a 204 may not carry a body and undici throws on one, so
// the first version of this helper made every "success" answer a transport
// failure — and the retry case failed for a reason that had nothing to do with
// retrying.
const ok = () => new Response(null, { status: 204 })
const status = (code: number) => () => new Response(null, { status: code })

function recorder(...answers: (() => Response)[]) {
  const calls: { headers: Record<string, string>; body: string }[] = []
  let i = 0
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    calls.push({
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: String(init?.body ?? ''),
    })
    return (answers[Math.min(i++, answers.length - 1)] as () => Response)()
  }) as unknown as typeof globalThis.fetch
  return { fetchImpl, calls }
}

const options = (fetchImpl: typeof globalThis.fetch, attempts = 3) => ({
  url: 'https://receiver.test/hook',
  secret: SECRET,
  attempts,
  fetch: fetchImpl,
  // No real waiting, so a retry test is milliseconds rather than seven seconds.
  wait: async () => undefined,
  now: () => 1_700_000_000_000,
})

describe('the payload', () => {
  it('carries identifiers and a status, and no document content', () => {
    const parsed = JSON.parse(body(indexed))

    expect(parsed).toEqual({
      event: 'document.indexed',
      document_id: 'doc-1',
      external_id: 'handbook/onboarding.md',
      layer_id: 'layer-1',
      org_id: 'org-1',
      status: 'indexed',
      chunk_count: 3,
      error: null,
    })
    // The rule this pins: a callback goes to an address with no principal
    // attached, so there is nothing on the other end to evaluate a grant
    // against. Identifiers travel; the document does not.
    for (const forbidden of ['text', 'content', 'title', 'metadata', 'chunks']) {
      expect(Object.keys(parsed)).not.toContain(forbidden)
    }
  })

  it('names the failure on a failed document, since the receiver has no other route to it', () => {
    const parsed = JSON.parse(body({ ...indexed, status: 'failed', chunkCount: 0, error: 'boom' }))

    expect(parsed.event).toBe('document.failed')
    expect(parsed.error).toBe('boom')
  })
})

describe('the signature', () => {
  it('covers the timestamp as well as the body', () => {
    // Beside the body rather than inside it would be a signature that proves
    // origin and not age: a captured payload replays with a fresh timestamp.
    expect(sign(SECRET, 1, 'x')).not.toBe(sign(SECRET, 2, 'x'))
    expect(verify(SECRET, 1, 'x', sign(SECRET, 1, 'x'))).toBe(true)
    expect(verify(SECRET, 2, 'x', sign(SECRET, 1, 'x'))).toBe(false)
  })

  it('does not verify under another key, or against a tampered body', () => {
    expect(verify('b'.repeat(32), 1, 'x', sign(SECRET, 1, 'x'))).toBe(false)
    expect(verify(SECRET, 1, 'tampered', sign(SECRET, 1, 'x'))).toBe(false)
  })

  it('travels with the request, over exactly what was sent', async () => {
    const { fetchImpl, calls } = recorder(ok)
    await deliver(indexed, options(fetchImpl))

    const call = calls[0]
    expect(call?.headers['x-nacre-event']).toBe('document.indexed')
    expect(
      verify(SECRET, Number(call?.headers['x-nacre-timestamp']), call?.body ?? '', call?.headers['x-nacre-signature'] ?? ''),
    ).toBe(true)
  })
})

describe('delivery', () => {
  it('retries what retrying can fix', async () => {
    const { fetchImpl, calls } = recorder(status(503), status(503), ok)

    expect(await deliver(indexed, options(fetchImpl))).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('does not retry an answer', async () => {
    // A 401 is the receiver saying the signature is not accepted, and a 400
    // that the body is wrong. Sending either again changes nothing and delays
    // every document behind it.
    for (const code of [400, 401, 404, 422]) {
      const { fetchImpl, calls } = recorder(status(code))
      expect(await deliver(indexed, options(fetchImpl))).toBe(false)
      expect(calls, `${code} must not be retried`).toHaveLength(1)
    }
  })

  it('gives up after the configured attempts and says why', async () => {
    const onFailure = vi.fn()
    const { fetchImpl, calls } = recorder(status(500))

    expect(await deliver(indexed, { ...options(fetchImpl, 2), onFailure })).toBe(false)
    expect(calls).toHaveLength(2)
    expect(onFailure).toHaveBeenCalledWith({ attempts: 2, reason: '500 ' })
  })

  it('treats a transport failure as retryable and reports the last reason', async () => {
    const onFailure = vi.fn()
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch

    expect(await deliver(indexed, { ...options(fetchImpl, 2), onFailure })).toBe(false)
    expect(onFailure).toHaveBeenCalledWith({ attempts: 2, reason: 'ECONNREFUSED' })
  })

  it('waits between attempts and not after the last one', async () => {
    const waits: number[] = []
    const { fetchImpl } = recorder(status(500))

    await deliver(indexed, {
      ...options(fetchImpl, 3),
      wait: async (ms) => void waits.push(ms),
    })

    // Two gaps for three attempts. A sleep after the final one is time spent
    // achieving nothing.
    expect(waits).toEqual([1000, 2000])
  })
})
