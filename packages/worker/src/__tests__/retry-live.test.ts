import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createPool } from '@nacre.work/core'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CLAIMABLE_NOW, recordFailure, retryDelayMs } from '../retry.js'
import { claimNext } from '../claim.js'

/**
 * A transient failure is retried and a permanent one is not, against a real
 * PostgreSQL.
 *
 * ## Why a database and not a fake
 *
 * The decision is **one statement**. `recordFailure` hands Postgres the
 * retryability and the bound and lets a `CASE` in the `UPDATE` choose both the
 * status and the `retry_after` from the row's own `attempts` — because reading
 * the count and then writing a verdict is two statements with a window between
 * them, and two workers in that window would each read `attempts = 4` against a
 * bound of 5 and each grant a retry.
 *
 * So what is under test is a `CASE` expression and a `make_interval`, and a
 * fake would be asserting my own arithmetic back at me. That is the shape this
 * repository names as a fixture written to match the code, on a path where
 * being wrong is silent: the symptom of getting it backwards is documents that
 * retry forever, or a permanent verdict on the first blip — neither of which
 * raises anything anywhere.
 *
 * The claim predicate is here for the same reason. `retry_after <= now()` is
 * the database's comparison, and a document that a worker can claim a
 * millisecond after failing is a bound that is not a bound.
 */

const url = process.env.NACRE_PG_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_PG_URL is not set and CI is; the ingest retry window would go untested.')
}

let pool: Pool
let orgId: string
let layerId: string

const when = url ? describe : describe.skip

