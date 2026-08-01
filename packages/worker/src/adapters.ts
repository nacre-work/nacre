import { QdrantClient } from '@qdrant/js-client-rest'
import { collectionName, withOrg } from '@nacre.work/core'
import type { Pool } from 'pg'

import type { DocumentStore, Parser, ParsedDocument, StoredDocument, VectorWriter } from './ingest.js'

/**
 * The adapters behind the ingest ports.
 *
 * Each one is thin on purpose: the ordering guarantees and the idempotency
 * live in `ingest.ts`, and a store that started making decisions of its own
 * would put them in two places.
 */

export class PostgresDocumentStore implements DocumentStore {
  constructor(private readonly pool: Pool, private readonly role?: string) {}

  private get scope() {
    return this.role === undefined ? {} : { role: this.role }
  }

  async find(orgId: string, layerId: string, externalId: string): Promise<StoredDocument | undefined> {
    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string; content_hash: string; chunk_count: number }>(
          `SELECT id, content_hash, chunk_count FROM documents
            WHERE org_id = $1 AND layer_id = $2 AND external_id = $3 AND deleted_at IS NULL`,
          [orgId, layerId, externalId],
        )
        const row = rows[0]
        return row === undefined
          ? undefined
          : { id: row.id, contentHash: row.content_hash, chunkCount: row.chunk_count }
      },
      this.scope,
    )
  }

  /**
   * Monotone on purpose: `<=` lets an equal version refresh the timestamp and
   * refuses an older one outright. Two ingests of the same document can finish
   * out of order, and without the guard the loser would walk `acl_version`
   * backwards and invent lag that nothing is actually behind on.
   *
   * `version` and `updated_at` are left alone. This records a fact about
   * tagging, not a change to the document, and bumping them would make every
   * retag look like an edit to anything watching for one.
   */
  async markTagged(orgId: string, documentId: string, aclVersion: number): Promise<void> {
    await withOrg(
      this.pool,
      orgId,
      async (client) => {
        await client.query(
          `UPDATE documents SET acl_version = $3, acl_tagged_at = now()
            WHERE org_id = $1 AND id = $2 AND acl_version <= $3`,
          [orgId, documentId, aclVersion],
        )
      },
      this.scope,
    )
  }

  /**
   * The document and all of its chunks, in one transaction.
   *
   * Replacing the chunks rather than diffing them: a partial replacement would
   * leave the old ordinals interleaved with the new, and the ordinal is what
   * ties a vector back to its text. `withOrg` already opens a transaction, so
   * the delete and the inserts commit together or not at all.
   */
  async upsert(input: {
    orgId: string
    layerId: string
    externalId: string
    title: string | undefined
    contentHash: string
    chunks: readonly { ordinal: number; text: string; pointId: string }[]
    metadata: Record<string, unknown>
  }): Promise<StoredDocument> {
    return withOrg(
      this.pool,
      input.orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO documents
             (org_id, layer_id, external_id, source_type, content_hash, title, metadata,
              status, chunk_count, updated_at)
           VALUES ($1,$2,$3,'inline',$4,$5,$6,'indexed',$7, now())
           ON CONFLICT (layer_id, external_id) DO UPDATE SET
             content_hash = EXCLUDED.content_hash,
             title        = EXCLUDED.title,
             metadata     = EXCLUDED.metadata,
             status       = 'indexed',
             chunk_count  = EXCLUDED.chunk_count,
             version      = documents.version + 1,
             updated_at   = now()
           RETURNING id`,
          [
            input.orgId,
            input.layerId,
            input.externalId,
            input.contentHash,
            input.title ?? null,
            JSON.stringify(input.metadata),
            input.chunks.length,
          ],
        )

        const id = rows[0]?.id
        if (id === undefined) throw new Error('the document upsert returned no id')

        await client.query('DELETE FROM chunks WHERE org_id = $1 AND document_id = $2', [input.orgId, id])

        for (const c of input.chunks) {
          await client.query(
            `INSERT INTO chunks (org_id, document_id, ordinal, text, point_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [input.orgId, id, c.ordinal, c.text, c.pointId],
          )
        }

        return { id, contentHash: input.contentHash, chunkCount: input.chunks.length }
      },
      this.scope,
    )
  }
}

export class QdrantVectorWriter implements VectorWriter {
  constructor(private readonly client: QdrantClient) {}

  async write(input: {
    orgId: string
    orgSlug: string
    layerId: string
    documentId: string
    vectorName: string
    points: readonly { pointId: string; ordinal: number; vector: readonly number[]; docId: string }[]
    aclTags: readonly string[]
    aclVersion: number
  }): Promise<void> {
    if (input.points.length === 0) return

    await this.client.upsert(collectionName(input.orgSlug), {
      wait: true,
      points: input.points.map((p) => ({
        id: p.pointId,
        vector: { [input.vectorName]: [...p.vector] },
        payload: {
          org_id: input.orgId,
          layer_id: input.layerId,
          doc_id: p.docId,
          chunk_id: p.pointId,
          ordinal: p.ordinal,
          // Never omitted, and never defaulted downstream. Invariant I5 asks
          // every query to filter on it, and a point without the field does not
          // match `deleted = false`.
          deleted: false,
          acl_tags: [...input.aclTags],
          acl_version: input.aclVersion,
        },
      })) as never,
    })
  }

  /**
   * Tombstone every point of a document.
   *
   * Sets `deleted` rather than removing the points: physical removal is a
   * background job, and between the two there is a window in which the document
   * is still in the index. Depending on the sweep's timing is how invariant I5
   * gets broken.
   */
  async tombstone(orgSlug: string, documentId: string): Promise<void> {
    await this.client.setPayload(collectionName(orgSlug), {
      wait: true,
      payload: { deleted: true },
      filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
    } as never)
  }
}

/**
 * The parser sidecar.
 *
 * It holds no credentials and reaches no database, so the only thing to be
 * careful about here is not trusting its output shape.
 */
export class HttpParser implements Parser {
  constructor(private readonly endpoint: string) {}

  async parse(source: { content?: string; url?: string }): Promise<ParsedDocument> {
    const response = await fetch(new URL('/parse', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(source),
    })

    if (!response.ok) {
      throw new Error(`the parser answered ${response.status}`)
    }

    const body = (await response.json()) as { text?: unknown; metadata?: unknown }
    if (typeof body.text !== 'string') {
      throw new Error('the parser returned no text')
    }

    return {
      text: body.text,
      metadata:
        typeof body.metadata === 'object' && body.metadata !== null
          ? (body.metadata as Record<string, unknown>)
          : {},
    }
  }
}
