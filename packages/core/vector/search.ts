import { QdrantClient } from '@qdrant/js-client-rest'

import { buildFilter, METADATA_PREFIX, type Narrowing, type QueryablePlan } from '../authz/filter.js'
import { logger } from '../logging.js'
import { buildHybridQuery, collectionConfig, collectionName, PAYLOAD_INDEXES, vectorParams, type Branch, type CollectionShape } from './query.js'

/**
 * What Qdrant actually said.
 *
 * The REST client throws `Error: Bad Request` with the reason in a `data`
 * property nobody looks at, so an unhandled one reaches a log as four words
 * that name no collection, no vector and no cause. Both times a query in this
 * repository was malformed, the message alone was useless and the reason was
 * one line inside `data`.
 */
export function explainQdrant(cause: unknown): string {
  const data = (cause as { data?: unknown } | null)?.data
  return data === undefined ? String(cause) : `${String(cause)} — ${JSON.stringify(data)}`
}

export interface VectorStoreOptions {
  readonly url: string
  readonly apiKey?: string
  /**
   * How every collection this store creates is laid out across the cluster.
   *
   * Absent is Qdrant's own default of one shard and one copy, which is what
   * every collection created before this had — so a deployment that says
   * nothing gets exactly what it had.
   */
  readonly shape?: CollectionShape
}

export interface SearchRequest {
  readonly orgId: string
  /**
   * The organization's collection, read from `organizations.vector_collection`.
   *
   * Not derived from the slug. It was, everywhere, and the column was written
   * once at `init` and read by nothing — so a reindex that moved the pointer
   * moved a pointer no query followed, and the copy it had just finished sat
   * unused while search carried on against the old collection. The name is a
   * value the database owns; deriving it in six places is what let the two
   * disagree silently.
   */
  readonly collection: string
  /** What the caller may reach. `none` is not accepted — see buildFilter. */
  readonly plan: QueryablePlan
  readonly branches: readonly Branch[]
  readonly topK: number
  /**
   * A restriction the caller asked for, layered on top of the permission one.
   *
   * Still not a filter the caller assembles — it is a list of layer ids that
   * `buildFilter` turns into a `must`, so it can only ever remove results. The
   * distinction is the whole reason this is not `filter?: VectorFilter`.
   */
  readonly narrow?: Narrowing
}

export interface Hit {
  readonly id: string
  readonly score: number
  readonly payload: Record<string, unknown>
}

/**
 * How many metadata keys one collection will have indexes built for.
 *
 * The keys are the caller's, so unlike `PAYLOAD_INDEXES` the set is not known
 * in advance and has no natural end: `parseMetadata` bounds a *document* to 32
 * keys and says nothing about how many distinct ones an organization uses, so
 * a caller putting an identifier in a key name would otherwise ask for an index
 * per document.
 *
 * A constant rather than a `NACRE_` variable. Every configuration variable is a
 * thing an operator has to understand and a thing `docs/config.md` has to
 * explain, and the failure this bounds — a slower filter past the sixty-fourth
 * distinct key — needs no per-deployment answer.
 */
export const METADATA_INDEX_LIMIT = 64

/**
 * Payload indexes for the keys a caller filters on.
 *
 * `PAYLOAD_INDEXES` covers the fields the permission filter uses, which are
 * fixed. A metadata filter reaches `meta.<key>`, and those fields had no index
 * at all — so the narrowing that `filters` performs was evaluated by scanning,
 * which is the failure the comment on `PAYLOAD_INDEXES` describes: it does not
 * fail a test, it gets slow at a customer's volume.
 *
 * Built when metadata is written, because that is the only moment the keys are
 * known. Three properties make that safe, and each was checked against a real
 * Qdrant rather than read:
 *
 * - **A missing index is slow, never wrong.** A filter on an unindexed field —
 *   and on one indexed under the wrong type — still returns exactly the right
 *   points. Qdrant falls back to a scan. So this is an optimization end to end,
 *   and everything below may fail without changing an answer.
 * - **Creating one is idempotent**, and it back-fills: an index added after the
 *   points covers them, so nothing has to be rebuilt or ordered.
 * - **`keyword` is safe for every value type.** A number or a boolean under a
 *   keyword index simply indexes nothing and still matches, and strings and
 *   lists of strings — the case `filters` exists for, "only documents from this
 *   source" — index properly.
 *
 * Which is why a failure here warns and returns. This is the opposite of
 * invariant I3 and deliberately so: nothing about an index decides who sees
 * what, and failing an ingest because an index could not be built would trade a
 * slow query for a document that never arrives.
 */
