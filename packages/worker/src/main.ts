import { randomUUID } from 'node:crypto'

import { QdrantClient } from '@qdrant/js-client-rest'
import {
  configureLogging,
  acrossOrganizations,
  ConfigError,
  createPool,
  endpointUrl,
  installGuards,
  logger,
  S3,
  VectorStore,
  loadConfig,
  withOrg,
} from '@nacre.work/core'

import {
  claimCopyable,
  claimPurgeable,
  claimReindexable,
  dueChecks,
  claimStranded,
  dueCollections,
  dueVectors,
  failReindex,
  finishCopy,
  finishReindexIfDone,
  forgetCollection,
  forgetVector,
  HttpParser,
  isLiveCollection,
  markReindexed,
  PostgresDocumentStore,
  pruneAuditEvents,
  pruneExpiredTokens,
  QdrantVectorWriter,
  recordCheck,
  recordReindexPass,
  embeddingFailure,
  EMBED_TIMEOUT_MS,
} from './adapters.js'
import { ingest } from './ingest.js'
import { collectOnce } from './collect.js'
import { pruneOnce } from './prune.js'
import { reapOnce } from './reap.js'
import { reindexOnce } from './reindex.js'
import { recallOnce, type RecallPorts } from './recall.js'
import { retireOnce, retireVectorsOnce } from './retire.js'

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

// Garbage collection. docs/architecture.md asks for "at least hourly", and this
// runs far more often than that because it is cheap when there is nothing to do
// — one indexed query returning no rows. The small batch is the point: nothing
// waits on this finishing, and a sweep that deletes thousands of points at once
// is trading search latency for a job with no deadline.
const GC_BATCH = 20
const GC_EVERY_MS = 60_000

// Reclaiming abandoned claims. Runs on its own clock like collection, and more
// often than it needs to: the query is one partial-index lookup that normally
// returns nothing, and the thing it fixes is invisible until someone asks why a
// document never indexed.
const REAP_BATCH = 20
const REAP_EVERY_MS = 60_000

// Retention. Hourly, because neither table is urgent and both are large: an
// expired refresh token is inert and an audit event a day past a 400-day
// horizon harms nobody. The batch is bigger than the others' because these are
// plain row deletes with no round trip to anything, and a deployment that has
// never pruned has a backlog measured in months — 2000 an hour drains a million
// rows in three weeks without ever holding a lock long enough to be noticed.
const PRUNE_BATCH = 2000
const PRUNE_EVERY_MS = 3_600_000

// On the prune clock, and small. A deployment accumulates one of these per
// model migration, so the backlog is measured in single digits and a batch that
// could work through a million rows would only make a bad delete faster.
const RETIRE_BATCH = 8

// Reindexing a layer onto a different model. Small batches on a slow clock,
// because every document in one is an embedding round trip against the model
// server a deployment sized for its own ingest rate — and a reindex is
// background work with no deadline. The documented response to it being slow is
// to leave it running, not to make it compete with the ingest it shares an
// endpoint with.
const REINDEX_BATCH = 10
const REINDEX_EVERY_MS = 5000

// Consecutive passes over one layer that achieved nothing before the reindex is
// marked failed. Twenty at five seconds apart is a little under two minutes of
// getting nowhere, which is long enough to ride out a model server restart and
// short enough that an operator polling the endpoint is told rather than left
// watching a number that will never move. Reset by any document succeeding —
// see recordReindexPass.
const REINDEX_FAILURE_BOUND = 20

// Layers scored per pass. One migration finishes at a time in any deployment
// anyone runs, and the cost of a batch is a set of embedding calls plus a query
// each — so this is small on purpose rather than tuned.
const RECALL_BATCH = 4

interface Claim {
  readonly orgId: string
  /** The organization's collection, not derived from its slug. */
  readonly collection: string
  readonly documentId: string
  readonly layerId: string
  readonly externalId: string
  readonly vectorName: string
  /** The layer's embedding provider. Never this process's configuration. */
  readonly providerId: string
  /** What the caller tagged the document with. Written into every point's payload. */
  readonly metadata: Record<string, unknown>
  readonly sourceRef: string | null
  readonly sourceType: string
  /** What the stored bytes are. Decides how the s3 branch hands them to the parser. */
  readonly contentType: string
}

