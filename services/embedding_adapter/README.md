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
| `NACRE_EMBED_ROUTES` | `model=vendor`, comma-separated. Required. |
| `NACRE_EMBED_OPENAI_COMPATIBLE_ENDPOINT` | Base URL. Required if a route names that vendor. |
| `NACRE_EMBED_OPENAI_COMPATIBLE_API_KEY[_FILE]` | |
| `NACRE_EMBED_CLOUDFLARE_ACCOUNT` | Account id. |
| `NACRE_EMBED_CLOUDFLARE_API_KEY[_FILE]` | |
| `NACRE_EMBED_GOOGLE_API_KEY[_FILE]` | |
| `PORT` | 8091. |

`_API_KEY` and `_API_KEY_FILE` together is refused rather than resolved by
precedence — two answers to one question leaves the losing one configured,
apparently in use, and ignored.

## Vendors

| `vendor` | Upstream |
|---|---|
| `openai-compatible` | Anything answering OpenAI's `/embeddings`: OpenAI, Together, Voyage, DeepInfra, vLLM, a self-hosted TEI |
| `cloudflare` | Workers AI |
| `google` | Generative Language API |

Named for the protocol rather than for a company in the first case, which is
why its endpoint is required configuration instead of a default pointing at one
vendor.

Adding a vendor is a function and a table entry in `app.py`. It is deliberately
not a column value and not a migration.

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
