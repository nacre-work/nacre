import { randomUUID } from 'node:crypto'

import { QdrantClient } from '@qdrant/js-client-rest'
import {
  configureLogging,
  acrossOrganizations,
  ConfigError,
  createPool,
  endpointReason,
  embedInBatches,
  endpointUrl,
  modelEndpointRefused,
  installGuards,
  logger,
  S3,
  VectorStore,
  vectorStoreOptions,
  loadConfig,
} from '@nacre.work/core'

import {
  claimCopyable,
  renewCopyClaim,
  repairAfterCopy,
  claimPurgeable,
  claimReindexable,
  dueChecks,
  claimStranded,
  dueCollections,
  dueVectors,
  failReindex,
  finishCopy,
  finishReindexIfDone,
  pendingReindexes,
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
import { DEFAULT_CHUNK_CONFIG } from './chunk.js'
import { ingest } from './ingest.js'
import { collectOnce } from './collect.js'
import { pruneOnce } from './prune.js'
import { reapOnce } from './reap.js'
import { reindexOnce } from './reindex.js'
import { recallOnce, type RecallPorts } from './recall.js'
import { retireOnce, retireVectorsOnce } from './retire.js'
import { claimNext, type Claim } from './claim.js'
import { recordFailure } from './retry.js'

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
  const store = new VectorStore(vectorStoreOptions(config))
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
    stillDeleted: documents.stillDeleted.bind(documents),
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

    // Bounded, and the bound is the endpoint's rather than a guess: TEI answers
    // **413** above `--max-client-batch-size`, which defaults to 32, and this
    // used to send a document's whole chunk list in one request. At 800
    // characters a chunk that is roughly 22 KB of text, past which every
    // document failed permanently — nothing retries `failed` — while the layer
    // went on answering searches with whatever had indexed. See
    // `embedInBatches`.
    const embed = async (texts: readonly string[]) =>
      embedInBatches(texts, config.embedBatch, (batch) => sendBatch(batch))

    const sendBatch = async (texts: readonly string[]) => {
      const endpoint = endpointUrl(provider.endpoint, 'embeddings')

      let response: Response
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: provider.model, input: texts }),
          // A 3xx is refused, not followed. The endpoint passed the egress
          // guard when the provider row was written; following a redirect at
          // fetch time is how a create-time-validated public host reaches an
          // internal one — `302 Location: http://169.254.169.254/…`. Closing it
          // here is the fetch-path half of that guard.
          redirect: 'error',
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
        throw modelEndpointRefused(
          'embedding',
          endpoint,
          response.status,
          await endpointReason(response),
        )
      }
      const body = (await response.json()) as {
        data?: { embedding?: number[]; index?: number }[]
      }
      // By `index` where the endpoint sends one, never by arrival: the
      // response contract carries the field because some vendors reorder —
      // this repository's own embedding adapter sorts by it for exactly that
      // reason — and trusting arrival order attaches the wrong vector to the
      // wrong chunk with the count check green. And a missing `embedding` is
      // a refusal, not `[]`: an empty vector passes the count check here and
      // fails later as a Qdrant dimension error naming neither the provider
      // nor the entry.
      const data = [...(body.data ?? [])]
      if (data.some((d) => typeof d.index === 'number')) {
        data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      }
      return data.map((d, at) => {
        if (d.embedding === undefined) {
          throw new Error(
            `embedding endpoint ${endpoint} answered entry ${String(d.index ?? at)} with no embedding`,
          )
        }
        return d.embedding
      })
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
    const targets = await claimCopyable(pool, 1, config.indexLease)
    let done = 0

    for (const target of targets) {
      // A name derived from the old one rather than random, so an operator
      // looking at Qdrant can tell which collection replaced which.
      const to = `${target.collection}_${target.shadowVector}`
      // The lease is renewed from the copy's own progress, because a copy of
      // a large collection outlives any fixed lease: the lease exists so a
      // dead worker's claim expires, and a live one proves it is alive here.
      // A renewal that answers false means another worker holds the claim —
      // the copy is abandoned by throwing, and nothing below may finish or
      // fail a migration that is no longer this worker's.
      let lost = false
      let renewedAt = Date.now()
      const renew = async (): Promise<void> => {
        if (Date.now() - renewedAt < 30_000) return
        renewedAt = Date.now()
        if (!(await renewCopyClaim(pool, target.orgId, target.layerId, target.claim, APP_ROLE))) {
          lost = true
          throw new Error('the copy claim moved to another worker')
        }
      }
      try {
        logger.info('copying collection', { org: target.orgSlug, from: target.collection, to })
        await store.copyCollection({
          from: target.collection,
          to,
          addVector: { name: target.shadowVector, size: target.dimensions },
          onProgress: renew,
        })
        const finished = await finishCopy(pool, target.orgId, target.layerId, target.claim, to, APP_ROLE)
        if (!finished) {
          // The fence refused: the claim moved while the last page was in
          // flight. The new holder's copy is the one that will finish.
          logger.warn('copy finished by another worker', { org: target.orgSlug })
          continue
        }
        // What moved underneath the scroll — deletes, PATCHes, and documents
        // claimed before the copy began — is requeued or re-tombstoned now,
        // against the collection that just went live. See repairAfterCopy.
        const repaired = await repairAfterCopy(pool, target.orgId, target.startedAt, APP_ROLE)
        for (const documentId of repaired.tombstoned) {
          // Re-assert the tombstone in the new collection so the pre-filter
          // holds immediately; the cleared vectors_purged_at already sent the
          // collector back for the physical removal, which is also what makes
          // a failure here a retry rather than a leak.
          await vectors.tombstone(to, documentId).catch((error: unknown) => {
            logger.error('re-tombstone after copy failed', {
              document_id: documentId,
              error: String(error),
            })
          })
        }
        if (repaired.requeued > 0 || repaired.tombstoned.length > 0) {
          logger.info('repaired copy drift', {
            org: target.orgSlug,
            requeued: repaired.requeued,
            retombstoned: repaired.tombstoned.length,
          })
        }
        logger.info('collection copied', { org: target.orgSlug, collection: to })
        done++
      } catch (error) {
        if (lost) {
          logger.warn('abandoning copy: the claim moved to another worker', { org: target.orgSlug })
          continue
        }
        // Failed rather than left running. A layer that sits in `copying`
        // forever with nothing happening is the worst outcome here: the
        // operator watches a progress number that will never move and has
        // nothing to read. The old collection is untouched and still live, so
        // failing costs only the attempt. Guarded on the claim, because a
        // worker that lost it must not mark the new holder's healthy copy
        // failed — the renewal doubles as "is it still mine".
        logger.error('collection copy failed', { org: target.orgSlug, error: String(error) })
        const stillOurs = await renewCopyClaim(
          pool,
          target.orgId,
          target.layerId,
          target.claim,
          APP_ROLE,
        ).catch(() => false)
        if (stillOurs) {
          await failReindex(pool, target.orgId, target.layerId, String(error), APP_ROLE).catch(() => {})
        }
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
    pending: () => pendingReindexes(pool),
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
  // thing worth looking for. Reaping is also not destructive — the common case
  // of a reclaimed document is indexing it twice, and ingest is idempotent.
  //
  // The honest worst case is worse and is a recorded limitation rather than a
  // solved one: nothing fences the original claimant. A worker stalled past
  // NACRE_INDEX_LEASE that then wakes interleaves its chunk upsert and point
  // sweep with its replacement's, and the two passes can leave chunk rows
  // from one and points from the other — a document whose hits hydrate to
  // nothing. The lease bounds abandonment, not overlap; a fencing token
  // checked by the upsert is what overlap needs, and this comment exists so
  // the next reader does not take the sentence above for that guarantee.
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

  /**
   * One tick of every background clock: reap, collect, copy/reindex/recall,
   * prune and retire, each on its own timer.
   *
   * Called from the idle branch *and* after every processed document, because
   * these passes used to live only in the idle branch — so any sustained
   * ingest backlog (a bulk --watch, or a fleet scaled out precisely because
   * it is busy) starved all of them for its whole duration: no lease reaping,
   * no garbage collection, no progress on the reindex an operator is
   * watching, no retention. Each pass keeps its own clock, so when nothing is
   * due this costs a few Date.now() comparisons per document.
   *
   * Returns true when a pass put claimable work back or left a backlog worth
   * returning to now — the idle branch skips its sleep on that answer.
   */
  const backgroundOnce = async (): Promise<boolean> => {
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
            return true
          }
        } catch (error) {
          logger.error('reap pass failed', { error: String(error) })
        }
      }

      // Rate-limited by its own clock rather than by the idle loop, because
      // collection only reclaims space: running it every two seconds would be
      // a query against every tenant's documents for no benefit. It used to
      // draw that contrast against retagging, which chased a backlog that
      // affected what a query returned — that sweep went with migration 0016,
      // so the clock is now justified on its own terms rather than against a
      // pass that is no longer here.
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
            return true
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
            return true
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
            return true
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
    return false
  }

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
      if (await backgroundOnce()) continue
      await sleep(IDLE_MS)
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
          // The ceiling the deployment's embedder enforces, so chunking is
          // bounded by what the model accepts and not only by a character
          // count. Without it a Cyrillic or CJK corpus failed every document:
          // 800 characters is 149 tokens of English and 1094 of Korean, and
          // the endpoint refuses above 512.
          chunkConfig: { ...DEFAULT_CHUNK_CONFIG, maxTokens: config.embedMaxTokens },
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
      // Reported after the decision rather than before it, so the log says
      // which of the two happened. "indexing failed" on a document that is
      // about to be retried reads as a lost document and sends an operator
      // looking for one.
      const outcome = await recordFailure(pool, claim, error, config.indexMaxAttempts).catch(
        () => undefined,
      )
      logger.error(outcome?.retrying === true ? 'indexing failed, will retry' : 'indexing failed', {
        document_id: claim.documentId,
        error: String(error),
        reason: outcome?.reason,
        attempts: claim.attempts,
        max_attempts: config.indexMaxAttempts,
      })
    }

    // The clocks tick while the queue is busy too. These passes used to run
    // only from the idle branch, so any sustained ingest backlog — a bulk
    // --watch, or a fleet scaled out precisely because it is busy — starved
    // all of them for its whole duration: no lease reaping, no garbage
    // collection, no progress on the reindex an operator is watching, no
    // retention. Each pass keeps its own clock, so when nothing is due this
    // is a few comparisons per document. The return value is the idle
    // branch's business; here the next claim is fetched either way.
    await backgroundOnce()
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
