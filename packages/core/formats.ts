/**
 * The binary document formats this product accepts, in one place.
 *
 * Three processes have to agree on what a binary upload may be: the API edge
 * decides whether to accept a file part, the worker decides whether to hand a
 * stored object to the parser as bytes or to decode it as text, and the parser
 * sidecar decides which extractor reads it. Until this table there was one
 * format and the agreement was the string `application/pdf` written in each of
 * them — which held exactly as long as there was one format.
 *
 * An entry is a declared media type, the signature its bytes must begin with,
 * and the name the sidecar converts it under. **Both signals must agree**: the
 * part declares the type *and* the bytes carry the family's signature. Either
 * alone is a refusal that names the other. A declared type the bytes
 * contradict is the disagreement the multipart parser's strictness exists to
 * refuse, and sniffing alone would turn the declared type into decoration.
 *
 * A signature identifies a *family* and not a format: every Office and
 * OpenDocument file is a ZIP archive and begins with the same four bytes, so
 * the edge can say "this is a ZIP-based document" and not which one. Which one
 * is the declaration's job, and the sidecar — which names the format to the
 * extractor rather than letting it guess — refuses a `.docx` declaration over
 * an `.odt` archive by its missing parts. That is the second half of the
 * agreement, enforced where the bytes are actually opened.
 *
 * What is deliberately not here: the legacy OLE formats (`.doc`, `.xls`,
 * `.ppt`). The extractor's own sniffer does not recognise their signature, and
 * no fixture exists here to measure a conversion against, so admitting them
 * would be admitting a format nobody has watched work. CSV is text and stays
 * text — it is already accepted as `text/plain` and indexed as what it is.
 *
 * The sidecar is Python and carries the same table; its suite holds the two
 * against each other by reading this file, which is why every entry below is
 * one line in one shape.
 */

export type SignatureFamily = 'pdf' | 'zip' | 'rtf'

export interface BinaryFormat {
  /** The declared media type, lower case, with no parameters. */
  readonly contentType: string
  /** The name the sidecar converts it as — the extractor's own vocabulary. */
  readonly format: string
  /** Whose signature the bytes must carry. */
  readonly family: SignatureFamily
  /** The conventional extension, for a client naming a file. */
  readonly extension: string
}

// One entry per line, in this shape: the sidecar's suite parses these lines.
export const BINARY_FORMATS: readonly BinaryFormat[] = [
  { contentType: 'application/pdf', format: 'pdf', family: 'pdf', extension: 'pdf' },
  { contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', format: 'docx', family: 'zip', extension: 'docx' },
  { contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', format: 'pptx', family: 'zip', extension: 'pptx' },
  { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', format: 'xlsx', family: 'zip', extension: 'xlsx' },
  { contentType: 'application/vnd.oasis.opendocument.text', format: 'odt', family: 'zip', extension: 'odt' },
  { contentType: 'application/vnd.oasis.opendocument.presentation', format: 'odp', family: 'zip', extension: 'odp' },
  { contentType: 'application/vnd.oasis.opendocument.spreadsheet', format: 'ods', family: 'zip', extension: 'ods' },
  { contentType: 'application/epub+zip', format: 'epub', family: 'zip', extension: 'epub' },
  { contentType: 'application/rtf', format: 'rtf', family: 'rtf', extension: 'rtf' },
]

/**
 * A second spelling a client may legitimately send, mapped to the canonical
 * one. `text/rtf` is what IANA registered first and what some mailers still
 * write; it is the same format.
 */
const ALIASES: Readonly<Record<string, string>> = {
  'text/rtf': 'application/rtf',
}

/** The bytes a family begins with. */
export const SIGNATURES: Readonly<Record<SignatureFamily, Uint8Array>> = {
  pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), // %PDF-
  zip: new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
  rtf: new Uint8Array([0x7b, 0x5c, 0x72, 0x74, 0x66]), // {\rtf
}

/** What a family's signature is called when a refusal names it. */
export const SIGNATURE_NAMES: Readonly<Record<SignatureFamily, string>> = {
  pdf: '%PDF- magic',
  zip: 'ZIP signature of an Office or OpenDocument file',
  rtf: '{\\rtf header',
}

/** The entry a declared type names, or `undefined` for a type outside the table. */
export function binaryFormat(declared: string): BinaryFormat | undefined {
  const type = declared.split(';')[0]?.trim().toLowerCase() ?? ''
  const canonical = ALIASES[type] ?? type
  return BINARY_FORMATS.find((f) => f.contentType === canonical)
}

/** Whether `declared` names a binary format the product accepts. */
export function isBinaryFormat(declared: string): boolean {
  return binaryFormat(declared) !== undefined
}

/** Which family's signature the bytes begin with, if any. */
export function signatureFamily(bytes: Uint8Array): SignatureFamily | undefined {
  for (const [family, signature] of Object.entries(SIGNATURES) as [SignatureFamily, Uint8Array][]) {
    if (bytes.length >= signature.length && signature.every((b, i) => bytes[i] === b)) return family
  }
  return undefined
}

/** The entry for a file name's extension, for a client that has a path and no declared type. */
export function binaryFormatForExtension(extension: string): BinaryFormat | undefined {
  const ext = extension.replace(/^\./, '').toLowerCase()
  return BINARY_FORMATS.find((f) => f.extension === ext)
}
