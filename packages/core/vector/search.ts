import { QdrantClient } from '@qdrant/js-client-rest'

import { buildFilter, type QueryablePlan } from '../authz/filter.js'
import { buildHybridQuery, collectionConfig, collectionName, PAYLOAD_INDEXES, type Branch } from './query.js'

export interface VectorStoreOptions {
  readonly url: string
  readonly apiKey?: string
}

export interface SearchRequest {
  readonly orgId: string
  readonly orgSlug: string
  /** What the caller may reach. `none` is not accepted — see buildFilter. */
  readonly plan: QueryablePlan
  readonly branches: readonly Branch[]
  readonly topK: number
}

export interface Hit {
  readonly id: string
  readonly score: number
  readonly payload: Record<string, unknown>
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
export class VectorStore {
  readonly #client: QdrantClient

  constructor(options: VectorStoreOptions) {
    // exactOptionalPropertyTypes distinguishes "absent" from "present and
    // undefined", and the client's parameters mean it: passing apiKey:
    // undefined is not the same as omitting it.
    this.#client = new QdrantClient(
      options.apiKey === undefined
        ? { url: options.url }
        : { url: options.url, apiKey: options.apiKey },
    )
  }

  async ensureCollection(orgSlug: string, vectorName: string, size: number): Promise<void> {
    const name = collectionName(orgSlug)
    const existing = await this.#client.getCollections()
    if (existing.collections.some((c) => c.name === name)) return

    await this.#client.createCollection(name, collectionConfig(vectorName, size) as never)

    // Created here rather than left to an operator: a filter that falls back to
    // a scan is a latency problem that only shows up at a customer's volume.
    for (const index of PAYLOAD_INDEXES) {
      await this.#client.createPayloadIndex(name, {
        field_name: index.field_name,
        field_schema: index.field_schema as never,
        wait: true,
      })
    }
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
  async tombstone(orgSlug: string, documentId: string): Promise<void> {
    await this.#client.setPayload(collectionName(orgSlug), {
      wait: true,
      payload: { deleted: true },
      filter: { must: [{ key: 'doc_id', match: { value: documentId } }] },
    } as never)
  }

  async search(request: SearchRequest): Promise<readonly Hit[]> {
    const filter = buildFilter(request.orgId, request.plan)
    const query = buildHybridQuery({
      branches: request.branches,
      filter,
      limit: request.topK,
    })

    const result = await this.#client.query(collectionName(request.orgSlug), query as never)

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