export class MetadataIndexer {
  readonly #client: QdrantClient
  readonly #limit: number
  /** Per collection, the `meta.` fields known to be indexed. */
  readonly #known = new Map<string, Set<string>>()
  readonly #atLimit = new Set<string>()

  constructor(client: QdrantClient, limit: number = METADATA_INDEX_LIMIT) {
    this.#client = client
    this.#limit = limit
  }

  /**
   * Held on the instance rather than in a module-level map: two stores against
   * different collections must not share it, and a cache that outlives the
   * process that built it is a cache nothing invalidates. Staleness is harmless
   * anyway — the operation it saves is idempotent.
   */
  async #indexed(collection: string): Promise<Set<string>> {
    const cached = this.#known.get(collection)
    if (cached !== undefined) return cached

    const info = await this.#client.getCollection(collection)
    const schema = (info.payload_schema ?? {}) as Record<string, unknown>
    const fields = new Set(
      Object.keys(schema).filter((field) => field.startsWith(`${METADATA_PREFIX}.`)),
    )
    this.#known.set(collection, fields)
    return fields
  }

  async ensure(collection: string, keys: Iterable<string>): Promise<void> {
    const wanted = [...keys]
    if (wanted.length === 0) return

    try {
      const indexed = await this.#indexed(collection)

      for (const key of wanted) {
        const field = `${METADATA_PREFIX}.${key}`
        if (indexed.has(field)) continue

        if (indexed.size >= this.#limit) {
          // Once per collection per process. The filter still answers
          // correctly; it stops being answered from an index.
          if (!this.#atLimit.has(collection)) {
            this.#atLimit.add(collection)
            logger.warn('metadata index limit reached', { collection,
                limit: this.#limit,
                unindexed: field })
          }
          continue
        }

        await this.#client.createPayloadIndex(collection, {
          field_name: field,
          field_schema: 'keyword' as never,
          wait: true,
        })
        indexed.add(field)
      }
    } catch (cause) {
      // Never fatal. See the note on this class.
      logger.warn('metadata index build failed', { collection,
          error: explainQdrant(cause) })
    }
  }

  /** The `meta.` indexes a collection already has, for carrying across a copy. */
  static async fieldsOf(client: QdrantClient, collection: string): Promise<readonly string[]> {
    const info = await client.getCollection(collection)
    const schema = (info.payload_schema ?? {}) as Record<string, unknown>
    return Object.keys(schema).filter((field) => field.startsWith(`${METADATA_PREFIX}.`))
  }
}

/**
 * The vector store.
 *
 * One method matters: `search` takes an `AccessPlan` and never a filter. The
 * filter is derived here, from the plan, and there is no way to pass one in —
 * so no caller can assemble a query that reaches the index without going
 * through the permission model first.
 *
 * `top_k` is passed straight through, uncorrected. Asking for more and trimming
 * is a post-filter that also costs more, and it is the specific mistake
 * invariant I2 is written against.
 */
/**
 * `VectorStoreOptions` from a loaded configuration, in one place.
 *
 * Five call sites built this literal by hand — the API, the worker, the MCP
 * transport, `init` and `rebuild-collection` — each spelling out the same
 * `apiKey === undefined ? … : …` dance. Adding the collection shape to it would
 * have been five edits with nothing that knows there are five, and the two that
 * create collections are `init` and the worker: miss one and an organization's
 * first collection is shaped differently from the one a reindex builds for it.
 *
 * The `undefined` branch is not tidiness either. `exactOptionalPropertyTypes`
 * distinguishes absent from present-and-undefined, and the Qdrant client means
 * it: passing `apiKey: undefined` is not the same as omitting it.
 */
