import { describe, expect, it } from 'vitest'

import {
  embedInBatches,
  endpointReason,
  endpointUrl,
  modelEndpointRefused,
} from '../endpoint.js'

/**
 * What an operator is told when a model endpoint refuses.
 *
 * The 401 case is the one this file is for, and it is a documentation defect
 * that became a code one. None of the three callers sends an `Authorization`
 * header and none can: `embedding_providers` has no column for a credential,
 * deliberately, because a vendor key there would reach every database dump. So
 * pointing an endpoint straight at a hosted vendor cannot work — and the whole
 * of what an operator saw was `answered 401`.
 *
 * They then read `docs/config.md`, which said "anything already speaking
 * OpenAI's contract works by pointing `embedding_providers.endpoint` straight
 * at it", with OpenAI named in the vendor table directly above. That sentence
 * is true only of endpoints wanting no credential, and it does not say so.
 * Found by somebody following it and asking why it did not work.
 */

describe('endpointUrl', () => {
  // The bug this function exists for: `new URL('/embeddings', base)` is
  // origin-relative, so every path an operator wrote was discarded.
  it('keeps a path the operator configured', () => {
    expect(endpointUrl('http://host.docker.internal:11434/v1', 'embeddings').href).toBe(
      'http://host.docker.internal:11434/v1/embeddings',
    )
  })

  it('still puts the route at the root when the base has no path', () => {
    expect(endpointUrl('http://embedder:80', 'embeddings').href).toBe(
      'http://embedder/embeddings',
    )
  })
})

describe('modelEndpointRefused', () => {
  const at = new URL('https://api.openai.com/v1/embeddings')

  // One table, both kinds, so a message fixed for the embedder and left alone
  // for the reranker is a failure here rather than a discovery later. The two
  // reach the same class of endpoint and neither sends a credential.
  const kinds = [
    { kind: 'embedding' as const, names: 'the embedding endpoint' },
    { kind: 'reranker' as const, names: 'the reranker' },
  ]

  for (const { kind, names } of kinds) {
    describe(kind, () => {
      for (const status of [401, 403]) {
        it(`says why on ${String(status)} rather than only the status`, () => {
          const message = modelEndpointRefused(kind, at, status).message

          expect(message).toContain(names)
          expect(message).toContain(at.href)
          expect(message).toContain(String(status))

          // The three things an operator cannot work out from a bare status:
          // that a credential is wanted, that this client structurally cannot
          // send one, and what to do instead.
          expect(message).toMatch(/credential/i)
          expect(message).toMatch(/embedding_providers/)
          expect(message).toMatch(/adapter/i)
        })
      }

      it('stays out of the way on a status that is not about credentials', () => {
        // 500 is the vendor's problem and the operator's next step is their
        // status page, not this repository's configuration. A paragraph about
        // credentials there would be noise on every transient failure.
        const message = modelEndpointRefused(kind, at, 500).message

        expect(message).toContain('500')
        expect(message).toContain(at.href)
        expect(message).not.toMatch(/credential/i)
      })
    })
  }

  it('names the URL in every case, because the endpoint comes from a row', () => {
    // An installation can run several providers. "Which one" is the question
    // the message has to answer, and the worker's transport-failure helper
    // already made that argument for the same reason.
    for (const status of [401, 403, 429, 500, 503]) {
      expect(modelEndpointRefused('embedding', at, status).message).toContain(at.href)
    }
  })

  it("carries the endpoint's own reason where it gave one", () => {
    // The case this exists for, and it is a real one: the embedding adapter's
    // 502 means an upstream failed, and which upstream and how is in its body.
    const message = modelEndpointRefused(
      'embedding',
      new URL('http://embedding-adapter:8091/embeddings'),
      502,
      'cloudflare answered 429',
    ).message

    expect(message).toContain('502')
    expect(message).toContain('cloudflare answered 429')
  })

  it('carries it on a credential refusal too, ahead of the explanation', () => {
    // 401 has a paragraph of its own, and the endpoint's sentence is the part
    // that is specific to this deployment — so it goes before the general
    // advice rather than after it, where nobody reads.
    const message = modelEndpointRefused('reranker', at, 401, 'missing api key').message
    const said = message.indexOf('missing api key')

    expect(said).toBeGreaterThan(-1)
    expect(said).toBeLessThan(message.indexOf('embedding_providers'))
  })
})

