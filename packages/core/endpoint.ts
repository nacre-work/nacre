/**
 * Where a route sits under a configured endpoint.
 *
 * Every model server here is named by a base URL an operator sets —
 * `NACRE_DEFAULT_EMBEDDING_ENDPOINT`, `NACRE_RERANKER_ENDPOINT`, and the
 * `endpoint` column on `embedding_providers` — and each caller then appends the
 * route it wants. The append is the part that was wrong: `new URL('/embeddings',
 * base)` is **origin-relative**, so every path the operator wrote is discarded.
 *
 *     new URL('/embeddings', 'http://embedder:80')          // http://embedder/embeddings
 *     new URL('/embeddings', 'https://api.openai.com/v1')   // https://api.openai.com/embeddings
 *
 * The first is right and is what the `full` profile configures, which is why
 * this held for as long as it did. The second is the shape of every hosted
 * OpenAI-compatible API and of the two servers a laptop actually runs — Ollama
 * and LM Studio both serve `/v1/embeddings` — so "bring your own model" was true
 * of exactly the endpoints that put the route at the root and silently `404` for
 * the rest. A 404 from a model server is indistinguishable from a wrong model
 * name until someone reads the URL.
 *
 * Resolving relative to the base instead keeps both: a base with no path still
 * puts the route at the root, and a base with one keeps it.
 */
export function endpointUrl(base: string | URL, route: string): URL {
  const at = new URL(base)
  // `new URL('embeddings', …/v1)` replaces the last segment rather than
  // descending into it, so the trailing slash is what makes `/v1` a directory.
  if (!at.pathname.endsWith('/')) at.pathname += '/'
  // Relative on purpose: a leading slash here would reintroduce the bug.
  return new URL(route.replace(/^\/+/, ''), at)
}

/**
 * What to say when an operator-configured model endpoint refuses.
 *
 * Three call sites reach one of these — the worker's ingest embedder, the
 * search path's query embedder, and the reranker — and each said
 * `answered ${status}` and nothing else. For most statuses that is fine. For
 * **401 and 403 it is the wrong end of the problem**, because the client sends
 * no `Authorization` header at all:
 *
 *     headers: { 'content-type': 'application/json' }
 *
 * and there is nowhere to put one. `embedding_providers` has no column for a
 * credential, deliberately — a vendor key there would reach Postgres and
 * therefore every dump, which is the argument the embedding adapter exists to
 * satisfy. So pointing an endpoint straight at a hosted vendor cannot work,
 * and the failure is a bare `401` that names neither the cause nor the way
 * round it.
 *
 * `docs/config.md` said "anything already speaking OpenAI's contract works by
 * pointing `embedding_providers.endpoint` straight at it", which is true only
 * of endpoints that want no credential — and OpenAI itself is the first name
 * in the vendor table directly above that sentence. Somebody reading it does
 * exactly the thing that cannot work.
 *
 * A message is the right place for this rather than only a document: this
 * failure arrives in a job's `error` column and in a log, where whoever meets
 * it is not reading `docs/config.md` and does not yet know they should.
 */
export function modelEndpointRefused(
  kind: 'embedding' | 'reranker',
  at: URL,
  status: number,
  reason?: string,
): Error {
  const what = kind === 'embedding' ? 'the embedding endpoint' : 'the reranker'
  const head =
    `${what} at ${at.href} answered ${String(status)}` + (reason === undefined ? '' : `: ${reason}`)

  if (status === 401 || status === 403) {
    return new Error(
      `${head}. That means it wants a credential. ` +
        'Nacre sends none: this request carries only a content-type, and there is no column ' +
        'on embedding_providers to hold a key — a vendor credential there would reach every ' +
        'database dump. Pointing an endpoint straight at a hosted vendor therefore cannot ' +
        'work, however correct the URL is. Route it through the embedding adapter instead ' +
        '(`docker compose --profile hosted`, NACRE_EMBED_ROUTES), which holds the key and ' +
        'speaks this same protocol inward — or put a proxy such as LiteLLM in front. ' +
        'docs/config.md, "Embeddings from a hosted API".',
    )
  }

  return new Error(head)
}

/** How much of an endpoint's own reason travels into a message. */
const REASON_LIMIT = 200

