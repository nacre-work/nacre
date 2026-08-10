# embedding-adapter

One protocol in, several vendors out. `POST /embeddings` takes exactly what the
worker and the search path already send — `{"model": …, "input": […]}` — and
answers exactly what they already read.

**It exists so the core does not learn three protocols.** The indexing path
speaks one, and everything OpenAI-shaped already works by pointing
`embedding_providers.endpoint` at it. What this adds is the vendors that do not,
and a credential, without either reaching Postgres.

## Nothing has a default

- No route exists unless `NACRE_EMBED_ROUTES` names it.
- An unrouted model is refused by name. There is no fallback vendor, because a
  fallback is a decision made on the operator's behalf about where their
  documents go.
- With no routes at all the process refuses to start.

Routing a model here means **the text of your documents leaves your
installation.** That is the trade; `docs/config.md` states it in those words.

## Configuration

| Variable | |
|---|---|
| `NACRE_EMBED_ROUTES` | `model=vendor`, comma-separated. Required unless a reranker is configured. |
| `NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT` | Base URL. Required if a route names that vendor. |
| `NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY[_FILE]` | |
| `NACRE_EMBED_CLOUDFLARE_ACCOUNT` | Account id. |
| `NACRE_EMBED_CLOUDFLARE_API_KEY[_FILE]` | |
| `NACRE_EMBED_GOOGLE_API_KEY[_FILE]` | |
| `NACRE_EMBED_VOYAGE_API_KEY[_FILE]` | |
| `NACRE_RERANK_VENDOR` | One of the rerank vendors below. With `NACRE_RERANK_MODEL`, or neither. |
| `NACRE_RERANK_MODEL` | The cross-encoder. |
| `NACRE_RERANK_CLOUDFLARE_ACCOUNT` | Account id. |
| `NACRE_RERANK_CLOUDFLARE_API_KEY[_FILE]` | |
| `NACRE_RERANK_COHERE_API_KEY[_FILE]` | |
| `NACRE_RERANK_JINA_API_KEY[_FILE]` | |
| `NACRE_RERANK_VOYAGE_API_KEY[_FILE]` | |
| `PORT` | 8091. |

`_API_KEY` and `_API_KEY_FILE` together is refused rather than resolved by
precedence — two answers to one question leaves the losing one configured,
apparently in use, and ignored.

The rerank credentials are separate from the embedding ones even where the
vendor is the same: the two jobs are independent, and an adapter that only
reranks must not have to set an embedding variable.

## Vendors

Embeddings, routed by model name:

| `vendor` | Upstream |
|---|---|
| `openai-compatible` | Anything answering OpenAI's `/embeddings`: OpenAI, Together, DeepInfra, vLLM, a self-hosted TEI |
| `cloudflare` | Workers AI |
| `google` | Generative Language API |
| `voyage` | Voyage AI |

Named for the protocol rather than for a company in the first case, which is
why its endpoint is required configuration instead of a default pointing at one
vendor. `voyage` is OpenAI-shaped and still has its own entry, because Anthropic
publishes no embeddings API and points at Voyage — so that is where "embeddings
from Anthropic" has to land, and it should not require knowing a URL.

Reranking, one per adapter:

| `NACRE_RERANK_VENDOR` | Upstream |
|---|---|
| `cloudflare` | Workers AI |
| `cohere` | Cohere Rerank |
| `jina` | Jina Reranker |
| `voyage` | Voyage Rerank |

**OpenAI, Anthropic and Google publish no reranking API**, so none of them can
be one — and the refusal for an unknown vendor says so rather than only listing
the four, because a list alone reads as "yours was forgotten".

Adding a vendor is a function and a table entry in `app.py`. It is deliberately
not a column value and not a migration.

## Two endpoints

`POST /embeddings` takes `{model, input}` and answers OpenAI's shape.

`POST /rerank` takes `{query, texts}` and answers TEI's — a bare
`[{index, score}]` array — so the core needs no code at all: point
`NACRE_RERANKER_ENDPOINT` here instead of at a TEI container. Every candidate
must come back scored and a short answer is refused naming the vendor, because
an unscored candidate sinks to the bottom of the results with no error anywhere.
Both paths also answer under `/v1/`.

## Zero dependencies

Standard library only. This process sees the text of every document routed
through it, which is the same argument that keeps `services/parser` at one
dependency. There is one operation here.

Anyone who would rather have the dependency has the documented escape hatch:
LiteLLM in front of the existing `embedding_providers.endpoint` needs no code
from this repository at all, since that path is already OpenAI-shaped.

## Not in `airgapped`

That profile's rule is no outbound connection at all, and this service is
absent from it rather than disabled in it — a rule enforced by a runtime check
is a check that has to be right, and a service that is not there cannot connect
to anything. `pnpm lint:compose` asserts the absence.

## Running it

```bash
python -m services.embedding_adapter
python -m unittest discover -s services/embedding_adapter -t . -v
```
