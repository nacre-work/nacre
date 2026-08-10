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
export function modelEndpointRefused(kind: 'embedding' | 'reranker', at: URL, status: number): Error {
  const what = kind === 'embedding' ? 'the embedding endpoint' : 'the reranker'

  if (status === 401 || status === 403) {
    return new Error(
      `${what} at ${at.href} answered ${String(status)}, which means it wants a credential. ` +
        'Nacre sends none: this request carries only a content-type, and there is no column ' +
        'on embedding_providers to hold a key — a vendor credential there would reach every ' +
        'database dump. Pointing an endpoint straight at a hosted vendor therefore cannot ' +
        'work, however correct the URL is. Route it through the embedding adapter instead ' +
        '(`docker compose --profile hosted`, NACRE_EMBED_ROUTES), which holds the key and ' +
        'speaks this same protocol inward — or put a proxy such as LiteLLM in front. ' +
        'docs/config.md, "Embeddings from a hosted API".',
    )
  }

  return new Error(`${what} at ${at.href} answered ${String(status)}`)
}
