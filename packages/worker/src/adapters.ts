import { QdrantClient } from '@qdrant/js-client-rest'
import {
  acrossOrganizations,
  explainQdrant as explain,
  METADATA_PREFIX,
  MetadataIndexer,
  toCheckJson,
  withOrg,
} from '@nacre.work/core'
import type { Pool } from 'pg'

import type { DocumentStore, Parser, ParsedDocument, StoredDocument, VectorWriter } from './ingest.js'
import type { PurgeTarget } from './collect.js'
import type { StrandedDocument } from './reap.js'
import type { ReindexTarget } from './reindex.js'
import type { RecallTarget, RecallVerdict } from './recall.js'

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
        // The lease goes with the completion. It matters
        // less here — `vectors_purged_at IS NULL` already keeps a purged
        // document out of the queue for good — but a claim left set on a row
        // nothing will claim again is a lie in the table, and the next person
        // to read `sweep_claimed_at` should not have to work out which of the
        // two sweeps left it there.
        await client.query(
          `UPDATE documents
              SET vectors_purged_at = now(), sweep_claimed_at = NULL
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
             -- Not written here at all, and for the same reason the title is
             -- COALESCEd: the API owns this column. It holds what the caller
             -- tagged the document with, and a filter reads it back — so a
             -- worker pass overwriting it with the parser's derived facts is
             -- the title bug again, with the tag disappearing instead of the
             -- name.
             --
             -- The parser's own output is dropped rather than merged. It is
             -- a byte count today, nothing filters on it, and letting a sidecar
             -- inject keys into a namespace callers filter by is a surface
             -- nobody asked for.
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
  private readonly metadataIndexes: MetadataIndexer

  constructor(private readonly client: QdrantClient) {
    this.metadataIndexes = new MetadataIndexer(client)
  }

  async write(input: {
    orgId: string
    collection: string
    layerId: string
    documentId: string
    vectorName: string
    metadata: Record<string, unknown>
    points: readonly { pointId: string; ordinal: number; vector: readonly number[]; docId: string }[]
  }): Promise<void> {
    try {
      if (input.points.length > 0) await this.upsertPoints(input)
    } catch (cause) {
      throw new Error(`upsert into ${input.collection} rejected: ${explain(cause)}`, { cause })
    }

    // After the upsert, never before, for the same reason the delete path is
    // ordered the other way round: sweeping first leaves the document
    // unsearchable for the length of an embedding round trip, and a reader who
    // hits that window sees an empty result rather than a stale one. Sweeping
    // second means the worst case is the state that existed before this line —
    // points nobody joins to — rather than a hole in the index.
    try {
      await this.sweep(input.collection, input.documentId, input.points.map((p) => p.pointId))
    } catch (cause) {
      throw new Error(`sweep of ${input.collection} rejected: ${explain(cause)}`, { cause })
    }

    // Ingest is where a metadata key is used for the first time, so it is where
    // the index for it gets built. Last, and it cannot fail the document: a
    // filter without an index returns the same points, just by scanning.
    await this.metadataIndexes.ensure(input.collection, Object.keys(input.metadata))
  }

  /**
   * Add a named vector to points that already exist.
   *
   * `updateVectors` and not `upsert`: this must not touch the payload and must
   * not disturb the vector the layer is currently searching on. A reindex adds
   * a second named vector to the same point, and the old one keeps answering
   * every query until `vector_name` switches — which is the whole of "search
   * stays available throughout".
   *
   * An upsert here would be the quiet version of the bug: it would rewrite the
   * payload from whatever this call happened to know, which is nothing about
   * acl tags, so a reindex would strip the permission tags off every point it
   * touched.
   */
  async addVector(
    collection: string,
    vectorName: string,
    points: readonly { pointId: string; vector: readonly number[] }[],
  ): Promise<void> {
    if (points.length === 0) return
    try {
      await this.client.updateVectors(collection, {
        wait: true,
        points: points.map((p) => ({ id: p.pointId, vector: { [vectorName]: [...p.vector] } })),
      } as never)
    } catch (cause) {
      throw new Error(
        `adding ${vectorName} to ${collection} rejected: ${explain(cause)}`,
        { cause },
      )
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
  private async sweep(collection: string, documentId: string, keep: readonly string[]): Promise<void> {
    await this.client.delete(collection, {
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
    collection: string
    layerId: string
    vectorName: string
    metadata: Record<string, unknown>
    points: readonly { pointId: string; ordinal: number; vector: readonly number[]; docId: string }[]
  }): Promise<void> {
    await this.client.upsert(input.collection, {
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
          // Every caller key under one reserved object, so `meta.org_id` is a
          // different field from `org_id` and there is no key a caller can
          // choose that reaches a permission field. Structural rather than a
          // denylist: a list of forbidden names has to stay in step with every
          // payload field ever added, and a namespace cannot fall out of step
          // with anything.
          [METADATA_PREFIX]: input.metadata,
        },
      })) as never,
    })
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
  async purge(collection: string, documentId: string): Promise<void> {
    try {
      await this.client.delete(collection, {
        wait: true,
        filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
      } as never)
    } catch (cause) {
      // No collection, no points. Reporting success here is not optimism: the
      // thing this job exists to remove demonstrably is not there, and the
      // alternative is a target that fails on every sweep, forever, at the head
      // of a queue ordered oldest-first.
      if (collectionMissing(cause)) return
      throw new Error(`purge from ${collection} rejected: ${explain(cause)}`, { cause })
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
  async tombstone(collection: string, documentId: string): Promise<void> {
    await this.client.setPayload(collection, {
      wait: true,
      payload: { deleted: true },
      filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
    } as never)
  }

  /**
   * The documents one reference query retrieves, on the shadow vector.
   *
   * ─── this has no ACL filter, and here is why that is allowed ───
   *
   * Everywhere else in this repository a query against the index without the
   * permission filter is the leak every other rule exists to prevent. This one
   * is different for a structural reason rather than a judgement call: **there
   * is no principal.** Nothing calls it on behalf of a caller, there is no
   * request and no token to resolve, and its result is fed to arithmetic that
   * returns a ratio. No id, no text and no payload leaves the worker.
   *
   * Two things keep it that way rather than merely intending it:
   *
   * - The signature takes a layer and a vector, never a filter. There is no
   *   argument through which a caller-assembled query could reach the index, so
   *   this cannot be reused from a request path by passing something different
   *   — which is the shape of the reuse that would turn it into a leak.
   * - `deleted = false` and `org_id` are still here, because they are not
   *   permission checks. Invariant 5 holds for every query in this system
   *   without exception, and scoring recall against tombstoned documents would
   *   also be wrong on its own terms.
   *
   * `limit` is a document count, not a point count: the same document usually
   * holds several chunks, so it is over-fetched at the point level and reduced
   * to distinct documents in order. That is not the over-fetch invariant 2
   * forbids — nothing is being trimmed on permission, and there is no caller to
   * withhold a result from.
   */
  async retrieveDocuments(input: {
    collection: string
    orgId: string
    layerId: string
    vectorName: string
    vector: readonly number[]
    limit: number
  }): Promise<readonly string[]> {
    const found = await this.client.query(input.collection, {
      query: [...input.vector],
      using: input.vectorName,
      // Points, not documents. A document with twenty chunks would otherwise
      // fill the whole answer and every reference query would score 1/n.
      limit: input.limit * MAX_CHUNKS_PER_DOCUMENT_ASSUMED,
      with_payload: true,
      filter: {
        must: [
          { key: 'org_id', match: { value: input.orgId } },
          { key: 'layer_id', match: { value: input.layerId } },
          { key: 'deleted', match: { value: false } },
        ],
      },
    } as never)

    const documents: string[] = []
    for (const point of found.points ?? []) {
      const docId = (point.payload ?? {})['doc_id']
      if (typeof docId !== 'string' || documents.includes(docId)) continue
      documents.push(docId)
      if (documents.length >= input.limit) break
    }
    return documents
  }
}

/**
 * How many points to ask for per document wanted.
 *
 * A guess, and it is allowed to be one: guessing low costs a slightly harsher
 * score on a layer of very long documents, and guessing high costs one larger
 * response on a query that runs once per migration. Neither is a correctness
 * property, which is why this is a constant here rather than a variable in
 * `docs/config.md` that an operator would have to reason about.
 */
const MAX_CHUNKS_PER_DOCUMENT_ASSUMED = 8

/**
 * The parser sidecar.
 *
 * It holds no credentials and reaches no database, so the only thing to be
 * careful about here is not trusting its output shape.
 */
export class HttpParser implements Parser {
  constructor(
    private readonly endpoint: string,
    /**
     * Two minutes. The sidecar has its own 30 s cap on fetching a URL, and the
     * rest is parsing a document that may be 50 MB of PDF.
     *
     * There has to be a number here. Without one, undici waits 300 s by
     * default, and the worker is strictly serial — so a sidecar that accepts
     * connections and never answers stops indexing for **every tenant**, five
     * minutes per attempt, with no metric and no liveness signal to say why.
     * A bounded wait turns that into a failed document and a retry.
     */
    private readonly timeoutMs = 120_000,
  ) {}

  async parse(source: { content?: string; url?: string }): Promise<ParsedDocument> {
    const response = await fetch(new URL('/parse', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(source),
      signal: AbortSignal.timeout(this.timeoutMs),
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
 * a stale set until the next reindex. The payload is a cache
 * otherwise.
 *
 * The version is read inside the same transaction as the grants, and that is
 * the whole reason this returns a pair instead of just the tags. Reading it
 * afterwards would let a membership change land in between, and the document
 * would then be recorded as tagged at a version whose grants it never saw —
 * a claim of freshness that is false in the direction nobody checks.
 */

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

/**
 * Documents whose vectors are still in the index after the grace period.
 *
 * Cross-tenant, and oldest first. The grace period is a
 * courtesy rather than a safeguard — nothing depends on the delay, and setting
 * it to zero is a valid choice for an operator who wants the space back.
 */
export async function claimPurgeable(
  pool: Pool,
  limit: number,
  graceSeconds: number,
  leaseSeconds = 900,
): Promise<readonly PurgeTarget[]> {
  return acrossOrganizations(pool, async (client) => {
      const { rows } = await client.query<{
        id: string
        org_id: string
        collection: string
        age: string
        source_type: string
        source_ref: string | null
      }>(
        `WITH claimed AS (
           SELECT d.id
             FROM documents d
            WHERE d.deleted_at IS NOT NULL
              AND d.vectors_purged_at IS NULL
              AND d.deleted_at < now() - make_interval(secs => $2)
              AND (d.sweep_claimed_at IS NULL
                   OR d.sweep_claimed_at < now() - make_interval(secs => $3))
            ORDER BY d.deleted_at
            LIMIT $1
            FOR UPDATE OF d SKIP LOCKED
         )
         -- Claimed in the same statement:
         -- without it every replica purged the same tombstones and the backlog
         -- drained at one worker's rate however many were running.
         UPDATE documents d
            SET sweep_claimed_at = now()
           FROM claimed c
           JOIN organizations o ON TRUE
          WHERE d.id = c.id AND o.id = d.org_id
          RETURNING d.id, d.org_id, o.vector_collection AS collection,
                    d.source_type, d.source_ref,
                    EXTRACT(EPOCH FROM (now() - d.deleted_at))::text AS age`,
        [limit, graceSeconds, leaseSeconds],
      )

      return rows.map((r) => ({
        orgId: r.org_id,
        collection: r.collection,
        documentId: r.id,
        deletedAgeSeconds: Number(r.age),
        // Only an `s3` document has bytes outside Postgres. An `inline` one
        // carries them in the row that is about to be marked purged, and a
        // `url` one never had a copy here at all — removing that key would be
        // this system deleting somebody else's object.
        ...(r.source_type === 's3' && r.source_ref !== null
          ? { objectKey: r.source_ref }
          : {}),
      }))
  })
}


/**
 * Delete refresh tokens that have already expired.
 *
 * `0009` promised this in a comment on the index built to make it cheap —
 * "expired rows are deleted by a sweep rather than kept forever" — and there
 * was no sweep. Every login and every rotation inserts a row, nothing removed
 * one, so the table grew at the rate people signed in and fastest on the
 * deployments rotating most often.
 *
 * Only past `expires_at`, which is why this loses nothing. `refresh()` refuses
 * an expired token and an unknown one identically, at the same place, with the
 * same `undefined` — so a row deleted after expiry cannot change any answer.
 * Reuse detection is untouched: a family is revoked while its tokens are still
 * live, which is the only window in which a replay is worth catching.
 *
 * Cross-tenant, under the worker's BYPASSRLS role. It is maintenance rather
 * than the queue, but it is the same mechanism and the same justification: one
 * predicate over every tenant's rows, run by the process that has no request in
 * hand. It names no organization because it selects on expiry alone.
 *
 * Bounded by `limit` for the reason every sweep here is: a table nobody has
 * pruned since the feature shipped should drain over many small transactions,
 * not one that holds locks while it scans a year.
 */
export async function pruneExpiredTokens(pool: Pool, limit: number): Promise<number> {
  return acrossOrganizations(pool, async (client) => {
    const { rowCount } = await client.query(
      // By ctid over a bounded, ordered subquery: refresh_tokens_expiry exists
      // precisely so the oldest are found without a scan, and ordering by it
      // makes repeated calls converge instead of revisiting the same window.
      `WITH doomed AS (
         SELECT ctid
           FROM refresh_tokens
          WHERE expires_at < now()
          ORDER BY expires_at
          LIMIT $1
       )
       DELETE FROM refresh_tokens t USING doomed d WHERE t.ctid = d.ctid`,
      [limit],
    )
    return rowCount ?? 0
  })
}

/**
 * Expire audit events past the retention horizon.
 *
 * Through `prune_audit_events`, never a DELETE: the grant is revoked from every
 * application role and stays revoked. See `0012` for why that is compatible
 * with the append-only guarantee rather than a hole in it — the short version
 * is that the function takes a number of days and cannot be handed a predicate,
 * so it can expire a window and can never erase an event.
 *
 * Errors are the caller's to log. A retention below the function's floor raises
 * rather than pruning less than asked, which is the right way round: an
 * operator who set 7 days should find out, not get 30 silently.
 */
export async function pruneAuditEvents(
  pool: Pool,
  retentionDays: number,
  limit: number,
): Promise<number> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{ pruned: number }>(
      'SELECT prune_audit_events($1, $2) AS pruned',
      [retentionDays, limit],
    )
    return Number(rows[0]?.pruned ?? 0)
  })
}

/**
 * Superseded collections whose rollback window has closed.
 *
 * Cross-tenant, oldest first, so a backlog drains in the order it accumulated
 * rather than by whichever organization sorts first.
 *
 * The interval is built from a bound integer rather than interpolated: the
 * value comes from `NACRE_COLLECTION_RETENTION_DAYS`, which `loadConfig`
 * already refuses below 1, and `make_interval` takes it as a parameter so there
 * is no string concatenation anywhere near it.
 */
export async function dueCollections(
  pool: Pool,
  retentionDays: number,
  limit: number,
): Promise<readonly { orgId: string; name: string }[]> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{ org_id: string; name: string }>(
      `SELECT org_id, name
         FROM retired_collections
        WHERE retired_at < now() - make_interval(days => $1::int)
        ORDER BY retired_at
        LIMIT $2`,
      [retentionDays, limit],
    )
    return rows.map((r) => ({ orgId: r.org_id, name: r.name }))
  })
}

/**
 * Whether any organization is pointing at this collection right now.
 *
 * Asked before every delete, and it is D2 in the rollback runbook rather than
 * distrust of the table: moving the pointer back to a superseded collection is
 * the cheap rollback, and it leaves the row here untouched. Without this the
 * sweep would delete the collection an operator had just rolled back onto.
 *
 * Deleted organizations count. Their collection is still theirs until the
 * organization is purged, and reclaiming disk from one is a different job with
 * a different confirmation.
 */
export async function isLiveCollection(pool: Pool, name: string): Promise<boolean> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{ live: string }>(
      'SELECT 1 AS live FROM organizations WHERE vector_collection = $1 LIMIT 1',
      [name],
    )
    return rows.length > 0
  })
}

export async function forgetCollection(
  pool: Pool,
  collection: { orgId: string; name: string },
): Promise<void> {
  await acrossOrganizations(pool, async (client) => {
    await client.query('DELETE FROM retired_collections WHERE org_id = $1 AND name = $2', [
      collection.orgId,
      collection.name,
    ])
  })
}

/**
 * Layers whose superseded vector slot may be reclaimed.
 *
 * A completed reindex leaves every point carrying two vectors: the one the
 * layer now searches and the one it used to. The second is dead weight —
 * a float per dimension per point, in memory by default — and nothing removed
 * it. Qdrant cannot drop a named vector from a collection's schema, which is
 * the constraint the whole migration design turns on, but it can drop the
 * *data* for one from a chosen set of points, which is all that costs anything.
 *
 * Selected the same way collections are: only what a finished migration
 * superseded, recorded by the statement that superseded it, and only past the
 * rollback window. `previous_vector` present is the whole condition — a layer
 * mid-reindex has no such key.
 *
 * The window is the same `NACRE_COLLECTION_RETENTION_DAYS`, and for the same
 * reason: both are how long a completed migration can still be undone cheaply.
 * Rolling `vector_name` back is instant while the old vectors are there and
 * impossible afterwards.
 */
export async function dueVectors(
  pool: Pool,
  retentionDays: number,
  limit: number,
): Promise<readonly { orgId: string; layerId: string; collection: string; vectorName: string }[]> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      org_id: string
      layer_id: string
      collection: string
      previous_vector: string
    }>(
      `SELECT l.org_id, l.id AS layer_id, o.vector_collection AS collection,
              l.reindex_state ->> 'previous_vector' AS previous_vector
         FROM layers l
         JOIN organizations o ON o.id = l.org_id
        WHERE l.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND l.reindex_state ->> 'status' = 'complete'
          AND l.reindex_state ? 'previous_vector'
          -- Never the slot the layer is searching now. The switch writes both
          -- in one statement so they cannot be equal, and a migration that
          -- somehow landed back on its own name would otherwise delete the
          -- vectors it is using.
          AND l.reindex_state ->> 'previous_vector' IS DISTINCT FROM l.vector_name
          AND (l.reindex_state ->> 'finished_at')::timestamptz
                < now() - make_interval(days => $1::int)
        ORDER BY (l.reindex_state ->> 'finished_at')::timestamptz
        LIMIT $2`,
      [retentionDays, limit],
    )
    return rows.map((r) => ({
      orgId: r.org_id,
      layerId: r.layer_id,
      collection: r.collection,
      vectorName: r.previous_vector,
    }))
  })
}

/**
 * Forget the slot, once its data is gone.
 *
 * After the delete, never before: the key is the only record that there is
 * anything to reclaim, and losing it first leaks the vectors permanently with
 * nothing naming them. The other order costs at worst a second delete of
 * something already gone, which Qdrant treats as a completed operation.
 */
export async function forgetVector(
  pool: Pool,
  orgId: string,
  layerId: string,
  role?: string,
): Promise<void> {
  await withOrg(
    pool,
    orgId,
    async (client) => {
      await client.query(
        `UPDATE layers
            SET reindex_state = reindex_state - 'previous_vector'
          WHERE org_id = $1 AND id = $2`,
        [orgId, layerId],
      )
    },
    role === undefined ? {} : { role },
  )
}

export async function countRetiredCollections(pool: Pool): Promise<number> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{ n: string }>(
      'SELECT count(*) AS n FROM retired_collections',
    )
    return Number(rows[0]?.n ?? 0)
  })
}

/**
 * Documents in a reindexing layer that do not yet carry the shadow vector.
 *
 * Cross-tenant, under the worker's BYPASSRLS role, so `org_id` comes back and
 * is named explicitly by everything downstream. Joined to `layers` rather than
 * driven from it: the interesting set is documents, and a layer with nothing
 * outstanding produces no rows rather than an empty batch to discard.
 *
 * Chunks come back in the same query. A reindex re-embeds stored text — it does
 * not re-parse a source or re-chunk anything — so the text and the point ids
 * are the whole input, and fetching them per document would be a query each.
 */
export async function claimReindexable(
  pool: Pool,
  limit: number,
): Promise<readonly ReindexTarget[]> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      org_id: string
      collection: string
      layer_id: string
      document_id: string
      shadow_vector: string
      provider_id: string
      chunks: { point_id: string; text: string }[]
    }>(
      `SELECT d.org_id, o.vector_collection AS collection, d.layer_id, d.id AS document_id,
              l.reindex_state ->> 'shadow_vector' AS shadow_vector,
              l.reindex_state ->> 'provider_id'   AS provider_id,
              (SELECT json_agg(json_build_object('point_id', c.point_id, 'text', c.text)
                               ORDER BY c.ordinal)
                 FROM chunks c WHERE c.document_id = d.id) AS chunks
         FROM documents d
         JOIN layers l        ON l.id = d.layer_id
         JOIN organizations o ON o.id = d.org_id
        WHERE l.reindex_state ->> 'status' = 'running'
          AND l.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND d.deleted_at IS NULL
          AND d.chunk_count > 0
          AND d.reindexed_vector IS DISTINCT FROM (l.reindex_state ->> 'shadow_vector')
        ORDER BY d.created_at
        LIMIT $1`,
      [limit],
    )

    return rows
      .filter((r) => r.chunks !== null && r.chunks.length > 0)
      .map((r) => ({
        orgId: r.org_id,
        collection: r.collection,
        layerId: r.layer_id,
        documentId: r.document_id,
        shadowVector: r.shadow_vector,
        providerId: r.provider_id,
        chunks: r.chunks.map((c) => ({ pointId: c.point_id, text: c.text })),
      }))
  })
}

/** Record that a document carries the shadow vector. */
export async function markReindexed(
  pool: Pool,
  orgId: string,
  documentId: string,
  shadowVector: string,
  role?: string,
): Promise<void> {
  await withOrg(
    pool,
    orgId,
    async (client) => {
      await client.query(
        'UPDATE documents SET reindexed_vector = $3 WHERE org_id = $1 AND id = $2',
        [orgId, documentId, shadowVector],
      )
    },
    role === undefined ? {} : { role },
  )
}

/**
 * Switch `vector_name` if the layer has nothing outstanding.
 *
 * One statement. The check and the write cannot be separated: asking first and
 * switching second leaves a window in which a document is ingested, gets no
 * shadow vector, and is then excluded from an index that has already become the
 * live one — a hole in a layer that reports itself migrated.
 *
 * `NOT EXISTS` over the same predicate the claim uses. The two must agree, and
 * they are three lines apart in this file for that reason.
 */
export async function finishReindexIfDone(
  pool: Pool,
  orgId: string,
  layerId: string,
  shadowVector: string,
  role?: string,
): Promise<boolean> {
  return withOrg(
    pool,
    orgId,
    async (client) => {
      const { rowCount } = await client.query(
        // `before` captures the name being moved away from. RETURNING sees the
        // new row — the same reason claimPurgeable reads the CTE's claimed_at
        // and not the table's — so the old value is held before the SET runs.
        `WITH before AS (
           SELECT id, vector_name FROM layers WHERE org_id = $1 AND id = $2
         )
         UPDATE layers l
            SET vector_name = $3,
                -- The provider moves with the vector, in the same statement.
                --
                -- Leaving it behind is the quiet half of a half-finished
                -- migration: vector_name says the layer is on the new model
                -- and provider_id still names the old one, so everything that
                -- asks the layer *which model* — the query embedder on the
                -- search path, the ingest embedder in the worker — keeps
                -- answering with the model the layer just moved off. Search
                -- then embeds a 1024-dim query against a 768-dim slot and
                -- Qdrant refuses the whole query, taking every other layer in
                -- the organization down with it.
                provider_id = (l.reindex_state ->> 'provider_id')::uuid,
                reindex_state = jsonb_set(
                  jsonb_set(
                    jsonb_set(l.reindex_state, '{status}', '"complete"'),
                    '{finished_at}', to_jsonb(now()::text)),
                  -- The slot this layer just stopped using, so the sweep that
                  -- reclaims it knows which one it is. Written by the statement
                  -- that supersedes it, exactly like retired_collections: a
                  -- vector nothing has moved off has no key here and cannot be
                  -- selected for deletion.
                  --
                  -- In reindex_state rather than a new table because that is
                  -- what the column is, the state of this layer's migration,
                  -- and its CHECK constraint requires status and shadow_vector
                  -- and permits anything else.
                  '{previous_vector}', to_jsonb(b.vector_name))
           FROM before b
          WHERE l.org_id = $1 AND l.id = $2 AND b.id = l.id
            AND l.reindex_state ->> 'status' = 'running'
            AND l.reindex_state ->> 'shadow_vector' = $3
            AND NOT EXISTS (
              SELECT 1 FROM documents d
               WHERE d.org_id = l.org_id AND d.layer_id = l.id
                 AND d.deleted_at IS NULL AND d.chunk_count > 0
                 AND d.reindexed_vector IS DISTINCT FROM $3
            )
            -- The recall gate, in this statement rather than in front of it.
            --
            -- Anywhere else it would be a check the caller performs and then
            -- acts on, with a window between the two. Here it is a predicate,
            -- so a reference set written while the check was being scored
            -- blocks the switch instead of being outrun by it — the same
            -- argument as the NOT EXISTS above, applied to a different table.
            --
            -- No reference set, no gate. That is the documented arrangement
            -- and not an oversight: the check needs documents an operator
            -- picked, so a deployment that has not picked any has nothing to
            -- be checked against, and failing every migration in that case
            -- would make the feature a way to break reindexing.
            AND (
              NOT EXISTS (SELECT 1 FROM reference_queries rq
                           WHERE rq.org_id = l.org_id AND rq.layer_id = l.id)
              OR (l.reindex_state -> 'check' ->> 'passed') = 'true'
            )`,
        [orgId, layerId, shadowVector],
      )
      return (rowCount ?? 0) > 0
    },
    role === undefined ? {} : { role },
  )
}

/** A layer waiting on the organization's collection being rebuilt. */
export interface CopyTarget {
  readonly orgId: string
  readonly orgSlug: string
  readonly layerId: string
  readonly collection: string
  readonly shadowVector: string
  readonly providerId: string
  readonly dimensions: number
}

/**
 * Layers stuck in the copy phase.
 *
 * At most one per organization, because the API refuses a second start while
 * one is copying — but the query says so rather than assuming it, since the
 * cost of two workers rebuilding one collection is losing whichever finished
 * first.
 */
export async function claimCopyable(pool: Pool, limit: number): Promise<readonly CopyTarget[]> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      org_id: string
      slug: string
      collection: string
      layer_id: string
      shadow_vector: string
      provider_id: string
      dimensions: number
    }>(
      `SELECT DISTINCT ON (l.org_id)
              l.org_id, o.slug, o.vector_collection AS collection, l.id AS layer_id,
              l.reindex_state ->> 'shadow_vector' AS shadow_vector,
              l.reindex_state ->> 'provider_id'   AS provider_id,
              p.dimensions
         FROM layers l
         JOIN organizations o      ON o.id = l.org_id
         JOIN embedding_providers p ON p.id = (l.reindex_state ->> 'provider_id')::uuid
        WHERE l.reindex_state ->> 'status' = 'running'
          AND l.reindex_state ->> 'phase'  = 'copying'
          AND l.deleted_at IS NULL AND o.deleted_at IS NULL
        ORDER BY l.org_id, l.id
        LIMIT $1`,
      [limit],
    )

    return rows.map((r) => ({
      orgId: r.org_id,
      orgSlug: r.slug,
      layerId: r.layer_id,
      collection: r.collection,
      shadowVector: r.shadow_vector,
      providerId: r.provider_id,
      dimensions: Number(r.dimensions),
    }))
  })
}

/**
 * Point the organization at the rebuilt collection, and move every layer of it
 * out of the copy phase.
 *
 * One statement each, one transaction. The pointer and the phases have to move
 * together: a pointer that moved without the phases leaves layers waiting for a
 * copy that already happened, and phases that moved without the pointer send
 * the embedding pass at a collection nothing is searching.
 *
 * `vector_collection` is what every search resolves through, so this line is
 * the moment the migration becomes visible — and it is a pointer swap rather
 * than a data change, which is why it is atomic and why rolling back is the
 * same statement with the old name.
 */
export async function finishCopy(
  pool: Pool,
  orgId: string,
  collection: string,
  role?: string,
): Promise<void> {
  await withOrg(
    pool,
    orgId,
    async (client) => {
      const { rows: before } = await client.query<{ vector_collection: string }>(
        'SELECT vector_collection FROM organizations WHERE id = $1',
        [orgId],
      )

      await client.query('UPDATE organizations SET vector_collection = $2 WHERE id = $1', [
        orgId,
        collection,
      ])

      // In the same transaction as the pointer move, and that ordering is the
      // safety property rather than a tidiness one. A row that exists without
      // the pointer having moved names a collection something is still
      // searching, and the sweep would delete it. The reverse — the pointer
      // moving without a row — leaks a collection, which is the state that
      // existed before this table.
      //
      // The old name, not the new one. A migration that somehow lands on the
      // name it started from retires nothing.
      const retired = before[0]?.vector_collection
      if (retired !== undefined && retired !== collection) {
        await client.query(
          `INSERT INTO retired_collections (org_id, name) VALUES ($1, $2)
             ON CONFLICT (org_id, name) DO NOTHING`,
          [orgId, retired],
        )
      }
      // Out of the copy phase, and straight to complete for a layer that
      // nothing is still holding back.
      //
      // The document half is the same predicate `finishReindexIfDone` uses, and
      // it has to be here as well: that function only ever runs for layers
      // whose documents a pass actually claimed, so a layer with none — one
      // created against a new provider, or an empty one being migrated — sat in
      // `running` forever with nothing that would ever move it. Its
      // `vector_name` was already right and ingest worked, which is what made
      // it a stuck status report rather than a stuck layer, and reporting a
      // migration as running for good is its own bug.
      //
      // The reference-set half is the recall gate reaching the path that skips
      // the embedding pass. Without it a layer with nothing to re-embed would
      // complete here, unchecked, while an identical layer holding one document
      // went through the gate — the same feature applying or not depending on
      // whether the corpus happened to be empty. `recallOnce` is what moves one
      // of these afterwards, and it switches through `finishReindexIfDone` like
      // every other layer does.
      //
      // One CTE rather than the three copies of the same EXISTS this replaced.
      // They had to agree and nothing made them.
      await client.query(
        `WITH held AS (
           SELECT l.id,
                  EXISTS (
                    SELECT 1 FROM documents d
                     WHERE d.org_id = l.org_id AND d.layer_id = l.id
                       AND d.deleted_at IS NULL AND d.chunk_count > 0
                       AND d.reindexed_vector IS DISTINCT FROM (l.reindex_state ->> 'shadow_vector')
                  )
                  OR EXISTS (
                    SELECT 1 FROM reference_queries rq
                     WHERE rq.org_id = l.org_id AND rq.layer_id = l.id
                  ) AS waiting
             FROM layers l
            WHERE l.org_id = $1
              AND l.reindex_state ->> 'status' = 'running'
              AND l.reindex_state ->> 'phase'  = 'copying'
         )
         UPDATE layers l
            SET reindex_state =
                  CASE WHEN h.waiting
                  THEN jsonb_set(l.reindex_state, '{phase}', '"embedding"')
                  ELSE jsonb_set(
                         jsonb_set(
                           jsonb_set(l.reindex_state, '{phase}', '"embedding"'),
                           '{status}', '"complete"'),
                         '{finished_at}', to_jsonb(now()::text))
                  END,
                -- And the same switch finishReindexIfDone makes, for the same
                -- reason, on the path that skips it: a layer with nothing left
                -- to do is finished the moment the collection exists, and the
                -- two columns have to move together or the layer names one
                -- model and embeds with another. A no-op for a layer created
                -- against the new provider, which is already on both.
                vector_name = CASE WHEN h.waiting
                  THEN l.vector_name ELSE l.reindex_state ->> 'shadow_vector' END,
                provider_id = CASE WHEN h.waiting
                  THEN l.provider_id ELSE (l.reindex_state ->> 'provider_id')::uuid END
           FROM held h
          WHERE h.id = l.id
            AND l.org_id = $1
            AND l.reindex_state ->> 'status' = 'running'
            AND l.reindex_state ->> 'phase'  = 'copying'`,
        [orgId],
      )
    },
    role === undefined ? {} : { role },
  )
}

/**
 * Record how a pass over one layer went, and give up if it keeps going badly.
 *
 * Two things were missing and they are the same omission twice. Nothing wrote
 * a per-document failure into `reindex_state`, so `GET` on the reindex path
 * answered `failed: 0, status: running` while the worker logged the same two
 * failures every five seconds — the endpoint an operator is told to poll was
 * the one place the failure was invisible. And nothing bounded the retries, so
 * a reindex that could never succeed retried until somebody noticed.
 *
 * `failed` counts **consecutive** failures rather than total: a pass that got
 * anywhere resets it, so a slow embedder dropping one request in ten does not
 * accumulate its way to a stop over an afternoon. Only a layer that is making
 * no progress at all reaches the bound.
 *
 * The whole thing is one statement, so two workers passing over the same layer
 * cannot both read `failed` and both write the same increment — which is how a
 * bounded retry becomes an unbounded one at exactly the moment the bound
 * matters.
 */
export async function recordReindexPass(
  pool: Pool,
  input: {
    orgId: string
    layerId: string
    shadowVector: string
    succeeded: number
    failed: number
    error?: string
  },
  bound: number,
  role?: string,
): Promise<void> {
  if (input.failed === 0 && input.succeeded === 0) return

  await withOrg(
    pool,
    input.orgId,
    async (client) => {
      await client.query(
        `UPDATE layers l
            SET reindex_state =
                  CASE
                    WHEN $4::int > 0 THEN
                      -- Progress. The consecutive count goes back to zero and
                      -- the stale error goes with it, because an error left
                      -- behind after a successful pass reads as the reason a
                      -- finished reindex stopped.
                      jsonb_set(l.reindex_state, '{failed}', '0') - 'error'
                    WHEN COALESCE((l.reindex_state ->> 'failed')::int, 0) + $5::int >= $6::int THEN
                      jsonb_set(
                        jsonb_set(
                          jsonb_set(l.reindex_state, '{failed}',
                            to_jsonb(COALESCE((l.reindex_state ->> 'failed')::int, 0) + $5::int)),
                          '{status}', '"failed"'),
                        '{error}', to_jsonb($7::text))
                    ELSE
                      jsonb_set(
                        jsonb_set(l.reindex_state, '{failed}',
                          to_jsonb(COALESCE((l.reindex_state ->> 'failed')::int, 0) + $5::int)),
                        '{error}', to_jsonb($7::text))
                  END
          WHERE l.org_id = $1 AND l.id = $2
            AND l.reindex_state ->> 'status' = 'running'
            AND l.reindex_state ->> 'shadow_vector' = $3`,
        [
          input.orgId,
          input.layerId,
          input.shadowVector,
          input.succeeded,
          input.failed,
          bound,
          (input.error ?? '').slice(0, 500),
        ],
      )
    },
    role === undefined ? {} : { role },
  )
}

/** Record that a copy could not be made, so the layer stops looking running. */
export async function failReindex(
  pool: Pool,
  orgId: string,
  layerId: string,
  error: string,
  role?: string,
): Promise<void> {
  await withOrg(
    pool,
    orgId,
    async (client) => {
      await client.query(
        `UPDATE layers
            SET reindex_state = jsonb_set(
                  jsonb_set(reindex_state, '{status}', '"failed"'),
                  '{error}', to_jsonb($3::text))
          WHERE org_id = $1 AND id = $2 AND reindex_state ->> 'status' = 'running'`,
        [orgId, layerId, error.slice(0, 500)],
      )
    },
    role === undefined ? {} : { role },
  )
}

/**
 * Layers whose reindex has embedded everything and has not been checked.
 *
 * Four conditions, and each one is load-bearing:
 *
 * - **`status = 'running'` and `phase = 'embedding'`** — not a layer still
 *   waiting on the collection copy, which has no shadow vectors at all.
 * - **`NOT EXISTS` over outstanding documents** — the *same* predicate
 *   `finishReindexIfDone` switches on. A verdict computed while a document was
 *   outstanding would describe an index the switch is not about to make live.
 *   The switch re-evaluates it in its own statement, so a document ingested
 *   between the check and the switch still blocks the switch; this one is
 *   about not wasting the check.
 * - **no `check` key yet** — the verdict is written once. Re-checking a layer
 *   whose numbers are already recorded would let a flapping embedder turn a
 *   failed migration into a passed one on the next pass.
 * - **at least one reference query** — a layer without a set has no gate, and
 *   scoring an empty set averages to zero, which would fail every migration in
 *   the deployment.
 *
 * `expected` is resolved from external ids to document ids here, in SQL,
 * because the index answers in document ids and the operator wrote external
 * ones. What does not resolve comes back in `missing` rather than as a shorter
 * list: a reference set naming a document that is gone is a different problem
 * from a model that cannot find it, and the two must not produce one number.
 */
export async function dueChecks(
  pool: Pool,
  limit: number,
): Promise<readonly RecallTarget[]> {
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      org_id: string
      layer_id: string
      collection: string
      shadow_vector: string
      provider_id: string
      queries: {
        id: string
        query: string
        expected: string[]
        found: { id: string; external_id: string }[]
      }[]
    }>(
      `SELECT l.org_id, l.id AS layer_id, o.vector_collection AS collection,
              l.reindex_state ->> 'shadow_vector' AS shadow_vector,
              l.reindex_state ->> 'provider_id'   AS provider_id,
              (SELECT json_agg(json_build_object(
                        'id', rq.id, 'query', rq.query, 'expected', rq.expected,
                        -- Both ids, because both are needed and for different
                        -- things: the document id is what the index answers in
                        -- and the score is computed over, and the external id
                        -- is what says which entry of the set failed to
                        -- resolve. Deriving the second from a count instead
                        -- reports every entry as missing when one is.
                        --
                        -- Live documents only, and in this layer only. An
                        -- external id is unique per layer, so a reference set
                        -- cannot be made to resolve against a neighbouring
                        -- layer's document by naming it.
                        'found', (SELECT coalesce(json_agg(json_build_object(
                                           'id', d.id, 'external_id', d.external_id)), '[]'::json)
                                    FROM documents d
                                   WHERE d.org_id = rq.org_id
                                     AND d.layer_id = rq.layer_id
                                     AND d.external_id = ANY (rq.expected)
                                     AND d.deleted_at IS NULL))
                      ORDER BY rq.ordinal)
                 FROM reference_queries rq
                WHERE rq.org_id = l.org_id AND rq.layer_id = l.id) AS queries
         FROM layers l
         JOIN organizations o ON o.id = l.org_id
        WHERE l.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND l.reindex_state ->> 'status' = 'running'
          AND l.reindex_state ->> 'phase'  = 'embedding'
          AND NOT l.reindex_state ? 'check'
          AND EXISTS (SELECT 1 FROM reference_queries rq
                       WHERE rq.org_id = l.org_id AND rq.layer_id = l.id)
          AND NOT EXISTS (
            SELECT 1 FROM documents d
             WHERE d.org_id = l.org_id AND d.layer_id = l.id
               AND d.deleted_at IS NULL AND d.chunk_count > 0
               AND d.reindexed_vector IS DISTINCT FROM (l.reindex_state ->> 'shadow_vector')
          )
        ORDER BY l.id
        LIMIT $1`,
      [limit],
    )

    return rows.map((r) => ({
      orgId: r.org_id,
      layerId: r.layer_id,
      collection: r.collection,
      shadowVector: r.shadow_vector,
      providerId: r.provider_id,
      queries: (r.queries ?? []).map((q) => {
        const resolved = new Set(q.found.map((f) => f.external_id))
        return {
          id: q.id,
          query: q.query,
          // Document ids, because that is what the index answers in.
          expected: q.found.map((f) => f.id),
          // And the external ids that produced none, named individually. The
          // operator wrote these strings; telling them the set is stale without
          // saying which line is the difference between a fix and a re-read.
          missing: q.expected.filter((e) => !resolved.has(e)),
        }
      }),
    }))
  })
}

/** Write the verdict where the switch predicate and the operator both read it. */
export async function recordCheck(
  pool: Pool,
  orgId: string,
  layerId: string,
  shadowVector: string,
  verdict: RecallVerdict,
  role?: string,
): Promise<void> {
  await withOrg(
    pool,
    orgId,
    async (client) => {
      await client.query(
        // Guarded on the shadow vector as well as the layer. A verdict computed
        // for one migration must not land on the next: a second reindex started
        // while this one was being scored writes a different shadow vector, and
        // its `check` key would otherwise arrive pre-passed.
        `UPDATE layers
            SET reindex_state = jsonb_set(reindex_state, '{check}', $4::jsonb)
          WHERE org_id = $1 AND id = $2
            AND reindex_state ->> 'status' = 'running'
            AND reindex_state ->> 'shadow_vector' = $3`,
        // Through the core codec, not JSON.stringify of the verdict. The rest
        // of this column is snake case and the SQL predicate that performs the
        // switch reads `passed` out of it — a second hand-written shape here is
        // how the writer and the reader drift apart with nothing failing.
        [orgId, layerId, shadowVector, JSON.stringify(toCheckJson(verdict))],
      )
    },
    role === undefined ? {} : { role },
  )
}