/**
 * The endpoint's own reason for refusing, where it gave one.
 *
 * A status alone is where this failure used to end, and an operator met it as
 * `the embedding endpoint at http://embedding-adapter:8091/embeddings answered
 * 502` — a sentence that names the one process in the chain that did *not*
 * decide anything. 502 is the embedding adapter's word for "somebody else's
 * service failed", and the adapter already knows which vendor and what it said:
 * its body carries `{"error": {"message": "cloudflare answered 429"}}`. Both
 * ends threw that away, so the fact existed for the length of one HTTP response
 * and then nowhere at all.
 *
 * Same argument as the parser's, in `packages/worker/src/adapters.ts`: a
 * refusal whose reason does not travel is a refusal nobody can act on. The
 * difference worth naming is that the parser is always ours and this endpoint
 * is whatever an operator configured — a hosted vendor, Ollama, a TEI
 * container, the adapter — so the safety argument cannot be "we wrote it".
 *
 * It is the bound instead. A vendor's error can quote the input it rejected and
 * the input is document text, which must not reach a log; so this takes one
 * declared field rather than the body, collapses it to a line, and cuts it at
 * `REASON_LIMIT`. The adapter — the endpoint this product ships and the one
 * that fronts every hosted vendor — is safe by construction beyond that, since
 * its own `_post_json` never puts an upstream body in an error.
 *
 * Both spellings, because both are on the wire here: OpenAI's
 * `{error: {message}}`, which the adapter answers, and TEI's `{error}`, which
 * the reranker path meets whenever a deployment points at a real TEI container.
 */
export async function endpointReason(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined)
  const error = (body as { error?: unknown } | undefined)?.error
  const message =
    typeof error === 'string' ? error : (error as { message?: unknown } | undefined)?.message
  if (typeof message !== 'string') return undefined

  const line = message.replace(/\s+/g, ' ').trim()
  if (line === '') return undefined
  return line.length > REASON_LIMIT ? `${line.slice(0, REASON_LIMIT)}…` : line
}

/**
 * How many texts go to an embedding endpoint in one request.
 *
 * **32, because that is what Text Embeddings Inference accepts by default** —
 * `--max-client-batch-size` — and TEI is the embedder this project's own
 * Compose profiles start. Not a guess at a good throughput number: a bound the
 * ecosystem's most common self-hosted server actually enforces.
 */
export const DEFAULT_EMBED_BATCH = 32

/**
 * Send texts to an embedding endpoint in bounded batches.
 *
 * Both clients used to send a document's whole chunk list as one `input` array
 * with no bound of their own, and a document is chunked at 800 characters with
 * 120 of overlap — so anything past roughly 22 KB of text crossed TEI's default
 * of 32 and came back **413**. The worker marks that document `failed`, nothing
 * retries that status, and the only visible sign is a count in the admin UI
 * beside a larger count. A layer where half the documents never indexed answers
 * searches perfectly well with the other half; the retrieval is just quietly
 * worse.
 *
 * Found on a running stand with twenty-six failures out of fifty, all of them
 * the same line:
 *
 *     the embedding endpoint at http://embedder/embeddings answered 413
 *
 * **Sequential, not parallel.** The endpoint is the bottleneck and is usually a
 * CPU container sized for one caller; issuing every batch at once would turn a
 * large document into a load spike against the thing already struggling, and
 * the worker is deliberately serial for the same reason. Slower and finishing
 * beats faster and refused.
 *
 * The count is asserted at the end as well as per batch, because the failure
 * this guards against is silent: a short or reordered result attaches the wrong
 * vector to the wrong text and nothing downstream can tell.
 */
export async function embedInBatches<T>(
  texts: readonly string[],
  limit: number,
  send: (batch: readonly string[]) => Promise<readonly T[]>,
): Promise<readonly T[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`the embedding batch limit must be a positive integer, got ${String(limit)}`)
  }
  if (texts.length === 0) return []
  if (texts.length <= limit) return send(texts)

  const out: T[] = []
  for (let at = 0; at < texts.length; at += limit) {
    const batch = texts.slice(at, at + limit)
    const vectors = await send(batch)
    if (vectors.length !== batch.length) {
      throw new Error(
        `the embedding endpoint returned ${String(vectors.length)} vectors for ` +
          `${String(batch.length)} inputs in a batch of ${String(texts.length)}`,
      )
    }
    out.push(...vectors)
  }

  if (out.length !== texts.length) {
    throw new Error(
      `batching produced ${String(out.length)} vectors for ${String(texts.length)} inputs`,
    )
  }
  return out
}
