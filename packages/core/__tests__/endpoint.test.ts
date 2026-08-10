import { describe, expect, it } from 'vitest'

import { endpointUrl, modelEndpointRefused } from '../endpoint.js'

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
})