async function claimNext(pool: ReturnType<typeof createPool>): Promise<Claim | undefined> {
  // No org scope here on purpose: this runs under the worker role, which the
  // schema gives BYPASSRLS, because it has to see every tenant. That is the one
  // place the second line of defense is off, which is why org_id is named
  // explicitly in every query the worker makes afterwards.
  //
  // The role has to actually be set, and for a long time it was not — 0001 said
  // the role existed and no migration created it, so this ran as whoever
  // connected. On a superuser that is invisible; on the unprivileged role
  // docs/config.md requires, it raised on every poll and the worker indexed
  // nothing.
  return acrossOrganizations(pool, async (client) => {
    const { rows } = await client.query<{
      id: string
      org_id: string
      collection: string
      layer_id: string
      external_id: string | null
      vector_name: string
      provider_id: string
      metadata: Record<string, unknown> | null
      source_ref: string | null
      source_type: string
      content_type: string
    }>(
      `SELECT d.id, d.org_id, o.vector_collection AS collection, d.layer_id, d.external_id, l.vector_name,
              l.provider_id, d.metadata, d.source_ref, d.source_type, d.content_type
         FROM documents d
         JOIN organizations o ON o.id = d.org_id
         JOIN layers l        ON l.id = d.layer_id
        WHERE d.status = 'pending' AND d.deleted_at IS NULL
          -- Not while this organization's collection is being copied.
          --
          -- The copy scrolls the old collection and the pointer moves when it
          -- finishes, so a document indexed in between lands in the collection
          -- that is about to be abandoned: Postgres says 'indexed', the new
          -- collection has never heard of it, and nothing queues it again.
          -- Silent, permanent, and proportional to how long the copy takes.
          --
          -- Waiting is the whole fix. The row stays 'pending', which is a
          -- queue and not an error, and the copy is the only thing it waits
          -- on. It also covers the case the copy exists for: a layer created
          -- against a provider the collection has no slot for yet, whose
          -- documents would otherwise fail every attempt with
          -- "Not existing vector name".
          AND NOT EXISTS (
            SELECT 1 FROM layers c
             WHERE c.org_id = d.org_id
               AND c.reindex_state ->> 'status' = 'running'
               AND c.reindex_state ->> 'phase'  = 'copying'
          )
        ORDER BY d.created_at
        LIMIT 1
        FOR UPDATE OF d SKIP LOCKED`,
    )

    // `acrossOrganizations` owns the transaction, so there is no COMMIT here.
    // The row lock taken by FOR UPDATE is held until it commits, which is what
    // makes SKIP LOCKED mean anything with several workers running.
    const row = rows[0]
    if (row === undefined) return undefined

    // claimed_at starts the lease. Without it a worker that stops existing
    // between here and the finish leaves this row in `parsing`, and nothing
    // claims `parsing` — see reap.ts.
    await client.query(
      `UPDATE documents
          SET status = 'parsing', claimed_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = $1`,
      [row.id],
    )

    return {
      orgId: row.org_id,
      collection: row.collection,
      documentId: row.id,
      layerId: row.layer_id,
      externalId: row.external_id ?? row.id,
      vectorName: row.vector_name,
      providerId: row.provider_id,
      metadata: row.metadata ?? {},
      sourceRef: row.source_ref,
      sourceType: row.source_type,
      contentType: row.content_type,
    }
  })
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
      // The lease is released with the status. A failed row that keeps its
      // claim would be reaped back into `pending` and retried, which is the
      // opposite of what recording a failure means.
      await client.query(
        `UPDATE documents SET status = 'failed', error = $3, claimed_at = NULL, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [claim.orgId, claim.documentId, String(error).slice(0, 500)],
      )
    },
    { role: APP_ROLE },
  )
}

async function main(): Promise<void> {
  const config = loadConfig()

  // Before anything else logs. `NACRE_LOG_LEVEL` and `NACRE_LOG_FORMAT` had been
  // validated here and read by nothing, so every process wrote JSON at one level
  // whatever the deployment asked for.
  configureLogging({ level: config.logLevel, format: config.logFormat })
  const pool = createPool({ connectionString: config.pgUrl, max: config.pgPoolMax })
  const parser = new HttpParser(config.parserEndpoint)
  const vectors = new QdrantVectorWriter(
    new QdrantClient(
      config.qdrantApiKey === undefined
        ? { url: config.qdrantUrl }
        : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
    ),
  )

  // The same Qdrant, through the shared client rather than a second
  // implementation. `copyCollection` lives there because the API needs
  // `vectorsOf` from the same place, and two copies of "what does a collection
  // look like" is how the two ends of a migration end up disagreeing.
  const store = new VectorStore(
    config.qdrantApiKey === undefined
      ? { url: config.qdrantUrl }
      : { url: config.qdrantUrl, apiKey: config.qdrantApiKey },
  )
  const documents = new PostgresDocumentStore(pool, APP_ROLE)

  // Absent when a deployment has none, which is the supported default: document
  // bytes then live in `documents.source_ref` and no target ever names an
  // object. `loadConfig` refuses a half-configured block, so this is either
  // fully usable or not there.
  const objects = config.s3 === undefined ? undefined : new S3(config.s3)

  const collectPorts = {
    claim: (limit: number, grace: number) => claimPurgeable(pool, limit, grace, config.indexLease),
    purge: vectors.purge.bind(vectors),
    // Never reached on a deployment without object storage: no target carries
    // a key there, so this is unreachable rather than a no-op that could later
    // be mistaken for one that works.
    removeObject: async (key: string) => {
      if (objects === undefined) {
        throw new Error(
          `document names object ${key} but this worker has no object storage configured`,
        )
      }
      await objects.remove(key)
    },
    markPurged: documents.markPurged.bind(documents),
    onError: (target: { documentId: string }, error: unknown) => {
      logger.error('purge failed', { document_id: target.documentId, error: String(error) })
    },
  }

  const reapPorts = {
    claim: (limit: number, lease: number, max: number) => claimStranded(pool, limit, lease, max),
    onReaped: (document: { documentId: string; heldSeconds: number; attempts: number }, outcome: string) => {
      logger.warn('reclaimed an abandoned claim', { document_id: document.documentId,
          held_seconds: Math.round(document.heldSeconds),
          attempts: document.attempts,
          outcome })
    },
  }

  const retirePorts = {
    due: (days: number, limit: number) => dueCollections(pool, days, limit),
    isLive: (name: string) => isLiveCollection(pool, name),
    // Tolerates one that is already gone, which is the state a pass that
    // dropped and then failed to forget leaves behind.
    drop: async (name: string) => {
      await store.dropCollection(name)
    },
    forget: (collection: { orgId: string; name: string }) => forgetCollection(pool, collection),
    onDropped: (collection: { orgId: string; name: string }) => {
      logger.info('collection dropped', { collection: collection.name })
    },
    onRevived: (collection: { orgId: string; name: string }) => {
      // Not an error. The pointer went back to it, which is the cheap rollback,
      // and the row is stale rather than the collection being wrong.
      logger.info('collection is live again, not dropping', { collection: collection.name })
    },
    onError: (collection: { orgId: string; name: string }, error: unknown) => {
      logger.error('collection drop failed', { collection: collection.name, error: String(error) })
    },
  }

  const vectorRetirePorts = {
    due: (days: number, limit: number) => dueVectors(pool, days, limit),
    drop: (collection: string, layerId: string, vectorName: string) =>
      store.dropLayerVector(collection, layerId, vectorName),
    forget: (target: { orgId: string; layerId: string }) =>
      forgetVector(pool, target.orgId, target.layerId, APP_ROLE),
    onDropped: (target: { layerId: string; vectorName: string }) => {
      logger.info('vector slot reclaimed', { layer_id: target.layerId, vector: target.vectorName })
    },
    onError: (target: { layerId: string; vectorName: string }, error: unknown) => {
      logger.error('vector slot reclaim failed', {
        layer_id: target.layerId,
        vector: target.vectorName,
        error: String(error),
      })
    },
  }

  const prunePorts = {
    tokens: (limit: number) => pruneExpiredTokens(pool, limit),
    audit: (days: number, limit: number) => pruneAuditEvents(pool, days, limit),
    onError: (what: string, error: unknown) => {
      // Warn rather than error: nothing is broken by a prune that did not run,
      // and the one failure an operator must act on — a retention below the
      // function's floor — carries its own message from the database.
      logger.warn('prune failed', { what, error: String(error) })
    },
  }

  /**
   * Embedders, one per provider, built on first use.
   *
   * Per provider and not one for the whole process. Ingest used to embed with
   * `NACRE_DEFAULT_EMBEDDING_*` whatever the layer's provider said, so a layer
   * on a second provider had 1024-dim vectors written into its 768-dim slot and
   * every document in it failed on `Vector dimension error`. A reindex embeds
   * with the shadow provider's model for the same reason — that one was wired,
   * and the ordinary path was not.
   *
   * The endpoint and model come from the `embedding_providers` row, which is
   * where they have always been: this process's configuration only ever
   * supplied the installation *default*, which `init` writes into that table as
   * the global row.
   */
  const embedders = new Map<string, (texts: readonly string[]) => Promise<readonly (readonly number[])[]>>()
  const embedderFor = async (providerId: string) => {
    const cached = embedders.get(providerId)
    if (cached !== undefined) return cached

    const { rows } = await acrossOrganizations(pool, (client) =>
      client.query<{ endpoint: string; model: string; name: string }>(
        'SELECT endpoint, model, name FROM embedding_providers WHERE id = $1',
        [providerId],
      ),
    )
    const provider = rows[0]
    if (provider === undefined) throw new Error(`no embedding provider ${providerId}`)

    const embed = async (texts: readonly string[]) => {
      const endpoint = endpointUrl(provider.endpoint, 'embeddings')

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: provider.model, input: texts }),
          // Bounded, for the same reason the parser call is: this worker is
          // serial, so an embedder that accepts connections and never answers
          // stops indexing for every tenant until undici's 300 s default gives
          // up. Generous, because a batch on a CPU-only endpoint is genuinely
          // slow.
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
        })
      } catch (cause) {
        // `TypeError: fetch failed` and nothing else is what an operator used to
        // get here, in the job's `error` column and in the log. It does not say
        // what was called, or that an embedding endpoint is a thing they have to
        // supply — and this is the first failure anyone following the quickstart
        // meets, because the documented `minimal` profile starts no embedder.
        //
        // undici puts the real reason in `cause`: ENOTFOUND for a name that does
        // not resolve, ECONNREFUSED for a port with nothing on it, a timeout for
        // one that accepts and never answers. Naming the URL matters as much:
        // the endpoint comes from an `embedding_providers` row, so "which one"
        // is the question the message has to answer.
        throw embeddingFailure(cause, endpoint, provider.name)
      }

      if (!response.ok) {
        throw new Error(`the embedding endpoint at ${endpoint.href} answered ${response.status}`)
      }
      const body = (await response.json()) as { data?: { embedding?: number[] }[] }
      return (body.data ?? []).map((d) => d.embedding ?? [])
    }

    embedders.set(providerId, embed)
    return embed
  }

  /**
   * The cheap half of a model migration, and the reason it exists.
   *
   * A named vector cannot be added to a live Qdrant collection. So the way to
   * make room for a new model is to build a collection that already has the
   * slot, move every point across carrying the vectors it already had, and
   * switch which collection the organization points at.
   *
   * **No embeddings are computed here.** Vectors come out of the old collection
   * and go into the new one unchanged; the new slot stays empty until a layer
   * is reindexed into it. That is what makes this affordable to do once for the
   * whole organization while the expensive half stays per layer.
   *
   * Search is unaffected throughout: it reads the old collection until the
   * pointer moves, and the new one is byte-for-byte the same data afterwards.
   */
  const copyOnce = async (): Promise<number> => {
    const targets = await claimCopyable(pool, 1)
    let done = 0

    for (const target of targets) {
      // A name derived from the old one rather than random, so an operator
      // looking at Qdrant can tell which collection replaced which.
      const to = `${target.collection}_${target.shadowVector}`
      try {
        logger.info('copying collection', { org: target.orgSlug, from: target.collection, to })
        await store.copyCollection({
          from: target.collection,
          to,
          addVector: { name: target.shadowVector, size: target.dimensions },
        })
        await finishCopy(pool, target.orgId, to, APP_ROLE)
        logger.info('collection copied', { org: target.orgSlug, collection: to })
        done++
      } catch (error) {
        // Failed rather than left running. A layer that sits in `copying`
        // forever with nothing happening is the worst outcome here: the
        // operator watches a progress number that will never move and has
        // nothing to read. The old collection is untouched and still live, so
        // failing costs only the attempt.
        logger.error('collection copy failed', { org: target.orgSlug, error: String(error) })
        await failReindex(pool, target.orgId, target.layerId, String(error), APP_ROLE).catch(() => {})
      }
    }

    return done
  }

  const reindexPorts = {
    claim: (limit: number) => claimReindexable(pool, limit),
    embed: async (providerId: string, texts: readonly string[]) =>
      (await embedderFor(providerId))(texts),
    addVector: vectors.addVector.bind(vectors),
    markReindexed: (orgId: string, documentId: string, shadow: string) =>
      markReindexed(pool, orgId, documentId, shadow, APP_ROLE),
    finishIfDone: (orgId: string, layerId: string, shadow: string) =>
      finishReindexIfDone(pool, orgId, layerId, shadow, APP_ROLE),
    recordPass: (input: {
      orgId: string
      layerId: string
      shadowVector: string
      succeeded: number
      failed: number
      error?: string
    }) => recordReindexPass(pool, input, REINDEX_FAILURE_BOUND, APP_ROLE),
    onError: (target: { documentId: string }, error: unknown) => {
      logger.error('reindex failed', { document_id: target.documentId, error: String(error) })
    },
  }

  const recallPorts: RecallPorts = {
    due: (limit: number) => dueChecks(pool, limit),
    embed: async (providerId: string, texts: readonly string[]) =>
      (await embedderFor(providerId))(texts),
    retrieve: (target, vector, k) =>
      vectors.retrieveDocuments({
        collection: target.collection,
        orgId: target.orgId,
        layerId: target.layerId,
        // The shadow slot, which is the whole point: the live one is the model
        // being migrated away from and would score the question that is not
        // being asked.
        vectorName: target.shadowVector,
        vector,
        limit: k,
      }),
    record: (target, verdict) =>
      recordCheck(pool, target.orgId, target.layerId, target.shadowVector, verdict, APP_ROLE),
    finishIfDone: (orgId: string, layerId: string, shadow: string) =>
      finishReindexIfDone(pool, orgId, layerId, shadow, APP_ROLE),
    fail: (target, reason) =>
      failReindex(pool, target.orgId, target.layerId, reason, APP_ROLE),
    onChecked: (target, verdict) => {
      // The numbers and never the queries. A reference query is the operator's
      // own text rather than a caller's, so this is not the rule about query
      // text — but a log line is the wrong place for either, and the ids join
      // to the set through the endpoint that lists it.
      logger.info('reindex recall check', {
        layer_id: target.layerId,
        recall: Number(verdict.recall.toFixed(4)),
        floor: verdict.floor,
        passed: verdict.passed,
        queries: verdict.queries,
        ...(verdict.unresolved === undefined ? {} : { unresolved: verdict.unresolved.length }),
      })
    },
    onError: (target, error) => {
      logger.error('recall check failed to run', {
        layer_id: target.layerId,
        error: String(error),
      })
    },
  }

  // Not zero: a sweep on the first idle tick would run before the process has
  // done anything, which is a destructive operation racing a cold start.
  let lastCollect = Date.now()
  let lastReindex = 0

  // Same reasoning, and more of it. This one deletes rows outright, so a worker
  // that crash-loops must not get a prune attempt per restart.
  let lastPrune = Date.now()

  // Zero, unlike collection. A worker starting up is very often a worker
  // replacing one that died, and the documents that one abandoned are the first
  // thing worth looking for. Reaping is also not destructive — the worst case
  // is indexing a document twice, and ingest is idempotent.
  let lastReap = 0

  let running = true
  // Woken by the signal handler so an idle sleep does not have to run out.
  let wake: (() => void) | undefined

  /**
   * Sleep, unless we are asked to stop first.
   *
   * The loop's idle wait backs off to 30 seconds, which is exactly Kubernetes'
   * default grace period — so a SIGTERM arriving just after a sleep began sat
   * there until the orchestrator lost patience and SIGKILLed. That is survivable
   * (the lease reclaims the document) and it made every drain a kill.
   */
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!running) return resolve()
      const timer = setTimeout(() => {
        wake = undefined
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(timer)
        wake = undefined
        resolve()
      }
    })

  const stop = (signal: string) => {
    logger.info('draining', { signal })
    running = false
    wake?.()
  }

  // The guards own the signals; `stop` only sets the flag and wakes the sleep.
  // The loop finishes the document it holds and exits on its own — and if it
  // cannot, the deadline in installGuards exits anyway rather than waiting for
  // a SIGKILL. A document interrupted mid-pipeline is reclaimed by its lease.
  installGuards({ service: 'worker', shutdown: async () => { stop('shutdown'); await pool.end() } })

  logger.info('worker started', { env: config.env })

  while (running) {
    let claim: Claim | undefined
    try {
      claim = await claimNext(pool)
    } catch (error) {
      logger.error('claim failed', { error: String(error) })
      await sleep(IDLE_MS)
      continue
    }

    if (claim === undefined) {
      // The idle wait, one value for every background pass.
      //
      // It used to back off when the retag sweep failed repeatedly, and that
      // sweep is gone — see migration 0016. No other pass ever set it: reap,
      // collect, reindex and prune each catch, log, and fall through to the
      // same sleep, so the loop's timing is now one number rather than one
      // number and an exception.
      const wait = IDLE_MS

      // Reaping first among the background passes, because it is the one that
      // puts work back into the queue and the loop is about to sleep. On its
      // own clock, and never skipped by another pass failing — the jobs share
      // a loop, not a fate.
      if (Date.now() - lastReap >= REAP_EVERY_MS) {
        lastReap = Date.now()
        try {
          const reaped = await reapOnce(reapPorts, REAP_BATCH, config.indexLease, config.indexMaxAttempts)
          if (reaped.requeued > 0) {
            // Requeued documents are claimable right now, so go take one rather
            // than sleeping first.
            continue
          }
        } catch (error) {
          logger.error('reap pass failed', { error: String(error) })
        }
      }

      // Rate-limited by its own clock rather than by the idle loop. Retagging
      // affects what a query returns and should chase the backlog; collection
      // only reclaims space, so running it every two seconds would be a query
      // against every tenant's documents for no benefit.
      //
      // Reached whether or not retagging just failed, which it was not before:
      // the retag branch returned early on failure, so a document whose
      // collection no longer exists — one `Not Found` forever — meant the
      // collector never ran again for as long as that row was in the queue.
      // The two jobs share a loop, not a fate. A vector store that refuses
      // setPayload can still accept a delete, and when it cannot, the sweep
      // costs one indexed query that comes back empty.
      if (Date.now() - lastCollect >= GC_EVERY_MS) {
        lastCollect = Date.now()
        try {
          const swept = await collectOnce(collectPorts, GC_BATCH, config.gcGrace)
          if (swept.purged > 0 || swept.failed > 0) {
            logger.info('collected', { ...swept })
          }
          // A full batch means the backlog is longer than one sweep, so the next
          // one runs on the idle tick rather than a minute later. Anything less
          // has drained the queue, and there is nothing to hurry back to.
          if (swept.purged >= GC_BATCH) {
            lastCollect = 0
            continue
          }
        } catch (error) {
          logger.error('collect pass failed', { error: String(error) })
        }
      }

      // Before retention and after collection. A reindex is the only one of
      // these an operator is watching in real time, and it is the only one that
      // changes what a search returns when it finishes.
      if (Date.now() - lastReindex >= REINDEX_EVERY_MS) {
        lastReindex = Date.now()
        try {
          // The copy first. A layer in the copy phase has no room to embed
          // into, so running the embedding pass before it would claim
          // documents and fail every one on a vector that does not exist yet.
          const copied = await copyOnce()
          if (copied > 0) {
            lastReindex = 0
            continue
          }

          const pass = await reindexOnce(reindexPorts, REINDEX_BATCH)
          if (pass.reindexed > 0 || pass.failed > 0 || pass.switched > 0) {
            logger.info('reindexed', { ...pass })
          }

          // After the embedding pass and before the next one, on the same
          // clock. `dueChecks` selects only layers with nothing outstanding, so
          // this is a no-op for every pass of a migration except the last —
          // and running it here rather than on the retention clock means an
          // operator watching a reindex is not told it finished an hour after
          // it did.
          //
          // Its own try/catch: a check that cannot run is not a migration that
          // failed, and an unreachable embedder must not stop the batches
          // above from continuing on the next tick.
          try {
            const checked = await recallOnce(recallPorts, config.reindexMinRecall, RECALL_BATCH)
            if (checked.passed > 0 || checked.failed > 0 || checked.errored > 0 || checked.switched > 0) {
              logger.info('recall checked', { ...checked })
            }
          } catch (error) {
            logger.error('recall pass failed', { error: String(error) })
          }
          // A full batch means there is more, so come back now rather than in
          // five seconds. A migration of a large layer should not be paced by
          // an idle timer.
          if (pass.reindexed >= REINDEX_BATCH) {
            lastReindex = 0
            continue
          }
        } catch (error) {
          logger.error('reindex pass failed', { error: String(error) })
        }
      }

      // Last, and on the longest clock. Retention competes with nothing: no
      // request waits on it, no metric moves when it runs, and the tables it
      // touches are read on the login path and nowhere else. Its own try/catch
      // is inside pruneOnce, which is why there is none here — the two tables
      // fail separately and a refused audit prune must not stop token expiry.
      if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
        lastPrune = Date.now()
        const pruned = await pruneOnce(prunePorts, PRUNE_BATCH, config.auditRetentionDays)
        if (pruned.tokens > 0 || pruned.audit > 0) {
          logger.info('pruned', { ...pruned })
        }

        // Same clock, and deliberately not the same function: retention here is
        // a rollback window over data in Qdrant, and the tables above are rows
        // in Postgres. A failure to reach Qdrant must not look like a failed
        // audit prune, and its own errors are per collection inside retireOnce.
        try {
          const retired = await retireOnce(
            retirePorts,
            config.collectionRetentionDays,
            RETIRE_BATCH,
          )
          if (retired.dropped > 0 || retired.revived > 0 || retired.failed > 0) {
            logger.info('collections retired', { ...retired })
          }
        } catch (error) {
          logger.error('retire pass failed', { error: String(error) })
        }

        // The slot inside the collection that survived the copy, on the same
        // clock and the same window. Its own try/catch because an unreachable
        // Qdrant must not look like a failed collection sweep, and the two
        // reclaim different things.
        try {
          const slots = await retireVectorsOnce(
            vectorRetirePorts,
            config.collectionRetentionDays,
            RETIRE_BATCH,
          )
          if (slots.dropped > 0 || slots.failed > 0) {
            logger.info('vector slots retired', { ...slots })
          }
        } catch (error) {
          logger.error('vector retire pass failed', { error: String(error) })
        }
      }

      await sleep(wait)
      continue
    }

    try {
      // Three shapes, and the s3 one is a fetch rather than a field.
      //
      // A missing object is failed rather than indexed as empty. The bytes were
      // written before the row — that ordering is in NacreIngest — so an object
      // that is not there means it was removed underneath us, and an empty
      // document silently replacing it would delete the content from every
      // answer while reporting success.
      let source: { url: string } | { content: string } | { bytes: Uint8Array; contentType: string }
      if (claim.sourceType === 's3' && claim.sourceRef !== null) {
        if (objects === undefined) {
          throw new Error(
            `document ${claim.documentId} is stored in object storage and this worker has none configured`,
          )
        }
        const bytes = await objects.get(claim.sourceRef)
        if (bytes === undefined) {
          throw new Error(`object ${claim.sourceRef} is missing from the bucket`)
        }
        if (claim.contentType === 'application/pdf') {
          // Binary goes to the parser as bytes under its real type; extraction
          // is the sidecar's job and the text never exists on this side.
          source = { bytes, contentType: claim.contentType }
        } else {
          // Text objects were validated as UTF-8 at the edge, so a decode
          // failure here means the bucket returned different bytes than were
          // stored — worth a failed row with a reason, never a silent mangle.
          try {
            source = { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
          } catch {
            throw new Error(
              `object ${claim.sourceRef} is not the UTF-8 text that was stored; the bucket's copy is corrupt`,
            )
          }
        }
      } else if (claim.sourceType === 'url' && claim.sourceRef !== null) {
        source = { url: claim.sourceRef }
      } else {
        source = { content: claim.sourceRef ?? '' }
      }

      const result = await ingest(
        {
          orgId: claim.orgId,
          collection: claim.collection,
          layerId: claim.layerId,
          vectorName: claim.vectorName,
          externalId: claim.externalId,
          metadata: claim.metadata,
          ...source,
        },
        {
          parser,
          // The layer's provider, resolved per claim. Not a process-wide
          // embedder: `layers.provider_id` decides which model a layer's
          // vectors are, and the slot they go into is named after it.
          embedder: { embed: async (texts) => (await embedderFor(claim.providerId))(texts) },
          documents,
          vectors,
          newId: randomUUID,
        },
      )

      logger.info('indexed', { document_id: result.documentId,
          chunks: result.chunkCount,
          unchanged: result.unchanged })
    } catch (error) {
      logger.error('indexing failed', { document_id: claim.documentId, error: String(error) })
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
  logger.error('failed to start', { error: String(error) })
  process.exit(1)
})
