import { randomUUID } from 'node:crypto'

import { QdrantClient } from '@qdrant/js-client-rest'
import {
  acrossOrganizations,
  ConfigError,
  createPool,
  installGuards,
  loadConfig,
  withOrg,
} from '@nacre.work/core'

import {
  claimPurgeable,
  claimStale,
  claimStranded,
  HttpParser,
  PostgresDocumentStore,
  pruneAuditEvents,
  pruneExpiredTokens,
  QdrantVectorWriter,
  tagsForLayer,
} from './adapters.js'
import { ingest } from './ingest.js'
import { collectOnce } from './collect.js'
import { pruneOnce } from './prune.js'
import { reapOnce } from './reap.js'
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

/** See the call site. Two minutes, and never unbounded. */
const EMBED_TIMEOUT_MS = 120_000
const IDLE_MS = 2000

// What a pass that only failed waits before the next one. A failing retag pass
// used to skip the idle sleep along with the successful ones — the loop treated
// "something happened" as "there is more to do" — so an unreachable vector store
// turned the worker into a spin at full CPU, logging one line per attempt. The
// cap is small on purpose: this backs off a broken dependency, it does not give
// up on it, and propagation lag is accruing the whole time.
const BACKOFF_MS = 2000
const BACKOFF_MAX_MS = 30_000

// The recomputation pass. Bounded because a revocation across a large layer can
// touch every document in it, and an unbounded sweep would take the vector
// store down at exactly the moment correctness depends on it being reachable.
const RETAG_BATCH = 50
const RETAG_CONCURRENCY = 4

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
      orgSlug: row.slug,
      documentId: row.id,
      layerId: row.layer_id,
      externalId: row.external_id ?? row.id,
      vectorName: row.vector_name,
      sourceRef: row.source_ref,
      sourceType: row.source_type,
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
      // Bounded, for the same reason the parser call is: this worker is serial,
      // so an embedder that accepts connections and never answers stops
      // indexing for every tenant until undici's 300 s default gives up.
      // Generous, because a batch on a CPU-only endpoint is genuinely slow.
      const response = await fetch(new URL('/embeddings', config.embeddingEndpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.embeddingModel, input: texts }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
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

  const collectPorts = {
    claim: (limit: number, grace: number) => claimPurgeable(pool, limit, grace),
    purge: vectors.purge.bind(vectors),
    markPurged: documents.markPurged.bind(documents),
    onError: (target: { documentId: string }, error: unknown) => {
      console.error(
        JSON.stringify({ msg: 'purge failed', document_id: target.documentId, error: String(error) }),
      )
    },
  }

  const reapPorts = {
    claim: (limit: number, lease: number, max: number) => claimStranded(pool, limit, lease, max),
    onReaped: (document: { documentId: string; heldSeconds: number; attempts: number }, outcome: string) => {
      console.warn(
        JSON.stringify({
          msg: 'reclaimed an abandoned claim',
          document_id: document.documentId,
          held_seconds: Math.round(document.heldSeconds),
          attempts: document.attempts,
          outcome,
        }),
      )
    },
  }

  const prunePorts = {
    tokens: (limit: number) => pruneExpiredTokens(pool, limit),
    audit: (days: number, limit: number) => pruneAuditEvents(pool, days, limit),
    onError: (what: string, error: unknown) => {
      // Warn rather than error: nothing is broken by a prune that did not run,
      // and the one failure an operator must act on — a retention below the
      // function's floor — carries its own message from the database.
      console.warn(JSON.stringify({ msg: 'prune failed', what, error: String(error) }))
    },
  }

  // Not zero: a sweep on the first idle tick would run before the process has
  // done anything, which is a destructive operation racing a cold start.
  let lastCollect = Date.now()

  // Same reasoning, and more of it. This one deletes rows outright, so a worker
  // that crash-loops must not get a prune attempt per restart.
  let lastPrune = Date.now()

  // Zero, unlike collection. A worker starting up is very often a worker
  // replacing one that died, and the documents that one abandoned are the first
  // thing worth looking for. Reaping is also not destructive — the worst case
  // is indexing a document twice, and ingest is idempotent.
  let lastReap = 0

  // Consecutive passes that did nothing but fail. Reset by any progress, so a
  // single bad document among healthy ones never slows the loop down.
  let barren = 0
  const backoff = () => Math.min(BACKOFF_MS * 2 ** Math.min(barren, 5), BACKOFF_MAX_MS)

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
    console.log(JSON.stringify({ msg: 'draining', signal }))
    running = false
    wake?.()
  }

  // The guards own the signals; `stop` only sets the flag and wakes the sleep.
  // The loop finishes the document it holds and exits on its own — and if it
  // cannot, the deadline in installGuards exits anyway rather than waiting for
  // a SIGKILL. A document interrupted mid-pipeline is reclaimed by its lease.
  installGuards({ service: 'worker', shutdown: async () => { stop('shutdown'); await pool.end() } })

  console.log(JSON.stringify({ msg: 'worker started', env: config.env }))

  while (running) {
    let claim: Claim | undefined
    try {
      claim = await claimNext(pool)
    } catch (error) {
      console.error(JSON.stringify({ msg: 'claim failed', error: String(error) }))
      await sleep(IDLE_MS)
      continue
    }

    if (claim === undefined) {
      // How long to wait at the bottom. A failing pass sets it higher; nothing
      // below returns early on a failure, because an early return here is what
      // let one unhealthy job hold the others hostage.
      let wait = IDLE_MS

      // Indexing first, retagging in the gaps. A document nobody can find yet
      // is a worse outage than a permission cache a few seconds behind, and
      // the SLA the lag is measured against has room for the wait.
      try {
        const pass = await retagOnce(retagPorts, RETAG_BATCH, RETAG_CONCURRENCY)
        if (pass.retagged > 0 || pass.failed > 0) {
          console.log(JSON.stringify({ msg: 'retagged', ...pass }))
        }
        // Only progress earns another immediate pass. A pass that retagged
        // nothing and failed on everything will fail again in two milliseconds,
        // and the claim it repeats is a query per attempt against every tenant.
        if (pass.retagged > 0) {
          barren = 0
          continue
        }
        if (pass.failed > 0) {
          barren++
          wait = backoff()
        } else {
          barren = 0
        }
      } catch (error) {
        console.error(JSON.stringify({ msg: 'retag pass failed', error: String(error) }))
        barren++
        wait = backoff()
      }

      // Before collection, because this one puts work back into the queue and
      // the loop is about to go to sleep for two seconds. Also on its own clock
      // and never skipped by an unhealthy retag, for the same reason.
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
          console.error(JSON.stringify({ msg: 'reap pass failed', error: String(error) }))
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
            console.log(JSON.stringify({ msg: 'collected', ...swept }))
          }
          // A full batch means the backlog is longer than one sweep, so the next
          // one runs on the idle tick rather than a minute later. Anything less
          // has drained the queue, and there is nothing to hurry back to.
          if (swept.purged >= GC_BATCH) {
            lastCollect = 0
            continue
          }
        } catch (error) {
          console.error(JSON.stringify({ msg: 'collect pass failed', error: String(error) }))
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
          console.log(JSON.stringify({ msg: 'pruned', ...pruned }))
        }
      }

      await sleep(wait)
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
