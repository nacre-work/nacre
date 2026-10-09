# Nacre documentation

Read [authz.md](./authz.md) first. Everything else depends on the permission
model, and reworking it after search is written is expensive.

| Document | Covers |
|---|---|
| [authz.md](./authz.md) | **Start here.** Permission model, algorithm, invariants, the T1–T39 test plan |
| [architecture.md](./architecture.md) | Components, data flow, vector storage, reindexing, backups |
| [mcp.md](./mcp.md) | MCP server: transport, authorization, tools |
| [skills.md](./skills.md) | Skills: what an agent is told on connecting, at installation, organization and layer level — *built; the panel, the console screens and the consent box are not* |
| [mcp-admin.md](./mcp-admin.md) | The administrative MCP: a separate resource and token, changes a person applies, the access log, notifications — *specified, not built* |
| [mcp-conformance.md](./mcp-conformance.md) | Every normative sentence of the 2026-07-28 binding, and where we stand on it |
| [api.md](./api.md) | REST API conventions · contract in [openapi.yaml](./openapi.yaml) |
| [config.md](./config.md) | Environment variables, Compose profiles, metrics |
| [audit.md](./audit.md) | Access log schema and guarantees |
| [extensions.md](./extensions.md) | The points a commercial module plugs into, and what the core refuses |
| [licensing.md](./licensing.md) | Open/commercial boundary, third-party licenses |
| [quickstart.md](./quickstart.md) | First run, first document, first search |
| [apple-silicon.md](./apple-silicon.md) | Running on an M-series Mac: what is native, and the one thing that is not |
| [upgrading.md](./upgrading.md) | What an operator does when a release comes out |
| [releasing.md](./releasing.md) | What ships and from where — and the one step in adding a package that a person has to do by hand |
| [backup.md](./backup.md) | Backing up and restoring by hand: what to copy, in what order, and what is derived |
| [operations/](./operations/) | Runbooks: [restoring from a backup](./operations/restore-from-backup.md), [rotating the JWT key](./operations/rotate-jwt-key.md), [rolling back a reindex](./operations/rollback-layer-reindex.md), [a climbing tombstone backlog](./operations/vector-collection-backlog.md) |
| [../deploy/helm](../deploy/helm/README.md) | The Kubernetes chart: what it deploys, what it refuses, and why Postgres, Qdrant and Redis are not subcharts |

## Order of work

All five steps below have landed at least once — this is the order they were
built in, kept because it is the order the dependencies actually run in, and
because anything reworking one of them still has to respect it.

1. `authz.md` and `packages/core/migrations/0001_init.sql` — the permission
   model and the schema, **with the tests from the test plan**. The tests are
   written before search, not after. Written after, they get written to match
   whatever was built rather than what was specified.
2. `architecture.md` — vector storage and the pre-filter.
3. `mcp.md` — the MCP server.
4. `api.md` and `openapi.yaml` — REST.
5. `config.md` and `audit.md` — operations and audit.

## The six invariants

Breaking any of them is a security incident, not a bug.

1. The organization comes from the token and nowhere else.
2. Access filtering is a pre-filter, never a post-filter.
3. A failure to evaluate permissions denies access.
4. "No permission" and "no such object" return identical responses.
5. A deleted document is never returned, including before garbage collection.
6. `write` does not imply `read`.
