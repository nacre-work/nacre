import { describe, expect, it } from 'vitest'

import { chunk, DEFAULT_CHUNK_CONFIG } from '../chunk.js'
import { contentHash, ingest, type IngestPorts, type StoredDocument } from '../ingest.js'

describe('chunking', () => {
  it('splits on the largest boundary that fits', () => {
    const text = ['First paragraph.', 'Second paragraph.', 'Third paragraph.'].join('\n\n')
    const chunks = chunk(text, { size: 40, overlap: 0, strategy: 'recursive' })

    expect(chunks.length).toBeGreaterThan(1)
    // A chunk ends where the text does, not mid-word.
    for (const c of chunks) expect(c.text).not.toMatch(/\w-$/)
  })

  it('never emits a chunk larger than the limit, even with no boundary', () => {
    // One 5000-character token. The embedding endpoint has its own ceiling and
    // discovering it there is worse than cutting here.
    const chunks = chunk('x'.repeat(5000), { size: 100, overlap: 10, strategy: 'recursive' })
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(100)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('numbers chunks from zero, without gaps', () => {
    const chunks = chunk('word '.repeat(500), DEFAULT_CHUNK_CONFIG)
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i))
  })

  it('overlaps so a sentence spanning a boundary is searchable from both sides', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta iota kappa'
    const chunks = chunk(text, { size: 24, overlap: 10, strategy: 'recursive' })
    expect(chunks.length).toBeGreaterThan(1)

    const first = chunks[0]?.text ?? ''
    const second = chunks[1]?.text ?? ''
    const tail = first.slice(-6).trim()
    expect(second, 'the overlap should carry the tail forward').toContain(tail.split(' ')[0] ?? '')
  })

  it('refuses an overlap that would stop the loop advancing', () => {
    expect(() => chunk('anything', { size: 100, overlap: 100, strategy: 'recursive' })).toThrow(
      /must be smaller than size/,
    )
  })

  it('empty and whitespace-only input produce no chunks', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   \n\n  ')).toEqual([])
  })

  it('is deterministic', () => {
    // An unstable chunker makes every reindex look like a content change, and
    // the propagation metric stops meaning anything.
    const text = 'Sentence one. Sentence two. Sentence three. '.repeat(20)
    expect(chunk(text)).toEqual(chunk(text))
  })
})

function ports(
  overrides: Partial<IngestPorts> = {},
): IngestPorts & { written: unknown[]; embedded: number; tagged: { id: string; version: number }[] } {
  const state = { written: [] as unknown[], embedded: 0, tagged: [] as { id: string; version: number }[] }
  let counter = 0
  const stored = new Map<string, StoredDocument>()

  return {
    parser: { parse: async (s) => ({ text: s.content ?? `fetched:${s.url}`, metadata: {} }) },
    embedder: {
      embed: async (texts) => {
        state.embedded += texts.length
        return texts.map(() => [0.1, 0.2, 0.3, 0.4])
      },
    },
    documents: {
      find: async (org, layer, external) => stored.get(`${org}/${layer}/${external}`),
      markTagged: async (_org, id, version) => {
        state.tagged.push({ id, version })
      },
      upsert: async (input) => {
        const key = `${input.orgId}/${input.layerId}/${input.externalId}`
        const doc: StoredDocument = {
          id: stored.get(key)?.id ?? `doc-${++counter}`,
          contentHash: input.contentHash,
          chunkCount: input.chunks.length,
          indexed: true,
        }
        stored.set(key, doc)
        return doc
      },
    },
    vectors: {
      write: async (input) => {
        state.written.push(input)
      },
    },
    newId: () => `point-${++counter}`,
    ...overrides,
    ...state,
  } as IngestPorts & { written: unknown[]; embedded: number; tagged: { id: string; version: number }[] }
}

const request = {
  orgId: 'org-1',
  collection: 'org_acme',
  layerId: 'layer-1',
  vectorName: 'v_bge_m3_1024',
  externalId: 'handbook-2026',
  content: 'New engineers get repository access on their first day.',
  aclTags: ['h:aaaa', 'h:bbbb'],
  aclVersion: 42,
}

