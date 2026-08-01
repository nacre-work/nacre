# Quickstart

> **This does not run end to end yet.** The compose file is real and its three
> profiles are validated in CI; the API and MCP transports, the permission
> model, and the ingest pipeline are implemented and tested. What is missing is
> the wiring between them — the adapters behind the storage ports, the embedder
> client, and the parser sidecar's body. Commands below are the intended shape,
> not a working transcript. Check
> [the issue tracker](https://github.com/nacre-work/nacre/issues) for where
> things actually stand.

## What you will need

- Docker with Compose v2
- 8 GB of RAM for the `minimal` profile
- An embedding endpoint. Any OpenAI-compatible one will do; the `full` profile
  brings its own.

## First run

```bash
git clone https://github.com/nacre-work/nacre && cd nacre
cp .env.example .env
docker compose --profile minimal up -d
```

`minimal` starts the API, a worker, PostgreSQL, Qdrant, Redis, and the parser
sidecar, and expects embeddings from an endpoint you name in
`NACRE_DEFAULT_EMBEDDING_ENDPOINT`. Use `--profile full` to run the embedder and
the reranker locally too; see [config.md](./config.md) for the difference.

## First document

```bash
curl -X POST http://localhost:8080/v1/documents \
  -H "Authorization: Bearer $NACRE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "layer": "handbook",
    "external_id": "onboarding-2026",
    "title": "Onboarding",
    "content": "New engineers get repository access on their first day."
  }'
```

Ingest is asynchronous and returns `202` with a `job_id`. Poll
`GET /v1/jobs/{id}` until `status` is `indexed`.

## First search

```bash
curl -X POST http://localhost:8080/v1/search \
  -H "Authorization: Bearer $NACRE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "query": "when do new hires get access", "top_k": 5 }'
```

You get back exactly the chunks your token is permitted to see. Not the top 5
filtered down to whatever survived — 5 permitted results, because the filter is
applied inside the index traversal. If that distinction is new, read
[authz.md](./authz.md); it is the reason this project exists.

## Connecting an agent

Over MCP, Streamable HTTP:

```
https://api.nacre.work/mcp
```

Locally, over STDIO, with a service account key:

```bash
NACRE_SERVICE_KEY=… npx @nacre.work/mcp
```

The local mode carries exactly the service account's permissions. There is no
developer-convenience relaxation, and there will not be one.

## The one thing to get right before production

The OAuth issuer and `/.well-known/*` belong on `api.nacre.work`, not on the
apex domain. Static hosting on the apex intercepts the discovery path, and the
issuer URL is baked into every token you have ever issued — moving it later
breaks every client at once. [mcp.md](./mcp.md) has the detail.
