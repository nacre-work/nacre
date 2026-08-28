import { describe, expect, it } from 'vitest'

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT } from 'jose'

import { createApi, type RetryOutcome } from '../server.js'

/**
 * `POST /v1/documents/{id}/retry` — the three answers and the audit row.
 *
 * The permission decision belongs to the adapter and is the retag path's,
 * statement for statement; what this asks is the half above it, which is the
 * half that turns an outcome into a status. Getting that wrong is not a leak
 * and is the kind of defect this repository keeps shipping: a `404` where the
 * caller is looking straight at the document sends an operator hunting for
 * something that is on their screen, and a route that answers `204` for a
 * document it did not requeue reports work that never happened.
 *
 * The port-absent case is here because it is the one this file would otherwise
 * pass without: a surface built without `retry` must answer `404` like any
 * other capability it does not have, and never `500`.
 */

const SECRET = new TextEncoder().encode('s'.repeat(32))

async function token(): Promise<string> {
  return await new SignJWT({ org: 'org-1', principal_type: 'user', role: 'org_admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer('https://api.nacre.test')
    .setAudience('nacre')
    .setExpirationTime('5m')
    .sign(SECRET)
}

interface Written {
  readonly action: string
  readonly result: string
  readonly detail?: Record<string, unknown>
}

async function serve(retry?: (id: string) => Promise<RetryOutcome>) {
  const audited: Written[] = []
  const api = createApi({
    verify: { key: SECRET, issuer: 'https://api.nacre.test', audience: 'nacre' },
    documents: {
      read: async () => undefined,
      ...(retry === undefined
        ? {}
        : { retry: async (_auth: unknown, id: string) => await retry(id) }),
    },
    search: { search: async () => [] },
    ingest: { queue: async () => undefined, remove: async () => false },
    audit: {
      write: async (event: Written) => {
        audited.push(event)
      },
    },
    metrics: { render: async () => '' },
    ready: async () => ({ postgres: true, qdrant: true }),
  } as unknown as Parameters<typeof createApi>[0])

  const server: Server = api.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    audited,
    async post(id: string) {
      return await fetch(`http://127.0.0.1:${port}/v1/documents/${id}/retry`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}` },
      })
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

const ID = '11111111-1111-4111-8111-111111111111'

describe('asking for a retry', () => {
  it('answers 204 with no body, because write does not imply read', async () => {
    const s = await serve(async () => 'requeued')
    try {
      const res = await s.post(ID)
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      const event = s.audited.find((e) => e.action === 'retry_document')
      expect(event?.result).toBe('allow')
      expect(event?.detail?.outcome).toBe('requeued')
    } finally {
      await s.close()
    }
  })

  it('answers 409 for a document that has not failed, not 404', async () => {
    // The caller may write this document, so `404` would be a lie — and it is
    // the lie that costs somebody an afternoon. The refusal is about the
    // document's state and goes away when it fails, which is what separates a
    // `409` here from the permanent `403` a scoped endpoint gives.
    const s = await serve(async () => 'not-failed')
    try {
      const res = await s.post(ID)
      expect(res.status).toBe(409)
      const body = (await res.json()) as { detail: string; status: number }
      expect(body.status).toBe(409)
      expect(body.detail).toMatch(/has not failed/)
      expect(s.audited.find((e) => e.action === 'retry_document')?.result).toBe('deny')
    } finally {
      await s.close()
    }
  })

  it('answers 404 for a document that is absent or invisible, in one wording', async () => {
    const s = await serve(async () => 'unreachable')
    try {
      const res = await s.post(ID)
      expect(res.status).toBe(404)
      const body = (await res.json()) as { detail: string }
      // Invariant 4: the same body a genuinely absent document gets. Nothing
      // in it may hint that the document exists.
      expect(body.detail).not.toMatch(/permission|forbidden|not allowed|failed/i)
      expect(s.audited.find((e) => e.action === 'retry_document')?.result).toBe('deny')
    } finally {
      await s.close()
    }
  })

  it('answers 404 where the surface has no retry at all', async () => {
    const s = await serve()
    try {
      expect((await s.post(ID)).status).toBe(404)
    } finally {
      await s.close()
    }
  })
})
