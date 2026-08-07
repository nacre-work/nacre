import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { embeddingFailure } from '../adapters.js'

/**
 * A slow embedder is not an absent one, and the message has to say which.
 *
 * The one that shipped said "could not be reached … this deployment must supply
 * one — the minimal Compose profile deliberately starts no embedder" for every
 * cause `fetch` can throw, including a timeout. A timeout is proof the endpoint
 * *exists*: something accepted the connection. The first person to hit it lost a
 * morning looking for a container that was running, healthy, on a Mac, emulated
 * at 300 % CPU.
 *
 * Against a real socket rather than a hand-made `TimeoutError`, on the same rule
 * `parser-reason.test.ts` follows: what is under test is the reading of a cause
 * undici produced, and an invented one proves only that the test knows what the
 * code checks.
 */

let server: Server

afterEach(() => {
  // The hanging case leaves a socket the aborted fetch never released, and
  // `close()` alone waits for it — which vitest reports as the suite failing
  // after every assertion in it passed.
  server?.closeAllConnections()
  server?.close()
})

const ENDPOINT = new URL('http://embedder/embeddings')

/** The cause `fetch` rejects with — the real one, not a description of it. */
async function causeFrom(url: string, timeoutMs: number): Promise<unknown> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    throw new Error('the request was expected to fail and did not')
  } catch (cause) {
    return cause
  }
}

describe('the embedder failed', () => {
  it('a socket that accepts and never answers is reported as slow, not absent', async () => {
    // Accepts the connection and holds it. This is the shape of a CPU-only
    // embedder mid-batch, which is the case the old message got wrong.
    server = createServer(() => {
      /* deliberately no response */
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const { port } = server.address() as AddressInfo

    const error = embeddingFailure(await causeFrom(`http://127.0.0.1:${port}/`, 150), ENDPOINT, 'default')

    expect(error.message).toContain('did not answer within')
    expect(error.message).toContain('too slow, not absent')
    // The operator's next step, which is the whole point of separating these.
    expect(error.message).toContain('docs/apple-silicon.md')
    // And never the sentence that sent somebody hunting for a missing service.
    expect(error.message).not.toContain('must supply one')
    expect(error.message).not.toContain('could not be reached')
  })

  it('a port with nothing on it keeps the message that was right for it', async () => {
    // Bound and immediately closed, so the port is dead rather than filtered —
    // ECONNREFUSED, which genuinely means no service.
    const dead = createServer()
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', () => r()))
    const { port } = dead.address() as AddressInfo
    await new Promise<void>((r) => dead.close(() => r()))

    const error = embeddingFailure(await causeFrom(`http://127.0.0.1:${port}/`, 2000), ENDPOINT, 'default')

    expect(error.message).toContain('could not be reached')
    expect(error.message).toContain('must supply one')
    expect(error.message).not.toContain('too slow')
  })

  it('both name the endpoint and the provider, because the row is what has to change', async () => {
    const refused = await causeFrom('http://127.0.0.1:1/', 2000)
    for (const error of [embeddingFailure(refused, ENDPOINT, 'acme-voyage')]) {
      expect(error.message).toContain('http://embedder/embeddings')
      expect(error.message).toContain('acme-voyage')
    }
  })
})
