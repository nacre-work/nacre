import { randomUUID } from 'node:crypto'

import { QdrantClient } from '@qdrant/js-client-rest'
import { ConfigError, createPool, loadConfig, withOrg } from '@nacre.work/core'

import { claimStale, HttpParser, PostgresDocumentStore, QdrantVectorWriter, tagsForLayer } from './adapters.js'
import { ingest } from './ingest.js'
import { retagOnce } from './retag.js'

/**
 * The indexing worker.
 *
 * Polls for documents left in `pending` and runs them through the pipeline. A
 * poll rather than a queue: the claim is done with `FOR UPDATE SKIP LOCKED`, so
 * several replicas can run against one table without coordinating, and a
 * replica that dies mid-document leaves the row claimed only until its
 * transaction rolls back.
 */

const APP_ROLE = 'nacre_app'
const IDLE_MS = 2000

// The recomputation pass. Bounded because a revocation across a large layer can
// touch every document in it, and an unbounded sweep would take the vector
// store down at exactly the moment correctness depends on it being reachable.
const RETAG_BATCH = 50
const RETAG_CONCURRENCY = 4

interface Claim {
  readonly orgId: string
  readonly orgSlug: string
  readonly documentId: string
  readonly layerId: string
  readonly externalId: string
  readonly vectorName: string
  readonly sourceRef: string | null
  readonly sourceType: string
}

async function claimNext(pool: ReturnType<typeof createPool>): Promise<Claim | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // No org scope here on purpose: this runs under the worker role, which the
    // schema gives BYPASSRLS, because it has to see every tenant. That is the
    // one place the second line of defense is off, which is why org_id is named
    // explicitly in every query the worker makes afterwards.
    const { rows } = await client.query<{
      id: string
      org_id: string
      slug: string
      layer_id: string
      external_id: string | null
      vector_name: string
      source_ref: string | null
      source_type: string
    }>(
      `SELECT d.id, d.org_id, o.slug, d.layer_id, d.external_id, l.vector_name,
              d.source_ref, d.source_type
         FROM documents d
         JOIN organizations o ON o.id = d.org_id
         JOIN layers l        ON l.id = d.layer_id
        WHERE d.status = 'pending' AND d.deleted_at IS NULL
        ORDER BY d.created_at
        LIMIT 1
        FOR UPDATE OF d SKIP LOCKED`,
    )

    const row = rows[0]
    if (row === undefined) {
      await client.query('COMMIT')
      return undefined
    }

    await client.query(`UPDATE documents SET status = 'parsing', updated_at = now() WHERE id = $1`, [row.id])
    await client.query('COMMIT')

    return {
      orgId: row.org_id,
      orgSlug: row.slug,
      documentId: row.id,
      layerId: row.layer_id,
      externalId: row.external_id ?? row.id,
      vectorName: row.vector_name,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function markFailed(
  pool: ReturnType<typeof createPool>,
  claim: Claim,
  error: unknown,
): Promise<void> {
  await withOrg(
    pool,
    claim.orgId,
    async (client) => {
      // The message, not the document. A parse failure that quotes the file
      // puts document contents in a column anyone with database access reads.
      await client.query(
        `UPDATE documents SET status = 'failed', error = $3, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [claim.orgId, claim.documentId, String(error).slice(0, 500)],
      )
    },
    { role: APP_ROLE },
  )
}

async function main(): Promise<void> {
  const config = loadConfig()
  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const parser = new HttpParser(config.parserEndpoint)
  const vectors = new QdrantVectorWriter(
    new QdrantClient(
      config.qdrantApiKey === undefined
        ? { url: config.qdrantUrl }
        : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
    ),
  )
  const documents = new PostgresDocumentStore(pool, APP_ROLE)
  const embedder = {
    embed: async (texts: readonly string[]) => {
      const response = await fetch(new URL('/embeddings', config.embeddingEndpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.embeddingModel, input: texts }),
      })
      if (!response.ok) throw new Error(`the embedding endpoint answered ${response.status}`)
      const body = (await response.json()) as { data?: { embedding?: number[] }[] }
      return (body.data ?? []).map((d) => d.embedding ?? [])
    },
  }

  const retagPorts = {
    claim: (limit: number) => claimStale(pool, limit),
    tagsFor: (orgId: string, layerId: string) => tagsForLayer(pool, orgId, layerId, APP_ROLE),
    retag: vectors.retag.bind(vectors),
    markTagged: documents.markTagged.bind(documents),
    onError: (document: { documentId: string }, error: unknown) => {
      console.error(
        JSON.stringify({ msg: 'retag failed', document_id: document.documentId, error: String(error) }),
      )
    },
  }

  let running = true
  const stop = (signal: string) => {
    console.log(JSON.stringify({ msg: 'draining', signal }))
    running = false
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  console.log(JSON.stringify({ msg: 'worker started', env: config.env }))

  while (running) {
    let claim: Claim | undefined
    try {
      claim = await claimNext(pool)
    } catch (error) {
      console.error(JSON.stringify({ msg: 'claim failed', error: String(error) }))
      await new Promise((r) => setTimeout(r, IDLE_MS))
      continue
    }

    if (claim === undefined) {
      // Indexing first, retagging in the gaps. A document nobody can find yet
      // is a worse outage than a permission cache a few seconds behind, and
      // the SLA the lag is measured against has room for the wait.
      try {
        const pass = await retagOnce(retagPorts, RETAG_BATCH, RETAG_CONCURRENCY)
        if (pass.retagged > 0 || pass.failed > 0) {
          console.log(JSON.stringify({ msg: 'retagged', ...pass }))
          continue
        }
      } catch (error) {
        console.error(JSON.stringify({ msg: 'retag pass failed', error: String(error) }))
      }

      await new Promise((r) => setTimeout(r, IDLE_MS))
      continue
    }

    try {
      const acl = await tagsForLayer(pool, claim.orgId, claim.layerId, APP_ROLE)
      const source =
        claim.sourceType === 'url' && claim.sourceRef !== null
          ? { url: claim.sourceRef }
          : { content: claim.sourceRef ?? '' }

      const result = await ingest(
        {
          orgId: claim.orgId,
          orgSlug: claim.orgSlug,
          layerId: claim.layerId,
          vectorName: claim.vectorName,
          externalId: claim.externalId,
          aclTags: acl.tags,
          // The organization's groups_version, never a clock. The propagation
          // gauge asks whether acl_version has fallen behind groups_version,
          // and a millisecond timestamp is larger than that counter will ever
          // be — so the comparison would never fire and the one metric that
          // evidences invariant I4 would report perfect health forever.
          aclVersion: acl.version,
          ...source,
        },
        { parser, embedder, documents, vectors, newId: randomUUID },
      )

      console.log(
        JSON.stringify({
          msg: 'indexed',
          document_id: result.documentId,
          chunks: result.chunkCount,
          unchanged: result.unchanged,
        }),
      )
    } catch (error) {
      console.error(
        JSON.stringify({ msg: 'indexing failed', document_id: claim.documentId, error: String(error) }),
      )
      await markFailed(pool, claim, error).catch(() => {})
    }
  }

  await pool.end()
  process.exit(0)
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(error.message)
    process.exit(2)
  }
  console.error(JSON.stringify({ msg: 'failed to start', error: String(error) }))
  process.exit(1)
})