/** A document in `indexing`, claimed, with `attempts` already at `n`. */
async function claimed(externalId: string, attempts: number): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO documents
       (org_id, layer_id, external_id, title, source_type, source_ref,
        content_hash, status, attempts, claimed_at)
     VALUES ($1, $2, $3, $3, 'inline', 'body', $4, 'indexing', $5, now())
     RETURNING id`,
    [orgId, layerId, externalId, externalId.padEnd(64, '0'), attempts],
  )
  return rows[0]!.id
}

async function row(id: string) {
  const { rows } = await pool.query<{
    status: string
    attempts: number
    error: string | null
    claimed_at: Date | null
    retry_after: Date | null
  }>(
    'SELECT status, attempts, error, claimed_at, retry_after FROM documents WHERE id = $1',
    [id],
  )
  return rows[0]!
}

when('the ingest retry window', () => {
  beforeAll(async () => {
    pool = createPool({ connectionString: url as string })
    await pool.query("DELETE FROM organizations WHERE slug = 'retrywin'")
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (slug, name, vector_collection)
       VALUES ('retrywin','retrywin','org_retrywin') RETURNING id`,
    )
    orgId = org.rows[0]!.id
    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (org_id, slug, name) VALUES ($1,'w','w') RETURNING id`,
      [orgId],
    )
    const provider = await pool.query<{ id: string }>(
      `INSERT INTO embedding_providers (org_id, name, endpoint, model, dimensions)
       VALUES ($1, 'p', 'http://embedder', 'bge-m3', 4) RETURNING id`,
      [orgId],
    )
    const layer = await pool.query<{ id: string }>(
      `INSERT INTO layers (org_id, workspace_id, slug, name, provider_id, vector_name)
       VALUES ($1, $2, 'l', 'l', $3, 'bge_m3') RETURNING id`,
      [orgId, ws.rows[0]!.id, provider.rows[0]!.id],
    )
    layerId = layer.rows[0]!.id
  })

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.query("DELETE FROM organizations WHERE slug = 'retrywin'")
      await pool.end()
    }
  })

  it('requeues a document whose dependency was unreachable', async () => {
    const id = await claimed('transient', 1)
    const outcome = await recordFailure(
      pool,
      { orgId, documentId: id, attempts: 1 },
      new Error('fetch failed'),
      5,
    )

    expect(outcome).toEqual({ retrying: true, reason: 'unavailable' })

    const after = await row(id)
    expect(after.status).toBe('pending')
    // The claim is released, or the row is pending and held by a worker that
    // has already given up on it — which is the sweep lease defect this
    // repository recorded once, from the other side.
    expect(after.claimed_at).toBeNull()
    expect(after.retry_after).not.toBeNull()
    // Bounded and in the future: an immediate retry is the whole failure mode
    // a window exists against.
    expect(after.retry_after!.getTime()).toBeGreaterThan(Date.now() - 1_000)
    expect(after.retry_after!.getTime()).toBeLessThan(Date.now() + 16 * 60_000)
    // The error is kept while it is pending, so `GET /v1/jobs/{id}` can say
    // what went wrong last time rather than reporting a document as merely
    // queued.
    expect(after.error).toContain('fetch failed')
  })

  it('fails a document permanently where re-sending cannot help', async () => {
    const id = await claimed('permanent', 1)
    const outcome = await recordFailure(
      pool,
      { orgId, documentId: id, attempts: 1 },
      new Error('input must have less than 512 tokens'),
      5,
    )

    expect(outcome).toEqual({ retrying: false, reason: 'too_long' })
    const after = await row(id)
    expect(after.status).toBe('failed')
    // NULL rather than a stale future time: a `failed` row is not claimable
    // whatever this column says, and leaving a value behind would make the
    // operator's retry look like it had a window to wait out.
    expect(after.retry_after).toBeNull()
  })

  it('does not retry a quota, whose remedy is a person raising a limit', async () => {
    // The one refusal in `isRetryable` that is not about whether the failure
    // repeats. Retrying against a quota that is still full is load with no
    // chance of success, and the limit moving is an event this process cannot
    // see — so the caller is told and the re-send is somebody's decision.
    const id = await claimed('quota', 1)
    const outcome = await recordFailure(
      pool,
      { orgId, documentId: id, attempts: 1 },
      new Error('max_documents limit reached for this organization'),
      5,
    )

    expect(outcome).toEqual({ retrying: false, reason: 'quota' })
    expect((await row(id)).status).toBe('failed')
  })

  it('retries a failure nothing recognises, because the bound makes that safe', async () => {
    // `internal` is the judgement call: an unknown error in a distributed
    // system might not happen twice, and guessing the other way costs a
    // document that would have indexed. What makes the guess affordable is
    // that a permanent unknown costs a bounded number of spaced attempts and
    // then fails exactly as it would have.
    const id = await claimed('unknown', 1)
    const outcome = await recordFailure(
      pool,
      { orgId, documentId: id, attempts: 1 },
      new Error('something nobody has classified'),
      5,
    )

    expect(outcome).toEqual({ retrying: true, reason: 'internal' })
    expect((await row(id)).status).toBe('pending')
  })

  it('stops at the attempt bound, whatever the classifier says', async () => {
    // The bound is the whole reason `internal` is allowed to retry at all: a
    // failure nobody has classified is guessed retryable, and the guess is only
    // safe because it cannot go on forever.
    const id = await claimed('exhausted', 5)
    const outcome = await recordFailure(
      pool,
      { orgId, documentId: id, attempts: 5 },
      new Error('fetch failed'),
      5,
    )

    expect(outcome).toEqual({ retrying: false, reason: 'unavailable' })
    expect((await row(id)).status).toBe('failed')
  })

  it('is not claimable until its window has passed', async () => {
    const id = await claimed('window', 1)
    await recordFailure(pool, { orgId, documentId: id, attempts: 1 }, new Error('fetch failed'), 5)
    // Far enough out that no plausible scheduling makes this flaky, and the
    // comparison is Postgres's rather than this process's clock.
    await pool.query("UPDATE documents SET retry_after = now() + interval '1 hour' WHERE id = $1", [
      id,
    ])

    // `CLAIMABLE_NOW` is the clause the worker's own claim interpolates, asked
    // here rather than spelled out — a case that writes its own copy of the
    // SQL stays green when the real query loses the clause.
    const claimable = `SELECT d.id FROM documents d
        WHERE d.id = $1 AND d.status = 'pending' AND d.deleted_at IS NULL
          AND ${CLAIMABLE_NOW}`

    const held = await pool.query(claimable, [id])
    expect(held.rowCount).toBe(0)

    await pool.query("UPDATE documents SET retry_after = now() - interval '1 second' WHERE id = $1", [
      id,
    ])
    const free = await pool.query(claimable, [id])
    expect(free.rowCount).toBe(1)
  })

  /**
   * `Claim.attempts` counts this attempt.
   *
   * Its own documentation says "including this claim — the claim statement
   * increments it", and for one release it did not: the SELECT reads the row
   * and the UPDATE increments it afterwards, so the field arrived one behind.
   * Two readers, wrong in the same direction — the worker logged
   * `attempts: 0` on a first attempt beside a `max_attempts: 3`, and the
   * backoff's exponent started a step low, so the first two attempts shared
   * one ceiling instead of doubling.
   *
   * Nothing failed, and the reason is worth keeping: the *bound* is not
   * computed from this field. `recordFailure` compares the row's own
   * post-increment count inside the statement that writes the verdict, so the
   * number of attempts a document got was always right. What was wrong was
   * every number a person reads.
   *
   * Found by starting the released 0.25.0 image against a parser that was not
   * there and reading the worker's own log — which is this repository's rule
   * about running the artifact, one step further out than usual: the artifact
   * had already shipped.
   */
  it('counts the attempt it is handing over', async () => {
    // The queue is emptied first, and that is not tidiness. `claimNext` takes
    // the oldest claimable document in the *installation*, so a case that
    // assumes the row it just wrote is the one that comes back is a case whose
    // claim depends on what the cases above it left behind — the flake shape
    // this repository runs a nightly hunt for. Emptying it makes the answer a
    // property of the statement rather than of the file's ordering.
    await pool.query("DELETE FROM documents WHERE org_id = $1 AND status = 'pending'", [orgId])

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, layer_id, external_id, title, source_type, source_ref, content_hash, status)
       VALUES ($1, $2, 'counted', 'counted', 'inline', 'body', $3, 'pending')
       RETURNING id`,
      [orgId, layerId, 'counted'.padEnd(64, '0')],
    )
    const id = rows[0]!.id

    const first = await claimNext(pool)
    expect(first?.documentId).toBe(id)
    // One, not zero. The row says one too, which is the agreement that was
    // missing: the field and the column are the same count.
    expect(first?.attempts).toBe(1)
    expect((await row(id)).attempts).toBe(1)

    await recordFailure(pool, { orgId, documentId: id, attempts: first!.attempts }, new Error('fetch failed'), 5)
    await pool.query('UPDATE documents SET retry_after = NULL WHERE id = $1', [id])

    const second = await claimNext(pool)
    expect(second?.documentId).toBe(id)
    expect(second?.attempts).toBe(2)
    expect((await row(id)).attempts).toBe(2)
  })

  it('leaves a document that never failed claimable', async () => {
    // No backfill: `retry_after` is NULL on every row that existed before this
    // migration and on every fresh document, and NULL means now.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, layer_id, external_id, title, source_type, source_ref, content_hash, status)
       VALUES ($1, $2, 'fresh', 'fresh', 'inline', 'body', $3, 'pending')
       RETURNING id`,
      [orgId, layerId, 'fresh'.padEnd(64, '0')],
    )
    const fresh = await pool.query(
      `SELECT d.id FROM documents d WHERE d.id = $1 AND d.status = 'pending' AND ${CLAIMABLE_NOW}`,
      [rows[0]!.id],
    )
    expect(fresh.rowCount).toBe(1)
  })
})

describe('the backoff', () => {
  /**
   * Full jitter over a doubling ceiling, which is the S3 client's rule beside
   * it and for the same reason: the callers are a fleet. Worker replicas share
   * an embedder, and a blip they all see is one they would all come back from
   * at the same instant if the delay were a formula rather than a draw.
   */
  it('draws inside a ceiling that doubles', () => {
    expect(retryDelayMs(1, () => 0.999_9)).toBeLessThan(30_000)
    expect(retryDelayMs(2, () => 0.999_9)).toBeGreaterThan(30_000)
    expect(retryDelayMs(2, () => 0.999_9)).toBeLessThan(60_000)
  })

  it('can draw zero, which is what makes it jitter and not a schedule', () => {
    expect(retryDelayMs(3, () => 0)).toBe(0)
  })

  it('caps, so a document that has failed four times is not parked for a day', () => {
    expect(retryDelayMs(40, () => 0.999_9)).toBeLessThanOrEqual(15 * 60_000)
  })

  it('treats a first attempt as a first attempt', () => {
    // `attempts` is 1 on the first run, not 0. Reading it as an exponent
    // without the offset would halve every window; reading it as negative
    // would produce a ceiling below the base.
    expect(retryDelayMs(0, () => 0.999_9)).toBeLessThan(30_000)
    expect(retryDelayMs(1, () => 0.999_9)).toBeLessThan(30_000)
  })
})

describe('the claim', () => {
  /**
   * Every statement that picks a `pending` document carries the window.
   *
   * The constant alone does not close this. `CLAIMABLE_NOW` being one string
   * stops the two spellings drifting; what it cannot stop is the claim
   * dropping the clause entirely, and the live case above would stay green,
   * because it asks the constant rather than the query. That is the same
   * narrow-projection shape it exists against, one level up.
   *
   * So the subject is **discovered** rather than named: any statement in the
   * worker asking for `status = 'pending'` is claiming work, and each has to
   * carry the clause. A second queue reader written later is covered on the
   * day it exists, and a run that finds no such statement refuses rather than
   * reporting green on nothing.
   */
  it('will not take a document before its window, in every statement that takes one', () => {
    // Every source in the package, discovered rather than listed. The first
    // version named three files, and the claim then moved into a fourth —
    // `claim.ts` — which turned this check from "the clause is missing" into
    // "there is nothing here to check". It refused, which is the behaviour that
    // matters, and a check that has to be edited when code moves is a check
    // somebody edits the wrong way.
    const root = fileURLToPath(new URL('../', import.meta.url))
    const sources = readdirSync(root)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, text: readFileSync(`${root}${name}`, 'utf8') }))

    const claims: string[] = []
    for (const file of sources) {
      // A statement is a backtick template; the queue readers are the ones
      // that ask for a pending document.
      for (const match of file.text.matchAll(/`([^`]*status\s*=\s*'pending'[^`]*)`/g)) {
        const statement = match[1]
        if (statement === undefined) continue
        if (!/\bFROM documents\b/i.test(statement)) continue
        claims.push(`${file.name}: ${statement.replace(/\s+/g, ' ').slice(0, 80)}`)
        expect(
          statement.includes('CLAIMABLE_NOW'),
          `${file.name} claims a pending document without the retry window`,
        ).toBe(true)
      }
    }

    // A check with nothing to hold must not report green.
    expect(claims.length, 'no statement claims a pending document; this check has no subject').
      toBeGreaterThan(0)
  })
})
