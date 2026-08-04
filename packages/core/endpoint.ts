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
