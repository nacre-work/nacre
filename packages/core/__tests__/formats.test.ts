import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  BINARY_FORMATS,
  SIGNATURES,
  binaryFormat,
  binaryFormatForExtension,
  isBinaryFormat,
  signatureFamily,
} from '../formats.js'

/**
 * The table every binary upload is judged by. The edge, the worker and the
 * sidecar read it; the sidecar's own suite holds its Python copy against this
 * file. What is asked here is the half a copy cannot see: that the lookups
 * answer the way the edge's refusals assume.
 */
describe('the binary format table', () => {
  it('has one entry per content type and one per extension', () => {
    const types = BINARY_FORMATS.map((f) => f.contentType)
    const extensions = BINARY_FORMATS.map((f) => f.extension)
    expect(new Set(types).size).toBe(types.length)
    expect(new Set(extensions).size).toBe(extensions.length)
    expect(BINARY_FORMATS.length).toBeGreaterThan(1)
  })

  it('names every family a signature exists for, and no other', () => {
    for (const f of BINARY_FORMATS) expect(Object.keys(SIGNATURES)).toContain(f.family)
  })

  it('looks a declared type up without its parameters and case', () => {
    expect(binaryFormat('Application/PDF; charset=binary')?.format).toBe('pdf')
    expect(binaryFormat('application/vnd.oasis.opendocument.text')?.format).toBe('odt')
    expect(isBinaryFormat('text/plain')).toBe(false)
    expect(isBinaryFormat('application/octet-stream')).toBe(false)
  })

  it('accepts the alias IANA registered for RTF', () => {
    expect(binaryFormat('text/rtf')?.contentType).toBe('application/rtf')
  })

  it('recognises each family by its first bytes and nothing shorter', () => {
    expect(signatureFamily(new TextEncoder().encode('%PDF-1.4\n'))).toBe('pdf')
    expect(signatureFamily(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBe('zip')
    expect(signatureFamily(new TextEncoder().encode('{\\rtf1\\ansi Hello}'))).toBe('rtf')
    expect(signatureFamily(new TextEncoder().encode('%PD'))).toBeUndefined()
    expect(signatureFamily(new TextEncoder().encode('# a heading\n'))).toBeUndefined()
    expect(signatureFamily(new Uint8Array())).toBeUndefined()
  })

  it('is the list the schema admits, in the newest migration that spells it', () => {
    // `documents.content_type` carries a CHECK naming every accepted value —
    // 0020 said extending it is a migration, deliberately — so the schema is
    // the one copy of this table the code cannot read. The e2e found the gap
    // the first time a second row existed: the edge admitted a Word document
    // and the row insert refused it with a 500. The newest migration spelling
    // the constraint decides, which is what a forward-only tree needs.
    const dir = join(import.meta.dirname, '..', 'migrations')
    const spelled = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .flatMap((sql) => [...sql.matchAll(/content_type IN \(([\s\S]*?)\)\)/g)].map((m) => m[1] as string))
    expect(spelled.length).toBeGreaterThan(0)
    const latest = new Set([...(spelled.at(-1) as string).matchAll(/'([^']+)'/g)].map((m) => m[1]))
    expect(latest).toEqual(new Set(['text/plain', ...BINARY_FORMATS.map((f) => f.contentType)]))
  })

  it('maps a file extension to the type a client should declare', () => {
    expect(binaryFormatForExtension('.DOCX')?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(binaryFormatForExtension('md')).toBeUndefined()
    // Deliberately absent: the extractor does not sniff OLE, and nothing here
    // has watched one convert.
    expect(binaryFormatForExtension('doc')).toBeUndefined()
  })
})
