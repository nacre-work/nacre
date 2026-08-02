import { describe, expect, it } from 'vitest'

import {
  MAX_PARTS,
  MAX_PART_HEADER_BYTES,
  MultipartError,
  multipartBoundary,
  parseMultipart,
} from '../multipart.js'

/**
 * A parser of attacker-supplied bytes on the request path.
 *
 * Most of these are refusals. That is the point: every bound in the module is
 * a refusal rather than a truncation, because a truncation is a silent
 * disagreement between what the caller sent and what got stored.
 */

const B = 'X-BOUNDARY-1'

function body(parts: readonly { headers: string; content: string | Buffer }[]): Uint8Array {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${B}\r\n${part.headers}\r\n\r\n`))
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${B}--\r\n`))
  return new Uint8Array(Buffer.concat(chunks))
}

const field = (name: string, value: string) => ({
  headers: `content-disposition: form-data; name="${name}"`,
  content: value,
})

const text = (p: { bytes: Uint8Array }) => Buffer.from(p.bytes).toString('utf8')

describe('multipartBoundary', () => {
  it('is undefined for JSON, which is how a caller says "not multipart"', () => {
    expect(multipartBoundary('application/json')).toBeUndefined()
    expect(multipartBoundary(undefined)).toBeUndefined()
  })

  it('reads the boundary, quoted or bare, and ignores case and spacing', () => {
    expect(multipartBoundary('multipart/form-data; boundary=abc')).toBe('abc')
    expect(multipartBoundary('Multipart/Form-Data;  BOUNDARY = "abc"')).toBe('abc')
  })

  it('refuses multipart with no boundary rather than guessing one', () => {
    expect(() => multipartBoundary('multipart/form-data')).toThrow(MultipartError)
  })

  it('refuses a boundary that is not one', () => {
    // The grammar is RFC 2046's, and it is what stops a boundary carrying a
    // newline, a regular expression, or a thousand characters.
    for (const bad of ['a\r\nb', 'a'.repeat(71), 'has<angle>', '']) {
      expect(() => multipartBoundary(`multipart/form-data; boundary="${bad}"`)).toThrow(MultipartError)
    }
  })

  it('accepts a boundary at exactly the length limit', () => {
    const seventy = 'a'.repeat(70)
    expect(multipartBoundary(`multipart/form-data; boundary=${seventy}`)).toBe(seventy)
  })
})