describe('ingest', () => {
  it('a repeat with identical content is a no-op', async () => {
    const p = ports()
    const first = await ingest(request, p)
    const embeddedAfterFirst = p.embedded

    const second = await ingest(request, p)

    expect(second.unchanged).toBe(true)
    expect(second.documentId).toBe(first.documentId)
    // The point of the idempotency key: every client that times out retries,
    // and re-embedding is what that costs if this is wrong.
    expect(p.embedded).toBe(embeddedAfterFirst)
  })

  it('a pending row with a matching hash is work to do, not work already done', async () => {
    // Exactly what the REST layer leaves behind: it inserts the document with
    // its content hash and status 'pending', and *that row is the work order*.
    //
    // Matching on the hash alone made the worker find the request it had just
    // been handed, call it unchanged, and index nothing — for every document,
    // in every deployment. The status stayed at 'parsing', /v1/jobs answered
    // `queued` forever, and Qdrant stayed empty. Nothing failed anywhere: the
    // worker logged `indexed` and moved on.
    const p = ports({
      documents: {
        find: async () => ({
          id: 'doc-1',
          contentHash: contentHash(request.content),
          chunkCount: 0,
          indexed: false,
        }),
        markTagged: async () => undefined,
        upsert: async (input) => ({
          id: 'doc-1',
          contentHash: input.contentHash,
          chunkCount: input.chunks.length,
          indexed: true,
        }),
      },
    })

    const result = await ingest(request, p)

    expect(result.unchanged).toBe(false)
    expect(result.chunkCount).toBeGreaterThan(0)
    expect(p.written, 'the vectors are the whole point of the job').toHaveLength(1)
  })

  it('changed content is reindexed under the same document id', async () => {
    const p = ports()
    const first = await ingest(request, p)
    const second = await ingest({ ...request, content: 'Something else entirely.' }, p)

    expect(second.unchanged).toBe(false)
    expect(second.documentId).toBe(first.documentId)
  })

  it('exactly one source is required', async () => {
    const p = ports()
    await expect(ingest({ ...request, url: 'https://x.test/a' }, p)).rejects.toThrow(/exactly one/)
    // exactOptionalPropertyTypes means "absent" and "present and undefined"
    // are different types, and the request type says absent. Build it that way
    // rather than casting the difference away.
    const { content: _content, ...withoutSource } = request
    void _content
    await expect(ingest(withoutSource, p)).rejects.toThrow(/exactly one/)
  })

  it('a short vector list is refused rather than written', async () => {
    const p = ports({
      embedder: { embed: async (texts) => texts.slice(1).map(() => [0, 0, 0, 0]) },
    })

    await expect(
      ingest({ ...request, content: 'a. '.repeat(2000) }, p),
    ).rejects.toThrow(/vectors for/)

    // Writing whatever came back would attach the wrong vector to the wrong
    // text: a retrieval defect with nothing failing anywhere.
    expect(p.written).toHaveLength(0)
  })

  it('acl tags and version reach the vector payload', async () => {
    const p = ports()
    await ingest(request, p)

    const write = p.written[0] as { aclTags: readonly string[]; aclVersion: number; orgId: string }
    expect(write.aclTags).toEqual(request.aclTags)
    expect(write.aclVersion).toBe(42)
    expect(write.orgId).toBe('org-1')
  })

  it('Postgres is written before the vector store', async () => {
    const order: string[] = []
    const p = ports()
    const wrapped: IngestPorts = {
      ...p,
      documents: {
        find: p.documents.find.bind(p.documents),
        markTagged: async (o, i, v) => {
          order.push('tagged')
          return p.documents.markTagged(o, i, v)
        },
        upsert: async (i) => {
          order.push('postgres')
          return p.documents.upsert(i)
        },
      },
      vectors: {
        write: async (i) => {
          order.push('vectors')
          return p.vectors.write(i)
        },
      },
    }

    await ingest(request, wrapped)

    // Vectors are rebuilt from Postgres and S3; the reverse does not hold. A
    // crash between the two must leave a document with no vectors — recoverable
    // by reindexing — rather than vectors with no document.
    //
    // `tagged` comes last for a different reason: it is a claim that the points
    // carry tags from this groups_version, and that claim is only true once the
    // vector write has returned.
    expect(order).toEqual(['postgres', 'vectors', 'tagged'])
  })

  it('a failed vector write leaves the document untagged', async () => {
    const p = ports()
    const wrapped: IngestPorts = {
      ...p,
      vectors: {
        write: async () => {
          throw new Error('qdrant is unreachable')
        },
      },
    }

    await expect(ingest(request, wrapped)).rejects.toThrow('qdrant is unreachable')

    // Tagged-but-not-written is the one combination that lies in the dangerous
    // direction: the lag gauge would report the document caught up while its
    // points still carry whatever grants they had. Untagged over-reports lag,
    // which is a false alarm and recoverable; the other way round is a leak
    // nothing is watching for.
    expect(p.tagged).toHaveLength(0)
  })

  it('an unchanged document is not marked as retagged', async () => {
    const p = ports()
    await ingest(request, p)
    p.tagged.length = 0

    // Same content, a newer groups_version. Nothing is rewritten, so the points
    // still carry the old tags — claiming otherwise would hide exactly the
    // window invariant I4 bounds.
    const result = await ingest({ ...request, aclVersion: 99 }, p)

    expect(result.unchanged).toBe(true)
    expect(p.tagged).toHaveLength(0)
  })

  it('a document is tagged at the version its points were written with', async () => {
    const p = ports()
    const result = await ingest(request, p)

    expect(p.tagged).toEqual([{ id: result.documentId, version: 42 }])
  })

  it('an empty document is recorded, so a retry does not reparse it forever', async () => {
    const p = ports({ parser: { parse: async () => ({ text: '   ', metadata: {} }) } })
    const result = await ingest(request, p)

    expect(result.chunkCount).toBe(0)
    expect(result.documentId).toBeTruthy()

    // The vector store is still called, and with no points — which is not the
    // same as not calling it. A document that had chunks and now parses to none
    // keeps every point from its last pass otherwise, and those are the worst
    // kind: no text left anywhere, still holding places in results.
    expect(p.written).toHaveLength(1)
    expect((p.written[0] as { points: unknown[] }).points).toHaveLength(0)

    // No points means no stale tag to leak through, so it is current by
    // construction. Left untagged it would sit behind the version forever and
    // hold the lag gauge at the age of the oldest empty file — a permanent
    // false alarm on the one metric that must stay believable.
    expect(p.tagged).toEqual([{ id: result.documentId, version: 42 }])
  })

  it('the content hash covers the parsed text, not the request', async () => {
    // Two requests differing only in title must not be treated as different
    // content, and a URL whose contents changed must be.
    expect(contentHash('same')).toBe(contentHash('same'))
    expect(contentHash('a')).not.toBe(contentHash('b'))

    const p = ports()
    await ingest(request, p)
    const again = await ingest({ ...request, title: 'A different title' }, p)
    expect(again.unchanged).toBe(true)
  })
})
