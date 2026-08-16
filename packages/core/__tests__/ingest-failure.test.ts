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

  /**
   * The rule that needed a dot held for `embedder.internal`, which is the
   * example in this module's own header, and for nothing this product ships:
   * every service name in `docker-compose.yml` and in the chart is a single
   * label. So the deployed configuration was the leaking one, and the example
   * that made it look fine was written here.
   *
   * Each case below is a string this stack actually produces. They are listed
   * rather than generated because the next person to touch those regexes needs
   * to see what they are for.
   */
  it.each([
    // The one that survived a redacted sentence: the URL goes, and undici then
    // appends its cause with the bare name in it.
    [
      'the cause undici appends',
      'the endpoint at http://embedder:8080/embeddings could not be reached: ' +
        'Error: getaddrinfo ENOTFOUND embedder',
      'embedder',
    ],
    ['a single-label host and port', 'connect ECONNREFUSED embedder:8080', 'embedder'],
    ['a single label in prose', 'could not reach qdrant', 'qdrant'],
    ['a kubernetes service', 'connection to embedder-svc refused', 'embedder-svc'],
    ['IPv6 in brackets', 'connect ECONNREFUSED [fd00:ec2::23]:8080', 'fd00'],
    ['IPv6 bare', 'no route to 2001:db8:85a3::8a2e:370:7334', 'db8'],
    // A leading `::` has no word boundary in front of it, which is how this
    // one survived the first attempt at the IPv6 rule.
    ['IPv6 loopback', 'connect ECONNREFUSED ::1:8080', '::1'],
    ['a credential inside a URL', 'postgres://user:hunter2@db.internal:5432/nacre', 'hunter2'],
  ])('takes the host out of %s', (_name, stored, secret) => {
    expect(withoutHosts(stored)).not.toContain(secret)
  })

  /**
   * The other direction, which is the whole reason the message is relayed
   * rather than replaced: what the sender came for has to survive.
   */
  it.each([
    ['the reason a PDF failed', 'this PDF is a scan; 4 of 4 pages need OCR', 'OCR'],
    ['the limit that was hit', '`inputs` must have less than 512 tokens. Given: 620', '512 tokens'],
    ['the status code', 'the embedding endpoint answered 413', 'answered 413'],
    // Three colons minimum in the IPv6 rule, so a clock is not an address.
    ['a clock', 'the worker gave up at 12:30:45 after 120 s', '12:30:45'],
    ['a version', 'pypdf 6.1.3 could not open the trailer', '6.1.3'],
  ])('keeps %s', (_name, stored, kept) => {
    expect(withoutHosts(stored)).toContain(kept)
  })

  /**
   * Written down as a test rather than only as a sentence in the header,
   * because it is a real cost and the next person to see it should find it
   * documented rather than think it is a bug.
   *
   * `contract.pdf` and `example.com` are the same shape. Nothing can separate
   * them, a list of extensions goes stale, and of the two ways to be wrong
   * only one of them leaks.
   */
  it('over-redacts a filename, which is the direction chosen', () => {
    expect(withoutHosts('could not extract text from contract.pdf')).toBe(
      'could not extract text from [host]',
    )
  })
})