describe('parseMultipart', () => {
  it('reads names and contents', () => {
    const parts = parseMultipart(body([field('layer', 'contracts'), field('external_id', 'q3.md')]), B)
    expect(parts.map((p) => [p.name, text(p)])).toEqual([
      ['layer', 'contracts'],
      ['external_id', 'q3.md'],
    ])
  })

  it('does not append the delimiter CRLF to the content', () => {
    // Two bytes on the end of every upload, and on the end of every hash
    // computed over one.
    const parts = parseMultipart(body([field('a', 'exactly this')]), B)
    expect(text(parts[0] as { bytes: Uint8Array })).toBe('exactly this')
    expect(parts[0]?.bytes).toHaveLength(12)
  })

  it('keeps bytes intact, including ones that are not text', () => {
    const raw = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x25, 0x50, 0x44, 0x46])
    const parts = parseMultipart(
      body([{ headers: 'content-disposition: form-data; name="file"; filename="a.pdf"', content: raw }]),
      B,
    )
    expect(Buffer.from(parts[0]?.bytes as Uint8Array)).toEqual(raw)
  })

  it('reads filename and content-type when a part carries them', () => {
    const parts = parseMultipart(
      body([
        {
          headers:
            'content-disposition: form-data; name="file"; filename="q3 plan.md"\r\ncontent-type: text/markdown',
          content: '# Q3',
        },
      ]),
      B,
    )
    expect(parts[0]).toMatchObject({ name: 'file', filename: 'q3 plan.md', contentType: 'text/markdown' })
  })

  it('leaves filename absent rather than empty when there is none', () => {
    // Absent and empty are different claims, and a downstream `?? ''` on an
    // empty string is how a document ends up titled "".
    const parts = parseMultipart(body([field('layer', 'x')]), B)
    expect('filename' in (parts[0] as object)).toBe(false)
  })

  it('handles an empty part without losing the ones around it', () => {
    const parts = parseMultipart(body([field('a', ''), field('b', 'two')]), B)
    expect(parts.map((p) => [p.name, text(p)])).toEqual([
      ['a', ''],
      ['b', 'two'],
    ])
  })

  it('refuses a body with no boundary in it at all', () => {
    expect(() => parseMultipart(new TextEncoder().encode('{"json": true}'), B)).toThrow(MultipartError)
  })

  it('refuses a part with no content-disposition', () => {
    expect(() => parseMultipart(body([{ headers: 'content-type: text/plain', content: 'x' }]), B)).toThrow(
      /content-disposition/,
    )
  })

  it('refuses a part with no name', () => {
    expect(() => parseMultipart(body([{ headers: 'content-disposition: form-data', content: 'x' }]), B)).toThrow(
      /no name/,
    )
  })

  it('refuses a part that is never terminated', () => {
    const truncated = Buffer.concat([
      Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="a"\r\n\r\n`),
      Buffer.from('the rest of this never arrives'),
    ])
    expect(() => parseMultipart(new Uint8Array(truncated), B)).toThrow(/not terminated/)
  })

  it('refuses a part whose headers never end', () => {
    const noEnd = Buffer.concat([
      Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="a"\r\n`),
      Buffer.from('x'.repeat(100)),
    ])
    expect(() => parseMultipart(new Uint8Array(noEnd), B)).toThrow(MultipartError)
  })

  it('refuses an implausibly large header block rather than scanning it', () => {
    const huge = Buffer.concat([
      Buffer.from(`--${B}\r\ncontent-disposition: form-data; name="a"\r\nx: `),
      Buffer.from('y'.repeat(MAX_PART_HEADER_BYTES + 10)),
      Buffer.from('\r\n\r\ncontent\r\n'),
      Buffer.from(`--${B}--\r\n`),
    ])
    expect(() => parseMultipart(new Uint8Array(huge), B)).toThrow(/header block/)
  })

  it('refuses more parts than it will hold', () => {
    const many = Array.from({ length: MAX_PARTS + 2 }, (_, i) => field(`f${i}`, 'x'))
    expect(() => parseMultipart(body(many), B)).toThrow(/at most/)
  })

  it('accepts exactly the maximum number of parts', () => {
    const exact = Array.from({ length: MAX_PARTS }, (_, i) => field(`f${i}`, 'x'))
    expect(parseMultipart(body(exact), B)).toHaveLength(MAX_PARTS)
  })

  it('refuses a transfer encoding it will not decode', () => {
    // Legal and archaic. A base64 decoder here is another parser of hostile
    // input for a case no browser and no HTTP client produces.
    expect(() =>
      parseMultipart(
        body([
          {
            headers: 'content-disposition: form-data; name="a"\r\ncontent-transfer-encoding: base64',
            content: 'eA==',
          },
        ]),
        B,
      ),
    ).toThrow(/content-transfer-encoding/)
  })

  it('refuses a boundary followed by a bare LF', () => {
    // No conforming client sends this, so accepting it only widens what has to
    // be reasoned about.
    const lf = Buffer.from(`--${B}\ncontent-disposition: form-data; name="a"\r\n\r\nx\r\n--${B}--\r\n`)
    expect(() => parseMultipart(new Uint8Array(lf), B)).toThrow(/CRLF/)
  })

  it('ignores an epilogue after the closing delimiter', () => {
    const withEpilogue = Buffer.concat([
      Buffer.from(body([field('a', 'one')])),
      Buffer.from('anything at all down here'),
    ])
    expect(parseMultipart(new Uint8Array(withEpilogue), B).map((p) => p.name)).toEqual(['a'])
  })
})
