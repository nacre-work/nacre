import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

import { SignJWT } from 'jose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createApi, type AuditEvent, type IngestRequest } from '../index.js'

/**
 * Uploading a document as a form.
 *
 * Declared in `docs/openapi.yaml` since before there was a server, listed as
 * not built for just as long. These run the real handler over a real socket:
 * the parser has its own tests, and what could not be tested there is that the
 * endpoint reaches it, that the guards in front of it still apply, and that a
 * file the installation cannot read is refused before anything is queued.
 */

const SECRET = new TextEncoder().encode('a'.repeat(48))
const ORG = '11111111-1111-4111-8111-111111111111'
const B = 'BOUND-1'

let server: Server
let base: string
let queued: IngestRequest | undefined
const audited: AuditEvent[] = []

const part = (headers: string, content: string | Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(`--${B}\r\n${headers}\r\n\r\n`),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from('\r\n'),
  ])

const closing = (): Buffer => Buffer.from(`--${B}--\r\n`)
const field = (name: string, value: string) => part(`content-disposition: form-data; name="${name}"`, value)
const file = (filename: string, content: string | Buffer) =>
  part(`content-disposition: form-data; name="file"; filename="${filename}"`, content)
const typedFile = (filename: string, contentType: string, content: string | Buffer) =>
  part(
    `content-disposition: form-data; name="file"; filename="${filename}"\r\ncontent-type: ${contentType}`,
    content,
  )

// Not a real PDF — just the five magic bytes and some binary tail. The edge
// checks the magic and object storage and queues; extraction is the worker's
// and the sidecar's problem, each with their own tests.
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0xff, 0xfe, 0x00, 0x01])])

