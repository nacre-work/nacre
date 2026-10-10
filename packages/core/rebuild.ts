import type { Pool } from 'pg'

import type { VectorStore } from './vector/search.js'

/**
 * Rebuild an organization's Qdrant collection from what Postgres knows.
 *
 * Vectors are derived: the database holds every document, its chunks, the
 * collection's name and the slot each layer searches, and the vector store
 * holds what the worker computed from them. So when the two disagree, Postgres
 * is the truth and the collection is rebuilt from it — recreated with the real
 * name and the real slots, and every live document requeued for the worker to
 * re-embed.
 *
 * Two disasters need it and they differ in one thing. The vector store is
 * **gone** — a lost volume, a deleted collection — and there is nothing to
 * replace. Or the database was **restored** and the vector store was not, and
 * then the collection is there and wrong: a document deleted after the archive
 * was taken comes back in Postgres while its points stay flagged deleted, so it
 * is never found; a document added afterwards leaves points whose chunk rows no
 * longer exist, which search hydration drops — each one a place in `top_k`
 * handed to nobody, forever. Measured on a running stack rather than reasoned:
 * after a restore, a document the archive held was absent from every search.
 *
 * `replace` is the second case and it is never a default. Rebuilding over a live
 * collection deletes every vector in it, which is exactly right after a restore
 * and exactly wrong as a reflex — so without it a collection that exists is
 * refused, as it always was.
 *
 * This lives in the core library rather than beside the command because the
 * command is one caller: a restore that brings Postgres back on a running
 * installation is another, and two implementations of "what an organization's
 * collection is made of" would be two answers about the one thing every search
 * depends on.
 */

export interface RebuildSchema {
  readonly orgId: string
  readonly collection: string
  readonly slots: { name: string; size: number }[]
  readonly metadataKeys: string[]
  readonly documents: number
}

/**
 * Everything the rebuild needs, read in one transaction.
 *
 * The organization row is read first and without the org setting, because
 * `organizations` is the tenant registry rather than tenant data and carries no
 * row-level security — the same reason `init` reads it before setting
 * `app.current_org`. Everything after the `set_config` is a FORCE'd tenant table
 * (`layers`, `embedding_providers`, `documents`), so the setting is what lets a
 * non-superuser role read them at all — a raw read here would raise
 * `unrecognized configuration parameter "app.current_org"` in exactly the
 * production the command exists to recover.
 */
export async function readRebuildSchema(pool: Pool, slug: string): Promise<RebuildSchema | string> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const { rows: orgs } = await client.query<{ id: string; vector_collection: string }>(
      `SELECT id, vector_collection FROM organizations WHERE slug = $1 AND deleted_at IS NULL`,
      [slug],
    )
    const org = orgs[0]
    if (org === undefined) {
      await client.query('ROLLBACK')
      return `no organization with slug "${slug}"`
    }

    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', org.id])

    // One slot per embedding model the layers use: the named vector the layer
    // stores and the dimension of the provider behind it. `DISTINCT` because two
    // layers on the same model share a slot, and the collection carries one of
    // each. A layer always references a provider, so the join drops nothing.
    const { rows: slotRows } = await client.query<{ vector_name: string; dimensions: number }>(
      `SELECT DISTINCT l.vector_name, p.dimensions
         FROM layers l
         JOIN embedding_providers p ON p.id = l.provider_id
        WHERE l.org_id = $1`,
      [org.id],
    )
    const slots = slotRows.map((r) => ({ name: r.vector_name, size: Number(r.dimensions) }))

    // The caller's metadata keys, so the rebuilt collection carries the same
    // filter indexes a reindex would have carried across. Bare keys — the
    // indexer namespaces them under `meta.` the way ingest does.
    const { rows: keyRows } = await client.query<{ key: string }>(
      `SELECT DISTINCT k AS key
         FROM documents d, jsonb_object_keys(d.metadata) AS k
        WHERE d.org_id = $1 AND d.deleted_at IS NULL`,
      [org.id],
    )
    const metadataKeys = keyRows.map((r) => r.key)

    const { rows: countRows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM documents WHERE org_id = $1 AND deleted_at IS NULL`,
      [org.id],
    )

    await client.query('COMMIT')
    return {
      orgId: org.id,
      collection: org.vector_collection,
      slots,
      metadataKeys,
      documents: Number(countRows[0]?.n ?? 0),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Requeue every live document, so the worker re-embeds it into the new
 * collection.
 *
 * `status = 'pending'` is what `claimNext` looks for, and the lease and attempt
 * fields are reset with it — a document reclaimed once by the sweep must not
 * come back already halfway to `failed`. Tombstoned documents are left alone:
 * they are not in the index and must not be put back into it. Run only after the
 * collection exists, or a worker claims a pending document and upserts into a
 * collection that is not there.
 *
 * `reindexed_vector = NULL` is the one reset that is about correctness rather
 * than scheduling. It records which shadow slot a document was re-embedded into
 * during a model migration — and the rebuild has just created a collection in
 * which no shadow slot holds anything, so every surviving marker is now false.
 * Left standing, a disaster that struck mid-reindex would leave
 * `finishReindexIfDone`'s completeness predicate ("no live document lacks the
 * shadow vector") satisfied by markers alone, and on a layer without a recall
 * gate the switch could move `vector_name` onto a slot with no data in it —
 * retrieval collapsing with no error anywhere, which is exactly the failure the
 * gate exists to catch. NULL restores the truth: nothing has been re-embedded
 * into this collection yet.
 */
export async function requeueForRebuild(pool: Pool, orgId: string): Promise<number> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.current_org', orgId])
    const { rowCount } = await client.query(
      `UPDATE documents
          SET status = 'pending', claimed_at = NULL, attempts = 0, error = NULL,
              reindexed_vector = NULL
        WHERE org_id = $1 AND deleted_at IS NULL`,
      [orgId],
    )
    await client.query('COMMIT')
    return rowCount ?? 0
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}


export interface RebuildResult {
  readonly collection: string
  readonly slots: readonly { name: string; size: number }[]
  readonly metadataKeys: number
  readonly requeued: number
}

/**
 * Read, recreate, requeue — in that order, and the collection before the
 * requeue: a worker that claims a pending document upserts into the
 * collection, so it has to exist first.
 *
 * A string is a refusal a caller can print: no such organization, or a
 * collection that exists while `replace` is unset.
 */
export async function rebuildOrganizationIndex(input: {
  readonly pool: Pool
  readonly vectors: VectorStore
  readonly slug: string
  readonly replace?: boolean
}): Promise<RebuildResult | string> {
  const schema = await readRebuildSchema(input.pool, input.slug)
  if (typeof schema === 'string') return schema
  await input.vectors.rebuildCollection(schema.collection, schema.slots, schema.metadataKeys, {
    replace: input.replace === true,
  })
  const requeued = await requeueForRebuild(input.pool, schema.orgId)
  return {
    collection: schema.collection,
    slots: schema.slots,
    metadataKeys: schema.metadataKeys.length,
    requeued,
  }
}
