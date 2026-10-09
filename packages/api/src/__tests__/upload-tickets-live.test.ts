import { Redis } from '@nacre.work/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { AuthContext } from '../auth.js'
import { RedisUploadTickets, TICKET_TTL_SECONDS } from '../uploads.js'

/**
 * The ticket store against a real Redis.
 *
 * The property that matters is single use, and it is the database's: `GETDEL`
 * reads and deletes in one command, so two redeems racing on one ticket get
 * one ticket and one nothing. A map in the unit suite agrees with whatever it
 * was written to; this asks Redis.
 */

const url = process.env.NACRE_REDIS_URL
if (!url && process.env.CI) {
  throw new Error('NACRE_REDIS_URL is not set and CI is; the upload ticket store would go untested.')
}
const when = url ? describe : describe.skip

const auth: AuthContext = {
  orgId: '77777777-7777-4777-8777-777777777777',
  principal: { type: 'service_account', id: 'agent-7' },
  role: 'member',
}

let redis: Redis
let store: RedisUploadTickets

when('upload tickets in Redis', () => {
  beforeAll(() => {
    redis = new Redis({ url: url as string })
    store = new RedisUploadTickets(redis)
  })

  afterAll(() => {
    redis.close()
  })

  it('stores what it was given, once, with the TTL', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS
    const id = await store.mint({ auth, layer: 'contracts', externalId: 'q3.md', metadata: { team: 'x' }, expiresAt })
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/)

    const ttl = Number(await redis.command('TTL', `upload:${id}`))
    expect(ttl).toBeGreaterThan(TICKET_TTL_SECONDS - 10)
    expect(ttl).toBeLessThanOrEqual(TICKET_TTL_SECONDS)

    expect(await store.redeem(id)).toEqual({ auth, layer: 'contracts', externalId: 'q3.md', metadata: { team: 'x' }, expiresAt })
    expect(await store.redeem(id)).toBeUndefined()
  })

  it('two redeems racing on one ticket get one ticket between them', async () => {
    const id = await store.mint({ auth, layer: 'contracts', expiresAt: 0 })
    const results = await Promise.all(Array.from({ length: 8 }, () => store.redeem(id)))
    expect(results.filter((r) => r !== undefined)).toHaveLength(1)
  })

  it('an id nobody minted is nothing', async () => {
    expect(await store.redeem('A'.repeat(43))).toBeUndefined()
  })
})
