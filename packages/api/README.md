# @nacre.work/api

The REST API and authorization service of [Nacre](https://nacre.work) — a
self-hosted knowledge index where search returns exactly what the caller is
permitted to see.

**You probably want the container, not this package.** A running installation is
the API, the MCP server, a worker, a parser sidecar, Postgres, Qdrant and Redis;
`docker compose --profile minimal up` brings all of it up from a clean clone.
This package is on the registry because the MCP server depends on it and because
an installation that assembles its own processes has to be able to install it.

- Building an application? [`@nacre.work/sdk`](https://www.npmjs.com/package/@nacre.work/sdk).
- Working from a terminal? [`@nacre.work/cli`](https://www.npmjs.com/package/@nacre.work/cli).
- Connecting an agent? [`@nacre.work/mcp`](https://www.npmjs.com/package/@nacre.work/mcp).

## What it serves

Documents and ingest (JSON, a URL, or `multipart/form-data` including PDF),
hybrid search with metadata filters, layers and workspaces, grants, users,
groups and service accounts, OAuth consent and connection ceilings, embedding
providers and layer reindexing gated on recall, the access log as JSON, JSONL or
CSV, and `/health`, `/ready` and `/metrics`.

The contract is normative and comes first:
[`docs/openapi.yaml`](https://github.com/nacre-work/nacre/blob/main/docs/openapi.yaml).

## Two behaviours to know before writing a client against it

**`404`, never `403`, for anything invisible** — same status and same wording
for "no such object" and "not yours", so nobody can map an installation by
probing it.

**`write` does not imply `read`.** `admin` implies both.

## Also here

`/ready` refuses while the database schema is behind the image, which is what
keeps a rolling upgrade from replacing working pods with pods that answer every
request with an error. It stays ready when the schema is *ahead*, which is the
normal middle of that same upgrade.

Apache 2.0. Configuration, the permission model and the operator documentation:
[github.com/nacre-work/nacre](https://github.com/nacre-work/nacre/tree/main/docs).
