# Quickstart

> **The pieces are wired; the stack has not been run from this file.** The
> adapters, the embedder client, and the parser sidecar exist now, and CI runs
> the worker pipeline and the search path against a real Postgres and a real
> Qdrant — a document is indexed and comes back bounded by its grants, which is
> the claim that matters. What has *not* happened is somebody running
> `docker compose up` from a clean checkout and following this page to the end.
> Treat the commands as accurate but unrehearsed, and
> [open an issue](https://github.com/nacre-work/nacre/issues) for whatever
> this page gets wrong.

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

## A layer, and someone allowed to read it

A document lives in a layer, and a layer lives in a workspace. Nothing is
readable by default — there is no implicit grant to a creator, an owner, or an
administrator of the workspace, which is deliberate and is the thing most
permission systems do differently.

```bash
curl -X POST http://localhost:8080/v1/layers \
  -H "Authorization: Bearer $NACRE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "workspace_id": "…", "slug": "handbook", "name": "Handbook" }'
```

Then grant someone `read` on it:

```bash
curl -X POST http://localhost:8080/v1/grants \
  -H "Authorization: Bearer $NACRE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "principal_type": "user",
    "principal_id": "…",
    "scope_type": "layer",
    "scope_id": "…",
    "permission": "read"
  }'
```

Both need `admin` on the scope in question — on the workspace to create a layer
in it, on the layer to grant against it. Admin on one layer does not let you
grant yourself another. A caller without it gets `404`, the same answer as for a
scope that does not exist, because telling the two apart is how you enumerate
what exists.

Grants are allow-only here. To revoke, delete the grant; `effect: deny` and
`scope_type: document` are commercial and this build refuses them with a `400`
saying so.

`write` does not imply `read` — someone with `write` on a layer can put
documents in it and cannot search them. `admin` implies both. This is the
opposite of most systems and it is not an oversight; see
[authz.md](./authz.md).

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
