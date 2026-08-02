import { QdrantClient } from '@qdrant/js-client-rest'
import { acrossOrganizations, aclTags, collectionName, loadGroupsVersion, withOrg } from '@nacre.work/core'
import type { PrincipalRef } from '@nacre.work/core'
import type { Pool } from 'pg'

import type { DocumentStore, Parser, ParsedDocument, StoredDocument, VectorWriter } from './ingest.js'
import type { StaleDocument } from './retag.js'
import type { PurgeTarget } from './collect.js'
import type { StrandedDocument } from './reap.js'

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
        const { rows } = await client.query<{
          id: string
          content_hash: string
          chunk_count: number
          status: string
        }>(
          `SELECT id, content_hash, chunk_count, status FROM documents
            WHERE org_id = $1 AND layer_id = $2 AND external_id = $3 AND deleted_at IS NULL`,
          [orgId, layerId, externalId],
        )
        const row = rows[0]
        return row === undefined
          ? undefined
          : {
              id: row.id,
              contentHash: row.content_hash,
              chunkCount: row.chunk_count,
              // Only 'indexed' counts. Every other status — pending, parsing,
              // embedding, failed — describes a document that still has work
              // outstanding, and treating any of them as done strands it there.
              indexed: row.status === 'indexed',
            }
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
   * Record that the vectors are physically gone.
   *
   * Only ever set once — the guard is not defensive, it is what keeps a
   * document out of the sweep queue after the first success. `deleted_at` is
   * left alone: when the tombstone happened and when the space came back are
   * different facts, and an operator investigating a delete wants both.
   */
  async markPurged(orgId: string, documentId: string): Promise<void> {
    await withOrg(
      this.pool,
      orgId,
      async (client) => {
        await client.query(
          `UPDATE documents SET vectors_purged_at = now()
            WHERE org_id = $1 AND id = $2 AND vectors_purged_at IS NULL`,
          [orgId, documentId],
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
             -- COALESCE, not EXCLUDED.title. The API stores the title the
             -- caller sent; the parser derives one only for formats that carry
             -- it, and returns null otherwise. Overwriting meant a document
             -- ingested with a title lost it the moment the worker finished —
             -- visible in every listing, and looking like the API had dropped
             -- the field.
             title        = COALESCE(EXCLUDED.title, documents.title),
             metadata     = EXCLUDED.metadata,
             status       = 'indexed',
             chunk_count  = EXCLUDED.chunk_count,
             version      = documents.version + 1,
             -- The lease ends here. Leaving it set would make a document that
             -- indexed correctly look abandoned to the reaper, which would put
             -- it back in the queue and index it again on a timer.
             claimed_at   = NULL,
             attempts     = 0,
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

        // The upsert writes status = 'indexed', so the row it returns is.
        return { id, contentHash: input.contentHash, chunkCount: input.chunks.length, indexed: true }
      },
      this.scope,
    )
  }
}

/**
 * The Qdrant client reports every rejection as `Bad Request` and puts the
 * reason in `.data`, which is nowhere near the stack trace. A worker log
 * reading `indexing failed: Error: Bad Request` says a write was refused and
 * nothing about why — a wrong vector name, a payload type the index disagrees
 * with, and a malformed id all look identical.
 */
function explain(cause: unknown): string {
  const data = (cause as { data?: unknown } | null)?.data
  return data === undefined ? String(cause) : `${String(cause)} — ${JSON.stringify(data)}`
}

/**
 * Whether Qdrant is saying the collection is not there.
 *
 * It matters only on the purge path, and only because the sweep is ordered
 * oldest-first with a small batch: a target that can never succeed sits at the
 * front of that queue forever and starves everything behind it. An organization
 * whose collection was dropped — offboarded, or a development database — turns
 * garbage collection off for every other tenant.
 */
