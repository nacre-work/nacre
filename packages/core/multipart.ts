/**
 * `multipart/form-data`, parsed strictly.
 *
 * `POST /v1/documents` has declared this in `docs/openapi.yaml` since before
 * there was a server, and `docs/api.md` has listed it as not built for just as
 * long. This is it.
 *
 * ─── why by hand, and what that obliges ───
 *
 * This parses attacker-supplied bytes. The usual answer is a library, and the
 * usual argument against one applies here more than anywhere else in this
 * repository: the request path of a document index is exactly where a
 * dependency's parser bugs become yours. The parser sidecar makes the same
 * choice for the same reason and says so.
 *
 * The obligation that comes with it is to be strict rather than clever. Every
 * bound below is a refusal, not a truncation, and none of them is
 * configurable — a caller who trips one gets `400` and a reason:
 *
 * - the boundary must match RFC 2046's grammar, so it cannot carry a regular
 *   expression, a newline, or a thousand characters;
 * - a bounded number of parts, so a body of ten thousand empty ones is a
 *   refusal rather than ten thousand allocations;
 * - a bounded header block per part, so a part that is all headers cannot be
 *   scanned forever;
 * - `filename` is read and never used to build anything. Object keys come from
 *   `documentKey`, which hashes the external id; a filename reaches a database
 *   column and nothing else.
 *
 * What it deliberately does not do: nested multipart, `Content-Transfer-
 * Encoding`, and charsets other than UTF-8. Each is a real part of the
 * specification and none is something a document upload needs, so each is a
 * refusal rather than a branch.
 */

export class MultipartError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartError'
  }
}

export interface MultipartPart {
  readonly name: string
  /** Present when the part carried one. Never used to build a path or a key. */
  readonly filename?: string
  readonly contentType?: string
  readonly bytes: Uint8Array
}

/** Enough for a document plus its fields, and small enough to bound the work. */
export const MAX_PARTS = 16
/** A part's headers. Anything longer is not a header block, it is an attack. */
export const MAX_PART_HEADER_BYTES = 8 * 1024

/** RFC 2046: 1-70 characters from a fixed set, not ending in a space. */
const BOUNDARY = /^[A-Za-z0-9'()+_,\-./:=?]([A-Za-z0-9'()+_,\-./:=? ]{0,68}[A-Za-z0-9'()+_,\-./:=?])?$/

/**
 * The boundary from a `content-type`, or `undefined` when this is not
 * multipart at all — which is not an error, it is how a caller says "JSON".
 */
export function multipartBoundary(contentType: string | undefined): string | undefined {
  if (contentType === undefined) return undefined
  const [type, ...rest] = contentType.split(';')
  if ((type ?? '').trim().toLowerCase() !== 'multipart/form-data') return undefined

  for (const parameter of rest) {
    const eq = parameter.indexOf('=')
    if (eq === -1) continue
    if (parameter.slice(0, eq).trim().toLowerCase() !== 'boundary') continue

    let value = parameter.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1)
    }
    if (!BOUNDARY.test(value)) {
      throw new MultipartError('the multipart boundary is not a valid one')
    }
    return value
  }

  throw new MultipartError('multipart/form-data with no boundary parameter')
}

const CRLF = Buffer.from('\r\n')
const DOUBLE_CRLF = Buffer.from('\r\n\r\n')

/** `name="x"; filename="y"` — one parameter, unescaped the way browsers send it. */
function parameter(header: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${key}\\s*=\\s*("([^"]*)"|[^;]*)`, 'i').exec(header)
  if (match === null) return undefined
  const value = match[2] ?? match[1] ?? ''
  return value.trim()
}

export function parseMultipart(body: Uint8Array, boundary: string): readonly MultipartPart[] {
  const buffer = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const delimiter = Buffer.from(`--${boundary}`)

  let cursor = buffer.indexOf(delimiter)
  if (cursor === -1) throw new MultipartError('the body contains no multipart boundary')

  const parts: MultipartPart[] = []

  while (cursor !== -1) {
    let start = cursor + delimiter.length

    // `--boundary--` closes the body. Anything after it is epilogue and
    // ignored, which is what the specification says and what every client does.
    if (buffer.slice(start, start + 2).toString() === '--') break

    // The delimiter is followed by CRLF. Tolerating a bare LF here would mean
    // accepting a body no conforming client sends, so it does not.
    if (!buffer.slice(start, start + 2).equals(CRLF)) {
      throw new MultipartError('a multipart boundary is not followed by CRLF')
    }
    start += 2

    const headerEnd = buffer.indexOf(DOUBLE_CRLF, start)
    if (headerEnd === -1) throw new MultipartError('a multipart part has no header block')
    if (headerEnd - start > MAX_PART_HEADER_BYTES) {
      throw new MultipartError('a multipart part has an implausibly large header block')
    }

    const headers = buffer.slice(start, headerEnd).toString('utf8')
    const bodyStart = headerEnd + DOUBLE_CRLF.length

    const next = buffer.indexOf(delimiter, bodyStart)
    if (next === -1) throw new MultipartError('a multipart part is not terminated')

    // The CRLF immediately before the next delimiter belongs to the delimiter,
    // not to the content. Keeping it appends two bytes to every uploaded file.
    const end = next >= 2 && buffer.slice(next - 2, next).equals(CRLF) ? next - 2 : next

    let disposition: string | undefined
    let contentType: string | undefined
    for (const line of headers.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim().toLowerCase()
      const value = line.slice(colon + 1).trim()
      if (key === 'content-disposition') disposition = value
      else if (key === 'content-type') contentType = value
      else if (key === 'content-transfer-encoding' && value.toLowerCase() !== 'binary') {
        // Refused rather than decoded. base64 here is legal and archaic, and a
        // decoder is another parser of hostile input for a case no browser and
        // no HTTP client produces.
        throw new MultipartError(`content-transfer-encoding ${value} is not supported`)
      }
    }

    if (disposition === undefined) throw new MultipartError('a multipart part has no content-disposition')
    const name = parameter(disposition, 'name')
    if (name === undefined || name === '') {
      throw new MultipartError('a multipart part has no name')
    }

    const filename = parameter(disposition, 'filename')
    parts.push({
      name,
      ...(filename === undefined || filename === '' ? {} : { filename }),
      ...(contentType === undefined ? {} : { contentType }),
      bytes: new Uint8Array(buffer.subarray(bodyStart, end)),
    })

    if (parts.length > MAX_PARTS) {
      throw new MultipartError(`a multipart body may carry at most ${MAX_PARTS} parts`)
    }

    cursor = next
  }

  if (parts.length === 0) throw new MultipartError('the multipart body carries no parts')
  return parts
}
