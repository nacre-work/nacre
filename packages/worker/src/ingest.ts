import { createHash } from 'node:crypto'

import { chunk, DEFAULT_CHUNK_CONFIG, type ChunkConfig } from './chunk.js'

/**
 * The indexing pipeline: parse, chunk, embed, write.
 *
 * Everything external is a port. The parser is a Python sidecar, the embedder
 * is somebody's endpoint, and neither belongs inside the logic that decides
 * what gets written — which is the part with the invariants on it.
 */

export interface ParsedDocument {
  readonly text: string
  readonly metadata: Record<string, unknown>
}

export interface Parser {
  parse(source: { content?: string; url?: string }): Promise<ParsedDocument>
}

export interface Embedder {
  /** One vector per input, in order. */
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

export interface StoredDocument {
  readonly id: string
  readonly contentHash: string
  readonly chunkCount: number
  /**
   * Whether this content was actually indexed, as opposed to merely recorded.
   *
   * The API writes the row — content hash included — before the worker ever
   * sees it, so the hash matching proves nothing on its own. Without this the
   * worker finds the work order it was handed, mistakes it for a completed
   * job, and returns `unchanged` having indexed nothing.
   */
  readonly indexed: boolean
}

export interface DocumentStore {
  /** The existing document for this idempotency key, if any. */
  find(orgId: string, layerId: string, externalId: string): Promise<StoredDocument | undefined>
  /**
   * Record which `groups_version` this document's vector tags were built from.
   *
   * Separate from `upsert` because it happens at a different moment — after the
   * vectors are written, not with the row — and the difference is the whole
   * point. See the call site.
   */
  markTagged(orgId: string, documentId: string, aclVersion: number): Promise<void>
  upsert(input: {
    orgId: string
    layerId: string
    externalId: string
    title: string | undefined
    contentHash: string
    chunks: readonly { ordinal: number; text: string; pointId: string }[]
    metadata: Record<string, unknown>
  }): Promise<StoredDocument>
}

export interface VectorWriter {
  /**
   * Write a document's points, and remove the ones it no longer has.
   *
   * Both halves, because indexing is a **replacement** and not an append. Every
   * pass mints fresh point ids, so an upsert on its own overwrites nothing: the
   * previous pass's points stay in the index with `deleted = false`, match the
   * permission filter, and occupy slots in every `top_k` — while hydration
   * silently drops them, because their chunk rows are gone. A search asking for
   * ten results starts returning six, permanently, and nothing fails.
   *
   * `points` empty is meaningful and not a no-op: it means this document has no
   * points at all now, so all of them go.
   */
  write(input: {
    orgId: string
    orgSlug: string
    layerId: string
    documentId: string
    vectorName: string
    points: readonly {
      pointId: string
      ordinal: number
      vector: readonly number[]
      docId: string
    }[]
    aclTags: readonly string[]
    aclVersion: number
  }): Promise<void>
}

export interface IngestRequest {
  readonly orgId: string
  readonly orgSlug: string
  readonly layerId: string
  readonly vectorName: string
  readonly externalId: string
  readonly title?: string
  readonly content?: string
  readonly url?: string
  readonly aclTags: readonly string[]
  readonly aclVersion: number
  readonly chunkConfig?: ChunkConfig
}

export interface IngestResult {
  readonly documentId: string
  readonly chunkCount: number
  /** True when the content was already indexed and nothing was written. */
  readonly unchanged: boolean
}

export interface IngestPorts {
  readonly parser: Parser
  readonly embedder: Embedder
  readonly documents: DocumentStore
  readonly vectors: VectorWriter
  /** Injected so tests are deterministic and a retry reuses the same ids. */
  readonly newId: () => string
}

export function contentHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/**
 * Index one document.
 *
 * Idempotent on `(layer, external_id)` plus `content_hash`: a repeat with
 * identical content is a no-op that returns the existing id. That is not a
 * nicety — ingest is retried by every client that ever times out, and without
 * it a flaky network turns into duplicate documents and a bill for re-embedding
 * them.
 *
 * Exactly one source. Accepting both `content` and `url` would mean choosing
 * silently, and the choice would differ from whatever the caller assumed.
 */
export async function ingest(request: IngestRequest, ports: IngestPorts): Promise<IngestResult> {
  const sources = [request.content, request.url].filter((s) => s !== undefined)
  if (sources.length !== 1) {
    throw new Error('exactly one of content or url is required')
  }

  const parsed = await ports.parser.parse(
    request.content !== undefined ? { content: request.content } : { url: request.url as string },
  )

  const hash = contentHash(parsed.text)
  const existing = await ports.documents.find(request.orgId, request.layerId, request.externalId)
  // `indexed` and not just the hash. The REST layer inserts the row with its
  // content hash and status 'pending' — that row *is* the work order — so a
  // hash match on its own means "somebody asked for this", not "this is
  // already in the index". Checking only the hash made the worker claim every
  // document, declare it unchanged, and index nothing at all, while the status
  // stayed at 'parsing' and the API kept answering `queued` forever.
  if (existing !== undefined && existing.contentHash === hash && existing.indexed) {
    // Deliberately not marked as tagged. Nothing was rewritten, so the points
    // still carry whichever acl_version they were written at; claiming the
    // current one would report a document as caught up while a revoked grant is
    // still on its vectors. Re-tagging unchanged content is the recomputation
    // job's work, and until that exists the lag gauge is supposed to say so.
    return { documentId: existing.id, chunkCount: existing.chunkCount, unchanged: true }
  }

  const chunks = chunk(parsed.text, request.chunkConfig ?? DEFAULT_CHUNK_CONFIG)
  if (chunks.length === 0) {
    // Nothing to index. Recording the document anyway keeps the idempotency key
    // meaningful — a retry must not re-parse an empty file forever.
    const stored = await ports.documents.upsert({
      orgId: request.orgId,
      layerId: request.layerId,
      externalId: request.externalId,
      title: request.title,
      contentHash: hash,
      chunks: [],
      metadata: parsed.metadata,
    })
    // Not a no-op. A document that had chunks and now parses to none — an
    // emptied file, a parser that stopped recognising a format — keeps every
    // point from its last pass unless they are swept here, and those are the
    // worst kind: a document with no text left, still holding places in results.
    await ports.vectors.write({
      orgId: request.orgId,
      orgSlug: request.orgSlug,
      layerId: request.layerId,
      documentId: stored.id,
      vectorName: request.vectorName,
      points: [],
      aclTags: request.aclTags,
      aclVersion: request.aclVersion,
    })

    // A document with no chunks has no points, so there is no stale tag it can
    // leak through and it is trivially current. Leaving it behind the version
    // forever would pin the lag gauge at the age of the oldest empty file and
    // teach everyone to ignore the one alert that says a revocation is late.
    await ports.documents.markTagged(request.orgId, stored.id, request.aclVersion)
    return { documentId: stored.id, chunkCount: 0, unchanged: false }
  }

  const vectors = await ports.embedder.embed(chunks.map((c) => c.text))
  if (vectors.length !== chunks.length) {
    // A mismatch means the embedder dropped or reordered something, and writing
    // whatever came back would attach the wrong vector to the wrong text — a
    // silent retrieval defect with no failing test anywhere.
    throw new Error(`embedder returned ${vectors.length} vectors for ${chunks.length} chunks`)
  }

  const withPoints = chunks.map((c) => ({ ...c, pointId: ports.newId() }))

  // Postgres first. It holds the text and is what vectors are rebuilt from when
  // the two disagree; the reverse does not hold. A crash between the two leaves
  // a document with no vectors, which is recoverable by reindexing — the other
  // order leaves vectors with no document, which is a leak waiting for a
  // collision on the id.
  const stored = await ports.documents.upsert({
    orgId: request.orgId,
    layerId: request.layerId,
    externalId: request.externalId,
    title: request.title,
    contentHash: hash,
    chunks: withPoints,
    metadata: parsed.metadata,
  })

  await ports.vectors.write({
    orgId: request.orgId,
    orgSlug: request.orgSlug,
    layerId: request.layerId,
    documentId: stored.id,
    vectorName: request.vectorName,
    points: withPoints.map((c, i) => ({
      pointId: c.pointId,
      ordinal: c.ordinal,
      vector: vectors[i] as readonly number[],
      docId: stored.id,
    })),
    aclTags: request.aclTags,
    aclVersion: request.aclVersion,
  })

  // After the vector write, never before. The column is a claim that the points
  // carry tags built from this groups_version, and the only moment that claim is
  // true is once the write has returned. Marking first and then failing would
  // leave a document reporting itself caught up while its points still carry a
  // revoked grant — the exact state invariant I4 forbids, recorded as healthy.
  await ports.documents.markTagged(request.orgId, stored.id, request.aclVersion)

  return { documentId: stored.id, chunkCount: withPoints.length, unchanged: false }
}
