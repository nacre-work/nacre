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
 *
 * ## It refuses a batch that is too large, because a real one does
 *
 * This accepted any number of inputs, and that is why the smoke ran green over
 * a defect that failed **twenty-six documents out of fifty** on a real stand:
 * both embedding clients sent a document's whole chunk list in one request, and
 * Text Embeddings Inference — the embedder every profile here actually starts —
 * answers `413` above `--max-client-batch-size`, which defaults to 32.
 *
 * A mock agrees with whatever it was written to, which is this repository's own
 * most-repeated lesson arriving in the one place built to catch that class. So
 * the stub now enforces the limit the real server enforces: the smoke fails if
 * a client stops bounding what it sends.
 */
import { createServer } from 'node:http'

const DIM = Number(process.env.NACRE_DEFAULT_EMBEDDING_DIM ?? '8')
const PORT = Number(process.env.PORT ?? '8000')
/** TEI's own default for `--max-client-batch-size`. */
const MAX_BATCH = Number(process.env.STUB_MAX_BATCH ?? '32')

const vector = Array.from({ length: DIM }, () => 1 / Math.sqrt(DIM))

const server = createServer((req, res) => {
  const url = req.url ?? '/'

  if (req.method === 'POST' && url.endsWith('/embeddings')) {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let input
      try {
        const parsed = JSON.parse(body || '{}')
        input = Array.isArray(parsed.input) ? parsed.input : []
      } catch {
        input = []
      }
      if (input.length > MAX_BATCH) {
        // TEI's status and shape, so the client meets here what it meets in a
        // deployment: `413`, with the reason in `{ error }`.
        console.log(`refusing a batch of ${input.length}; the limit is ${MAX_BATCH}`)
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            error: `batch size ${input.length} > maximum allowed batch size ${MAX_BATCH}`,
          }),
        )
        return
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
  console.log(`stub embedder listening on :${PORT}, dimension ${DIM}, max batch ${MAX_BATCH}`)
})