const token = async () =>
  new SignJWT({ org: ORG, principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('alice')
    .setIssuer('i')
    .setAudience('a')
    .setExpirationTime('5m')
    .sign(SECRET)

async function upload(body: Buffer, contentType = `multipart/form-data; boundary=${B}`) {
  const res = await fetch(`${base}/v1/documents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': contentType },
    body: new Uint8Array(body),
  })
  return { status: res.status, body: (await res.json().catch(() => null)) as { detail?: string } | null }
}

describe('multipart ingest', () => {
  beforeAll(async () => {
    server = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      ingest: {
        queue: async (_auth, request) => {
          queued = request
          return { documentId: 'd1', jobId: 'j1', unchanged: false }
        },
        remove: async () => false,
      },
      audit: { write: async (event) => void audited.push(event) },
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    queued = undefined
    audited.length = 0
  })

  it('accepts a text document and takes its name from the filename', async () => {
    // A form that uploaded `q3-plan.md` has already said what the document is
    // called; asking for the same string twice is how one document ends up
    // with two names.
    const res = await upload(Buffer.concat([field('layer', 'contracts'), file('q3-plan.md', '# Q3'), closing()]))

    expect(res.status).toBe(202)
    expect(queued).toMatchObject({ layer: 'contracts', externalId: 'q3-plan.md', content: '# Q3' })
  })

  it('lets an explicit external_id win over the filename', async () => {
    const res = await upload(
      Buffer.concat([
        field('layer', 'contracts'),
        field('external_id', 'notes/explicit.md'),
        file('ignored.md', 'body'),
        closing(),
      ]),
    )

    expect(res.status).toBe(202)
    expect(queued?.externalId).toBe('notes/explicit.md')
  })

  it('refuses a binary format outside the table, and queues nothing', async () => {
    // PDF is the one binary format in the table; everything else must still be
    // UTF-8 text. The sidecar used to decode with errors="replace", so a
    // binary file became replacement characters that were chunked, embedded,
    // stored as the body and reported as indexed. Refusing here means the
    // caller learns immediately instead of from a failed row minutes later,
    // if they looked.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const res = await upload(Buffer.concat([field('layer', 'contracts'), file('a.png', png), closing()]))

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/not UTF-8/)
    expect(res.body?.detail).toMatch(/extractor/)
    expect(queued).toBeUndefined()
  })

  it('refuses a declared PDF whose bytes lack the magic, naming the magic', async () => {
    // Both signals must agree. A declared type the bytes contradict is the
    // disagreement the multipart parser's strictness doctrine exists to
    // refuse, and sniffing alone would turn the declared type into decoration.
    const res = await upload(
      Buffer.concat([
        field('layer', 'contracts'),
        typedFile('a.pdf', 'application/pdf', 'just text, no magic'),
        closing(),
      ]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/%PDF-/)
    expect(queued).toBeUndefined()
  })

  it('refuses PDF magic without the declared type, naming the declaration', async () => {
    const res = await upload(
      Buffer.concat([field('layer', 'contracts'), file('a.pdf', PDF), closing()]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/application\/pdf/)
    expect(queued).toBeUndefined()
  })

  it('refuses a real PDF when the deployment has no object storage, naming NACRE_S3_*', async () => {
    // The bytes' only home is the bucket — source_ref is text and stays text.
    // This server was built without object storage, so the caller learns on
    // the request which variables turn binary ingest on.
    const res = await upload(
      Buffer.concat([
        field('layer', 'contracts'),
        typedFile('a.pdf', 'application/pdf', PDF),
        closing(),
      ]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/NACRE_S3_/)
    expect(queued).toBeUndefined()
  })

  it('T2 · still refuses an organization named in a multipart field', async () => {
    // The guard runs on the request body before routing. A multipart request
    // whose fields never became that body would be a second door into this
    // endpoint with the check on the other side of it.
    const res = await upload(
      Buffer.concat([
        field('layer', 'contracts'),
        field('org_id', '99999999-9999-4999-8999-999999999999'),
        file('x.md', 'hi'),
        closing(),
      ]),
    )

    expect(res.status).toBe(403)
    expect(queued).toBeUndefined()
    expect(audited.some((e) => e.action === 'tenant_override_attempt')).toBe(true)
  })

  it('reads metadata from a field carrying JSON text', async () => {
    // Every multipart field is a string, so this arrives as text where the
    // JSON body carries an object. The first version of the branch answered
    // 400 for a perfectly good field, found by running it.
    const res = await upload(
      Buffer.concat([
        field('layer', 'contracts'),
        field('metadata', '{"source":"notion","team":"legal"}'),
        file('m.md', 'x'),
        closing(),
      ]),
    )

    expect(res.status).toBe(202)
    expect(queued?.metadata).toEqual({ source: 'notion', team: 'legal' })
  })

  it('says which field is wrong when metadata is not JSON', async () => {
    const res = await upload(
      Buffer.concat([field('layer', 'c'), field('metadata', 'not json'), file('m.md', 'x'), closing()]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/metadata/)
  })

  it('refuses a second file rather than choosing one', async () => {
    const res = await upload(
      Buffer.concat([
        field('layer', 'c'),
        part('content-disposition: form-data; name="a"; filename="1.md"', 'x'),
        part('content-disposition: form-data; name="b"; filename="2.md"', 'y'),
        closing(),
      ]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/more than one file/)
  })

  it('refuses a file alongside content or url', async () => {
    const res = await upload(
      Buffer.concat([field('layer', 'c'), field('content', 'inline too'), file('x.md', 'y'), closing()]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/multipart upload carries the document/)
  })

  it('still requires a layer', async () => {
    const res = await upload(Buffer.concat([file('x.md', 'y'), closing()]))
    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/layer/)
  })

  it('names the multipart problem rather than blaming the bytes', async () => {
    const res = await upload(Buffer.from('there is no delimiter in this body'))
    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/multipart boundary/)
  })

  it('refuses a boundary outside the grammar', async () => {
    const res = await upload(Buffer.from('x'), `multipart/form-data; boundary=${'a'.repeat(71)}`)
    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/boundary/)
  })

  it('leaves the JSON path exactly as it was', async () => {
    const res = await fetch(`${base}/v1/documents`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ layer: 'contracts', external_id: 'j.md', content: 'json path' }),
    })

    expect(res.status).toBe(202)
    expect(queued).toMatchObject({ externalId: 'j.md', content: 'json path' })
  })
})

describe('multipart ingest with object storage', () => {
  // The same handler with `objectStorage: true` — what a deployment with
  // NACRE_S3_* configured looks like from where this test stands. The fake
  // ingest port stands in for the adapter; what is being pinned here is the
  // edge's decision and the exact shape it hands over: bytes untouched, the
  // content type it verified, and no `content` beside them.
  let s3Server: Server
  let s3Base: string

  beforeAll(async () => {
    s3Server = createApi({
      verify: { key: SECRET, issuer: 'i', audience: 'a' },
      documents: { read: async () => undefined },
      search: { search: async () => [] },
      objectStorage: true,
      ingest: {
        queue: async (_auth, request) => {
          queued = request
          return { documentId: 'd1', jobId: 'j1', unchanged: false }
        },
        remove: async () => false,
      },
      audit: { write: async (event) => void audited.push(event) },
    })
    await new Promise<void>((resolve) => s3Server.listen(0, '127.0.0.1', resolve))
    s3Base = `http://127.0.0.1:${(s3Server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => s3Server.close(() => resolve()))
  })

  async function uploadTo(body: Buffer) {
    const res = await fetch(`${s3Base}/v1/documents`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': `multipart/form-data; boundary=${B}`,
      },
      body: new Uint8Array(body),
    })
    return { status: res.status, body: (await res.json().catch(() => null)) as { detail?: string } | null }
  }

  it('accepts a PDF whose declared type and magic agree, and queues the bytes', async () => {
    const res = await uploadTo(
      Buffer.concat([
        field('layer', 'contracts'),
        typedFile('q3-report.pdf', 'application/pdf', PDF),
        closing(),
      ]),
    )

    expect(res.status).toBe(202)
    expect(queued).toMatchObject({
      layer: 'contracts',
      externalId: 'q3-report.pdf',
      contentType: 'application/pdf',
    })
    // The bytes reach the port untouched — no decode, no normalisation — and
    // `content` is absent: a binary document has no text at this stage, and a
    // field that sometimes held one would be an invitation to log it.
    expect(queued?.content).toBeUndefined()
    expect(Buffer.from(queued?.bytes ?? [])).toEqual(PDF)
  })

  it('still refuses the signals disagreeing, storage or not', async () => {
    // Object storage answers "where do the bytes live", never "do the type
    // and the magic agree" — the agreement check runs first.
    const res = await uploadTo(
      Buffer.concat([
        field('layer', 'contracts'),
        typedFile('a.pdf', 'application/pdf', 'no magic here'),
        closing(),
      ]),
    )

    expect(res.status).toBe(400)
    expect(res.body?.detail).toMatch(/%PDF-/)
  })

  it('a text file is still text, even with object storage on', async () => {
    const res = await uploadTo(
      Buffer.concat([field('layer', 'contracts'), file('notes.md', '# notes'), closing()]),
    )

    expect(res.status).toBe(202)
    expect(queued).toMatchObject({ externalId: 'notes.md', content: '# notes' })
    expect(queued?.bytes).toBeUndefined()
  })
})