function collectionMissing(cause: unknown): boolean {
  return /doesn't exist|does not exist|Not found: Collection/i.test(explain(cause))
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
    try {
      if (input.points.length > 0) await this.upsertPoints(input)
    } catch (cause) {
      throw new Error(`upsert into ${collectionName(input.orgSlug)} rejected: ${explain(cause)}`, { cause })
    }

    // After the upsert, never before, for the same reason the delete path is
    // ordered the other way round: sweeping first leaves the document
    // unsearchable for the length of an embedding round trip, and a reader who
    // hits that window sees an empty result rather than a stale one. Sweeping
    // second means the worst case is the state that existed before this line —
    // points nobody joins to — rather than a hole in the index.
    try {
      await this.sweep(input.orgSlug, input.documentId, input.points.map((p) => p.pointId))
    } catch (cause) {
      throw new Error(`sweep of ${collectionName(input.orgSlug)} rejected: ${explain(cause)}`, { cause })
    }
  }

  /**
   * Remove every point of this document that is not in the set just written.
   *
   * Each indexing pass mints fresh point ids, so `upsert` overwrites nothing —
   * without this, the previous pass's points stay behind with `deleted = false`
   * and match every query the document matches. They cannot leak text, because
   * hydration joins on a chunk row that no longer exists; what they do is take
   * places in `top_k` and hand them to nobody, so a search for ten results
   * quietly returns six.
   *
   * A filtered delete rather than a delete by id: the set to remove is
   * "whatever else is there", which is only knowable to the index.
   */
  private async sweep(orgSlug: string, documentId: string, keep: readonly string[]): Promise<void> {
    await this.client.delete(collectionName(orgSlug), {
      wait: true,
      filter: {
        must: [{ key: 'doc_id', match: { value: documentId } }],
        // Empty `keep` means the document has no points at all now, and every
        // one of them goes — an emptied file leaving its old text behind in
        // results is the same bug with worse consequences.
        ...(keep.length === 0 ? {} : { must_not: [{ has_id: [...keep] }] }),
      },
    } as never)
  }

  private async upsertPoints(input: {
    orgId: string
    orgSlug: string
    layerId: string
    vectorName: string
    points: readonly { pointId: string; ordinal: number; vector: readonly number[]; docId: string }[]
    aclTags: readonly string[]
    aclVersion: number
  }): Promise<void> {
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
   * Replace the ACL tags on every point of a document.
   *
   * `setPayload` with a filter rather than a re-upsert: the vectors are
   * unchanged and re-embedding a document because its permissions moved would
   * make a revocation cost as much as an ingest, which is how a recomputation
   * job ends up disabled in production.
   *
   * The filter carries `doc_id` alone and not `deleted`. A tombstoned document
   * still has points until garbage collection takes them, and leaving stale
   * tags on them would matter the moment a purge is late — I5 keeps them out of
   * answers, but this job should not be the reason that is the only thing
   * standing in the way.
   */
  async retag(input: {
    orgSlug: string
    documentId: string
    aclTags: readonly string[]
    aclVersion: number
  }): Promise<void> {
    await this.client.setPayload(collectionName(input.orgSlug), {
      wait: true,
      payload: { acl_tags: [...input.aclTags], acl_version: input.aclVersion },
      filter: { must: [{ key: 'doc_id', match: { value: input.documentId } }] },
    } as never)
  }

  /**
   * Physically remove every point of a document.
   *
   * `delete`, not `setPayload` — the tombstone already happened, and this is
   * the sweep that makes it mean something on disk. Filtered on `doc_id` so a
   * point that somehow lost its `deleted` flag is still collected: the
   * authority for what should exist is Postgres, and a vector store that
   * disagrees loses.
   */
  async purge(orgSlug: string, documentId: string): Promise<void> {
    try {
      await this.client.delete(collectionName(orgSlug), {
        wait: true,
        filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
      } as never)
    } catch (cause) {
      // No collection, no points. Reporting success here is not optimism: the
      // thing this job exists to remove demonstrably is not there, and the
      // alternative is a target that fails on every sweep, forever, at the head
      // of a queue ordered oldest-first.
      if (collectionMissing(cause)) return
      throw new Error(`purge from ${collectionName(orgSlug)} rejected: ${explain(cause)}`, { cause })
    }
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

/**
 * Principals allowed to read this layer, hashed into tags, and the
 * `groups_version` those tags were built from.
 *
 * Read from `grants` every time rather than cached: these go into the payload
 * and become the thing a query trusts, so a stale set written at index time is
 * a stale set until the next reindex. `acl_tags` is a cache of a cache
 * otherwise.
 *
 * The version is read inside the same transaction as the grants, and that is
 * the whole reason this returns a pair instead of just the tags. Reading it
 * afterwards would let a membership change land in between, and the document
 * would then be recorded as tagged at a version whose grants it never saw —
 * a claim of freshness that is false in the direction nobody checks.
 */
/**
 * Documents whose ACL tags are behind their organization's permission version.
 *
 * Across tenants, so it runs under the worker role rather than `withOrg`. The
 * oldest first: the lag gauge reports the worst laggard, so clearing the oldest
 * is what actually moves the number an alert fires on.
 *
 * No `FOR UPDATE SKIP LOCKED` and no claim column. Retagging is idempotent —
 * two replicas writing the same tags to the same points produce the same
 * payload — so the cost of a double retag is a wasted call, while the cost of a
 * claim that leaks on a crash is a document nothing retries. The version guard
 * in `markTagged` is what keeps concurrent passes from disagreeing.
 */
export async function claimStale(pool: Pool, limit: number): Promise<readonly StaleDocument[]> {
  return acrossOrganizations(pool, async (client) => {
      const { rows } = await client.query<{
        id: string
        org_id: string
        slug: string
        layer_id: string
      }>(
        `SELECT d.id, d.org_id, o.slug, d.layer_id
           FROM documents d
           JOIN organizations o ON o.id = d.org_id
          WHERE d.deleted_at IS NULL
            AND o.deleted_at IS NULL
            AND d.acl_version < o.groups_version
            -- "Has points", not "is currently indexed". A document that
            -- indexed once and failed on a later pass still has the earlier
            -- pass's points in the index, still carries their tags, and is the
            -- one case where a revoked grant can actually leak — and
            -- a status filter skipped precisely those. It also left them
            -- counted by nacre_acl_propagation_lag_seconds with nothing able to
            -- drain them, pinning the one alerted metric permanently.
            --
            -- observability.ts uses the same predicate. The two must agree: a
            -- gauge that counts what the loop cannot claim is a stuck alert.
            AND d.chunk_count > 0
          ORDER BY COALESCE(d.acl_tagged_at, d.created_at)
          LIMIT $1`,
        [limit],
      )

      return rows.map((r) => ({
        orgId: r.org_id,
        orgSlug: r.slug,
        documentId: r.id,
        layerId: r.layer_id,
      }))
  })
}

/**
 * Documents whose vectors are still in the index after the grace period.
 *
 * Cross-tenant like `claimStale`, and oldest first. The grace period is a
 * courtesy rather than a safeguard — nothing depends on the delay, and setting
 * it to zero is a valid choice for an operator who wants the space back.
 */
export async function claimPurgeable(
  pool: Pool,
  limit: number,
  graceSeconds: number,
): Promise<readonly PurgeTarget[]> {
  return acrossOrganizations(pool, async (client) => {
      const { rows } = await client.query<{
        id: string
        org_id: string
        slug: string
        age: string
      }>(
        `SELECT d.id, d.org_id, o.slug,
                EXTRACT(EPOCH FROM (now() - d.deleted_at))::text AS age
           FROM documents d
           JOIN organizations o ON o.id = d.org_id
          WHERE d.deleted_at IS NOT NULL
            AND d.vectors_purged_at IS NULL
            AND d.deleted_at < now() - make_interval(secs => $2)
          ORDER BY d.deleted_at
          LIMIT $1`,
        [limit, graceSeconds],
      )

      return rows.map((r) => ({
        orgId: r.org_id,
        orgSlug: r.slug,
        documentId: r.id,
        deletedAgeSeconds: Number(r.age),
      }))
  })
}

/**
 * Reclaim documents whose lease expired, in one statement.
 *
 * The requeue and the fail are the same UPDATE, decided by `attempts + 1`
 * against the ceiling. Reading first and writing second would let two reapers
 * both see attempt 4 and both write 5, which turns a bounded retry into an
 * unbounded one at exactly the moment the bound matters.
 *
 * `SKIP LOCKED` for the same reason `claimNext` uses it: several replicas run
 * this and none of them coordinate.
 *
 * Cross-tenant, under the worker's BYPASSRLS role, so `org_id` is returned and
 * named explicitly by everything downstream.
 */
export async function claimStranded(
  pool: Pool,
  limit: number,
  leaseSeconds: number,
  maxAttempts: number,
): Promise<readonly StrandedDocument[]> {
  return acrossOrganizations(pool, async (client) => {
      const { rows } = await client.query<{
        id: string
        org_id: string
        held: string
        attempts: number
      }>(
        `WITH expired AS (
           SELECT id, claimed_at
             FROM documents
            WHERE status IN ('parsing', 'indexing')
              AND claimed_at IS NOT NULL
              AND claimed_at < now() - make_interval(secs => $2)
            ORDER BY claimed_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE documents d
            SET attempts   = d.attempts + 1,
                status     = CASE WHEN d.attempts + 1 >= $3 THEN 'failed' ELSE 'pending' END,
                -- The lease is released either way. A failed row keeps no claim,
                -- and a requeued one is claimed again by whoever picks it up.
                claimed_at = NULL,
                error      = CASE WHEN d.attempts + 1 >= $3
                                  THEN 'Indexing was abandoned ' || $3::text ||
                                       ' times without completing. The worker did not report a failure, ' ||
                                       'which means it stopped between claiming this document and finishing it.'
                                  ELSE d.error END,
                updated_at = now()
           FROM expired e
          WHERE d.id = e.id
          -- e.claimed_at, not d.claimed_at: RETURNING sees the new row, and the
          -- new row's claim was just cleared. The CTE still holds the old value.
          RETURNING d.id, d.org_id, d.attempts,
                    EXTRACT(EPOCH FROM (now() - e.claimed_at))::text AS held`,
        [limit, leaseSeconds, maxAttempts],
      )

      return rows.map((r) => ({
        orgId: r.org_id,
        documentId: r.id,
        heldSeconds: Number(r.held),
        attempts: r.attempts,
      }))
  })
}

export async function tagsForLayer(
  pool: Pool,
  orgId: string,
  layerId: string,
  role?: string,
): Promise<{ tags: readonly string[]; version: number }> {
  return withOrg(
    pool,
    orgId,
    async (client) => {
      const version = await loadGroupsVersion(client, orgId)
      const { rows } = await client.query<{ principal_type: string; principal_id: string }>(
        `SELECT DISTINCT principal_type, principal_id
           FROM grants
          WHERE org_id = $1
            AND effect = 'allow'
            AND permission IN ('read','admin')
            AND (
              (scope_type = 'layer'     AND scope_id = $2)
              OR (scope_type = 'workspace' AND scope_id = (SELECT workspace_id FROM layers WHERE id = $2))
            )`,
        [orgId, layerId],
      )
      return {
        tags: aclTags(rows.map((r) => `${r.principal_type}:${r.principal_id}` as PrincipalRef)),
        version,
      }
    },
    role === undefined ? {} : { role },
  )
}