export function vectorStoreOptions(config: {
  readonly qdrantUrl: string
  readonly qdrantApiKey: string | undefined
  readonly qdrantShards: number
  readonly qdrantReplicationFactor: number
}): VectorStoreOptions {
  return {
    url: config.qdrantUrl,
    ...(config.qdrantApiKey === undefined ? {} : { apiKey: config.qdrantApiKey }),
    shape: { shards: config.qdrantShards, replicationFactor: config.qdrantReplicationFactor },
  }
}

export class VectorStore {
  readonly #client: QdrantClient
  readonly #metadataIndexes: MetadataIndexer
  /** Applied to every collection this store creates, and to none it reads. */
  readonly #shape: CollectionShape

  constructor(options: VectorStoreOptions) {
    // exactOptionalPropertyTypes distinguishes "absent" from "present and
    // undefined", and the client's parameters mean it: passing apiKey:
    // undefined is not the same as omitting it.
    this.#client = new QdrantClient(
      options.apiKey === undefined
        ? { url: options.url }
        : { url: options.url, apiKey: options.apiKey },
    )
    this.#metadataIndexes = new MetadataIndexer(this.#client)
    this.#shape = options.shape ?? {}
  }

  /**
   * Create an organization's first collection, if it is not there.
   *
   * `collectionName(orgSlug)` is the *initial* name and only that. Once a
   * reindex has rebuilt the collection the organization's name no longer
   * derives from its slug, which is why every other method here takes the
   * collection rather than working it out.
   */
  async ensureCollection(orgSlug: string, vectorName: string, size: number): Promise<string> {
    const name = collectionName(orgSlug)
    const existing = await this.#client.getCollections()
    if (existing.collections.some((c) => c.name === name)) return name

    await this.#client.createCollection(
      name,
      collectionConfig({ name: vectorName, size }, this.#shape) as never,
    )

    // Created here rather than left to an operator: a filter that falls back to
    // a scan is a latency problem that only shows up at a customer's volume.
    for (const index of PAYLOAD_INDEXES) {
      await this.#client.createPayloadIndex(name, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }

    return name
  }

  /**
   * Recreate a collection from a schema Postgres still has.
   *
   * `ensureCollection` cannot serve the one case this is for: the collection is
   * gone — the Qdrant volume was lost, or a reindex left an orphaned name — and
   * Postgres is the only surviving record of what it was. `ensureCollection`
   * derives the name from the slug and gives it a single slot from the process
   * configuration, and after a reindex neither is right: the name lives in
   * `organizations.vector_collection` and no longer follows the slug, and the
   * slots are one per embedding model the organization's layers use, not the one
   * the process happens to be configured with. So both come from the caller,
   * which read them from the database.
   *
   * It **refuses a collection that already exists** rather than replacing it: the
   * whole point is one that is not there, and a rebuild over a live collection
   * would delete every vector it holds. Recreating the schema is all this does —
   * the points are the worker's to re-embed once the documents are requeued,
   * because a vector is the one thing Postgres does not keep. The payload indexes
   * are the two sets `copyWithNewVector` carries across, for the same reason it
   * carries them: a rebuilt collection missing the caller's metadata indexes
   * would send every metadata filter back to a scan. The caller's keys go
   * through the same `MetadataIndexer` ingest uses, so the `meta.` namespacing
   * and the 64-index bound live in one place rather than being reimplemented
   * here.
   */
  async rebuildCollection(
    collection: string,
    slots: readonly { name: string; size: number }[],
    metadataKeys: readonly string[],
  ): Promise<void> {
    if (slots.length === 0) {
      throw new Error(
        `refusing to rebuild ${collection} with no vector slots — the organization's layers name none`,
      )
    }

    const present = await this.#client.getCollections()
    if (present.collections.some((c) => c.name === collection)) {
      throw new Error(
        `${collection} already exists. Rebuild is for a lost collection and will not replace a live ` +
          'one, because that would delete every vector it holds. Drop it first if that is what you mean.',
      )
    }

    const vectors: Record<string, unknown> = {}
    for (const slot of slots) vectors[slot.name] = vectorParams(slot.size)

    await this.#client.createCollection(
      collection,
      collectionConfig(vectors as Record<string, unknown>, this.#shape) as never,
    )

    for (const index of PAYLOAD_INDEXES) {
      await this.#client.createPayloadIndex(collection, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }
    await this.#metadataIndexes.ensure(collection, [...metadataKeys])
  }

  /**
   * Mark every point of a document deleted.
   *
   * A payload write, not a removal: physical deletion is the collector's job
   * and runs on its own schedule. This is what actually takes the document out
   * of results, because `deleted = false` is what the pre-filter tests — the
   * Postgres tombstone alone changes nothing a query looks at.
   *
   * It lives on the search client rather than in the worker because the
   * request that deletes a document is served by the API, and a document that
   * is tombstoned in Postgres but not here stays searchable until a background
   * job gets to it. That window is exactly what invariant I5 forbids.
   */
  async tombstone(collection: string, documentId: string): Promise<void> {
    await this.#client.setPayload(collection, {
      wait: true,
      payload: { deleted: true },
      filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
    } as never)
  }

  /**
   * The same flag, over every point of a layer, in one request.
   *
   * Deleting a layer is deleting everything in it, and doing that by calling
   * `tombstone` per document would put a loop over an unbounded collection on
   * the request path — a layer with ten thousand documents is ten thousand
   * round trips before the caller hears anything, and a failure halfway leaves
   * a layer that is half invisible.
   *
   * `setPayload` already takes a filter, so `layer_id` costs exactly what
   * `doc_id` does. The Postgres side still tombstones each document row,
   * because that is what the collector's queue is built from — but that is one
   * statement, not one round trip per document.
   */
  async tombstoneLayer(collection: string, layerId: string): Promise<void> {
    await this.#client.setPayload(collection, {
      wait: true,
      payload: { deleted: true },
      filter: { must: [{ key: 'layer_id', match: { value: layerId } }] },
    } as never)
  }

  /**
   * Replace the caller's metadata on every point of a document.
   *
   * `setPayload` under the reserved key, which merges at the top level and so
   * leaves `org_id`, `deleted`, `doc_id` and the rest exactly as they were —
   * the namespace is what makes that safe rather than a list of fields to
   * preserve.
   *
   * Whole-object replacement inside that key, not a merge: a caller sending
   * `{source: "notion"}` after `{source: "confluence", team: "legal"}` means
   * the document now has one tag, and merging would leave a tag they removed
   * still matching filters. `PATCH` names the resource, not the field.
   *
   * The vectors are untouched. Re-embedding a document because a tag moved
   * would make a bulk retag cost as much as a bulk ingest, which is the same
   * argument the ACL retag path is built on.
   */
  async setMetadata(
    collection: string,
    documentId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.#client.setPayload(collection, {
        wait: true,
        payload: { [METADATA_PREFIX]: metadata },
        filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
      } as never)
    } catch (cause) {
      throw new Error(
        `metadata write to ${collection} rejected: ${explainQdrant(cause)}`,
        { cause },
      )
    }

    // After the write, not before: an index built for a write that then failed
    // is an index for a key no point carries.
    await this.#metadataIndexes.ensure(collection, Object.keys(metadata))
  }

  /**
   * Remove a collection.
   *
   * Tolerates one that is not there. The caller is the retire sweep, which
   * drops before it forgets the row — so a pass that dropped and then failed to
   * forget comes back to a name whose collection is already gone, and that is a
   * completed job rather than an error. The alternative order loses the only
   * record that the collection exists.
   *
   * There is no confirmation and no dry run because there is no ambiguity at
   * this level: by the time a name reaches here it has been through the
   * rollback window and been checked against every organization's pointer.
   */
  async dropCollection(collection: string): Promise<void> {
    try {
      await this.#client.deleteCollection(collection)
    } catch (cause) {
      const existing = await this.#client.getCollections()
      if (existing.collections.some((c) => c.name === collection)) {
        throw new Error(`deleting ${collection} rejected: ${explainQdrant(cause)}`, { cause })
      }
    }
  }

  /**
   * Drop one named vector's data from a layer's points.
   *
   * Qdrant cannot remove a named vector from a collection's schema — that is
   * the constraint the whole reindex design turns on — but it can remove the
   * *data* for one from a chosen set of points, and the data is what costs
   * anything: a float per dimension per point, in memory by default.
   *
   * Scoped to one layer, because a collection holds several and only the ones
   * that finished migrating have a slot to give back.
   *
   * The consequence to be careful about, checked by asking a running Qdrant: a
   * point with no vector under the queried name does not error, it simply does
   * not match. So calling this for a slot something still searches would empty
   * that layer's results silently — which is why the caller selects only
   * layers whose `vector_name` has already moved, and never the slot it moved
   * to.
   */
  async dropLayerVector(collection: string, layerId: string, vectorName: string): Promise<void> {
    try {
      await this.#client.deleteVectors(collection, {
        wait: true,
        vector: [vectorName],
        filter: { must: [{ key: 'layer_id', match: { value: layerId } }] },
      } as never)
    } catch (cause) {
      throw new Error(
        `dropping ${vectorName} from ${collection} rejected: ${explainQdrant(cause)}`,
        { cause },
      )
    }
  }

  /**
   * The named vectors a collection has, and their widths.
   *
   * The set is fixed when the collection is created. That is the fact the whole
   * reindex design turns on, and it was worth checking rather than assuming:
   * `update_collection` adjusts the parameters of vectors that already exist and
   * answers `Not existing vector name error` for anything else, so there is no
   * way to add one to a live collection.
   */
  async vectorsOf(collection: string): Promise<Record<string, number>> {
    const info = await this.#client.getCollection(collection)
    const vectors = (info.config?.params?.vectors ?? {}) as Record<string, { size?: number }>
    return Object.fromEntries(
      Object.entries(vectors).map(([name, v]) => [name, Number(v.size ?? 0)]),
    )
  }

  /**
   * Copy an organization's collection into a new one that also has room for a
   * new model.
   *
   * This exists because a named vector cannot be added to a collection after it
   * is created. The way around that is not to add one — it is to create a
   * collection that already has the slot, move the points across as they are,
   * and switch which collection the organization points at.
   *
   * **No embeddings are computed here.** The vectors that come out of the old
   * collection go into the new one unchanged. That is what makes this the cheap
   * half of a model migration: the expensive half — computing vectors with the
   * new model — happens afterwards, one layer at a time, into the slot this
   * created.
   *
   * Idempotent by construction: if the target already exists it is deleted and
   * rebuilt. A half-copied collection is worse than none, and there is no way to
   * tell one from a complete one by looking at it — the source is still live and
   * still authoritative until the pointer moves, so throwing away a partial
   * attempt costs only the time it took.
   */
  async copyCollection(input: {
    from: string
    to: string
    /** Added alongside everything the source already has. */
    addVector: { name: string; size: number }
    /** Points per scroll page and per upsert. */
    batch?: number
    /**
     * Awaited per page. The worker renews its copy claim here — a copy of a
     * large collection outlives any fixed lease, and a callback that can
     * throw is how an over-taken claim aborts the copy instead of finishing
     * over the new holder's.
     */
    onProgress?: (copied: number) => void | Promise<void>
  }): Promise<void> {
    const existing = await this.vectorsOf(input.from)
    if (input.addVector.name in existing) {
      throw new Error(
        `${input.from} already has a vector called ${input.addVector.name}; nothing to copy for`,
      )
    }

    const vectors: Record<string, unknown> = {}
    for (const [name, size] of Object.entries(existing)) {
      vectors[name] = vectorParams(size)
    }
    vectors[input.addVector.name] = vectorParams(input.addVector.size)

    // Rebuilt rather than resumed. See the note above.
    await this.#client.deleteCollection(input.to).catch(() => undefined)
    // The copy a reindex builds gets the same shape as everything else. It was
    // spelled out inline here, which is how `collectionConfig` came to be one
    // place that two of the three creations did not go through.
    await this.#client.createCollection(
      input.to,
      collectionConfig(vectors as Record<string, unknown>, this.#shape) as never,
    )

    for (const index of PAYLOAD_INDEXES) {
      await this.#client.createPayloadIndex(input.to, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }

    // The metadata indexes too, or a reindex quietly undoes them: the new
    // collection is built from `PAYLOAD_INDEXES`, which by construction knows
    // nothing about keys a caller chose, so every metadata filter in that
    // organization would go back to scanning the moment the pointer moved. The
    // source is the only record of which keys are in use.
    for (const field of await MetadataIndexer.fieldsOf(this.#client, input.from)) {
      await this.#client.createPayloadIndex(input.to, {
        field_name: field,
        field_schema: 'keyword' as never,
        wait: true,
      })
    }

    const batch = input.batch ?? 256
    let offset: unknown = undefined
    let copied = 0

    do {
      const page = await this.#client.scroll(input.from, {
        limit: batch,
        with_payload: true,
        with_vector: true,
        ...(offset === undefined || offset === null ? {} : { offset }),
      } as never)

      const points = page.points ?? []
      if (points.length > 0) {
        await this.#client.upsert(input.to, {
          wait: true,
          points: points.map((p) => ({
            id: p.id,
            // Whatever the source had, unchanged. The new slot stays empty
            // until a layer is reindexed into it.
            vector: p.vector as never,
            payload: p.payload ?? {},
          })),
        } as never)
        copied += points.length
        await input.onProgress?.(copied)
      }

      offset = page.next_page_offset
    } while (offset !== undefined && offset !== null)
  }

  async search(request: SearchRequest): Promise<readonly Hit[]> {
    const filter = buildFilter(request.orgId, request.plan, request.narrow)
    const query = buildHybridQuery({
      branches: request.branches,
      filter,
      limit: request.topK,
    })

    let result
    try {
      result = await this.#client.query(request.collection, query as never)
    } catch (cause) {
      // Named, because the query has as many branches as the organization has
      // models and "Bad Request" does not say which one Qdrant objected to.
      throw new Error(
        `query against ${request.collection} using ` +
          `${query.prefetch.map((b) => b.using).join(', ')} rejected: ${explainQdrant(cause)}`,
        { cause },
      )
    }

    return result.points.map((p) => ({
      id: String(p.id),
      score: p.score,
      payload: (p.payload ?? {}) as Record<string, unknown>,
    }))
  }

  /**
   * Re-check the tenant on the way out.
   *
   * Invariant I1 asks for this explicitly: the filter is checked once more when
   * a response is serialized, and a mismatch is an error rather than a quiet
   * drop. Filtering silently here would hide the bug that produced the row —
   * and a bug that produces one cross-tenant row will produce more.
   */
  static assertTenant(orgId: string, hits: readonly Hit[]): readonly Hit[] {
    for (const hit of hits) {
      if (hit.payload.org_id !== orgId) {
        throw new Error(
          `tenant mismatch on the way out: point ${hit.id} carries org_id ` +
            `${String(hit.payload.org_id)} for a request scoped to ${orgId}`,
        )
      }
    }
    return hits
  }

  /**
   * Whether the vector store is answering.
   *
   * `getCollections` rather than a bare TCP connect: Qdrant accepting a socket
   * while refusing queries is the failure a readiness probe exists to catch,
   * and the Compose healthcheck already covers the socket.
   */
  async ready(): Promise<boolean> {
    await this.#client.getCollections()
    return true
  }

  async close(): Promise<void> {
    // The REST client holds no pool; this exists so callers have one shape to
    // depend on when it does.
  }
}
