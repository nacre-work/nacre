import {
  aclTags,
  buildFilter,
  effectivePrincipals,
  loadGrants,
  loadScopeTree,
  PostgresGroupGraph,
  resolve,
  VectorStore,
  withOrg,
  type Hit,
} from '@nacre.work/core'
import type { Pool } from 'pg'

import type { AuditEvent, AuditSink, Documents, SearchService } from './server.js'
import type { AuthContext } from './auth.js'

/**
 * The adapters that put the permission model on the request path.
 *
 * `NacreSearchService` is the one to read. Every step between a token and a
 * result is here, in order, and none of them can be skipped by a caller —
 * there is no method that takes a filter, and no method that takes an
 * organization.
 */

export interface Embedder {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>
}

export class PostgresDocuments implements Documents {
  constructor(private readonly pool: Pool, private readonly role?: string) {}

  /**
   * Undefined for absent and for another organization's document alike.
   *
   * The query is scoped twice on purpose: `withOrg` sets the row-level security
   * context, and `org_id` is named in the WHERE clause anyway. Either alone
   * would do; both means a mistake in one is not a leak.
   */
  async read(orgId: string, documentId: string): Promise<{ id: string; title: string } | undefined> {
    // A malformed id must not reach Postgres as a cast error — an error
    // distinguishable from "not found" is an oracle for the id format.
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) return undefined

    return withOrg(
      this.pool,
      orgId,
      async (client) => {
        const { rows } = await client.query<{ id: string; title: string | null }>(
          `SELECT id, title FROM documents
            WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [orgId, documentId],
        )
        const row = rows[0]
        return row === undefined ? undefined : { id: row.id, title: row.title ?? '' }
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

export interface SearchDeps {
  readonly pool: Pool
  readonly vectors: VectorStore
  readonly embedder: Embedder
  /** Resolved per organization; the collection name is derived from it. */
  readonly orgSlug: (orgId: string) => Promise<string | undefined>
  readonly vectorName: string
  readonly role?: string
}

export class NacreSearchService implements SearchService {
  constructor(private readonly deps: SearchDeps) {}

  async search(auth: AuthContext, query: string, topK: number): Promise<readonly Hit[]> {
    const slug = await this.deps.orgSlug(auth.orgId)
    if (slug === undefined) {
      // The token names an organization that is not there. Rule I3: a
      // permission that cannot be evaluated denies.
      return []
    }

    const plan = await withOrg(
      this.deps.pool,
      auth.orgId,
      async (client) => {
        const graph = await PostgresGroupGraph.load(client, auth.orgId)
        const principals = effectivePrincipals(auth.principal, graph)
        const grants = await loadGrants(client, auth.orgId, principals)
        const tree = await loadScopeTree(
          client,
          auth.orgId,
          grants.filter((g) => g.scope.type === 'document').map((g) => g.scope.id),
        )
        return resolve({ orgId: auth.orgId, role: auth.role, principals, grants, tree }, 'read')
      },
      this.deps.role === undefined ? {} : { role: this.deps.role },
    )

    // No access at all. Returning early rather than querying is not an
    // optimization — buildFilter refuses this plan, and it refuses it because
    // there is no filter that means "nothing" without meaning "everything" by
    // one mistake.
    if (plan.kind === 'none') return []

    const [vector] = await this.deps.embedder.embed([query])
    if (vector === undefined) throw new Error('the embedder returned no vector for the query')

    const hits = await this.deps.vectors.search({
      orgId: auth.orgId,
      orgSlug: slug,
      plan,
      branches: [{ kind: 'dense', using: this.deps.vectorName, vector }],
      // Passed through. Asking for more and trimming is a post-filter that also
      // costs more.
      topK,
    })

    // Invariant I1, checked again on the way out. Raises rather than filtering:
    // silently dropping the row would hide the bug that produced it.
    return VectorStore.assertTenant(auth.orgId, hits)
  }

  /** Exposed so the filter can be inspected in tests without a vector store. */
  static filterFor(orgId: string, plan: Parameters<typeof buildFilter>[1]) {
    return buildFilter(orgId, plan)
  }
}

/**
 * The audit sink.
 *
 * Writes with the application role, which has INSERT and SELECT on
 * `audit_events` and neither UPDATE nor DELETE — revoked at the database level
 * by migration 0002, so a bug here cannot rewrite history and neither can
 * anyone holding these credentials.
 */
export class PostgresAudit implements AuditSink {
  constructor(private readonly pool: Pool, private readonly role?: string) {}

  async write(event: AuditEvent): Promise<void> {
    const [actorType, actorId] = event.actor.split(':')
    await withOrg(
      this.pool,
      event.orgId,
      async (client) => {
        await client.query(
          `INSERT INTO audit_events
             (org_id, actor_type, actor_id, actor_label, action, surface, target, result, detail, request_id)
           VALUES ($1,$2,$3,$4,$5,'api','{}'::jsonb,$6,$7,$8)`,
          [
            event.orgId,
            actorType ?? 'unknown',
            /^[0-9a-f-]{36}$/i.test(actorId ?? '') ? actorId : null,
            event.actor,
            event.action,
            event.result,
            JSON.stringify(event.detail),
            event.requestId,
          ],
        )
      },
      this.role === undefined ? {} : { role: this.role },
    )
  }
}

/**
 * An OpenAI-compatible embedding client.
 *
 * "Bring your own model" means this has to work against anything speaking that
 * shape, so the only thing assumed is `POST /embeddings` returning
 * `{ data: [{ embedding: number[] }] }`.
 */
export class HttpEmbedder implements Embedder {
  constructor(
    private readonly endpoint: string,
    private readonly model: string,
    private readonly dimensions: number,
  ) {}

  async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
    if (texts.length === 0) return []

    const response = await fetch(new URL('/embeddings', this.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    })

    if (!response.ok) {
      throw new Error(`the embedding endpoint answered ${response.status}`)
    }

    const body = (await response.json()) as { data?: { embedding?: unknown }[] }
    const vectors = (body.data ?? []).map((d) => d.embedding)

    if (vectors.length !== texts.length) {
      // Same reason as in the ingest pipeline: a short or reordered batch
      // attaches the wrong vector to the wrong text, and nothing downstream can
      // tell.
      throw new Error(`the embedding endpoint returned ${vectors.length} vectors for ${texts.length} inputs`)
    }

    return vectors.map((v, i) => {
      if (!Array.isArray(v) || v.length !== this.dimensions || !v.every((n) => typeof n === 'number')) {
        throw new Error(
          `vector ${i} is not ${this.dimensions} numbers; the endpoint and ` +
            'NACRE_DEFAULT_EMBEDDING_DIM disagree, and the index would be built wrong',
        )
      }
      return v as number[]
    })
  }
}

export { aclTags }
