import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it } from 'vitest'

import { HttpParser } from '../adapters.js'

/**
 * A refusal from the sidecar arrives with its reason attached.
 *
 * This threw `the parser answered 422` and dropped the body, which is where the
 * reason lives. That message is not decoration: it lands in the job's `error`
 * column and is the only thing an operator ever sees, so a scan refused with
 * "it has no text layer, and this build does no OCR" reaching them as a bare
 * status sends them looking for a corrupt file instead of an OCR step.
 *
 * Against a real HTTP server rather than a stubbed `fetch`, because what is
 * under test is the reading of a response — a fake of that is a fake of the
 * thing that was wrong.
 */

let server: Server

afterEach(() => {
  server?.close()
})

async function parserAnswering(status: number, body: string, contentType = 'application/json'): Promise<HttpParser> {
  server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': contentType })
    res.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return new HttpParser(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 5_000)
}

describe('a parser refusal', () => {
  it('carries the sidecar’s reason, not only its status', async () => {
    const reason = 'the PDF has no text layer — it is a scan, and this build does no OCR'
    const parser = await parserAnswering(422, JSON.stringify({ error: reason }))
    await expect(parser.parse({ content: 'x' })).rejects.toThrow(/no text layer/)
    // The status stays too. It is what separates a refusal the sidecar decided
    // on from one of its own failures, and an operator reading a job error
    // should not have to guess which they are looking at.
    await expect(parser.parse({ content: 'x' })).rejects.toThrow(/422/)
  })

  it('falls back to the status when there is no reason to carry', async () => {
    // A proxy's error page, a truncated body, a sidecar that died mid-reply.
    // None of those is JSON with an `error` string, and inventing one would put
    // words in the sidecar's mouth.
    for (const [status, body, type] of [
      [502, '<html>bad gateway</html>', 'text/html'],
      [500, '{"not_an_error":"x"}', 'application/json'],
      [422, '', 'application/json'],
    ] as const) {
      const parser = await parserAnswering(status, body, type)
      await expect(parser.parse({ content: 'x' })).rejects.toThrow(
        new RegExp(`the parser answered ${status}`),
      )
      server.close()
    }
  })
})
