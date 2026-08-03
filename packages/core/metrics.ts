/**
 * A minimal Prometheus registry.
 *
 * Dependency-free because the exposition format is four lines of rules and this
 * container reads documents for a living — every dependency in it is something
 * to keep patched. If the needs here outgrow histograms and gauges, replace it
 * with prom-client rather than growing this file.
 */

export type Labels = Readonly<Record<string, string>>

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}

function series(name: string, labels: Labels): string {
  const pairs = Object.entries(labels)
    .filter(([, v]) => v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
  return pairs.length === 0 ? name : `${name}{${pairs.join(',')}}`
}

interface Metric {
  readonly name: string
  readonly help: string
  readonly type: 'counter' | 'gauge' | 'histogram'
  render(): string[]
}

export class Counter implements Metric {
  readonly type = 'counter' as const
  readonly #values = new Map<string, { labels: Labels; value: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
  ) {
    if (!NAME.test(name)) throw new Error(`not a valid metric name: ${name}`)
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = series(this.name, labels)
    const entry = this.#values.get(key) ?? { labels, value: 0 }
    entry.value += by
    this.#values.set(key, entry)
  }

  render(): string[] {
    // A counter with no observations is still reported, at zero. An absent
    // series and a zero series look the same on a graph and mean opposite
    // things: "nothing happened" versus "the exporter is not running".
    if (this.#values.size === 0) return [`${this.name} 0`]
    return [...this.#values].map(([key, e]) => `${key} ${e.value}`)
  }
}

export class Gauge implements Metric {
  readonly type = 'gauge' as const
  readonly #values = new Map<string, number>()

  constructor(
    readonly name: string,
    readonly help: string,
  ) {
    if (!NAME.test(name)) throw new Error(`not a valid metric name: ${name}`)
  }

  set(value: number, labels: Labels = {}): void {
    this.#values.set(series(this.name, labels), value)
  }

  reset(): void {
    this.#values.clear()
  }

  render(): string[] {
    if (this.#values.size === 0) return [`${this.name} 0`]
    return [...this.#values].map(([key, v]) => `${key} ${v}`)
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

export class Histogram implements Metric {
  readonly type = 'histogram' as const
  readonly #series = new Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>()

  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[] = DEFAULT_BUCKETS,
  ) {
    if (!NAME.test(name)) throw new Error(`not a valid metric name: ${name}`)
  }

  observe(seconds: number, labels: Labels = {}): void {
    const key = series(this.name, labels)
    const entry = this.#series.get(key) ?? {
      labels,
      counts: new Array<number>(this.buckets.length).fill(0),
      sum: 0,
      count: 0,
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (seconds <= (this.buckets[i] as number)) entry.counts[i] = (entry.counts[i] as number) + 1
    }
    entry.sum += seconds
    entry.count += 1
    this.#series.set(key, entry)
  }

  /** Times `fn`, recording however it ends. A failure has a duration too. */
  async time<T>(labels: Labels, fn: () => Promise<T>): Promise<T> {
    const started = performance.now()
    try {
      return await fn()
    } finally {
      this.observe((performance.now() - started) / 1000, labels)
    }
  }

  render(): string[] {
    const lines: string[] = []
    for (const entry of this.#series.values()) {
      // Already cumulative, and deliberately so: `observe` increments every
      // bucket whose bound the value is under, rather than only its own. The
      // exposition format requires cumulative counts, and summing them here
      // instead would be the same arithmetic done once per scrape rather than
      // once per observation.
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(
          `${series(`${this.name}_bucket`, { ...entry.labels, le: String(this.buckets[i]) })} ${entry.counts[i] as number}`,
        )
      }
      lines.push(`${series(`${this.name}_bucket`, { ...entry.labels, le: '+Inf' })} ${entry.count}`)
      lines.push(`${series(`${this.name}_sum`, entry.labels)} ${entry.sum}`)
      lines.push(`${series(`${this.name}_count`, entry.labels)} ${entry.count}`)
    }
    return lines
  }
}

export class Registry {
  readonly #metrics: Metric[] = []
  readonly #collectors: (() => Promise<void>)[] = []

  register<T extends Metric>(metric: T): T {
    if (this.#metrics.some((m) => m.name === metric.name)) {
      throw new Error(`metric already registered: ${metric.name}`)
    }
    this.#metrics.push(metric)
    return metric
  }

  /**
   * A function run before every scrape, for values that are queries rather than
   * counters — document counts and pending tombstones.
   */
  collect(fn: () => Promise<void>): void {
    this.#collectors.push(fn)
  }

  /**
   * How long a collected value is reused.
   *
   * `/metrics` is unauthenticated by default and the collectors are database
   * queries — one per organization. Without this, anyone who can reach the port
   * decides how often the API queries every tenant's `documents` table, on the
   * same pool the request path uses. A scrape loop is a denial of service that
   * looks like monitoring.
   *
   * Ten seconds is shorter than any sensible scrape interval, so a real
   * Prometheus never sees a cached value and the numbers are as live as they
   * were. It only collapses the excess: a second scraper, a human with `watch
   * curl`, or a flood.
   */
  static readonly COLLECT_TTL_MS = 10_000

  /**
   * When the collectors last finished, on the same clock `render` was given.
   *
   * `undefined` and not 0, because "never collected" and "collected at time
   * zero" have to be different: a caller injecting a clock — a test, or
   * anything replaying — would otherwise find a fresh registry believing it had
   * just collected, and the first scrape would return empty gauges.
   */
  #collectedAt: number | undefined
  #collecting: Promise<void> | undefined

  /**
   * Run the collectors, at most one run at a time and at most one per window.
   *
   * The single-flight part matters as much as the cache: two scrapes arriving
   * together used to start two full sweeps, so concurrency multiplied the cost
   * that the cache alone would bound only in sequence.
   */
  async #collectOnce(now: number): Promise<void> {
    if (this.#collecting !== undefined) return this.#collecting
    if (this.#collectedAt !== undefined && now - this.#collectedAt < Registry.COLLECT_TTL_MS) return

    // A collector that fails must not blank the whole exposition: the metrics
    // that still work are how you find out which one broke.
    this.#collecting = Promise.allSettled(this.#collectors.map((fn) => fn())).then(() => {
      // Stamped with the clock this call was given, never with Date.now().
      // Mixing the two means an injected clock is compared against a real one,
      // and the window is then either always open or never.
      //
      // On completion rather than on entry, so a sweep slower than the window
      // does not have the next one queued behind it the instant it finishes.
      this.#collectedAt = now
      this.#collecting = undefined
    })

    return this.#collecting
  }

  async render(now: number = Date.now()): Promise<string> {
    await this.#collectOnce(now)

    const lines: string[] = []
    for (const metric of this.#metrics) {
      lines.push(`# HELP ${metric.name} ${metric.help}`)
      lines.push(`# TYPE ${metric.name} ${metric.type}`)
      lines.push(...metric.render())
    }
    return `${lines.join('\n')}\n`
  }
}

/**
 * The metrics docs/config.md requires.
 *
 * There is deliberately no `nacre_acl_propagation_lag_seconds` here. It was the
 * one metric with an alert on it, back when invariant I4 was temporal — a
 * revoked grant reflected *within an SLA*, with a cache the worker had to catch
 * up. Migration 0016 removed that cache: the permitted set is computed per
 * request from the grants, so I4 is structural now and there is no lag to
 * measure. A gauge that reported one would be reporting on a subsystem that no
 * longer exists.
 */
export function createMetrics(registry: Registry) {
  return {
    searchDuration: registry.register(
      new Histogram('nacre_search_duration_seconds', 'Search latency, end to end', [
        0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5,
      ]),
    ),
    searchResults: registry.register(
      new Counter('nacre_search_results_total', 'Results returned, by layer'),
    ),
    aclDenials: registry.register(
      new Counter('nacre_acl_denials_total', 'Access denials, by reason'),
    ),
    // Labelled by what was presented, never by why it failed. The 401 itself
    // carries one message for every reason so a caller cannot tell an expired
    // token from a forged one; a `reason` label would hand that distinction
    // back through an endpoint that is unauthenticated by default.
    //
    // `kind="jwt"` is the series a key rotation moves, and it is why this
    // exists: there is no dual-key window, so every outstanding access token
    // fails at once and an operator has to watch that drain. `kind="service_key"`
    // staying flat through the same window is the check that the rotation hit
    // only what it was meant to.
    authFailures: registry.register(
      new Counter(
        'nacre_auth_failures_total',
        'Rejected credentials, by the kind presented: missing, jwt, service_key. Never by reason — the 401 is deliberately one answer',
      ),
    ),
    // Rate limiting fails open when Redis is unreachable, deliberately — it is
    // availability protection, not an authorization control. That is the one
    // degradation an operator has to be able to see, because the symptom is
    // *silence*: requests keep flowing and nothing is being counted. Every
    // increment here is a request that was let through unmetered.
    rateLimitUnavailable: registry.register(
      new Counter(
        'nacre_rate_limit_unavailable_total',
        'Requests allowed because the rate-limit check could not run (Redis unreachable), by resource',
      ),
    ),
    ingestDuration: registry.register(
      new Histogram('nacre_ingest_duration_seconds', 'Indexing latency, by stage'),
    ),
    documents: registry.register(new Gauge('nacre_documents_total', 'Documents, by organization and status')),
    // Specified in docs/config.md and registered by nothing until there was a
    // reindex to measure.
    //
    // One series per layer that has ever been reindexed, and no series for the
    // rest — a layer nobody has migrated has no progress to report, and
    // inventing a zero for it would mean every layer in the installation
    // permanently reads "reindex started, gone nowhere".
    //
    // With no reindexes at all the registry still emits a bare
    // `nacre_reindex_progress_ratio 0`, because an unlabelled gauge with no
    // values renders that way here. That is the "nothing to report" marker
    // rather than a layer at zero: a real layer always carries a `layer` label.
    reindexProgress: registry.register(
      new Gauge(
        'nacre_reindex_progress_ratio',
        'How far a layer is through a reindex, 0 to 1. Absent when no reindex has run; 0 means one started and has moved nothing',
      ),
    ),
    tombstonesPending: registry.register(
      new Gauge(
        'nacre_tombstones_pending_total',
        'Deleted documents whose vectors are not yet purged. Climbing means garbage collection is losing',
      ),
    ),
    // The one thing a wedged worker leaves outside its own log. The worker
    // serves no port and has no registry — by design, so that a liveness check
    // is not a second surface with an auth story — so a worker stuck inside one
    // document is invisible except in the log line that stopped. This is the
    // age of the oldest document currently claimed for indexing, per
    // organization, computed on the API's side from `documents.claimed_at`. A
    // series appears only while something is in flight; one that climbs past
    // NACRE_INDEX_LEASE is a worker wedged in a document, or gone with the
    // reaper not reclaiming it — and either way the document behind it is not
    // getting indexed.
    processingAge: registry.register(
      new Gauge(
        'nacre_document_processing_age_seconds',
        'Age of the oldest document a worker is currently indexing, by organization. Absent when nothing is in flight; past the index lease means a worker is wedged or gone',
      ),
    ),
    // A gauge and not a counter, because the question an operator has is "how
    // much disk is a finished migration still holding", not "how many have I
    // reclaimed since this process started". Each one retained is a full copy
    // of an organization's vectors, so a number that stays high is the signal —
    // and a number that never falls means the sweep is not running at all,
    // which is the state this whole table replaced.
    collectionsRetired: registry.register(
      new Gauge(
        'nacre_collections_retired_total',
        'Superseded collections still held for the reindex rollback window, by organization. Each is a full copy of that organization vectors',
      ),
    ),
  }
}

export type Metrics = ReturnType<typeof createMetrics>
