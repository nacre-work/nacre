import { describe, expect, it } from 'vitest'

import { classifyIngestFailure, withoutHosts } from '../index.js'

describe('classifyIngestFailure', () => {
  it('recognises the refusal this repository has actually seen', () => {
    // Verbatim from a real TEI, through the worker, into `documents.error`.
    const stored =
      'Error: the embedding endpoint at http://127.0.0.1:8100/embeddings answered 413: ' +
      'Input validation error: `inputs` must have less than 512 tokens. Given: 620'
    expect(classifyIngestFailure(stored).reason).toBe('too_long')
  })

  it('separates a service being down from a document being wrong', () => {
    expect(classifyIngestFailure('TypeError: fetch failed').reason).toBe('unavailable')
    expect(classifyIngestFailure('connect ECONNREFUSED 10.0.0.4:8080').reason).toBe('unavailable')
    expect(classifyIngestFailure('the parser could not extract text').reason).toBe('unreadable')
  })

  it('is honest rather than clever about what it does not recognise', () => {
    // `internal` says "an operator has to look", which is true. Guessing here
    // would send a caller to re-send a document that will never index.
    expect(classifyIngestFailure('something nobody has seen before').reason).toBe('internal')
  })

  /**
   * The property the whole module exists for. The caller may be a third party
   * acting through a delegation somebody granted; what they get must not be a
   * map of the installation.
   */
  it('never repeats a host, a URL or the stored text', () => {
    const stored =
      'Error: the embedding endpoint at http://embedder.internal:8080/embeddings answered 413'
    const { message } = classifyIngestFailure(stored)
    expect(message).not.toContain('embedder.internal')
    expect(message).not.toContain('8080')
    // The wording survives; only the infrastructure in it is gone.
    expect(message).toContain('answered 413')
    expect(message).toContain('[endpoint]')
  })

  /**
   * The regression the compose smoke caught. A canned sentence per reason threw
   * away the only detail that made some failures actionable — a scan needs OCR,
   * and "could not be read" sends an operator hunting for a corrupt file.
   */
  it('keeps the wording that says what to do about it', () => {
    const scan = 'ParseError: this PDF is a scan; 4 of 4 pages need OCR'
    const { reason, message } = classifyIngestFailure(scan)
    expect(reason).toBe('unreadable')
    expect(message).toContain('scan')
    expect(message).toContain('OCR')
  })
})

describe('withoutHosts', () => {
  it('removes what an endpoint error carries', () => {
    expect(withoutHosts('answered 413 from http://embedder:8080/embeddings')).toBe(
      'answered 413 from [endpoint]',
    )
    expect(withoutHosts('connect ECONNREFUSED 10.0.0.4:8080')).toBe('connect ECONNREFUSED [host]')
    expect(withoutHosts('could not reach parser.svc.cluster.local')).toBe('could not reach [host]')
  })
})
