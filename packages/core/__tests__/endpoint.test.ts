import { describe, expect, it } from 'vitest'

import { endpointUrl } from '../endpoint.js'

/**
 * The route a model-server call ends up at.
 *
 * Every case here is an endpoint somebody configures. The first two are what
 * the Compose profiles set and are the reason the origin-relative version held
 * for as long as it did; the rest are what "any OpenAI-compatible endpoint"
 * actually means in practice, and each one lost its path.
 */
describe('endpointUrl', () => {
  it.each([
    // The `full` profile's embedder and reranker: no path, route at the root.
    ['http://embedder:80', 'embeddings', 'http://embedder/embeddings'],
    ['http://reranker:80', 'rerank', 'http://reranker/rerank'],
    // A base path is kept rather than discarded. This is the whole change:
    // `new URL('/embeddings', …)` answered `https://api.openai.com/embeddings`,
    // which is a 404 that names no cause.
    ['https://api.openai.com/v1', 'embeddings', 'https://api.openai.com/v1/embeddings'],
    // Ollama and LM Studio, which is what a laptop — and an Apple Silicon
    // laptop in particular, where there is no local TEI image — actually runs.
    ['http://host.docker.internal:11434/v1', 'embeddings', 'http://host.docker.internal:11434/v1/embeddings'],
    ['http://host.docker.internal:1234/v1/', 'embeddings', 'http://host.docker.internal:1234/v1/embeddings'],
    // Deeper than one segment, and a port that is not the scheme's default.
    ['https://gateway.internal:8443/models/bge-m3', 'embeddings', 'https://gateway.internal:8443/models/bge-m3/embeddings'],
    // A trailing slash on a bare origin is the same URL as no path at all.
    ['http://embedder:80/', 'embeddings', 'http://embedder/embeddings'],
  ])('%s + %s → %s', (base, route, expected) => {
    expect(endpointUrl(base, route).href).toBe(expected)
  })

  it('takes a route written with a leading slash and still resolves it relatively', () => {
    // Not an invitation to write one — it is there so a caller that copies the
    // old spelling across does not silently reintroduce the defect this module
    // exists to remove.
    expect(endpointUrl('https://api.openai.com/v1', '/embeddings').href).toBe('https://api.openai.com/v1/embeddings')
  })

  it('does not mutate the URL it was handed', () => {
    const base = new URL('https://api.openai.com/v1')
    endpointUrl(base, 'embeddings')
    expect(base.href).toBe('https://api.openai.com/v1')
  })
})
