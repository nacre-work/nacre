#!/usr/bin/env node
/**
 * A stub embedding endpoint, for the Compose end-to-end smoke test only.
 *
 * `minimal` starts no embedder — that is what keeps it laptop-runnable — so a
 * clean boot of the whole loop needs one supplied. This answers the OpenAI
 * `/embeddings` contract the worker calls (`{ model, input: [...] }` in,
 * `{ data: [{ embedding: [...] }] }` out) with a constant unit vector: a smoke
 * test drives the permission loop, where the ACL pre-filter and not relevance
 * decides what a search returns, so every text embedding to the same point is
 * exactly enough. Non-zero, so cosine similarity is defined rather than NaN.
 *
 * The dimension is read from the environment so it matches the collection init
 * builds; keep it small in CI, since the vectors are meaningless anyway.
 */
import { createServer } from 'node:http'

const DIM = Number(process.env.NACRE_DEFAULT_EMBEDDING_DIM ?? '8')
const PORT = Number(process.env.PORT ?? '8000')

const vector = Array.from({ length: DIM }, () => 1 / Math.sqrt(DIM))

const server = createServer((req, res) => {
  const url = req.url ?? '/'

  if (req.method === 'POST' && url.endsWith('/embeddings')) {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let input = []
      try {
        const parsed = JSON.parse(body || '{}')
        input = Array.isArray(parsed.input) ? parsed.input : [parsed.input]
      } catch {
        input = []
      }
      const data = input.map((_, index) => ({ object: 'embedding', index, embedding: vector }))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', model: 'stub', data }))
    })
    return
  }

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => {
  console.log(`stub embedder listening on :${PORT}, dimension ${DIM}`)
})
