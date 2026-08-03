import { describe, expect, it } from 'vitest'

import { Counter, createMetrics, Gauge, Histogram, Registry } from '../metrics.js'

describe('metrics', () => {
  it('a counter with no observations still reports zero', async () => {
    const registry = new Registry()
    registry.register(new Counter('nacre_test_total', 'A counter'))

    // An absent series and a zero series look identical on a graph and mean
    // opposite things: "nothing happened" versus "the exporter is not running".
    expect(await registry.render()).toContain('nacre_test_total 0')
  })

  it('labels are sorted, so a series name is stable', async () => {
    const registry = new Registry()
    const counter = registry.register(new Counter('nacre_test_total', 'A counter'))
    counter.inc({ b: '2', a: '1' })

    expect(await registry.render()).toContain('nacre_test_total{a="1",b="2"} 1')
  })

  it('label values with quotes or newlines are escaped', async () => {
    const registry = new Registry()
    const counter = registry.register(new Counter('nacre_test_total', 'A counter'))
    // A layer name is user-supplied and ends up in a label. Unescaped, one
    // quote makes the whole exposition unparseable and every metric vanishes.
    counter.inc({ layer: 'a "quoted"\nname' })

    const rendered = await registry.render()
    expect(rendered).toContain('layer="a \\"quoted\\"\\nname"')
    expect(rendered.split('\n').filter((l) => l.startsWith('nacre_test_total{'))).toHaveLength(1)
  })

  it('a histogram reports cumulative buckets, a sum and a count', async () => {
    const registry = new Registry()
    const histogram = registry.register(new Histogram('nacre_test_seconds', 'A histogram', [0.1, 1]))
    histogram.observe(0.05)
    histogram.observe(0.5)
    histogram.observe(5)

    const rendered = await registry.render()
    expect(rendered).toContain('nacre_test_seconds_bucket{le="0.1"} 1')
    expect(rendered).toContain('nacre_test_seconds_bucket{le="1"} 2')
    expect(rendered).toContain('nacre_test_seconds_bucket{le="+Inf"} 3')
    expect(rendered).toContain('nacre_test_seconds_count 3')
  })

  it('a timed call that throws is still observed', async () => {
    const histogram = new Histogram('nacre_test_seconds', 'A histogram')
    const registry = new Registry()
    registry.register(histogram)

    await expect(
      histogram.time({}, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // A failure has a duration too, and a latency metric that only counts
    // successes hides the case where everything is slow and then errors.
    expect(await registry.render()).toContain('nacre_test_seconds_count 1')
  })

  it('a failing collector does not blank the exposition', async () => {
    const registry = new Registry()
    const gauge = registry.register(new Gauge('nacre_test_gauge', 'A gauge'))
    gauge.set(7)

    registry.collect(async () => {
      throw new Error('the database is unreachable')
    })

    // The metrics that still work are how you find out which one broke.
    expect(await registry.render()).toContain('nacre_test_gauge 7')
  })

  it('a duplicate registration is refused', () => {
    const registry = new Registry()
    registry.register(new Counter('nacre_test_total', 'A counter'))
    expect(() => registry.register(new Counter('nacre_test_total', 'Another'))).toThrow(
      /already registered/,
    )
  })

  it('an invalid metric name is refused at construction', () => {
    expect(() => new Counter('not a valid name', 'x')).toThrow(/valid metric name/)
  })

  it('every metric docs/config.md requires is registered', async () => {
    const registry = new Registry()
    createMetrics(registry)
    const rendered = await registry.render()

    for (const name of [
      'nacre_search_duration_seconds',
      'nacre_search_results_total',
      'nacre_acl_denials_total',
      'nacre_ingest_duration_seconds',
      'nacre_documents_total',
      'nacre_tombstones_pending_total',
      'nacre_rate_limit_unavailable_total',
    ]) {
      expect(rendered, `${name} is required by docs/config.md`).toContain(`# TYPE ${name}`)
    }
  })

  it('the rate-limit degradation counter reports zero until a request is let through', async () => {
    // Zero, not absent — the whole reason it exists is that a failed-open
    // request leaves no other trace, so an operator has to be able to tell
    // "the limiter is fine" (a flat zero) from "the exporter is not running"
    // (no series at all).
    const registry = new Registry()
    const metrics = createMetrics(registry)
    expect(await registry.render()).toContain('nacre_rate_limit_unavailable_total 0')

    metrics.rateLimitUnavailable.inc({ resource: 'search' })
    metrics.rateLimitUnavailable.inc({ resource: 'search' })
    metrics.rateLimitUnavailable.inc({ resource: 'ingest' })
    const rendered = await registry.render()
    expect(rendered).toContain('nacre_rate_limit_unavailable_total{resource="search"} 2')
    expect(rendered).toContain('nacre_rate_limit_unavailable_total{resource="ingest"} 1')
  })
})

/**
 * Collector caching.
 *
 * `/metrics` is unauthenticated by default and the collectors are database
 * queries — one per organization. Without a bound, whoever can reach the port
 * decides how often the API queries every tenant's documents table, on the same
 * pool the request path uses. A scrape loop is a denial of service that looks
 * like monitoring.
 */
describe('collector caching', () => {
  it('runs collectors once per window, not once per scrape', async () => {
    const registry = new Registry()
    let runs = 0
    registry.collect(async () => {
      runs++
    })

    const t0 = 1_000_000
    await registry.render(t0)
    await registry.render(t0 + 1)
    await registry.render(t0 + 9_000)
    expect(runs).toBe(1)

    // Past the window it collects again. A cache that never expired would be a
    // dashboard reporting whatever was true when the process started.
    await registry.render(t0 + Registry.COLLECT_TTL_MS + 1_000)
    expect(runs).toBe(2)
  })

  it('collapses concurrent scrapes into one collection', async () => {
    const registry = new Registry()
    let runs = 0
    let release: (() => void) | undefined
    registry.collect(async () => {
      runs++
      await new Promise<void>((resolve) => {
        release = resolve
      })
    })

    // Two scrapes arriving together. Without the single-flight guard both start
    // a full sweep, so concurrency multiplies the cost the cache alone bounds
    // only in sequence.
    const a = registry.render(0)
    const b = registry.render(0)
    await Promise.resolve()
    expect(runs).toBe(1)

    release?.()
    await Promise.all([a, b])
    expect(runs).toBe(1)
  })

  it('still renders when a collector throws', async () => {
    const registry = new Registry()
    registry.collect(async () => {
      throw new Error('the database is down')
    })
    const counter = registry.register(new Counter('probe_total', 'a probe'))
    counter.inc({}, 3)

    // The metrics that still work are how you find out which collector broke.
    await expect(registry.render(0)).resolves.toContain('probe_total 3')
  })
})
