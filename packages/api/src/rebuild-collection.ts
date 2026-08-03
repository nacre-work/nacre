import { ConfigError, createPool, loadConfig, VectorStore } from '@nacre.work/core'
import type { Pool } from 'pg'
import { pathToFileURL } from 'node:url'

/**
 * Rebuild an organization's Qdrant collection from what Postgres still knows.
 *
 * The disaster this is for: the vector store is gone — a lost volume, a deleted
 * collection, a restore that brought Postgres back and not Qdrant — and there
 * was no command to put it back. `init` is the wrong tool twice over. It builds
 * `org_{slug}` with a single slot from the process configuration, and after a
 * reindex the name lives in `organizations.vector_collection` and no longer
 * follows the slug, while the slots are one per embedding model the layers use.
 * Both of those are in the database; none of them are in `init`'s arguments.
 *
 * So this reads the real name and the real slots from Postgres, recreates the
 * collection with them, and requeues every document — the worker re-embeds them,
 * because the vectors are the one thing Postgres does not hold. It is a one-shot
 * command run where the operator already has credentials, the same shape as
 * `init` and `migrate`, and it is deliberately not an endpoint: recreating a
 * collection and requeuing an organization's documents is not a request the API
 * should take from the network.
 *
 * It **refuses when the collection still exists** — `VectorStore.rebuildCollection`
 * does, because rebuilding over a live one would delete every vector in it. The
 * command is for a collection that is not there; if a corrupt one is, drop it
 * first.
 */

interface Args {
  readonly org: string
}

function parseArgs(argv: readonly string[]): Args | string {
  let org: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--org') {
      org = argv[++i]
    } else {
      return `unexpected argument: ${String(arg)}`
    }
  }
  if (org === undefined || org === '') return '--org <slug> is required'
  return { org }
}

interface Schema {
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
async function readSchema(pool: Pool, slug: string): Promise<Schema | string> {
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
async function requeue(pool: Pool, orgId: string): Promise<number> {
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

async function main(): Promise<void> {
  const say = (msg: string, extra?: Record<string, unknown>): void => {
    process.stdout.write(extra === undefined ? `${msg}\n` : `${msg} ${JSON.stringify(extra)}\n`)
  }

  const parsed = parseArgs(process.argv.slice(2))
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\nusage: rebuild-collection --org <slug>\n`)
    process.exit(2)
  }

  const config = loadConfig()
  const pool = createPool({ connectionString: config.pgUrl, max: 2 })

  try {
    const schema = await readSchema(pool, parsed.org)
    if (typeof schema === 'string') {
      process.stderr.write(`${schema}\n`)
      process.exit(1)
    }
    say('read the schema from Postgres', {
      collection: schema.collection,
      slots: schema.slots.map((s) => `${s.name}:${s.size}`),
      metadata_keys: schema.metadataKeys.length,
      documents: schema.documents,
    })

    // Qdrant before the requeue, and only when the read succeeded: the collection
    // has to exist before a worker can claim a document and write to it.
    const vectors = new VectorStore(
      config.qdrantApiKey === undefined
        ? { url: config.qdrantUrl }
        : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
    )
    await vectors.rebuildCollection(schema.collection, schema.slots, schema.metadataKeys)
    say('collection rebuilt', { collection: schema.collection })

    const requeued = await requeue(pool, schema.orgId)
    say('documents requeued for re-indexing', { documents: requeued })

    say(
      `Done. The worker will re-embed ${requeued} document${requeued === 1 ? '' : 's'} into ` +
        `${schema.collection}; watch them reach "indexed".`,
    )
  } finally {
    await pool.end()
  }
}

// Run only when executed directly, so importing this module in a test does not
// try to connect to anything — the same guard `init` uses.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(`${String(error)}\n`)
    process.exit(1)
  })
}