describe('endpointReason', () => {
  const answering = (body: string, type = 'application/json') =>
    new Response(body, { status: 502, headers: { 'content-type': type } })

  it("reads OpenAI's shape, which is what the adapter answers", async () => {
    const reason = await endpointReason(
      answering(JSON.stringify({ error: { message: 'cloudflare answered 429' } })),
    )
    expect(reason).toBe('cloudflare answered 429')
  })

  it("reads TEI's shape, which is what a real TEI container answers", async () => {
    // The reranker path meets this one whenever a deployment points at TEI
    // rather than at the adapter, and TEI's error is a bare string.
    const reason = await endpointReason(
      answering(JSON.stringify({ error: 'Input validation error', error_type: 'validation' })),
    )
    expect(reason).toBe('Input validation error')
  })

  it('collapses a message onto one line', async () => {
    // It goes into a log line and into `documents.error`; a stack trace pasted
    // into a JSON string would break the first and be unreadable in the second.
    const reason = await endpointReason(
      answering(JSON.stringify({ error: { message: 'first\n  second\ttab  ' } })),
    )
    expect(reason).toBe('first second tab')
  })

  it('bounds it, because a vendor can quote the input it rejected', async () => {
    // The safety argument for forwarding at all. The endpoint is whatever an
    // operator configured — the adapter never quotes an upstream body, but a
    // hosted vendor reached directly may quote document text, and this message
    // reaches a log.
    const reason = await endpointReason(
      answering(JSON.stringify({ error: { message: 'x'.repeat(5000) } })),
    )
    expect(reason).toHaveLength(201)
    expect(reason?.endsWith('…')).toBe(true)
  })

  for (const [what, body] of [
    ['a body that is not JSON', '<html>502 Bad Gateway</html>'],
    ['a body with no error field', JSON.stringify({ detail: 'nope' })],
    ['an error that is neither a string nor an object with one', JSON.stringify({ error: 42 })],
    ['a message that is only whitespace', JSON.stringify({ error: { message: '   ' } })],
    ['an empty body', ''],
  ] as const) {
    it(`says nothing rather than something wrong for ${what}`, async () => {
      // Every one of these is a real answer from something in this position —
      // an nginx in front of a wedged container answers the first. `undefined`
      // leaves the message exactly as it was before this existed.
      expect(await endpointReason(answering(body))).toBeUndefined()
    })
  }
})

/**
 * The batch an embedding endpoint is actually sent.
 *
 * Both clients used to send a document's whole chunk list as one `input` array.
 * A chunk is 800 characters with 120 of overlap, so past roughly 22 KB of text
 * that crossed Text Embeddings Inference's default `--max-client-batch-size` of
 * 32 and came back 413 — and the worker marks such a document `failed`, which
 * nothing retries. Twenty-six documents out of fifty on a running stand, with
 * the layer still answering searches out of the other twenty-four.
 */
describe('embedInBatches', () => {
  const vectorsFor = (batch: readonly string[]) => batch.map((t) => [t.length])

  it('sends one request when the input fits', async () => {
    const sent: number[] = []
    const out = await embedInBatches(['a', 'b'], 32, (batch) => {
      sent.push(batch.length)
      return Promise.resolve(vectorsFor(batch))
    })
    expect(sent).toEqual([2])
    expect(out).toEqual([[1], [1]])
  })

  it('splits at the limit, and no request exceeds it', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => 'x'.repeat(i + 1))
    const sent: number[] = []
    const out = await embedInBatches(texts, 32, (batch) => {
      sent.push(batch.length)
      return Promise.resolve(vectorsFor(batch))
    })
    expect(sent).toEqual([32, 32, 6])
    expect(Math.max(...sent)).toBeLessThanOrEqual(32)
    expect(out).toHaveLength(70)
  })

  /**
   * The order is the whole point. A vector attached to the wrong text is a
   * document that indexes cleanly and answers the wrong questions, and nothing
   * downstream can tell — which is why the batches are concatenated in order
   * and never raced.
   */
  it('keeps every vector with its own text across batches', async () => {
    const texts = Array.from({ length: 100 }, (_, i) => 'x'.repeat(i + 1))
    const out = await embedInBatches(texts, 7, (batch) => Promise.resolve(vectorsFor(batch)))
    expect(out).toEqual(texts.map((t) => [t.length]))
  })

  it('runs the batches one at a time, because the endpoint is the bottleneck', async () => {
    let inFlight = 0
    let most = 0
    const texts = Array.from({ length: 50 }, () => 'x')
    await embedInBatches(texts, 10, async (batch) => {
      inFlight += 1
      most = Math.max(most, inFlight)
      await Promise.resolve()
      inFlight -= 1
      return vectorsFor(batch)
    })
    expect(most).toBe(1)
  })

  it('refuses a short batch rather than returning a misaligned result', async () => {
    const texts = Array.from({ length: 40 }, () => 'x')
    await expect(
      embedInBatches(texts, 32, (batch) => Promise.resolve(vectorsFor(batch).slice(1))),
    ).rejects.toThrow(/returned 31 vectors for 32 inputs/)
  })

  /**
   * The case a shortcut broke. `texts.length <= limit` used to return the
   * endpoint's answer directly, which skipped the count check — and this is
   * almost every call, since a document under the limit is one batch and a
   * search query is one text. A short answer there misaligns silently.
   */
  it('refuses a short batch when the whole input is one batch', async () => {
    await expect(
      embedInBatches(['a', 'b'], 32, () => Promise.resolve([[1, 2, 3, 4]])),
    ).rejects.toThrow(/returned 1 vectors for 2 inputs/)
  })

  it('refuses a limit that is not a positive integer', async () => {
    await expect(embedInBatches(['a'], 0, () => Promise.resolve([[0]]))).rejects.toThrow(
      /positive integer/,
    )
  })

  it('sends nothing at all for no texts', async () => {
    let called = false
    const out = await embedInBatches([], 32, () => {
      called = true
      return Promise.resolve([])
    })
    expect(called).toBe(false)
    expect(out).toEqual([])
  })
})
